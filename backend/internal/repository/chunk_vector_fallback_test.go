package repository

import (
	"context"
	"strings"
	"testing"

	"github.com/google/uuid"

	"kbchat/backend/internal/model"
)

func TestVersionAtLeastComparesNumerically(t *testing.T) {
	cases := []struct {
		version string
		want    bool
	}{
		{"0.8.0", true},
		{"0.8.1", true},
		{"0.10.0", true},
		{"1.0", true},
		{"0.7.4", false},
		{"0.5.1", false},
		{"0.8.0-rc1", true},
		{"0.8", true},
		{"", false},
	}
	for _, tc := range cases {
		if got := versionAtLeast(tc.version, 0, 8, 0); got != tc.want {
			t.Errorf("versionAtLeast(%q, 0.8.0) = %v, want %v", tc.version, got, tc.want)
		}
	}
}

// The count is the ceiling the retrieval service compares an approximate
// result against, so it must apply exactly the vector search's own filters.
func TestCountVectorSearchableMatchesTheVectorSearchScope(t *testing.T) {
	fixture := newChunkRepositoryTestFixture(t)
	ctx := context.Background()
	db := fixture.repository.db

	deleted := fixture.documentA
	deleted.ID = uuid.New()
	deleted.Filename = "deleted.txt"
	deleted.StoragePath = "deleted.txt"
	if err := db.Create(&deleted).Error; err != nil {
		t.Fatalf("create deleted document: %v", err)
	}
	if err := db.Delete(&deleted).Error; err != nil {
		t.Fatalf("soft delete document: %v", err)
	}

	chunks := []model.DocumentChunk{
		fixture.chunk(fixture.documentA, 0, "live"),
		fixture.chunk(fixture.documentA, 1, "live too"),
		fixture.chunk(fixture.documentA, 2, "no vector yet"),
		fixture.chunk(deleted, 0, "in a deleted document"),
		fixture.chunk(fixture.documentB, 0, "other knowledge base"),
	}
	if err := db.Create(&chunks).Error; err != nil {
		t.Fatalf("seed chunks: %v", err)
	}
	// The model always writes a vector; a chunk from an interrupted import can
	// still have none.
	if err := db.Exec("UPDATE document_chunks SET embedding = NULL WHERE content = ?", "no vector yet").Error; err != nil {
		t.Fatalf("clear embedding: %v", err)
	}

	count, err := fixture.repository.CountVectorSearchable(ctx, fixture.documentA.KnowledgeBaseID)
	if err != nil {
		t.Fatalf("count: %v", err)
	}
	if count != 2 {
		t.Fatalf("expected 2 searchable chunks, got %d", count)
	}
}

func TestExactVectorSearchFiltersBeforeOrdering(t *testing.T) {
	query := strings.Join(strings.Fields(strings.ToLower(exactVectorSearchSQL)), " ")
	for _, want := range []string{
		"with candidates as materialized",
		"document_chunks.knowledge_base_id = ?",
		"documents.knowledge_base_id = ?",
		"documents.deleted_at is null",
		"document_chunks.embedding is not null",
		"from candidates order by embedding <=> ?",
	} {
		if !strings.Contains(query, want) {
			t.Errorf("exact search SQL lacks %q:\n%s", want, exactVectorSearchSQL)
		}
	}
	if strings.Contains(query, "documents.status") {
		t.Error("exact search must keep published chunks searchable during reprocessing, like SearchByVector")
	}
}

func TestPgvectorInfoIsEmptyOffPostgres(t *testing.T) {
	fixture := newChunkRepositoryTestFixture(t)
	info := fixture.repository.Pgvector(context.Background())
	if info.Version != "" || info.IterativeScan {
		t.Fatalf("expected no pgvector on SQLite, got %#v", info)
	}
}
