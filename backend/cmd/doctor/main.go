package main

import (
	"context"
	"time"

	"go.uber.org/zap"

	"rag/backend/internal/cache"
	"rag/backend/internal/config"
	"rag/backend/internal/database"
	"rag/backend/internal/logger"
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

	redisClient := cache.Open(cfg)
	if err := cache.Ping(ctx, redisClient); err != nil {
		log.Fatal("redis ping failed", zap.Error(err))
	}
	log.Info("redis connected")
}
