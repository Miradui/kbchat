package repository

import (
	"context"
	"errors"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"kbchat/backend/internal/model"
)

func TestPostgresConcurrentDocumentUploadReceipts(t *testing.T) {
	db1, db2 := newPostgresConcurrencyTestDBs(t)
	if err := db1.AutoMigrate(&model.User{}, &model.KnowledgeBase{}, &model.Document{}, &model.DocumentJob{}); err != nil {
		t.Fatal(err)
	}
	migration, err := os.ReadFile("../../migrations/040_document_upload_receipts.sql")
	if err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err := db1.Exec(string(migration)).Error; err != nil {
			t.Fatal(err)
		}
	}
	actor := model.User{ID: uuid.New(), Username: "receipt", PasswordHash: "fixture"}
	if err := db1.Create(&actor).Error; err != nil {
		t.Fatal(err)
	}
	kb := model.KnowledgeBase{ID: uuid.New(), OwnerID: actor.ID, Name: "receipt"}
	if err := db1.Create(&kb).Error; err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()

	run := func(replaces *uuid.UUID, sameRequest bool) {
		t.Helper()
		key := uuid.New()
		docs := []*model.Document{
			{ID: uuid.New(), KnowledgeBaseID: kb.ID, UploaderID: actor.ID, Filename: "first.md", StoragePath: uuid.NewString()},
			{ID: uuid.New(), KnowledgeBaseID: kb.ID, UploaderID: actor.ID, Filename: "second.md", StoragePath: uuid.NewString()},
		}
		for _, doc := range docs {
			if err := NewStorageCleanupRepository(db1).Reserve(ctx, doc.StoragePath, time.Now().Add(time.Hour)); err != nil {
				t.Fatal(err)
			}
		}
		start := make(chan struct{})
		results := make([]error, 2)
		var wg sync.WaitGroup
		for i, db := range []*gorm.DB{db1, db2} {
			requestID := key
			if !sameRequest {
				requestID = uuid.New()
			}
			wg.Add(1)
			go func(i int, db *gorm.DB, requestID uuid.UUID) {
				defer wg.Done()
				<-start
				receipt := &model.DocumentUploadReceipt{UserID: actor.ID, KnowledgeBaseID: kb.ID, RequestID: requestID, Fingerprint: "same"}
				results[i] = NewDocumentRepository(db).CommitUpload(ctx, docs[i], &model.DocumentJob{JobType: "process_document", Status: "pending"}, actor.ID, receipt, replaces)
			}(i, db, requestID)
		}
		close(start)
		wg.Wait()
		var successes, conflicts int
		for _, err := range results {
			if err == nil {
				successes++
			} else if (sameRequest && errors.Is(err, ErrDocumentUploadReplayed)) || (!sameRequest && errors.Is(err, ErrDocumentAlreadySuperseded)) {
				conflicts++
			} else {
				t.Fatalf("unexpected concurrent result: %v", err)
			}
		}
		if successes != 1 || conflicts != 1 {
			t.Fatalf("concurrent outcomes: %v", results)
		}
		var count int64
		if err := db1.Model(&model.Document{}).Where("id IN ?", []uuid.UUID{docs[0].ID, docs[1].ID}).Count(&count).Error; err != nil || count != 1 {
			t.Fatalf("stray revision: %d %v", count, err)
		}
	}
	t.Run("same request", func(t *testing.T) { run(nil, true) })
	old := model.Document{ID: uuid.New(), KnowledgeBaseID: kb.ID, UploaderID: actor.ID, Filename: "original.md", StoragePath: uuid.NewString()}
	if err := db1.Create(&old).Error; err != nil {
		t.Fatal(err)
	}
	t.Run("different replacements", func(t *testing.T) { run(&old.ID, false) })
	var receipt model.DocumentUploadReceipt
	if err := db1.Where("document_id IS NOT NULL").First(&receipt).Error; err != nil {
		t.Fatal(err)
	}
	if err := db1.Where("document_id = ?", receipt.DocumentID).Delete(&model.DocumentJob{}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db1.Unscoped().Delete(&model.Document{}, "id = ?", receipt.DocumentID).Error; err != nil {
		t.Fatal(err)
	}
	reloaded, err := NewDocumentRepository(db1).UploadReceipt(ctx, actor.ID, kb.ID, receipt.RequestID)
	if err != nil || reloaded == nil || reloaded.DocumentID != nil {
		t.Fatalf("deleted document must retain tombstone: %+v %v", reloaded, err)
	}
}
