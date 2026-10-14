package main

import (
	"context"
	"net/http"
	"time"

	"go.uber.org/zap"

	"kbchat/backend/internal/cache"
	"kbchat/backend/internal/config"
	"kbchat/backend/internal/database"
	"kbchat/backend/internal/document/parser"
	"kbchat/backend/internal/document/processor"
	"kbchat/backend/internal/document/splitter"
	"kbchat/backend/internal/job"
	"kbchat/backend/internal/logger"
	"kbchat/backend/internal/observability"
	embeddingprovider "kbchat/backend/internal/provider/embedding"
	"kbchat/backend/internal/repository"
	"kbchat/backend/internal/router"
	"kbchat/backend/internal/storage"
)

func main() {
	cfg := config.Load()
	log := logger.New(cfg)
	defer func() { _ = log.Sync() }()
	if err := cfg.Validate(); err != nil {
		log.Fatal("invalid configuration", zap.Error(err))
	}

	db, err := database.Open(cfg)
	if err != nil {
		log.Fatal("database connection failed", zap.Error(err))
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := database.AutoMigrate(ctx, db); err != nil {
		log.Fatal("database migration failed", zap.Error(err))
	}
	if err := repository.NewSystemRepository(db).ValidateEmbeddingDimension(ctx, cfg.EmbeddingDimension); err != nil {
		log.Fatal("embedding schema incompatible", zap.Error(err))
	}

	redisClient := cache.Open(cfg)
	defer func() { _ = redisClient.Close() }()
	if err := cache.Ping(ctx, redisClient); err != nil {
		log.Warn("redis ping failed", zap.Error(err))
	} else {
		log.Info("redis connected")
	}

	documentRepo := repository.NewDocumentRepository(db)
	chunkRepo := repository.NewChunkRepository(db)
	storageCleanupRepo := repository.NewStorageCleanupRepository(db)
	fileStorage, err := storage.NewFromConfig(cfg)
	if err != nil {
		log.Fatal("initialize document storage failed", zap.Error(err))
	}
	if err := storage.EnsureReady(ctx, fileStorage); err != nil {
		log.Fatal("document storage readiness check failed", zap.Error(err))
	}
	documentProcessor := processor.NewWithStorage(
		documentRepo,
		chunkRepo,
		parser.NewConfiguredParser(cfg),
		splitter.New(splitter.DefaultChunkSize, splitter.DefaultChunkOverlap),
		embeddingprovider.NewOpenAICompatibleProvider(cfg),
		fileStorage,
	)
	workerCtx, stopWorker := context.WithCancel(context.Background())
	documentProcessor.SetEmbeddingIdentity(cfg.EmbeddingModel, cfg.EmbeddingDimension)
	defer stopWorker()
	go job.NewWorkerWithOptions(documentRepo, documentProcessor, log, job.Options{
		Concurrency: cfg.WorkerConcurrency,
		MaxRetries:  cfg.WorkerMaxRetries,
		RetryDelay:  cfg.WorkerRetryDelay,
	}).Start(workerCtx)
	go job.NewStorageCleanupWorker(storageCleanupRepo, fileStorage, log, job.Options{
		RetryDelay:       cfg.WorkerRetryDelay,
		OperationTimeout: cfg.StorageOperationTimeout,
	}).Start(workerCtx)

	// The same Redis client the application uses is handed to the router so the
	// diagnostics probe checks the real connection pool rather than a second one.
	r := router.NewWithStorageAndDependencies(cfg, db, log, fileStorage, router.Dependencies{
		Redis:          redisClient,
		RateLimiter:    cache.NewFixedWindowRateLimiter(redisClient),
		EmbeddingCache: cache.NewEmbeddingCache(redisClient),
		Metrics:        observability.NewRecorder(),
		WorkerContext:  workerCtx,
	})

	server := &http.Server{
		Addr:    ":" + cfg.ServerPort,
		Handler: r,
	}

	log.Info("starting server", zap.String("addr", server.Addr))
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal("server failed", zap.Error(err))
	}
}
