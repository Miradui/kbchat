package database

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"

	"kbchat/backend/internal/config"
	"kbchat/backend/internal/model"
)

func Open(cfg config.Config) (*gorm.DB, error) {
	if cfg.DatabaseURL == "" {
		return nil, fmt.Errorf("DATABASE_URL is required")
	}

	connConfig, err := postgresConnectionConfig(cfg.DatabaseURL)
	if err != nil {
		return nil, err
	}
	sqlDB := stdlib.OpenDB(*connConfig)
	db, err := gorm.Open(postgres.New(postgres.Config{Conn: sqlDB}), &gorm.Config{
		NowFunc: func() time.Time { return time.Now().UTC().Truncate(time.Microsecond) },
	})
	if err != nil {
		_ = sqlDB.Close()
		return nil, err
	}

	return db, nil
}

func postgresConnectionConfig(dsn string) (*pgx.ConnConfig, error) {
	cfg, err := pgx.ParseConfig(dsn)
	if err != nil {
		return nil, err
	}
	// SQL defaults and casts must use the same UTC convention as bound times.
	// PostgreSQL accepts differently cased names; retain only one timezone key.
	for key := range cfg.RuntimeParams {
		if strings.EqualFold(key, "timezone") {
			delete(cfg.RuntimeParams, key)
		}
	}
	cfg.RuntimeParams["timezone"] = "UTC"
	return cfg, nil
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
	if !migrator.HasColumn(&model.ChatMessage{}, "feedback_reason") || !migrator.HasColumn(&model.ChatMessage{}, "feedback_comment") {
		return fmt.Errorf("database schema incompatible: chat_messages missing feedback_reason/feedback_comment; apply migration 021 (migrations/021_quality_evaluations.sql)")
	}
	if db.Dialector.Name() == "postgres" {
		for _, required := range []struct {
			model     any
			column    string
			migration string
		}{
			{&model.DocumentChunk{}, "search_vector", "024_hybrid_search.sql"},
			{&model.User{}, "status", "025_user_status_and_admin.sql"},
			{&model.User{}, "created_by", "025_user_status_and_admin.sql"},
			{&model.KnowledgeBase{}, "answer_config", "027_kb_answer_config.sql"},
			{&model.EvaluationRun{}, "answer_config", "028_evaluation_answer_config.sql"},
			{&model.Document{}, "embedding_model", "029_document_embedding_identity.sql"},
			{&model.Document{}, "embedding_dimension", "029_document_embedding_identity.sql"},
			{&model.Document{}, "pdf_text_summary", "032_document_pdf_text_summary.sql"},
			{&model.Document{}, "source_path", "038_document_source_path.sql"},
			{&model.Document{}, "table_import", "041_document_table_import.sql"},
			{&model.DocumentUploadReceipt{}, "fingerprint", "040_document_upload_receipts.sql"},
			{&model.ChatSession{}, "scope_mode", "031_chat_automatic_scope.sql"},
			{&model.ChatSession{}, "branch_from_session_id", "036_chat_branches.sql"},
			{&model.ChatSession{}, "branch_from_message_id", "036_chat_branches.sql"},
			{&model.ChatSession{}, "branch_request_id", "036_chat_branches.sql"},
			{&model.ChatBookmark{}, "message_id", "034_chat_bookmarks.sql"},
			{&model.ChatBookmark{}, "user_id", "034_chat_bookmarks.sql"},
			{&model.ChatBookmark{}, "note", "034_chat_bookmarks.sql"},
			{&model.QuestionTemplate{}, "title", "037_question_templates.sql"},
			{&model.QuestionTemplate{}, "body", "037_question_templates.sql"},
			{&model.QuestionTemplate{}, "user_id", "037_question_templates.sql"},
		} {
			if !migrator.HasColumn(required.model, required.column) {
				return fmt.Errorf("database schema incompatible: missing %s; apply migration %s", required.column, required.migration)
			}
		}
		if !migrator.HasTable(&model.ChatSessionKnowledgeBase{}) {
			return fmt.Errorf("database schema incompatible: missing chat_session_knowledge_bases; apply migration 030_chat_session_knowledge_bases.sql")
		}
		if !migrator.HasTable(&model.ModelUsageRecord{}) {
			return fmt.Errorf("database schema incompatible: missing model_usage_records; apply migration 026_model_usage_records.sql")
		}
		if !migrator.HasTable(&model.ChatBookmark{}) {
			return fmt.Errorf("database schema incompatible: missing chat_bookmarks; apply migration 034_chat_bookmarks.sql")
		}
		var errorConstraint string
		if err := db.WithContext(ctx).Raw(`SELECT pg_get_constraintdef(oid) FROM pg_constraint
			WHERE conrelid = 'documents'::regclass AND conname = 'documents_error_code_check' AND contype = 'c'`).Scan(&errorConstraint).Error; err != nil {
			return fmt.Errorf("check document error constraint: %w", err)
		}
		if !strings.Contains(errorConstraint, "'table_limit_exceeded'") {
			return fmt.Errorf("database schema incompatible: documents_error_code_check missing table_limit_exceeded; apply migration 039_table_error_code.sql")
		}
		if !strings.Contains(errorConstraint, "'table_import_invalid'") {
			return fmt.Errorf("database schema incompatible: missing table_import_invalid; apply migration 041_document_table_import.sql")
		}
	}
	return validateTimestampSchema(ctx, db)
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
		&model.DocumentUploadReceipt{},
		&model.DocumentJob{},
		&model.StorageCleanupJob{},
		&model.DocumentChunk{},
		&model.ChatSession{},
		&model.ChatSessionKnowledgeBase{},
		&model.ChatMessage{},
		&model.ChatBookmark{},
		&model.QuestionTemplate{},
		&model.EvaluationCase{},
		&model.EvaluationRun{},
		&model.Activity{},
	}
}
