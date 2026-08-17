package repository

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"rag/backend/internal/model"
)

func TestDocumentRestoreAndPermanentDeleteRequireDeletedState(t *testing.T) {
	db := newDocumentRepositoryTestDB(t)
	repository := NewDocumentRepository(db)
	document := createDocumentRepositoryTestDocument(t, db)

	if err := repository.PermanentDelete(context.Background(), document.ID); !errors.Is(err, ErrDocumentNotDeleted) {
		t.Fatalf("expected active document permanent delete to lose with deleted-state sentinel, got %v", err)
	}
	if err := db.Delete(&document).Error; err != nil {
		t.Fatalf("soft delete document: %v", err)
	}
	if err := repository.Restore(context.Background(), document.ID); err != nil {
		t.Fatalf("restore deleted document: %v", err)
	}
	if err := repository.Restore(context.Background(), document.ID); !errors.Is(err, ErrDocumentNotDeleted) {
		t.Fatalf("expected stale document restore to fail, got %v", err)
	}
}

func TestDocumentBatchRestoreRollsBackWhenOneDocumentLeavesRecycleBin(t *testing.T) {
	db := newDocumentRepositoryTestDB(t)
	repository := NewDocumentRepository(db)
	first := createDocumentRepositoryTestDocument(t, db)
	second := createDocumentRepositoryTestDocument(t, db)
	if err := db.Delete(&first).Error; err != nil {
		t.Fatalf("soft delete first document: %v", err)
	}
	if err := db.Delete(&second).Error; err != nil {
		t.Fatalf("soft delete second document: %v", err)
	}
	if err := repository.PermanentDelete(context.Background(), second.ID); err != nil {
		t.Fatalf("permanently delete second document: %v", err)
	}

	err := repository.BatchRestore(context.Background(), []uuid.UUID{first.ID, second.ID})
	if !errors.Is(err, ErrDocumentNotDeleted) {
		t.Fatalf("expected batch restore deleted-state sentinel, got %v", err)
	}
	var firstAfter model.Document
	if err := db.Unscoped().First(&firstAfter, "id = ?", first.ID).Error; err != nil {
		t.Fatalf("reload first document: %v", err)
	}
	if !firstAfter.DeletedAt.Valid {
		t.Fatal("expected all-or-nothing rollback to keep first document deleted")
	}
}

func TestKnowledgeBaseRestoreAndPermanentDeleteRequireDeletedState(t *testing.T) {
	db := newDocumentRepositoryTestDB(t)
	migrateKnowledgeBasePermanentDeleteDependencies(t, db)
	document := createDocumentRepositoryTestDocument(t, db)
	repository := NewKnowledgeBaseRepository(db)

	if err := repository.PermanentDelete(context.Background(), document.KnowledgeBaseID); !errors.Is(err, ErrKnowledgeBaseNotDeleted) {
		t.Fatalf("expected active knowledge base permanent delete to fail, got %v", err)
	}
	if err := db.Delete(&model.KnowledgeBase{ID: document.KnowledgeBaseID}).Error; err != nil {
		t.Fatalf("soft delete knowledge base: %v", err)
	}
	if err := repository.Restore(context.Background(), document.KnowledgeBaseID); err != nil {
		t.Fatalf("restore deleted knowledge base: %v", err)
	}
	if err := repository.Restore(context.Background(), document.KnowledgeBaseID); !errors.Is(err, ErrKnowledgeBaseNotDeleted) {
		t.Fatalf("expected stale knowledge base restore to fail, got %v", err)
	}
}

func TestKnowledgeBaseBatchRestoreRollsBackWhenOneKnowledgeBaseLeavesRecycleBin(t *testing.T) {
	db := newDocumentRepositoryTestDB(t)
	migrateKnowledgeBasePermanentDeleteDependencies(t, db)
	firstDocument := createDocumentRepositoryTestDocument(t, db)
	secondDocument := createDocumentRepositoryTestDocument(t, db)
	repository := NewKnowledgeBaseRepository(db)
	if err := db.Delete(&model.KnowledgeBase{ID: firstDocument.KnowledgeBaseID}).Error; err != nil {
		t.Fatalf("soft delete first knowledge base: %v", err)
	}
	if err := db.Delete(&model.KnowledgeBase{ID: secondDocument.KnowledgeBaseID}).Error; err != nil {
		t.Fatalf("soft delete second knowledge base: %v", err)
	}
	if err := repository.PermanentDelete(context.Background(), secondDocument.KnowledgeBaseID); err != nil {
		t.Fatalf("permanently delete second knowledge base: %v", err)
	}

	err := repository.BatchRestore(context.Background(), []uuid.UUID{
		firstDocument.KnowledgeBaseID,
		secondDocument.KnowledgeBaseID,
	})
	if !errors.Is(err, ErrKnowledgeBaseNotDeleted) {
		t.Fatalf("expected batch restore deleted-state sentinel, got %v", err)
	}
	var firstAfter model.KnowledgeBase
	if err := db.Unscoped().First(&firstAfter, "id = ?", firstDocument.KnowledgeBaseID).Error; err != nil {
		t.Fatalf("reload first knowledge base: %v", err)
	}
	if !firstAfter.DeletedAt.Valid {
		t.Fatal("expected all-or-nothing rollback to keep first knowledge base deleted")
	}
}

func migrateKnowledgeBasePermanentDeleteDependencies(t *testing.T, db *gorm.DB) {
	t.Helper()
	if err := db.AutoMigrate(
		&model.ChatSession{},
		&model.ChatMessage{},
		&model.KnowledgeBaseMember{},
		&model.KnowledgeBaseFavorite{},
		&model.KnowledgeBaseViewEvent{},
		&model.KnowledgeBaseTag{},
		&model.KnowledgeBaseTagBinding{},
	); err != nil {
		t.Fatalf("migrate permanent-delete dependencies: %v", err)
	}
}
