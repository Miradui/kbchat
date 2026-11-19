package database

import (
	"strings"
	"testing"
	"time"

	"gorm.io/gorm"
)

func TestPostgresTimestampMigration(t *testing.T) {
	db := newMigrationTestDB(t)
	// The historical input is the schema produced by 001-022, not today's model
	// list: later tables and timestamp-free snapshots did not exist at this point.
	applyTestMigrations(t, db, "022_user_avatars.sql")
	for _, statement := range []string{
		"CREATE TABLE rag_time_sentinel (created_at TIMESTAMP)",
		// Exercise an already-converted column alongside legacy columns.
		"ALTER TABLE users ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING updated_at AT TIME ZONE 'UTC'",
		"SET LOCAL TIME ZONE 'Asia/Shanghai'",
		`INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES
   ('00000000-0000-4000-8000-000000000001', 'first', 'fixture', TIMESTAMP '2026-09-13 16:14:15.123456', TIMESTAMPTZ '2026-09-14 00:14:15.123456+08'),
   ('00000000-0000-4000-8000-000000000002', 'second', 'fixture', NULL, NULL)`,
		`INSERT INTO knowledge_bases (id, name, owner_id) VALUES ('00000000-0000-4000-8000-000000000003', 'fixture', '00000000-0000-4000-8000-000000000001')`,
		`INSERT INTO documents (id, knowledge_base_id, uploader_id, filename, storage_path, created_at, deleted_at) VALUES
   ('00000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000001', 'fixture.txt', 'fixture.txt', TIMESTAMP '2026-09-13 16:14:15.123456', TIMESTAMP '2026-09-13 16:14:15.123456')`,
	} {
		if err := db.Exec(statement).Error; err != nil {
			t.Fatal(err)
		}
	}
	metadataBefore := timestampMigrationMetadata(t, db)
	ctx := db.Statement.Context
	if err := validateTimestampSchema(ctx, db); err == nil || !strings.Contains(err.Error(), "users.created_at") || !strings.Contains(err.Error(), "user_avatars.updated_at") {
		t.Fatalf("expected legacy schema rejection, got %v", err)
	}
	var clock struct{ Now time.Time }
	if err := db.Raw("SELECT CURRENT_TIMESTAMP AS now").Scan(&clock).Error; err != nil {
		t.Fatal(err)
	}
	want := time.Date(2026, 9, 13, 16, 14, 15, 123456000, time.UTC)
	for attempt := 1; attempt <= 2; attempt++ {
		executeTestMigration(t, db, "023_timestamps_with_time_zone.sql")
		if err := validateTimestampSchema(ctx, db); err != nil {
			t.Fatalf("migrated schema rejected: %v", err)
		}
		if after := timestampMigrationMetadata(t, db); after != metadataBefore {
			t.Fatalf("migration changed defaults, nullability, indexes or constraints: %#v -> %#v", metadataBefore, after)
		}
		var legacy []string
		if err := db.Raw("SELECT table_name FROM information_schema.columns WHERE table_schema = current_schema() AND data_type = 'timestamp without time zone' ORDER BY table_name").Scan(&legacy).Error; err != nil {
			t.Fatal(err)
		}
		if len(legacy) != 1 || legacy[0] != "rag_time_sentinel" {
			t.Fatalf("expected only unrelated table to retain timestamp, got %v", legacy)
		}
		type times struct{ CreatedAt, UpdatedAt, DeletedAt *time.Time }
		var first, second, document times
		if err := db.Raw("SELECT created_at, updated_at FROM users WHERE username = 'first'").Scan(&first).Error; err != nil {
			t.Fatal(err)
		}
		if err := db.Raw("SELECT created_at, updated_at FROM users WHERE username = 'second'").Scan(&second).Error; err != nil {
			t.Fatal(err)
		}
		if err := db.Raw("SELECT created_at, deleted_at FROM documents WHERE filename = 'fixture.txt'").Scan(&document).Error; err != nil {
			t.Fatal(err)
		}
		for name, actual := range map[string]*time.Time{"legacyCreated": first.CreatedAt, "alreadyZoned": first.UpdatedAt, "documentCreated": document.CreatedAt, "softDeleted": document.DeletedAt} {
			if actual == nil || !actual.Equal(want) {
				t.Fatalf("%s shifted: got %v, want %s", name, actual, want)
			}
		}
		if second.CreatedAt != nil || second.UpdatedAt != nil {
			t.Fatal("migration lost NULL timestamps")
		}
		if attempt == 1 {
			if err := db.Exec(`INSERT INTO users (id, username, password_hash) VALUES ('00000000-0000-4000-8000-000000000005', 'default-time', 'fixture')`).Error; err != nil {
				t.Fatal(err)
			}
		}
		var defaults times
		if err := db.Raw("SELECT created_at, updated_at FROM users WHERE username = 'default-time'").Scan(&defaults).Error; err != nil {
			t.Fatal(err)
		}
		if defaults.CreatedAt == nil || !defaults.CreatedAt.Equal(clock.Now) || defaults.UpdatedAt == nil || !defaults.UpdatedAt.Equal(clock.Now) {
			t.Fatalf("SQL defaults changed instant: %#v", defaults)
		}
	}
	t.Log(`{"timestampMigration":"passed","repeatApply":"passed","utcValues":"preserved","nulls":"preserved","schemaMetadata":"preserved"}`)
}

func timestampMigrationMetadata(t *testing.T, db *gorm.DB) (result struct{ Columns, Indexes, Constraints string }) {
	t.Helper()
	if err := db.Raw(`SELECT
  (SELECT md5(string_agg(table_name || column_name || is_nullable || COALESCE(column_default, ''), '' ORDER BY table_name, ordinal_position))
   FROM information_schema.columns WHERE table_schema = current_schema()) AS columns,
  (SELECT md5(string_agg(indexdef, '' ORDER BY tablename, indexname))
   FROM pg_catalog.pg_indexes WHERE schemaname = current_schema()) AS indexes,
  (SELECT md5(string_agg(conname || pg_get_constraintdef(oid), '' ORDER BY conrelid::regclass::text, conname))
   FROM pg_catalog.pg_constraint WHERE connamespace = current_schema()::regnamespace) AS constraints`).Scan(&result).Error; err != nil {
		t.Fatal(err)
	}
	return result
}
