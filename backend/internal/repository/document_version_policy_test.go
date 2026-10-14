package repository

import (
	"context"
	"reflect"
	"sort"
	"testing"
	"time"

	"github.com/google/uuid"
	"kbchat/backend/internal/model"
)

func TestCurrentVersionScopeRetainsPublishedSnapshotAndHistoricalReads(t *testing.T) {
	f := newChunkRepositoryTestFixture(t)
	db := f.repository.db
	ctx := context.Background()
	kb := f.documentA.KnowledgeBaseID
	if err := db.Model(&model.KnowledgeBase{}).Where("id = ?", kb).Update("document_version_policy", "current").Error; err != nil {
		t.Fatal(err)
	}
	a := f.documentA
	b := model.Document{KnowledgeBaseID: kb, UploaderID: a.UploaderID, Filename: "b.txt", StoragePath: "b", Status: "uploaded"}
	c := model.Document{KnowledgeBaseID: kb, UploaderID: a.UploaderID, Filename: "c.txt", StoragePath: "c", Status: "uploaded"}
	for _, doc := range []*model.Document{&b, &c} {
		if err := db.Create(doc).Error; err != nil {
			t.Fatal(err)
		}
	}
	if err := f.repository.CreateBatch(ctx, []model.DocumentChunk{f.chunk(a, 0, "old")}); err != nil {
		t.Fatal(err)
	}
	link := func(from, to uuid.UUID) {
		t.Helper()
		if err := db.Model(&model.Document{}).Where("id = ?", from).Update("superseded_by_id", to).Error; err != nil {
			t.Fatal(err)
		}
	}
	assertScope := func(want ...uuid.UUID) {
		t.Helper()
		var got []uuid.UUID
		if err := publishedChunks(db, kb).Distinct("document_chunks.document_id").Pluck("document_chunks.document_id", &got).Error; err != nil {
			t.Fatal(err)
		}
		sort.Slice(got, func(i, j int) bool { return got[i].String() < got[j].String() })
		sort.Slice(want, func(i, j int) bool { return want[i].String() < want[j].String() })
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("scope: %v want %v", got, want)
		}
	}
	link(a.ID, b.ID)
	assertScope(a.ID)
	if err := db.Model(&b).Update("status", "failed").Error; err != nil {
		t.Fatal(err)
	}
	assertScope(a.ID)
	if err := f.repository.CreateBatch(ctx, []model.DocumentChunk{f.chunk(b, 0, "published new")}); err != nil {
		t.Fatal(err)
	}
	assertScope(b.ID)
	// Status changes during reprocessing cannot hide the published snapshot.
	if err := db.Model(&b).Update("status", "parsing").Error; err != nil {
		t.Fatal(err)
	}
	assertScope(b.ID)
	link(b.ID, c.ID)
	assertScope(b.ID)
	if err := f.repository.CreateBatch(ctx, []model.DocumentChunk{f.chunk(c, 0, "latest")}); err != nil {
		t.Fatal(err)
	}
	assertScope(c.ID)
	if err := db.Delete(&b).Error; err != nil {
		t.Fatal(err)
	}
	assertScope(c.ID)
	if err := db.Delete(&c).Error; err != nil {
		t.Fatal(err)
	}
	assertScope(a.ID)
	if err := db.Unscoped().Model(&b).Update("deleted_at", nil).Error; err != nil {
		t.Fatal(err)
	}
	assertScope(b.ID)
	if err := db.Unscoped().Model(&c).Update("deleted_at", nil).Error; err != nil {
		t.Fatal(err)
	}
	assertScope(c.ID)
	history, err := f.repository.ListByDocument(ctx, a.ID)
	if err != nil || len(history) != 1 || history[0].Content != "old" {
		t.Fatalf("old citation content disappeared: %+v %v", history, err)
	}
	if err := db.Model(&model.KnowledgeBase{}).Where("id = ?", kb).Update("document_version_policy", "all").Error; err != nil {
		t.Fatal(err)
	}
	assertScope(a.ID, b.ID, c.ID)
	if err := db.Model(&model.KnowledgeBase{}).Where("id = ?", kb).Update("document_version_policy", "current").Error; err != nil {
		t.Fatal(err)
	}
	// A moved successor belongs to a separate library and cannot hide local data.
	link(a.ID, f.documentB.ID)
	assertScope(a.ID, c.ID)
	if err := db.Model(&model.KnowledgeBase{}).Where("id = ?", kb).Update("deleted_at", time.Now()).Error; err != nil {
		t.Fatal(err)
	}
	count, err := f.repository.CountVectorSearchable(ctx, kb)
	if err != nil || count != 0 {
		t.Fatalf("deleted library searchable: %d %v", count, err)
	}
}
