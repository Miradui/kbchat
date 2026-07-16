package repository

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"

	"rag/backend/internal/model"
)

func TestArchiveSessionDoesNotOverwriteExistingTimestamp(t *testing.T) {
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatalf("open test database: %v", err)
	}
	if err := db.AutoMigrate(&model.ChatSession{}); err != nil {
		t.Fatalf("migrate chat session: %v", err)
	}
	session := model.ChatSession{
		UserID:          uuid.New(),
		KnowledgeBaseID: uuid.New(),
		Title:           "archive once",
	}
	if err := db.Create(&session).Error; err != nil {
		t.Fatalf("create chat session: %v", err)
	}
	repository := NewChatRepository(db)
	first := time.Date(2026, time.July, 16, 9, 0, 0, 0, time.UTC)
	second := first.Add(time.Hour)

	if err := repository.ArchiveSession(context.Background(), session.ID, first); err != nil {
		t.Fatalf("archive session first time: %v", err)
	}
	if err := repository.ArchiveSession(context.Background(), session.ID, second); err != nil {
		t.Fatalf("archive session second time: %v", err)
	}

	var stored model.ChatSession
	if err := db.First(&stored, "id = ?", session.ID).Error; err != nil {
		t.Fatalf("reload chat session: %v", err)
	}
	if stored.ArchivedAt == nil || !stored.ArchivedAt.Equal(first) {
		t.Fatalf("expected first archive timestamp to remain, got %#v", stored.ArchivedAt)
	}
}
