// reembed schedules document reprocessing after an embedding model change.
package main

import (
	"context"
	"flag"
	"github.com/google/uuid"
	"go.uber.org/zap"
	"kbchat/backend/internal/config"
	"kbchat/backend/internal/database"
	"kbchat/backend/internal/logger"
	"kbchat/backend/internal/repository"
	"kbchat/backend/internal/service"
	"os"
	"os/signal"
	"time"
)

func main() {
	kb := flag.String("kb", "", "optional knowledge base UUID")
	only := flag.Bool("only-mismatched", true, "select unknown or mismatched model/dimension")
	dry := flag.Bool("dry-run", false, "report the count without writing jobs")
	batch := flag.Int("batch", 100, "documents per batch, 1-1000")
	flag.Parse()
	cfg := config.Load()
	log := logger.New(cfg)
	defer func() { _ = log.Sync() }()
	options := service.ReembedOptions{Identity: repository.EmbeddingIdentity{Model: cfg.EmbeddingModel, Dimension: cfg.EmbeddingDimension}, OnlyMismatched: *only, DryRun: *dry, Batch: *batch}
	if *kb != "" {
		id, err := uuid.Parse(*kb)
		if err != nil {
			log.Fatal("invalid -kb UUID")
		}
		options.KnowledgeBaseID = &id
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	ctx, cancel := context.WithTimeout(ctx, time.Hour)
	defer cancel()
	db, err := database.Open(cfg)
	if err != nil {
		log.Fatal("database connection failed", zap.Error(err))
	}
	sqlDB, err := db.DB()
	if err != nil {
		log.Fatal("database handle failed", zap.Error(err))
	}
	defer sqlDB.Close()
	// No AutoMigrate: dry-run must remain read-only, including on an old schema.
	if err := repository.NewSystemRepository(db).ValidateEmbeddingDimension(ctx, cfg.EmbeddingDimension); err != nil {
		log.Fatal("embedding schema incompatible", zap.Error(err))
	}
	result, err := service.Reembed(ctx, repository.NewDocumentRepository(db), options)
	if err != nil {
		log.Fatal("reembed failed", zap.Int("selected", result.Selected), zap.Int("queued", result.Queued), zap.Error(err))
	}
	log.Info("reembed completed", zap.Bool("dry_run", *dry), zap.Int("selected", result.Selected), zap.Int("queued", result.Queued))
}
