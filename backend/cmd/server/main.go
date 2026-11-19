package main

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
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
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, cfg, log); err != nil {
		log.Error("server stopped with an error", zap.Error(err))
		_ = log.Sync()
		os.Exit(1)
	}
}

func run(ctx context.Context, cfg config.Config, log *zap.Logger) error {
	if err := cfg.Validate(); err != nil {
		return fmt.Errorf("invalid configuration: %w", err)
	}
	telemetry, err := observability.InitTelemetry(ctx, cfg, log)
	if err != nil {
		return fmt.Errorf("initialize telemetry: %w", err)
	}
	defer func() {
		flushCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := telemetry.Shutdown(flushCtx); err != nil {
			log.Warn("telemetry shutdown incomplete")
		}
	}()
	db, err := database.Open(cfg)
	if err != nil {
		return fmt.Errorf("database connection failed: %w", err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		return fmt.Errorf("database handle failed: %w", err)
	}
	defer func() { _ = sqlDB.Close() }()
	startupCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	if database.AllowAutoMigrate(cfg) {
		log.Warn("RAG_ALLOW_AUTOMIGRATE is set: creating missing tables from GORM models; the result is not migration-equivalent")
		if err := database.AutoMigrate(startupCtx, db); err != nil {
			return fmt.Errorf("database migration failed: %w", err)
		}
	} else if err := database.EnsureSchema(startupCtx, db); err != nil {
		return fmt.Errorf("database schema incompatible: %w", err)
	}
	if err := repository.NewSystemRepository(db).ValidateEmbeddingDimension(startupCtx, cfg.EmbeddingDimension); err != nil {
		return fmt.Errorf("embedding schema incompatible: %w", err)
	}
	redisClient := cache.Open(cfg)
	defer func() { _ = redisClient.Close() }()
	if err := cache.Ping(startupCtx, redisClient); err != nil {
		log.Warn("redis ping failed", zap.Error(err))
	} else {
		log.Info("redis connected")
	}
	metrics := observability.NewRecorder().WithLogger(log)
	documentRepo := repository.NewDocumentRepository(db)
	chunkRepo := repository.NewChunkRepository(db)
	storageCleanupRepo := repository.NewStorageCleanupRepository(db)
	fileStorage, err := storage.NewFromConfig(cfg)
	if err != nil {
		return fmt.Errorf("initialize document storage: %w", err)
	}
	if err := storage.EnsureReady(startupCtx, fileStorage); err != nil {
		return fmt.Errorf("document storage readiness check: %w", err)
	}
	documentProcessor := processor.NewWithStorage(documentRepo, chunkRepo, parser.NewConfiguredParser(cfg), splitter.New(splitter.DefaultChunkSize, splitter.DefaultChunkOverlap), embeddingprovider.NewOpenAICompatibleProvider(cfg), fileStorage)
	documentProcessor.SetEmbeddingIdentity(cfg.EmbeddingModel, cfg.EmbeddingDimension)
	documentProcessor.SetRecorder(metrics)

	// Bind before launching workers: an occupied port must not leave jobs running.
	listener, err := net.Listen("tcp", ":"+cfg.ServerPort)
	if err != nil {
		return fmt.Errorf("listen: %w", err)
	}
	defer listener.Close()
	workerCtx, stopWorkers := context.WithCancel(context.Background())
	defer stopWorkers()
	var workers sync.WaitGroup
	startWorker := func(work func(context.Context)) { workers.Go(func() { work(workerCtx) }) }
	startWorker(job.NewWorkerWithOptions(documentRepo, documentProcessor, log, job.Options{Recorder: metrics, Concurrency: cfg.WorkerConcurrency, MaxRetries: cfg.WorkerMaxRetries, RetryDelay: cfg.WorkerRetryDelay}).Start)
	startWorker(job.NewStorageCleanupWorker(storageCleanupRepo, fileStorage, log, job.Options{RetryDelay: cfg.WorkerRetryDelay, OperationTimeout: cfg.StorageOperationTimeout}).Start)
	r := router.NewWithStorageAndDependencies(cfg, db, log, fileStorage, router.Dependencies{
		Redis:          redisClient,
		RateLimiter:    cache.NewFixedWindowRateLimiter(redisClient),
		EmbeddingCache: cache.NewEmbeddingCache(redisClient),
		Metrics:        metrics,
		StartWorker:    startWorker,
	})
	server := &http.Server{Handler: r, ReadHeaderTimeout: 5 * time.Second, IdleTimeout: time.Minute}
	log.Info("starting server", zap.String("addr", listener.Addr().String()))
	return serve(ctx, server, listener, stopWorkers, &workers)
}
