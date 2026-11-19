package repository

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"github.com/google/uuid"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"

	"kbchat/backend/internal/model"
)

func TestBatchMoveCategoryRollsBackWhenLaterKnowledgeBaseIsDeleted(t *testing.T) {
	db := newKnowledgeBaseRepositoryTestDB(t)
	owner := model.User{Username: "owner", PasswordHash: "fixture"}
	if err := db.Create(&owner).Error; err != nil {
		t.Fatal(err)
	}
	first := model.KnowledgeBase{OwnerID: owner.ID, Name: "first"}
	second := model.KnowledgeBase{OwnerID: owner.ID, Name: "second"}
	for _, kb := range []*model.KnowledgeBase{&first, &second} {
		if err := db.Create(kb).Error; err != nil {
			t.Fatal(err)
		}
	}
	if err := db.Delete(&second).Error; err != nil {
		t.Fatal(err)
	}
	categoryID := uuid.New()
	err := NewKnowledgeBaseRepository(db).BatchMoveCategory(context.Background(), owner.ID, []uuid.UUID{first.ID, second.ID}, &categoryID)
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		t.Fatalf("expected deleted target rejection, got %v", err)
	}
	if err := db.First(&first, "id = ?", first.ID).Error; err != nil {
		t.Fatal(err)
	}
	if first.CategoryID != nil {
		t.Fatal("earlier move survived a deleted target")
	}
}

// A whole-row Save wrote owner_id back from the caller's snapshot, so a manager
// renaming a knowledge base while its owner transferred it silently undid the
// transfer: the new owner saw 404 and the old owner kept the knowledge base.
func TestKnowledgeBaseUpdateDoesNotRestorePreviousOwner(t *testing.T) {
	ctx := context.Background()
	db := newKnowledgeBaseRepositoryTestDB(t)
	original := model.User{Username: "original-owner", PasswordHash: "fixture"}
	next := model.User{Username: "next-owner", PasswordHash: "fixture"}
	for _, user := range []*model.User{&original, &next} {
		if err := db.Create(user).Error; err != nil {
			t.Fatal(err)
		}
	}
	kb := model.KnowledgeBase{Name: "手册", OwnerID: original.ID, Visibility: "private"}
	if err := db.Create(&kb).Error; err != nil {
		t.Fatal(err)
	}

	// The caller's snapshot predates the transfer that committed meanwhile.
	if err := db.Model(&model.KnowledgeBase{}).Where("id = ?", kb.ID).Update("owner_id", next.ID).Error; err != nil {
		t.Fatal(err)
	}
	kb.Name = "新名字"
	kb.Visibility = "public"
	kb.UpdatedByID = &next.ID
	if err := NewKnowledgeBaseRepository(db).Update(ctx, &kb); err != nil {
		t.Fatal(err)
	}

	var stored model.KnowledgeBase
	if err := db.First(&stored, "id = ?", kb.ID).Error; err != nil {
		t.Fatal(err)
	}
	if stored.OwnerID != next.ID {
		t.Fatalf("update restored the previous owner: got %s want %s", stored.OwnerID, next.ID)
	}
	if stored.Name != "新名字" || stored.Visibility != "public" || stored.UpdatedByID == nil || *stored.UpdatedByID != next.ID {
		t.Fatalf("named columns were not written: %+v", stored)
	}
}

// The soft-delete guard has to survive the switch from Save to a column list:
// resurrecting a deleted knowledge base would also make it visible again.
func TestKnowledgeBaseUpdateDoesNotResurrectDeletedRow(t *testing.T) {
	ctx := context.Background()
	db := newKnowledgeBaseRepositoryTestDB(t)
	owner := model.User{Username: "owner", PasswordHash: "fixture"}
	if err := db.Create(&owner).Error; err != nil {
		t.Fatal(err)
	}
	kb := model.KnowledgeBase{Name: "手册", OwnerID: owner.ID, Visibility: "private"}
	if err := db.Create(&kb).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Delete(&model.KnowledgeBase{}, "id = ?", kb.ID).Error; err != nil {
		t.Fatal(err)
	}

	kb.Name = "改名"
	if err := NewKnowledgeBaseRepository(db).Update(ctx, &kb); err != nil {
		t.Fatal(err)
	}

	var stored model.KnowledgeBase
	if err := db.Unscoped().First(&stored, "id = ?", kb.ID).Error; err != nil {
		t.Fatal(err)
	}
	if !stored.DeletedAt.Valid || stored.Name != "手册" {
		t.Fatalf("update touched a deleted knowledge base: deleted_at=%v name=%q", stored.DeletedAt, stored.Name)
	}
}

func newKnowledgeBaseRepositoryTestDB(t *testing.T) *gorm.DB {
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
	if err := db.AutoMigrate(
		&model.User{},
		&model.KnowledgeBase{},
		&model.KnowledgeBaseMember{},
	); err != nil {
		t.Fatalf("auto migrate knowledge base fixture: %v", err)
	}
	return db
}
