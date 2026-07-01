package main

import (
	"context"
	"net/http"
	"time"

	"go.uber.org/zap"

	"rag/backend/internal/cache"
	"rag/backend/internal/config"
	"rag/backend/internal/database"
	"rag/backend/internal/document/parser"
	"rag/backend/internal/document/processor"
	"rag/backend/internal/document/splitter"
	"rag/backend/internal/job"
	"rag/backend/internal/logger"
	embeddingprovider "rag/backend/internal/provider/embedding"
	"rag/backend/internal/repository"
	"rag/backend/internal/router"
)

func main() {
	cfg := config.Load()
	log := logger.New(cfg)
	defer func() { _ = log.Sync() }()

	db, err := database.Open(cfg)
	if err != nil {
		log.Fatal("database connection failed", zap.Error(err))
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := database.AutoMigrate(ctx, db); err != nil {
		log.Fatal("database migration failed", zap.Error(err))
	}

	redisClient := cache.Open(cfg)
	if err := cache.Ping(ctx, redisClient); err != nil {
		log.Warn("redis ping failed", zap.Error(err))
	} else {
		log.Info("redis connected")
	}

	documentRepo := repository.NewDocumentRepository(db)
	chunkRepo := repository.NewChunkRepository(db)
	documentProcessor := processor.New(
		documentRepo,
		chunkRepo,
		parser.NewDefaultParser(),
		splitter.New(splitter.DefaultChunkSize, splitter.DefaultChunkOverlap),
		embeddingprovider.NewOpenAICompatibleProvider(cfg),
	)
	workerCtx, stopWorker := context.WithCancel(context.Background())
	defer stopWorker()
	go job.NewWorker(documentRepo, documentProcessor, log).Start(workerCtx)

	r := router.New(cfg, db, log)

	server := &http.Server{
		Addr:    ":" + cfg.ServerPort,
		Handler: r,
	}

	log.Info("starting server", zap.String("addr", server.Addr))
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal("server failed", zap.Error(err))
	}
}
