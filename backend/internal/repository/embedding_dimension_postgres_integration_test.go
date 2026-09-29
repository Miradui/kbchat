package repository

import (
	"context"
	"os"
	"testing"
)

func TestPostgresEmbeddingDimensionAndMigration(t *testing.T) {
	db := newPostgresVectorTestDB(t)
	for _, sql := range []string{"CREATE TABLE documents (id UUID PRIMARY KEY)", "CREATE TABLE document_chunks (embedding vector(3))", "INSERT INTO documents VALUES ('00000000-0000-0000-0000-000000000001')"} {
		if err := db.Exec(sql).Error; err != nil {
			t.Fatal(err)
		}
	}
	repo := NewSystemRepository(db)
	if err := repo.ValidateEmbeddingDimension(context.Background(), 3); err != nil {
		t.Fatal(err)
	}
	if err := repo.ValidateEmbeddingDimension(context.Background(), 1536); err == nil {
		t.Fatal("expected dimension mismatch")
	}
	migration, err := os.ReadFile("../../migrations/029_document_embedding_identity.sql")
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if err := db.Exec(string(migration)).Error; err != nil {
			t.Fatal(err)
		}
	}
	var unknown int64
	if err := db.Raw("SELECT count(*) FROM documents WHERE embedding_model IS NULL AND embedding_dimension IS NULL").Scan(&unknown).Error; err != nil || unknown != 1 {
		t.Fatalf("unknown=%d err=%v", unknown, err)
	}
}
