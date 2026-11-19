package database

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	"kbchat/backend/internal/config"
)

// This executes the SQL shipped to operators and then the same assertion used
// by server, seed and reindex-keywords. SQLite model creation cannot exercise it.
func TestPostgresMigrationsSatisfyStartupSchema(t *testing.T) {
	db := newMigrationTestDB(t)
	applyTestMigrations(t, db, "")
	ctx := db.Statement.Context
	if err := EnsureSchema(ctx, db); err != nil {
		t.Fatalf("fully migrated database rejected at startup: %v", err)
	}
	if err := db.Exec("ALTER TABLE document_jobs DROP COLUMN traceparent").Error; err != nil {
		t.Fatal(err)
	}
	if err := EnsureSchema(ctx, db); err == nil || !strings.Contains(err.Error(), "049_document_job_traceparent.sql") {
		t.Fatalf("expected missing trace context to reject startup, got %v", err)
	}
	executeTestMigration(t, db, "049_document_job_traceparent.sql")
	executeTestMigration(t, db, "049_document_job_traceparent.sql")
	if err := EnsureSchema(ctx, db); err != nil {
		t.Fatalf("repeated trace context migration rejected: %v", err)
	}
	// An old intent constraint must still fail before any model call can occur.
	executeTestMigration(t, db, "018_chat_message_intent_and_retrieval_query.sql")
	if err := EnsureSchema(ctx, db); err == nil || !strings.Contains(err.Error(), "048_chat_message_general_intent.sql") {
		t.Fatalf("expected stale intent constraint to reject startup, got %v", err)
	}
	executeTestMigration(t, db, "048_chat_message_general_intent.sql")
	if err := EnsureSchema(ctx, db); err != nil {
		t.Fatalf("restored migration rejected: %v", err)
	}
	if err := db.Exec("ALTER TABLE documents DROP CONSTRAINT documents_status_check").Error; err != nil {
		t.Fatal(err)
	}
	if err := EnsureSchema(ctx, db); err == nil || !strings.Contains(err.Error(), "documents_status_check") {
		t.Fatalf("expected missing status constraint to reject startup, got %v", err)
	}
	t.Log(`{"fullMigrationStartup":"passed","staleIntentRejected":true,"missingStatusConstraintRejected":true}`)
}

// All DDL and data live in a randomly named schema inside one transaction. Even
// a terminated test connection rolls it back. The explicit DSN must identify an
// authorized test database; CI supplies a disposable PostgreSQL service.
func newMigrationTestDB(t *testing.T) *gorm.DB {
	t.Helper()
	dsn := strings.TrimSpace(os.Getenv("RAG_TEST_POSTGRES_DSN"))
	if dsn == "" {
		t.Skip("set RAG_TEST_POSTGRES_DSN to run isolated SQL migration checks")
	}
	db, err := Open(config.Config{DatabaseURL: dsn})
	if err != nil {
		t.Fatalf("open PostgreSQL test connection failed (%T)", err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	t.Cleanup(cancel)
	tx := db.WithContext(ctx).Session(&gorm.Session{Logger: logger.Default.LogMode(logger.Silent)}).Begin()
	if tx.Error != nil {
		t.Fatal(tx.Error)
	}
	t.Cleanup(func() { _ = tx.WithContext(context.Background()).Rollback().Error })
	name := fmt.Sprintf("rag_it_%s_%s", time.Now().UTC().Format("20060102t150405"), strings.ReplaceAll(uuid.NewString(), "-", "")[:8])
	quoted := pgx.Identifier{name}.Sanitize()
	for _, statement := range []string{
		"SET LOCAL lock_timeout = '5s'",
		"SET LOCAL statement_timeout = '60s'",
		"CREATE SCHEMA " + quoted,
		// public resolves an already-installed vector extension. Every application
		// table is created in the isolated schema before its first write.
		"SET LOCAL search_path = " + quoted + ", public",
	} {
		if err := tx.Exec(statement).Error; err != nil {
			t.Fatal(err)
		}
	}
	return tx
}

func applyTestMigrations(t *testing.T, db *gorm.DB, last string) {
	t.Helper()
	files, err := filepath.Glob("../../migrations/*.sql")
	if err != nil {
		t.Fatal(err)
	}
	sort.Strings(files)
	if len(files) == 0 {
		t.Fatal("no SQL migrations found")
	}
	for _, file := range files {
		name := filepath.Base(file)
		executeTestMigration(t, db, name)
		if name == last {
			return
		}
	}
	if last != "" {
		t.Fatalf("migration boundary %s was not found", last)
	}
}

func executeTestMigration(t *testing.T, db *gorm.DB, name string) {
	t.Helper()
	content, err := os.ReadFile(filepath.Join("../../migrations", name))
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Exec(string(content)).Error; err != nil {
		t.Fatalf("migration %s failed: %v", name, err)
	}
}
