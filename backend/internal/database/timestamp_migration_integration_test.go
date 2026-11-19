package database

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
	"gorm.io/gorm/schema"

	"kbchat/backend/internal/config"
)

type timestampMigrationFixture struct {
	table   string
	columns []string
}

// The migration runs only against transaction-local temporary tables. Removing
// public from search_path prevents any fixture from falling through to real data.
func TestPostgresTimestampMigration(t *testing.T) {
	dsn := strings.TrimSpace(os.Getenv("RAG_TEST_POSTGRES_DSN"))
	if dsn == "" {
		t.Skip("set RAG_TEST_POSTGRES_DSN to run the isolated timestamp migration check")
	}
	db, err := Open(config.Config{DatabaseURL: timestampTestDSN(t, dsn, "cache_statement")})
	if err != nil {
		t.Fatalf("open PostgreSQL connection failed (%T)", err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	t.Cleanup(cancel)
	tx := db.WithContext(ctx).Session(&gorm.Session{Logger: logger.Default.LogMode(logger.Silent)}).Begin()
	if tx.Error != nil {
		t.Fatal(tx.Error)
	}
	t.Cleanup(func() { _ = tx.Rollback().Error })
	migration, err := os.ReadFile("../../migrations/023_timestamps_with_time_zone.sql")
	if err != nil {
		t.Fatal(err)
	}
	for _, query := range []string{
		"CREATE TEMP TABLE rag_time_sentinel (created_at TIMESTAMP) ON COMMIT DROP",
		"SET LOCAL search_path = pg_temp, pg_catalog",
		"SET LOCAL TIME ZONE 'Asia/Shanghai'",
	} {
		if err := tx.Exec(query).Error; err != nil {
			t.Fatal(err)
		}
	}
	var clock struct{ Now time.Time }
	if err := tx.Raw("SELECT CURRENT_TIMESTAMP AS now").Scan(&clock).Error; err != nil {
		t.Fatal(err)
	}

	want := time.Date(2026, 9, 13, 16, 14, 15, 123456000, time.UTC)
	// These tables were introduced after 023 with TIMESTAMPTZ columns. They
	// are current-schema coverage, not synthetic pre-023 upgrade inputs.
	zonedTables := map[string]bool{
		"model_usage_records": true, "document_upload_receipts": true,
		"chat_bookmarks": true, "question_templates": true, "chat_quality_issues": true,
	}
	var fixtures []timestampMigrationFixture
	for _, item := range timestampSchemaModels() {
		statement := &gorm.Statement{DB: tx}
		if err := statement.Parse(item); err != nil {
			t.Fatal(err)
		}
		fixture := timestampMigrationFixture{table: statement.Schema.Table}
		definitions := []string{"probe_id INTEGER PRIMARY KEY CHECK (probe_id > 0)"}
		firstValues, secondValues := []string{"1"}, []string{"2"}
		for _, field := range statement.Schema.Fields {
			if field.DataType != schema.Time {
				continue
			}
			fixture.columns = append(fixture.columns, field.DBName)
			columnType := "TIMESTAMP"
			value := "TIMESTAMP '2026-09-13 16:14:15.123456'"
			if zonedTables[fixture.table] || strings.HasPrefix(fixture.table, "evaluation_") || fixture.table == "activities" ||
				(fixture.table == "users" && field.DBName == "updated_at") || field.DBName == "superseded_at" {
				columnType = "TIMESTAMPTZ"
				value = "TIMESTAMPTZ '2026-09-14 00:14:15.123456+08'"
			}
			nullableValue := "NULL"
			if fixture.table == "users" && field.DBName == "created_at" {
				columnType += " NOT NULL"
				nullableValue = value
			}
			definitions = append(definitions, pgx.Identifier{field.DBName}.Sanitize()+" "+columnType+" DEFAULT CURRENT_TIMESTAMP")
			firstValues = append(firstValues, value)
			secondValues = append(secondValues, nullableValue)
		}
		if len(fixture.columns) == 0 {
			continue
		}
		table := pgx.Identifier{"pg_temp", fixture.table}.Sanitize()
		if err := tx.Exec("CREATE TEMP TABLE " + table + " (" + strings.Join(definitions, ", ") + ") ON COMMIT DROP").Error; err != nil {
			t.Fatal(err)
		}
		if err := tx.Exec("INSERT INTO " + table + " VALUES (" + strings.Join(firstValues, ", ") + "), (" + strings.Join(secondValues, ", ") + ")").Error; err != nil {
			t.Fatal(err)
		}
		fixtures = append(fixtures, fixture)
	}
	if len(fixtures) == 0 {
		t.Fatal("timestamp migration fixture must cover application time columns")
	}
	for _, query := range []string{
		"CREATE INDEX rag_time_created_idx ON pg_temp.users (created_at DESC)",
		"CREATE INDEX rag_time_deleted_idx ON pg_temp.documents (deleted_at) WHERE deleted_at IS NOT NULL",
		"ALTER TABLE pg_temp.documents ADD FOREIGN KEY (probe_id) REFERENCES pg_temp.users (probe_id)",
	} {
		if err := tx.Exec(query).Error; err != nil {
			t.Fatal(err)
		}
	}
	metadataBefore := timestampMigrationMetadata(t, tx)
	if err := validateTimestampSchema(ctx, tx); err == nil || !strings.Contains(err.Error(), "migration 023") ||
		!strings.Contains(err.Error(), "users.created_at") || !strings.Contains(err.Error(), "user_avatars.updated_at") {
		t.Fatalf("expected startup to reject legacy application columns, got %v", err)
	}

	for attempt := 1; attempt <= 2; attempt++ {
		if err := tx.Exec(string(migration)).Error; err != nil {
			t.Fatalf("migration attempt %d: %v", attempt, err)
		}
		if err := validateTimestampSchema(ctx, tx); err != nil {
			t.Fatalf("migrated schema rejected: %v", err)
		}
		if after := timestampMigrationMetadata(t, tx); after != metadataBefore {
			t.Fatalf("migration changed defaults, nullability, indexes or constraints: %#v -> %#v", metadataBefore, after)
		}
		var legacy []string
		if err := tx.Raw("SELECT table_name FROM information_schema.columns WHERE table_schema = current_schema() AND data_type = 'timestamp without time zone'").Scan(&legacy).Error; err != nil {
			t.Fatal(err)
		}
		if len(legacy) != 1 || legacy[0] != "rag_time_sentinel" {
			t.Fatalf("expected only the unrelated table to keep timestamp, got %v", legacy)
		}
		for _, fixture := range fixtures {
			if attempt == 1 {
				if err := tx.Exec("INSERT INTO " + pgx.Identifier{"pg_temp", fixture.table}.Sanitize() + " (probe_id) VALUES (3)").Error; err != nil {
					t.Fatal(err)
				}
			}
			assertMigratedTimes(t, tx, fixture, want, clock.Now)
		}
	}
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

func assertMigratedTimes(t *testing.T, db *gorm.DB, fixture timestampMigrationFixture, want, databaseNow time.Time) {
	t.Helper()
	columns := []string{"probe_id"}
	for _, column := range fixture.columns {
		columns = append(columns, pgx.Identifier{column}.Sanitize())
	}
	rows, err := db.Raw("SELECT " + strings.Join(columns, ", ") + " FROM " + pgx.Identifier{"pg_temp", fixture.table}.Sanitize() + " ORDER BY probe_id").Rows()
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	count := 0
	for rows.Next() {
		var id int
		values := make([]sql.NullTime, len(fixture.columns))
		destinations := []any{&id}
		for i := range values {
			destinations = append(destinations, &values[i])
		}
		if err := rows.Scan(destinations...); err != nil {
			t.Fatal(err)
		}
		for i, value := range values {
			field := fmt.Sprintf("%s[%d].%s", fixture.table, id, fixture.columns[i])
			if id == 2 && !(fixture.table == "users" && fixture.columns[i] == "created_at") {
				if value.Valid {
					t.Errorf("%s lost NULL", field)
				}
				continue
			}
			expected := want
			if id == 3 {
				expected = databaseNow
			}
			if !value.Valid || !value.Time.Equal(expected) {
				t.Errorf("%s shifted: got %s, want %s", field, value.Time, expected)
			}
		}
		count++
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if count != 3 {
		t.Fatalf("%s: expected 3 rows, got %d", fixture.table, count)
	}
}
