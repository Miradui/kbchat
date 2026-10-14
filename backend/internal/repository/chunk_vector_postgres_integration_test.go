package repository

import (
	"context"
	"math"
	"os"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/pgvector/pgvector-go"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

// A filtered HNSW scan hands back at most ef_search neighbours before the
// knowledge-base and soft-delete filters run. Here the query's nearest
// neighbours are chunks of deleted documents and of another knowledge base, so
// an index scan of knowledge base A can come back short. The exhaustive search
// must still return A's true top 30, and from pgvector 0.8 the iterative scan
// must too.
func TestPostgresVectorSearchSurvivesFilteredHNSWShortfall(t *testing.T) {
	db := newPostgresVectorTestDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	for _, statement := range []string{
		`CREATE TABLE knowledge_bases (id UUID PRIMARY KEY, document_version_policy VARCHAR(16) NOT NULL DEFAULT 'all', deleted_at TIMESTAMPTZ)`,
		`CREATE TABLE documents (id UUID PRIMARY KEY, knowledge_base_id UUID NOT NULL, filename TEXT NOT NULL, superseded_by_id UUID, deleted_at TIMESTAMPTZ)`,
		`CREATE TABLE document_chunks (
			id UUID PRIMARY KEY,
			document_id UUID NOT NULL,
			knowledge_base_id UUID NOT NULL,
			chunk_index INT NOT NULL,
			content TEXT NOT NULL,
			page_number INT,
			metadata JSONB,
			embedding vector(3)
		)`,
	} {
		if err := db.Exec(statement).Error; err != nil {
			t.Fatalf("prepare tables: %v", err)
		}
	}

	kbA, kbB := uuid.New(), uuid.New()
	for _, id := range []uuid.UUID{kbA, kbB} {
		if err := db.Exec("INSERT INTO knowledge_bases (id) VALUES (?)", id).Error; err != nil {
			t.Fatal(err)
		}
	}
	liveA, deletedA, docB := uuid.New(), uuid.New(), uuid.New()
	now := time.Now()
	for _, document := range []struct {
		id, kb  uuid.UUID
		deleted *time.Time
	}{{liveA, kbA, nil}, {deletedA, kbA, &now}, {docB, kbB, nil}} {
		if err := db.Exec(`INSERT INTO documents (id, knowledge_base_id, filename, deleted_at) VALUES (?, ?, 'doc.md', ?)`,
			document.id, document.kb, document.deleted).Error; err != nil {
			t.Fatalf("insert document: %v", err)
		}
	}

	query := []float32{1, 0, 0}
	type seeded struct {
		id       uuid.UUID
		distance float64
	}
	var live []seeded
	insert := func(document, kb uuid.UUID, index int, vector []float32) uuid.UUID {
		id := uuid.New()
		if err := db.Exec(`INSERT INTO document_chunks (id, document_id, knowledge_base_id, chunk_index, content, embedding) VALUES (?, ?, ?, ?, 'chunk', ?)`,
			id, document, kb, index, pgvector.NewVector(vector)).Error; err != nil {
			t.Fatalf("insert chunk: %v", err)
		}
		return id
	}
	// Nearest to the query: deleted chunks of A, then all of B.
	for i := 0; i < 60; i++ {
		insert(deletedA, kbA, i, []float32{1, float32(i) * 0.001, 0})
	}
	for i := 0; i < 200; i++ {
		insert(docB, kbB, i, []float32{1, 0.1 + float32(i)*0.001, 0})
	}
	// A's live chunks are further away, each at a distinct distance.
	for i := 0; i < 40; i++ {
		vector := []float32{1, 0.6 + float32(i)*0.02, 0.3}
		live = append(live, seeded{id: insert(liveA, kbA, i, vector), distance: cosineDistance(query, vector)})
	}
	sort.Slice(live, func(i, j int) bool { return live[i].distance < live[j].distance })

	if err := db.Exec(`CREATE INDEX ON document_chunks USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64)`).Error; err != nil {
		t.Fatalf("create hnsw index: %v", err)
	}
	if err := db.Exec(`ANALYZE document_chunks`).Error; err != nil {
		t.Fatalf("analyze: %v", err)
	}
	// Make the planner take the index the way it would on a large table.
	for _, setting := range []string{"SET enable_seqscan = off", "SET enable_bitmapscan = off", "SET enable_sort = off"} {
		if err := db.Exec(setting).Error; err != nil {
			t.Fatalf("%s: %v", setting, err)
		}
	}

	repo := NewChunkRepository(db)
	count, err := repo.CountVectorSearchable(ctx, kbA)
	if err != nil || count != 40 {
		t.Fatalf("searchable = %d err=%v, want 40", count, err)
	}

	exact, err := repo.SearchByVectorExact(ctx, kbA, query, 30)
	if err != nil {
		t.Fatalf("exact search: %v", err)
	}
	if len(exact) != 30 {
		t.Fatalf("exact search returned %d rows, want 30", len(exact))
	}
	for i, row := range exact {
		if row.ChunkID != live[i].id {
			t.Fatalf("exact row %d = %s, want %s", i, row.ChunkID, live[i].id)
		}
	}

	approximate, err := repo.SearchByVector(ctx, kbA, query, 30)
	if err != nil {
		t.Fatalf("approximate search: %v", err)
	}
	info := repo.Pgvector(ctx)
	t.Logf("pgvector %s iterative=%v: approximate search returned %d of 30", info.Version, info.IterativeScan, len(approximate))
	if info.IterativeScan && len(approximate) != 30 {
		t.Fatalf("iterative scan should fill the page, got %d rows", len(approximate))
	}
}

func cosineDistance(a, b []float32) float64 {
	var dot, na, nb float64
	for i := range a {
		dot += float64(a[i]) * float64(b[i])
		na += float64(a[i]) * float64(a[i])
		nb += float64(b[i]) * float64(b[i])
	}
	return 1 - dot/(math.Sqrt(na)*math.Sqrt(nb))
}

// newPostgresVectorTestDB is the isolated-schema harness with public on the
// search path, where the vector type and its operators live. One connection
// keeps session settings in force for every query.
func newPostgresVectorTestDB(t *testing.T) *gorm.DB {
	t.Helper()
	dsn := strings.TrimSpace(os.Getenv("RAG_TEST_POSTGRES_DSN"))
	if dsn == "" {
		t.Skip("set RAG_TEST_POSTGRES_DSN to run PostgreSQL vector search integration tests")
	}
	base, err := gorm.Open(postgres.Open(dsn), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatalf("open PostgreSQL test database: %v", err)
	}
	schema := createPostgresTestSchema(t, base)

	scopedDSN, err := postgresDSNWithSearchPath(dsn, schema+",public")
	if err != nil {
		t.Fatalf("scope PostgreSQL DSN: %v", err)
	}
	db, err := gorm.Open(postgres.Open(scopedDSN), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatalf("open scoped PostgreSQL connection: %v", err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatalf("get scoped SQL database: %v", err)
	}
	sqlDB.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = sqlDB.Close() })
	return db
}
