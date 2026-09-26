package repository

import (
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
)

// PostgreSQL integration tests each work in their own schema. A test that hangs
// is killed by go test's timeout without running t.Cleanup, which left
// rag_it_* schemas behind in the shared database; the timestamp in the name
// lets later runs recognise and drop them, and the statement and lock timeouts
// turn a hang into a failure that reports where it waited.
const (
	postgresTestSchemaPrefix = "rag_it_"
	staleTestSchemaAge       = 24 * time.Hour
	postgresTestLockTimeout  = "5s"
	postgresTestStmtTimeout  = "60s"
)

var postgresTestSchemaPattern = regexp.MustCompile(`^rag_it_(\d{8}t\d{6})_[0-9a-f]{8}$`)

func postgresTestSchemaName(now time.Time) string {
	return fmt.Sprintf("%s%s_%s", postgresTestSchemaPrefix, now.UTC().Format("20060102t150405"), strings.ReplaceAll(uuid.NewString(), "-", "")[:8])
}

// staleTestSchema reports whether name is a timestamped test schema older
// than staleTestSchemaAge. Names in any other format are never touched.
func staleTestSchema(name string, now time.Time) bool {
	match := postgresTestSchemaPattern.FindStringSubmatch(name)
	if match == nil {
		return false
	}
	created, err := time.Parse("20060102t150405", match[1])
	if err != nil {
		return false
	}
	return now.UTC().Sub(created) > staleTestSchemaAge
}

// createPostgresTestSchema drops stale test schemas, creates a fresh one and
// registers its removal.
func createPostgresTestSchema(t *testing.T, base *gorm.DB) string {
	t.Helper()
	now := time.Now()
	var existing []string
	if err := base.Raw(`SELECT nspname FROM pg_namespace WHERE nspname LIKE 'rag\_it\_%'`).Scan(&existing).Error; err != nil {
		t.Fatalf("list test schemas: %v", err)
	}
	for _, name := range existing {
		if staleTestSchema(name, now) {
			if err := base.Exec(`DROP SCHEMA IF EXISTS "` + name + `" CASCADE`).Error; err != nil {
				t.Logf("drop stale test schema %s: %v", name, err)
			}
		}
	}
	schema := postgresTestSchemaName(now)
	if err := base.Exec(`CREATE SCHEMA "` + schema + `"`).Error; err != nil {
		t.Fatalf("create isolated schema: %v", err)
	}
	t.Cleanup(func() { _ = base.Exec(`DROP SCHEMA IF EXISTS "` + schema + `" CASCADE`).Error })
	return schema
}

// postgresDSNWithSearchPath scopes a DSN to the given search_path and adds the
// test lock and statement timeouts as run-time parameters.
func postgresDSNWithSearchPath(dsn, searchPath string) (string, error) {
	settings := [][2]string{
		{"search_path", searchPath},
		{"lock_timeout", postgresTestLockTimeout},
		{"statement_timeout", postgresTestStmtTimeout},
	}
	if strings.Contains(dsn, "://") {
		parsed, err := url.Parse(dsn)
		if err != nil {
			return "", err
		}
		query := parsed.Query()
		for _, setting := range settings {
			query.Set(setting[0], setting[1])
		}
		parsed.RawQuery = query.Encode()
		return parsed.String(), nil
	}
	scoped := strings.TrimSpace(dsn)
	for _, setting := range settings {
		scoped += " " + setting[0] + "=" + setting[1]
	}
	return scoped, nil
}

func TestPostgresTestSchemaNamesExpireAfterADay(t *testing.T) {
	now := time.Date(2026, 9, 26, 12, 0, 0, 0, time.UTC)
	fresh := postgresTestSchemaName(now)
	if !postgresTestSchemaPattern.MatchString(fresh) {
		t.Fatalf("generated name %q does not match the recognised format", fresh)
	}
	if staleTestSchema(fresh, now.Add(23*time.Hour)) {
		t.Fatalf("a schema younger than a day must not be dropped: %s", fresh)
	}
	if !staleTestSchema(fresh, now.Add(25*time.Hour)) {
		t.Fatalf("a schema older than a day should be dropped: %s", fresh)
	}
	for _, name := range []string{"public", "rag_it_b78c568d3ac04580ba4baa63c7a17c28", "rag_accept_66dbeff82163454a9024a3addba5cc2f", "rag_it_20260101t000000_zz"} {
		if staleTestSchema(name, now) {
			t.Errorf("%q is not a timestamped test schema and must never be dropped", name)
		}
	}
}

func TestPostgresTestDSNAddsSearchPathAndTimeouts(t *testing.T) {
	scoped, err := postgresDSNWithSearchPath("postgres://user:secret@db:5432/app?sslmode=disable", "rag_it_x,public")
	if err != nil {
		t.Fatal(err)
	}
	parsed, _ := url.Parse(scoped)
	query := parsed.Query()
	if query.Get("search_path") != "rag_it_x,public" || query.Get("lock_timeout") != "5s" || query.Get("statement_timeout") != "60s" || query.Get("sslmode") != "disable" {
		t.Fatalf("unexpected URL DSN %q", scoped)
	}
	keyword, err := postgresDSNWithSearchPath("host=db dbname=app", "rag_it_x")
	if err != nil {
		t.Fatal(err)
	}
	if keyword != "host=db dbname=app search_path=rag_it_x lock_timeout=5s statement_timeout=60s" {
		t.Fatalf("unexpected keyword DSN %q", keyword)
	}
}
