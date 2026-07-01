package main

import (
	"context"
	"os"
	"path/filepath"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"
	"go.uber.org/zap"

	"rag/backend/internal/config"
	"rag/backend/internal/logger"
)

func main() {
	cfg := config.Load()
	log := logger.New(cfg)
	defer func() { _ = log.Sync() }()

	if cfg.DatabaseURL == "" {
		log.Fatal("DATABASE_URL is required")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	conn, err := pgx.Connect(ctx, cfg.DatabaseURL)
	if err != nil {
		log.Fatal("connect database failed", zap.Error(err))
	}
	defer conn.Close(context.Background())

	files, err := filepath.Glob("migrations/*.sql")
	if err != nil {
		log.Fatal("find migrations failed", zap.Error(err))
	}
	sort.Strings(files)

	if len(files) == 0 {
		log.Fatal("no migration files found")
	}

	for _, file := range files {
		sql, err := os.ReadFile(file)
		if err != nil {
			log.Fatal("read migration failed", zap.String("file", file), zap.Error(err))
		}

		log.Info("applying migration", zap.String("file", file))
		if _, err := conn.Exec(ctx, string(sql)); err != nil {
			log.Fatal("apply migration failed", zap.String("file", file), zap.Error(err))
		}
	}

	log.Info("applied migrations", zap.Int("count", len(files)))
}
