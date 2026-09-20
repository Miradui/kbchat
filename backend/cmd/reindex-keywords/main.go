// reindex-keywords recomputes document_chunks.search_vector for every chunk.
//
// Run it once after migration 024 so chunks published before the column existed
// take part in keyword recall, and again after any change to
// internal/document/lexer so the index and future queries agree.
package main

import (
	"context"
	"flag"
	"os"
	"os/signal"
	"time"

	"go.uber.org/zap"

	"kbchat/backend/internal/config"
	"kbchat/backend/internal/database"
	"kbchat/backend/internal/logger"
	"kbchat/backend/internal/repository"
)

func main() {
	batchSize := flag.Int("batch", 200, "chunks per committed batch")
	timeout := flag.Duration("timeout", time.Hour, "overall deadline")
	flag.Parse()

	cfg := config.Load()
	log := logger.New(cfg)
	defer func() { _ = log.Sync() }()

	db, err := database.Open(cfg)
	if err != nil {
		log.Fatal("database connection failed", zap.Error(err))
	}

	ctx, cancel := context.WithTimeout(context.Background(), *timeout)
	defer cancel()
	ctx, stop := signal.NotifyContext(ctx, os.Interrupt)
	defer stop()

	if err := database.AutoMigrate(ctx, db); err != nil {
		log.Fatal("database migration failed", zap.Error(err))
	}

	start := time.Now()
	chunks := repository.NewChunkRepository(db)
	done, err := chunks.ReindexKeywords(ctx, *batchSize, func(done int) {
		log.Info("reindexed chunks", zap.Int("done", done))
	})
	if err != nil {
		log.Fatal("reindex keywords failed", zap.Int("done", done), zap.Error(err))
	}
	log.Info("reindex keywords completed", zap.Int("chunks", done), zap.Duration("elapsed", time.Since(start)))
}
