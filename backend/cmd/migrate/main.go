package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"go.uber.org/zap"

	"rag/backend/internal/config"
	"rag/backend/internal/logger"
)

func main() {
	migration := flag.String("migration", "", "apply only the named file from migrations/")
	flag.Parse()

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
	files, err = selectMigrationFiles(files, *migration)
	if err != nil {
		log.Fatal("select migrations failed", zap.Error(err))
	}

	if len(files) == 0 {
		log.Fatal("no migration files found")
	}

	for _, file := range files {
		log.Info("applying migration", zap.String("file", file))
		if err := applyMigration(ctx, conn, file, *migration != ""); err != nil {
			log.Fatal("apply migration failed", zap.String("file", file), zap.Error(err))
		}
	}

	log.Info("applied migrations", zap.Int("count", len(files)))
}

func selectMigrationFiles(files []string, selected string) ([]string, error) {
	files = append([]string(nil), files...)
	sort.Strings(files)
	if selected == "" {
		return files, nil
	}
	if filepath.IsAbs(selected) || filepath.Ext(selected) != ".sql" ||
		strings.ContainsAny(selected, `/\\`) || filepath.Base(selected) != selected {
		return nil, fmt.Errorf("migration must be a .sql filename from migrations/")
	}
	for _, file := range files {
		if filepath.Base(file) == selected {
			return []string{file}, nil
		}
	}
	return nil, fmt.Errorf("migration %q was not found in migrations/", selected)
}

func applyMigration(ctx context.Context, conn *pgx.Conn, file string, transactional bool) error {
	sql, err := os.ReadFile(file)
	if err != nil {
		return fmt.Errorf("read migration: %w", err)
	}
	if !transactional {
		_, err = conn.Exec(ctx, string(sql))
		return err
	}

	tx, err := conn.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin migration transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if _, err := tx.Exec(ctx, string(sql)); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit migration transaction: %w", err)
	}
	return nil
}
