package repository

import (
	"context"
	"errors"
	"net/url"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"gorm.io/gorm/logger"
)

// TestPostgresRecycleBinRestoreLosesToPermanentDelete is intentionally skipped
// unless an isolated test server is supplied. It verifies real row-lock waiting
// with two independent pools; the SQLite clause-order tests cannot do that.
func TestPostgresRecycleBinRestoreLosesToPermanentDelete(t *testing.T) {
	db1, db2 := newPostgresConcurrencyTestDBs(t)
	ctx := context.Background()

	t.Run("document", func(t *testing.T) {
		ownerID, kbID, documentID := uuid.New(), uuid.New(), uuid.New()
		insertPostgresRecycleFixture(t, db1, ownerID, kbID)
		if err := db1.Exec(`INSERT INTO documents
			(id, knowledge_base_id, uploader_id, filename, storage_path, status, created_at, updated_at, deleted_at)
			VALUES (?, ?, ?, 'manual.pdf', 'manual.pdf', 'completed', now(), now(), now())`,
			documentID, kbID, ownerID).Error; err != nil {
			t.Fatalf("insert deleted document: %v", err)
		}

		assertPostgresRestoreWaitsAndLoses(
			t,
			db1,
			"documents",
			func() error { return NewDocumentRepository(db1).PermanentDelete(ctx, documentID) },
			func() error { return NewDocumentRepository(db2).Restore(ctx, documentID) },
			ErrDocumentNotDeleted,
		)
	})

	t.Run("knowledge base", func(t *testing.T) {
		ownerID, kbID := uuid.New(), uuid.New()
		insertPostgresRecycleFixture(t, db1, ownerID, kbID)
		if err := db1.Exec("UPDATE knowledge_bases SET deleted_at = now() WHERE id = ?", kbID).Error; err != nil {
			t.Fatalf("soft delete knowledge base: %v", err)
		}

		assertPostgresRestoreWaitsAndLoses(
			t,
			db1,
			"knowledge_bases",
			func() error { return NewKnowledgeBaseRepository(db1).PermanentDelete(ctx, kbID) },
			func() error { return NewKnowledgeBaseRepository(db2).Restore(ctx, kbID) },
			ErrKnowledgeBaseNotDeleted,
		)
	})

	t.Run("chat session", func(t *testing.T) {
		ownerID, kbID, sessionID := uuid.New(), uuid.New(), uuid.New()
		insertPostgresRecycleFixture(t, db1, ownerID, kbID)
		if err := db1.Exec(`INSERT INTO chat_sessions
			(id, user_id, knowledge_base_id, title, created_at, updated_at, deleted_at)
			VALUES (?, ?, ?, 'deleted session', now(), now(), now())`, sessionID, ownerID, kbID).Error; err != nil {
			t.Fatalf("insert deleted session: %v", err)
		}

		assertPostgresRestoreWaitsAndLoses(
			t,
			db1,
			"chat_sessions",
			func() error { return NewChatRepository(db1).PermanentDeleteSession(ctx, sessionID) },
			func() error { return NewChatRepository(db2).RestoreSession(ctx, sessionID) },
			ErrChatSessionNotDeleted,
		)
	})
}

func assertPostgresRestoreWaitsAndLoses(
	t *testing.T,
	db *gorm.DB,
	table string,
	permanentDelete func() error,
	restore func() error,
	wantRestoreError error,
) {
	t.Helper()
	locked := make(chan struct{})
	release := make(chan struct{})
	var paused atomic.Bool
	callbackName := "test:pause-postgres-lock-" + uuid.NewString()
	if err := db.Callback().Query().After("gorm:query").Register(callbackName, func(tx *gorm.DB) {
		lockingClause, ok := tx.Statement.Clauses["FOR"]
		if !ok || tx.Statement.Table != table {
			return
		}
		locking, ok := lockingClause.Expression.(clause.Locking)
		if !ok || locking.Strength != "UPDATE" || !paused.CompareAndSwap(false, true) {
			return
		}
		close(locked)
		<-release
	}); err != nil {
		t.Fatalf("register lock pause callback: %v", err)
	}
	t.Cleanup(func() { _ = db.Callback().Query().Remove(callbackName) })

	deleteDone := make(chan error, 1)
	go func() { deleteDone <- permanentDelete() }()
	select {
	case <-locked:
	case <-time.After(5 * time.Second):
		t.Fatal("permanent delete did not acquire the expected row lock")
	}

	restoreDone := make(chan error, 1)
	go func() { restoreDone <- restore() }()
	select {
	case err := <-restoreDone:
		t.Fatalf("restore returned before the permanent-delete lock was released: %v", err)
	case <-time.After(150 * time.Millisecond):
	}
	close(release)
	if err := <-deleteDone; err != nil {
		t.Fatalf("permanent delete: %v", err)
	}
	if err := <-restoreDone; !errors.Is(err, wantRestoreError) {
		t.Fatalf("expected restore loser error %v, got %v", wantRestoreError, err)
	}
}

func newPostgresConcurrencyTestDBs(t *testing.T) (*gorm.DB, *gorm.DB) {
	t.Helper()
	dsn := strings.TrimSpace(os.Getenv("RAG_TEST_POSTGRES_DSN"))
	if dsn == "" {
		t.Skip("set RAG_TEST_POSTGRES_DSN to run PostgreSQL row-lock integration tests")
	}
	base, err := gorm.Open(postgres.Open(dsn), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatalf("open PostgreSQL test database: %v", err)
	}
	schema := "rag_it_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	if err := base.Exec(`CREATE SCHEMA "` + schema + `"`).Error; err != nil {
		t.Fatalf("create isolated schema: %v", err)
	}
	t.Cleanup(func() { _ = base.Exec(`DROP SCHEMA IF EXISTS "` + schema + `" CASCADE`).Error })

	scopedDSN, err := postgresDSNWithSearchPath(dsn, schema)
	if err != nil {
		t.Fatalf("scope PostgreSQL DSN: %v", err)
	}
	open := func() *gorm.DB {
		db, openErr := gorm.Open(postgres.Open(scopedDSN), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
		if openErr != nil {
			t.Fatalf("open scoped PostgreSQL connection: %v", openErr)
		}
		sqlDB, openErr := db.DB()
		if openErr != nil {
			t.Fatalf("get scoped SQL database: %v", openErr)
		}
		sqlDB.SetMaxOpenConns(1)
		t.Cleanup(func() { _ = sqlDB.Close() })
		return db
	}
	db1, db2 := open(), open()
	createPostgresConcurrencyTables(t, db1)
	return db1, db2
}

func postgresDSNWithSearchPath(dsn, schema string) (string, error) {
	if strings.Contains(dsn, "://") {
		parsed, err := url.Parse(dsn)
		if err != nil {
			return "", err
		}
		query := parsed.Query()
		query.Set("search_path", schema)
		parsed.RawQuery = query.Encode()
		return parsed.String(), nil
	}
	return strings.TrimSpace(dsn) + " search_path=" + schema, nil
}

func createPostgresConcurrencyTables(t *testing.T, db *gorm.DB) {
	t.Helper()
	statements := []string{
		`CREATE TABLE users (id UUID PRIMARY KEY, username TEXT, password_hash TEXT)`,
		`CREATE TABLE knowledge_bases (id UUID PRIMARY KEY, owner_id UUID, name TEXT, deleted_at TIMESTAMPTZ)`,
		`CREATE TABLE documents (id UUID PRIMARY KEY, knowledge_base_id UUID, uploader_id UUID, filename TEXT, storage_path TEXT, status TEXT, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ, deleted_at TIMESTAMPTZ)`,
		`CREATE TABLE document_jobs (id UUID PRIMARY KEY, document_id UUID, job_type TEXT, status TEXT)`,
		`CREATE TABLE document_chunks (id UUID PRIMARY KEY, document_id UUID, knowledge_base_id UUID)`,
		`CREATE TABLE chat_sessions (id UUID PRIMARY KEY, user_id UUID, knowledge_base_id UUID, title TEXT, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ, deleted_at TIMESTAMPTZ)`,
		`CREATE TABLE chat_messages (id UUID PRIMARY KEY, session_id UUID, role TEXT, content TEXT)`,
		`CREATE TABLE knowledge_base_members (knowledge_base_id UUID, user_id UUID)`,
		`CREATE TABLE knowledge_base_favorites (knowledge_base_id UUID, user_id UUID)`,
		`CREATE TABLE knowledge_base_view_events (id UUID, knowledge_base_id UUID, user_id UUID)`,
		`CREATE TABLE knowledge_base_tag_bindings (knowledge_base_id UUID, tag_id UUID)`,
	}
	for _, statement := range statements {
		if err := db.Exec(statement).Error; err != nil {
			t.Fatalf("create integration table with %q: %v", statement, err)
		}
	}
}

func insertPostgresRecycleFixture(t *testing.T, db *gorm.DB, ownerID, kbID uuid.UUID) {
	t.Helper()
	if err := db.Exec("INSERT INTO users (id, username, password_hash) VALUES (?, ?, 'hash')", ownerID, "user-"+ownerID.String()).Error; err != nil {
		t.Fatalf("insert owner: %v", err)
	}
	if err := db.Exec("INSERT INTO knowledge_bases (id, owner_id, name) VALUES (?, ?, ?)", kbID, ownerID, "kb-"+kbID.String()).Error; err != nil {
		t.Fatalf("insert knowledge base: %v", err)
	}
}
