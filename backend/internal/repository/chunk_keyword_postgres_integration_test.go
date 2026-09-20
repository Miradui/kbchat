package repository

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"kbchat/backend/internal/document/lexer"
	"kbchat/backend/internal/model"
)

// Keyword recall needs real tsvector / tsquery semantics, which the SQLite
// fixtures cannot provide, so this runs on the isolated-schema PostgreSQL
// harness. The chunks table is created without the embedding column: the
// vector extension lives in public and this schema's search_path excludes it,
// and nothing here touches embeddings.
func TestPostgresSearchByKeywordRanksExactCodesAndScopesToKnowledgeBase(t *testing.T) {
	db, _ := newPostgresConcurrencyTestDBs(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	for _, statement := range []string{
		`DROP TABLE document_chunks`,
		`CREATE TABLE document_chunks (
			id UUID PRIMARY KEY,
			document_id UUID NOT NULL,
			knowledge_base_id UUID NOT NULL,
			chunk_index INT NOT NULL,
			content TEXT NOT NULL,
			page_number INT,
			search_vector tsvector
		)`,
		`CREATE INDEX idx_chunks_search_vector ON document_chunks USING gin (search_vector)`,
	} {
		if err := db.Exec(statement).Error; err != nil {
			t.Fatalf("prepare chunks table: %v", err)
		}
	}

	kbA, kbB := uuid.New(), uuid.New()
	docA, docB, docDeleted := uuid.New(), uuid.New(), uuid.New()
	now := time.Now()
	for _, document := range []struct {
		id      uuid.UUID
		kb      uuid.UUID
		deleted *time.Time
	}{
		{id: docA, kb: kbA},
		{id: docDeleted, kb: kbA, deleted: &now},
		{id: docB, kb: kbB},
	} {
		if err := db.Exec(
			`INSERT INTO documents (id, knowledge_base_id, filename, status, created_at, updated_at, deleted_at) VALUES (?, ?, ?, 'completed', ?, ?, ?)`,
			document.id, document.kb, document.id.String()+".md", now, now, document.deleted,
		).Error; err != nil {
			t.Fatalf("insert document: %v", err)
		}
	}

	insertChunk := func(id, documentID, kbID uuid.UUID, index int, content string) {
		vector := lexer.TSVector(lexer.Tokenize(content))
		if err := db.Exec(
			`INSERT INTO document_chunks (id, document_id, knowledge_base_id, chunk_index, content, search_vector) VALUES (?, ?, ?, ?, ?, ?::tsvector)`,
			id, documentID, kbID, index, content, vector,
		).Error; err != nil {
			t.Fatalf("insert chunk: %v", err)
		}
	}
	exact, partial, unrelated, deleted, otherKB := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	insertChunk(exact, docA, kbA, 0, "退款接口返回错误码 E-4021 时，需要检查签名配置。")
	insertChunk(partial, docA, kbA, 1, "退款流程说明：提交申请后等待审核。")
	insertChunk(unrelated, docA, kbA, 2, "公司年度假期安排与调休规则。")
	insertChunk(deleted, docDeleted, kbA, 0, "已删除文档里的错误码 E-4021 说明。")
	insertChunk(otherKB, docB, kbB, 0, "另一个知识库的错误码 E-4021 说明。")

	repository := NewChunkRepository(db)
	results, err := repository.SearchByKeyword(ctx, kbA, "退款 E-4021", 10)
	if err != nil {
		t.Fatalf("keyword search: %v", err)
	}
	if len(results) != 2 {
		t.Fatalf("expected the two matching live chunks of the knowledge base, got %d: %#v", len(results), results)
	}
	if results[0].ChunkID != exact {
		t.Fatalf("expected the chunk matching both the code and the CJK term first, got %s", results[0].ChunkID)
	}
	if results[1].ChunkID != partial {
		t.Fatalf("expected the CJK-only match second, got %s", results[1].ChunkID)
	}
	for _, result := range results {
		if result.KeywordScore == nil || *result.KeywordScore <= 0 || *result.KeywordScore >= 1 {
			t.Fatalf("expected normalized keyword score in (0, 1), got %#v", result.KeywordScore)
		}
		if result.VectorScore != 0 {
			t.Fatalf("expected zero vector score from the keyword stage, got %v", result.VectorScore)
		}
		if result.Filename == "" {
			t.Fatal("expected the document filename to be joined in")
		}
	}
	if *results[0].KeywordScore <= *results[1].KeywordScore {
		t.Fatalf("expected descending keyword scores, got %v then %v", *results[0].KeywordScore, *results[1].KeywordScore)
	}

	codeOnly, err := repository.SearchByKeyword(ctx, kbA, "e4021", 10)
	if err != nil {
		t.Fatalf("keyword search without hyphen: %v", err)
	}
	if len(codeOnly) != 0 {
		t.Fatalf("expected the unhyphenated spelling not to match the hyphenated code, got %#v", codeOnly)
	}
	parts, err := repository.SearchByKeyword(ctx, kbA, "4021", 10)
	if err != nil {
		t.Fatalf("keyword search by code part: %v", err)
	}
	if len(parts) != 1 || parts[0].ChunkID != exact {
		t.Fatalf("expected the numeric part of the code to match the exact chunk only, got %#v", parts)
	}

	if err := db.Model(&model.DocumentChunk{}).Where("1 = 1").UpdateColumn("search_vector", gorm.Expr("NULL")).Error; err != nil {
		t.Fatalf("clear search vectors: %v", err)
	}
	if cleared, err := repository.SearchByKeyword(ctx, kbA, "退款", 10); err != nil || len(cleared) != 0 {
		t.Fatalf("expected no keyword matches with NULL search vectors, got %#v err=%v", cleared, err)
	}
	done, err := repository.ReindexKeywords(ctx, 2, nil)
	if err != nil || done != 5 {
		t.Fatalf("reindex keywords: done=%d err=%v", done, err)
	}
	reindexed, err := repository.SearchByKeyword(ctx, kbA, "退款", 10)
	if err != nil || len(reindexed) != 2 {
		t.Fatalf("expected reindex to restore keyword recall, got %#v err=%v", reindexed, err)
	}
}
