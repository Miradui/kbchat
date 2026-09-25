package main

import (
	"context"
	"time"

	"go.uber.org/zap"

	"kbchat/backend/internal/cache"
	"kbchat/backend/internal/config"
	"kbchat/backend/internal/database"
	"kbchat/backend/internal/logger"
	"kbchat/backend/internal/repository"
)

func main() {
	cfg := config.Load()
	log := logger.New(cfg)
	defer func() { _ = log.Sync() }()

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	db, err := database.Open(cfg)
	if err != nil {
		log.Fatal("database connection failed", zap.Error(err))
	}

	sqlDB, err := db.DB()
	if err != nil {
		log.Fatal("database handle failed", zap.Error(err))
	}
	if err := sqlDB.PingContext(ctx); err != nil {
		log.Fatal("database ping failed", zap.Error(err))
	}
	log.Info("database connected")

	// A filtered HNSW scan can come back short before pgvector 0.8.0; retrieval
	// then reruns it exhaustively, which is correct but slower on large
	// knowledge bases. See docs/05-rag-pipeline.md "pgvector 查询约束".
	switch vector := repository.NewChunkRepository(db).Pgvector(ctx); {
	case vector.Version == "":
		log.Warn("pgvector extension not found; apply the migrations before starting the server")
	case !vector.IterativeScan:
		log.Warn("pgvector is older than 0.8.0: filtered vector searches fall back to exact scans when the index returns too few rows; upgrade to enable iterative index scans",
			zap.String("version", vector.Version))
	default:
		log.Info("pgvector supports iterative index scans", zap.String("version", vector.Version))
	}

	redisClient := cache.Open(cfg)
	if err := cache.Ping(ctx, redisClient); err != nil {
		log.Fatal("redis ping failed", zap.Error(err))
	}
	log.Info("redis connected")
}
