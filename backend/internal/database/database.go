package database

import (
	"context"
	"fmt"
	"strings"

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

	return validateSchema(ctx, db)
}

func validateSchema(ctx context.Context, db *gorm.DB) error {
	migrator := db.WithContext(ctx).Migrator()
	if !migrator.HasColumn(&model.DocumentJob{}, "progress") {
		return fmt.Errorf(
			"database schema incompatible: document_jobs missing progress; apply migration 016 (migrations/016_document_job_progress.sql)",
		)
	}
	requiredColumns := []string{"feedback_rating", "feedback_updated_at"}
	missing := make([]string, 0, len(requiredColumns))
	for _, column := range requiredColumns {
		if !migrator.HasColumn(&model.ChatMessage{}, column) {
			missing = append(missing, column)
		}
	}
	if len(missing) > 0 {
		return fmt.Errorf(
			"database schema incompatible: chat_messages missing %s; apply migration 014 (migrations/014_chat_message_feedback.sql)",
			strings.Join(missing, ", "),
		)
	}
	cleanupColumns := []string{"storage_path", "retry_count", "next_attempt_at", "locked_at", "lease_token", "last_error", "created_at", "updated_at"}
	missing = missing[:0]
	for _, column := range cleanupColumns {
		if !migrator.HasColumn(&model.StorageCleanupJob{}, column) {
			missing = append(missing, column)
		}
	}
	requiredIndexes := []string{
		"idx_storage_cleanup_jobs_storage_path",
		"idx_storage_cleanup_jobs_next_attempt_at",
		"idx_storage_cleanup_jobs_locked_at",
		"idx_storage_cleanup_jobs_lease_token",
	}
	missingIndexes := make([]string, 0, len(requiredIndexes))
	for _, index := range requiredIndexes {
		if !migrator.HasIndex(&model.StorageCleanupJob{}, index) {
			missingIndexes = append(missingIndexes, index)
		}
	}
	if len(missing) > 0 || len(missingIndexes) > 0 {
		return fmt.Errorf(
			"database schema incompatible: storage_cleanup_jobs missing columns [%s] or indexes [%s]; apply migration 015 (migrations/015_storage_cleanup_jobs.sql)",
			strings.Join(missing, ", "),
			strings.Join(missingIndexes, ", "),
		)
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
		&model.StorageCleanupJob{},
		&model.DocumentChunk{},
		&model.ChatSession{},
		&model.ChatMessage{},
		&model.Activity{},
	}
}
