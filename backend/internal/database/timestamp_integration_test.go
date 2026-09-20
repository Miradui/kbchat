package database

import (
	"context"
	"encoding/json"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	"kbchat/backend/internal/config"
)

type timestampProbe struct {
	ID          int            `json:"id"`
	CreatedAt   time.Time      `json:"createdAt"`
	UpdatedAt   time.Time      `json:"updatedAt"`
	ObservedAt  time.Time      `json:"observedAt"`
	DefaultAt   time.Time      `gorm:"default:CURRENT_TIMESTAMP" json:"defaultAt"`
	ScheduledAt *time.Time     `json:"scheduledAt"`
	DeletedAt   gorm.DeletedAt `json:"-"`
}

// Only temporary tables are written. No migration, existing table, or worker is
// involved; each transaction drops its temporary table before returning.
func TestPostgresCurrentTimestamps(t *testing.T) {
	dsn := strings.TrimSpace(os.Getenv("RAG_TEST_POSTGRES_DSN"))
	if dsn == "" {
		t.Skip("set RAG_TEST_POSTGRES_DSN to run PostgreSQL timestamp regression checks")
	}
	for _, mode := range []string{"cache_statement", "exec", "simple_protocol"} {
		t.Run(mode, func(t *testing.T) {
			testDSN := timestampTestDSN(t, dsn, mode)
			db, err := Open(config.Config{DatabaseURL: testDSN})
			if err != nil {
				t.Fatalf("open PostgreSQL connection failed (%T)", err)
			}
			sqlDB, err := db.DB()
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = sqlDB.Close() })
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			db = db.WithContext(ctx).Session(&gorm.Session{Logger: logger.Default.LogMode(logger.Silent)})
			started := time.Now().UTC()
			if err := db.Transaction(func(tx *gorm.DB) error {
				var zone string
				if err := tx.Raw("SHOW timezone").Scan(&zone).Error; err != nil {
					return err
				}
				if zone != "UTC" {
					t.Fatalf("database session uses %q instead of UTC", zone)
				}
				var clock struct{ Now time.Time }
				if err := tx.Raw("SELECT CURRENT_TIMESTAMP AS now").Scan(&clock).Error; err != nil {
					return err
				}
				if err := tx.Exec(`CREATE TEMP TABLE rag_timestamp_probe (
					id BIGINT PRIMARY KEY,
					created_at TIMESTAMPTZ NOT NULL,
					updated_at TIMESTAMPTZ NOT NULL,
					observed_at TIMESTAMPTZ NOT NULL,
					default_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
					scheduled_at TIMESTAMPTZ NULL,
					deleted_at TIMESTAMPTZ NULL
				) ON COMMIT DROP`).Error; err != nil {
					return err
				}
				const table = "pg_temp.rag_timestamp_probe"
				zones := []*time.Location{time.UTC, time.FixedZone("UTC+8", 8*3600), time.FixedZone("UTC-7", -7*3600)}
				for i, zone := range zones {
					input := time.Now().In(zone).Truncate(time.Microsecond)
					created := timestampProbe{ID: i + 1, CreatedAt: input, UpdatedAt: input, ObservedAt: input}
					if err := tx.Table(table).Create(&created).Error; err != nil {
						return err
					}
					var stored timestampProbe
					if err := tx.Table(table).First(&stored, created.ID).Error; err != nil {
						return err
					}
					for name, actual := range map[string]time.Time{"createdAt": stored.CreatedAt, "updatedAt": stored.UpdatedAt, "observedAt": stored.ObservedAt} {
						if !actual.Equal(input) {
							t.Fatalf("%s shifted after create/reload from %s to %s", name, input, actual)
						}
					}
					// Compare the SQL default against the same database clock;
					// the application and database hosts need not have identical clocks.
					if !stored.DefaultAt.Equal(clock.Now) {
						t.Fatalf("SQL default was shifted from %s to %s", clock.Now, stored.DefaultAt)
					}
					// A predicate and an explicit update can supply different offsets.
					next := input.Add(time.Minute).In(zones[(i+1)%len(zones)])
					updated := tx.Table(table).Model(&timestampProbe{}).
						Where("id = ? AND updated_at = ?", created.ID, input).
						Updates(map[string]any{"updated_at": next, "scheduled_at": next})
					if updated.Error != nil {
						return updated.Error
					}
					if updated.RowsAffected != 1 {
						t.Fatal("equivalent timestamp did not match the optimistic update predicate")
					}
					if err := tx.Table(table).First(&stored, created.ID).Error; err != nil {
						return err
					}
					if !stored.CreatedAt.Equal(input) || !stored.UpdatedAt.Equal(next) || stored.ScheduledAt == nil || !stored.ScheduledAt.Equal(next) {
						t.Fatalf("explicit update shifted a timestamp: %#v", stored)
					}
					var count int64
					if err := tx.Table(table).Where("id = ? AND scheduled_at > ? AND scheduled_at <= ?", created.ID, input, next.In(zone)).Count(&count).Error; err != nil {
						return err
					}
					if count != 1 {
						t.Fatal("time-window query did not find the scheduled record")
					}
					payload, err := json.Marshal(stored)
					if err != nil {
						return err
					}
					var api struct{ CreatedAt, UpdatedAt time.Time }
					if err := json.Unmarshal(payload, &api); err != nil {
						return err
					}
					if !api.CreatedAt.Equal(input) || !api.UpdatedAt.Equal(next) {
						t.Fatal("JSON serialization changed the represented instant")
					}
				}
				// GORM-generated create/update/delete times must follow the same rule.
				automatic := timestampProbe{ID: 100, ObservedAt: time.Now()}
				if err := tx.Table(table).Create(&automatic).Error; err != nil {
					return err
				}
				var reloaded timestampProbe
				if err := tx.Table(table).First(&reloaded, automatic.ID).Error; err != nil {
					return err
				}
				if automatic.CreatedAt.Location() != time.UTC || !automatic.CreatedAt.Equal(reloaded.CreatedAt) || !automatic.UpdatedAt.Equal(reloaded.UpdatedAt) {
					t.Fatal("GORM automatic timestamps changed after reload")
				}
				if err := tx.Table(table).Delete(&automatic).Error; err != nil {
					return err
				}
				if err := tx.Table(table).Unscoped().First(&reloaded, automatic.ID).Error; err != nil {
					return err
				}
				if !reloaded.DeletedAt.Valid || reloaded.DeletedAt.Time.Before(started.Add(-time.Second)) || reloaded.DeletedAt.Time.After(time.Now().Add(time.Second)) {
					t.Fatalf("soft-delete time was shifted: %#v", reloaded.DeletedAt)
				}
				return nil
			}); err != nil {
				t.Fatalf("temporary-table timestamp check: %v", err)
			}
		})
	}
}

func timestampTestDSN(t *testing.T, dsn, mode string) string {
	t.Helper()
	if strings.Contains(dsn, "://") {
		parsed, err := url.Parse(dsn)
		if err != nil {
			t.Fatal("invalid PostgreSQL test URL")
		}
		query := parsed.Query()
		query.Set("default_query_exec_mode", mode)
		query.Set("timezone", "Asia/Shanghai")
		parsed.RawQuery = query.Encode()
		return parsed.String()
	}
	return dsn + " default_query_exec_mode=" + mode + " timezone=Asia/Shanghai"
}
