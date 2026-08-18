package database

import (
	"context"
	"fmt"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"

	"rag/backend/internal/config"
	"rag/backend/internal/model"
)

func Open(cfg config.Config) (*gorm.DB, error) {
	if cfg.DatabaseURL == "" {
		return nil, fmt.Errorf("DATABASE_URL is required")
	}

	db, err := gorm.Open(postgres.Open(cfg.DatabaseURL), &gorm.Config{})
	if err != nil {
		return nil, err
	}

	return db, nil
}

func AutoMigrate(ctx context.Context, db *gorm.DB) error {
	if err := db.WithContext(ctx).Exec("CREATE EXTENSION IF NOT EXISTS vector").Error; err != nil {
		return err
	}

	for _, item := range autoMigrateModels() {
		if !db.WithContext(ctx).Migrator().HasTable(item) {
			if err := db.WithContext(ctx).Migrator().CreateTable(item); err != nil {
				return err
			}
		}
	}

	return nil
}

func autoMigrateModels() []any {
	return []any{
		&model.User{},
		&model.KnowledgeBase{},
		&model.KnowledgeBaseCategory{},
		&model.KnowledgeBaseMember{},
		&model.KnowledgeBaseFavorite{},
		&model.KnowledgeBaseViewEvent{},
		&model.Document{},
		&model.DocumentJob{},
		&model.DocumentChunk{},
		&model.ChatSession{},
		&model.ChatMessage{},
		&model.Activity{},
	}
}
