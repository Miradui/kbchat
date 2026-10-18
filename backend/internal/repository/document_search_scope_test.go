package repository

import (
	"context"
	"github.com/google/uuid"
	"kbchat/backend/internal/model"
	"testing"
)

func TestDocumentSearchScopeSelectsHistoricalDocumentBeforeLimit(t *testing.T) {
	f := newChunkRepositoryTestFixture(t)
	ctx := context.Background()
	db := f.repository.db
	old := f.documentA
	next := model.Document{KnowledgeBaseID: old.KnowledgeBaseID, UploaderID: old.UploaderID, Filename: "new.txt", StoragePath: "new"}
	if err := db.Create(&next).Error; err != nil {
		t.Fatal(err)
	}
	db.Model(&old).Update("superseded_by_id", next.ID)
	db.Model(&model.KnowledgeBase{}).Where("id = ?", old.KnowledgeBaseID).Update("document_version_policy", "current")
	if err := f.repository.CreateBatch(ctx, []model.DocumentChunk{f.chunk(old, 0, "old"), f.chunk(next, 0, "new")}); err != nil {
		t.Fatal(err)
	}
	scoped := WithDocumentSearchScope(ctx, []uuid.UUID{old.ID})
	var ids []uuid.UUID
	if err := publishedChunks(db.WithContext(scoped), old.KnowledgeBaseID).Limit(1).Pluck("document_chunks.document_id", &ids).Error; err != nil {
		t.Fatal(err)
	}
	if len(ids) != 1 || ids[0] != old.ID {
		t.Fatalf("scope expanded or hid selected history: %v", ids)
	}
	db.Delete(&old)
	ids = nil
	if err := publishedChunks(db.WithContext(scoped), old.KnowledgeBaseID).Pluck("document_chunks.document_id", &ids).Error; err != nil {
		t.Fatal(err)
	}
	if len(ids) != 0 {
		t.Fatal("deleted selection fell back to another document")
	}
}
