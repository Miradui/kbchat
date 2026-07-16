package repository

import (
	"context"
	"fmt"
	"testing"

	"github.com/google/uuid"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"

	"rag/backend/internal/model"
)

func TestClaimPendingJobWaitsForSameDocumentRunningJob(t *testing.T) {
	db := newDocumentRepositoryTestDB(t)
	repository := NewDocumentRepository(db)
	document := createDocumentRepositoryTestDocument(t, db)
	running := model.DocumentJob{DocumentID: document.ID, JobType: "process_document", Status: "running"}
	successor := model.DocumentJob{DocumentID: document.ID, JobType: "process_document", Status: "pending"}
	if err := db.Create(&running).Error; err != nil {
		t.Fatalf("create running job: %v", err)
	}
	if err := db.Create(&successor).Error; err != nil {
		t.Fatalf("create successor job: %v", err)
	}

	claimed, err := repository.ClaimPendingJob(context.Background())
	if err != nil {
		t.Fatalf("claim while predecessor runs: %v", err)
	}
	if claimed != nil {
		t.Fatalf("expected successor to wait for running predecessor, got %#v", claimed)
	}

	if err := db.Model(&running).Update("status", "completed").Error; err != nil {
		t.Fatalf("complete predecessor: %v", err)
	}
	claimed, err = repository.ClaimPendingJob(context.Background())
	if err != nil {
		t.Fatalf("claim successor: %v", err)
	}
	if claimed == nil || claimed.ID != successor.ID {
		t.Fatalf("expected successor after predecessor completion, got %#v", claimed)
	}
}

func newDocumentRepositoryTestDB(t *testing.T) *gorm.DB {
	t.Helper()
	dsn := fmt.Sprintf("file:%s?mode=memory&cache=shared", uuid.NewString())
	db, err := gorm.Open(sqlite.Open(dsn), &gorm.Config{})
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatalf("get sqlite connection: %v", err)
	}
	sqlDB.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = sqlDB.Close() })
	if err := db.AutoMigrate(&model.User{}, &model.KnowledgeBase{}, &model.Document{}, &model.DocumentJob{}); err != nil {
		t.Fatalf("auto migrate document repository fixture: %v", err)
	}
	return db
}

func createDocumentRepositoryTestDocument(t *testing.T, db *gorm.DB) model.Document {
	t.Helper()
	user := model.User{Username: "jobs-" + uuid.NewString(), PasswordHash: "hash"}
	if err := db.Create(&user).Error; err != nil {
		t.Fatalf("create user: %v", err)
	}
	knowledgeBase := model.KnowledgeBase{Name: "Job Repository", OwnerID: user.ID}
	if err := db.Create(&knowledgeBase).Error; err != nil {
		t.Fatalf("create knowledge base: %v", err)
	}
	document := model.Document{
		KnowledgeBaseID: knowledgeBase.ID,
		UploaderID:      user.ID,
		Filename:        "manual.pdf",
		FileType:        "pdf",
		StoragePath:     "manual.pdf",
		Status:          "completed",
	}
	if err := db.Create(&document).Error; err != nil {
		t.Fatalf("create document: %v", err)
	}
	return document
}
