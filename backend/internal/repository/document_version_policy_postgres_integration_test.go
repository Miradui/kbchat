package repository

import (
	"context"
	"os"
	"reflect"
	"sort"
	"testing"

	"github.com/google/uuid"
	"github.com/pgvector/pgvector-go"
	"kbchat/backend/internal/document/lexer"
)

func TestPostgresDocumentVersionPolicyAcrossRecallPaths(t *testing.T) {
	db := newPostgresVectorTestDB(t)
	ctx := context.Background()
	for _, sql := range []string{
		`CREATE TABLE knowledge_bases (id UUID PRIMARY KEY, deleted_at TIMESTAMPTZ)`,
		`CREATE TABLE documents (id UUID PRIMARY KEY, knowledge_base_id UUID NOT NULL, filename TEXT, status TEXT, superseded_by_id UUID REFERENCES documents(id) ON DELETE SET NULL, deleted_at TIMESTAMPTZ)`,
		`CREATE TABLE document_chunks (id UUID PRIMARY KEY, document_id UUID REFERENCES documents(id) ON DELETE CASCADE, knowledge_base_id UUID, chunk_index INT, content TEXT, page_number INT, metadata JSONB, embedding vector(3), search_vector tsvector)`,
	} {
		if err := db.Exec(sql).Error; err != nil {
			t.Fatal(err)
		}
	}
	kb, otherKB := uuid.New(), uuid.New()
	if err := db.Exec("INSERT INTO knowledge_bases (id) VALUES (?), (?)", kb, otherKB).Error; err != nil {
		t.Fatal(err)
	}
	migration, err := os.ReadFile("../../migrations/042_document_version_policy.sql")
	if err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err := db.Exec(string(migration)).Error; err != nil {
			t.Fatal(err)
		}
	}
	var policy string
	if err := db.Table("knowledge_bases").Select("document_version_policy").Where("id = ?", kb).Scan(&policy).Error; err != nil || policy != "all" {
		t.Fatalf("migration changed default: %q %v", policy, err)
	}
	if err := db.Table("knowledge_bases").Where("id = ?", kb).Update("document_version_policy", "current").Error; err != nil {
		t.Fatal(err)
	}
	old, next, future, unrelated := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	for _, row := range []struct{ id, kb uuid.UUID }{{old, kb}, {next, kb}, {future, kb}, {unrelated, otherKB}} {
		if err := db.Exec("INSERT INTO documents (id, knowledge_base_id, filename, status) VALUES (?, ?, 'policy.md', 'uploaded')", row.id, row.kb).Error; err != nil {
			t.Fatal(err)
		}
	}
	link := func(a, b uuid.UUID) {
		t.Helper()
		if err := db.Exec("UPDATE documents SET superseded_by_id = ? WHERE id = ?", b, a).Error; err != nil {
			t.Fatal(err)
		}
	}
	vector := pgvector.NewVector([]float32{1, 0, 0})
	addChunk := func(id, library uuid.UUID, content string) {
		t.Helper()
		if err := db.Exec("INSERT INTO document_chunks (id, document_id, knowledge_base_id, chunk_index, content, embedding, search_vector) VALUES (?, ?, ?, 0, ?, ?, ?::tsvector)", uuid.New(), id, library, content, vector, lexer.TSVector(lexer.Tokenize(content))).Error; err != nil {
			t.Fatal(err)
		}
	}
	addChunk(old, kb, "退款旧政策")
	addChunk(unrelated, otherKB, "退款其他库")
	link(old, next)
	repo := NewChunkRepository(db)
	assertScope := func(want ...uuid.UUID) {
		t.Helper()
		for _, path := range []string{"vector", "exact", "keyword"} {
			var rows []SearchResult
			var err error
			switch path {
			case "vector":
				rows, err = repo.SearchByVector(ctx, kb, []float32{1, 0, 0}, 20)
			case "exact":
				rows, err = repo.SearchByVectorExact(ctx, kb, []float32{1, 0, 0}, 20)
			default:
				rows, err = repo.SearchByKeyword(ctx, kb, "退款", 20)
			}
			if err != nil {
				t.Fatalf("%s: %v", path, err)
			}
			got := make([]string, 0, len(rows))
			expected := make([]string, 0, len(want))
			for _, row := range rows {
				got = append(got, row.DocumentID.String())
			}
			for _, id := range want {
				expected = append(expected, id.String())
			}
			sort.Strings(got)
			sort.Strings(expected)
			if !reflect.DeepEqual(got, expected) {
				t.Fatalf("%s scope: %v want %v", path, got, expected)
			}
		}
		if count, err := repo.CountVectorSearchable(ctx, kb); err != nil || count != int64(len(want)) {
			t.Fatalf("count: %d %v", count, err)
		}
	}
	assertScope(old)
	addChunk(next, kb, "退款新政策")
	assertScope(next)
	for _, status := range []string{"embedding", "failed"} {
		if err := db.Exec("UPDATE documents SET status = ? WHERE id = ?", status, next).Error; err != nil {
			t.Fatal(err)
		}
		assertScope(next)
	}
	link(next, future)
	assertScope(next)
	if err := db.Exec("UPDATE documents SET deleted_at = now() WHERE id = ?", next).Error; err != nil {
		t.Fatal(err)
	}
	assertScope(old)
	addChunk(future, kb, "退款未来政策")
	assertScope(future)
	if err := db.Exec("UPDATE documents SET deleted_at = NULL WHERE id = ?", next).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Table("knowledge_bases").Where("id = ?", kb).Update("document_version_policy", "all").Error; err != nil {
		t.Fatal(err)
	}
	assertScope(old, next, future)
	if err := db.Table("knowledge_bases").Where("id = ?", kb).Update("document_version_policy", "current").Error; err != nil {
		t.Fatal(err)
	}
	history, err := repo.ListByDocument(ctx, old)
	if err != nil || len(history) != 1 || history[0].Content != "退款旧政策" {
		t.Fatalf("history lost: %+v %v", history, err)
	}
	if err := db.Exec("DELETE FROM documents WHERE id = ?", next).Error; err != nil {
		t.Fatal(err)
	}
	assertScope(old, future)
}
