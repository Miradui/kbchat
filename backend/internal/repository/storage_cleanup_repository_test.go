package repository

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/google/uuid"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"

	"rag/backend/internal/model"
)

func TestStorageCleanupRepositoryClaimRetryAndComplete(t *testing.T) {
	db := newStorageCleanupTestDB(t)
	createdAt := time.Now()
	first := model.StorageCleanupJob{StoragePath: "minio://bucket/first", CreatedAt: createdAt}
	second := model.StorageCleanupJob{StoragePath: "minio://bucket/second", CreatedAt: createdAt.Add(time.Microsecond)}
	if err := db.Create(&first).Error; err != nil {
		t.Fatalf("create first cleanup: %v", err)
	}
	if err := db.Create(&second).Error; err != nil {
		t.Fatalf("create second cleanup: %v", err)
	}

	repository := NewStorageCleanupRepository(db)
	claimed, err := repository.ClaimPending(context.Background(), 0)
	if err != nil || claimed == nil || claimed.ID != first.ID {
		t.Fatalf("claim first cleanup: claimed=%#v err=%v", claimed, err)
	}
	retryAt := time.Now().Add(time.Hour)
	if err := repository.Retry(context.Background(), claimed.ID, *claimed.LeaseToken, 1, retryAt, "offline"); err != nil {
		t.Fatalf("retry first cleanup: %v", err)
	}
	claimed, err = repository.ClaimPending(context.Background(), 0)
	if err != nil || claimed == nil || claimed.ID != second.ID {
		t.Fatalf("claim second cleanup: claimed=%#v err=%v", claimed, err)
	}
	if err := repository.Complete(context.Background(), claimed.ID, *claimed.LeaseToken); err != nil {
		t.Fatalf("complete second cleanup: %v", err)
	}
	claimed, err = repository.ClaimPending(context.Background(), 0)
	if err != nil || claimed != nil {
		t.Fatalf("future retry should not be claimable: claimed=%#v err=%v", claimed, err)
	}
}

func TestStorageCleanupRepositoryRejectsStaleLeaseCompletion(t *testing.T) {
	db := newStorageCleanupTestDB(t)
	cleanup := model.StorageCleanupJob{StoragePath: "minio://bucket/stale"}
	if err := db.Create(&cleanup).Error; err != nil {
		t.Fatalf("create cleanup: %v", err)
	}
	repository := NewStorageCleanupRepository(db)
	first, err := repository.ClaimPending(context.Background(), 0)
	if err != nil || first == nil || first.LeaseToken == nil {
		t.Fatalf("claim first lease: cleanup=%#v err=%v", first, err)
	}
	if err := db.Model(&model.StorageCleanupJob{}).Where("id = ?", cleanup.ID).
		Update("locked_at", time.Now().Add(-defaultStorageCleanupLeaseDuration-time.Minute)).Error; err != nil {
		t.Fatalf("expire first lease: %v", err)
	}
	second, err := repository.ClaimPending(context.Background(), 0)
	if err != nil || second == nil || second.LeaseToken == nil {
		t.Fatalf("claim second lease: cleanup=%#v err=%v", second, err)
	}
	if *first.LeaseToken == *second.LeaseToken {
		t.Fatal("reclaimed cleanup must receive a new lease token")
	}
	if err := repository.Complete(context.Background(), first.ID, *first.LeaseToken); !errors.Is(err, ErrStorageCleanupLeaseLost) {
		t.Fatalf("expected stale completion to lose lease, got %v", err)
	}
	var stored model.StorageCleanupJob
	if err := db.First(&stored, "id = ?", cleanup.ID).Error; err != nil {
		t.Fatalf("stale completion must preserve cleanup job: %v", err)
	}
	if stored.LeaseToken == nil || *stored.LeaseToken != *second.LeaseToken {
		t.Fatalf("stale completion changed current lease: %#v", stored.LeaseToken)
	}
}

func TestStorageCleanupRepositoryReservesAndCancelsUploadCleanup(t *testing.T) {
	db := newStorageCleanupTestDB(t)
	repository := NewStorageCleanupRepository(db)
	nextAttemptAt := time.Now().Add(10 * time.Minute)
	path := "minio://bucket/reserved"

	if err := repository.Reserve(context.Background(), path, nextAttemptAt); err != nil {
		t.Fatalf("reserve cleanup: %v", err)
	}
	var stored model.StorageCleanupJob
	if err := db.First(&stored, "storage_path = ?", path).Error; err != nil {
		t.Fatalf("read reserved cleanup: %v", err)
	}
	if stored.NextAttemptAt == nil || !stored.NextAttemptAt.Equal(nextAttemptAt) {
		t.Fatalf("expected reservation deadline %s, got %#v", nextAttemptAt, stored.NextAttemptAt)
	}
	if err := repository.Reserve(context.Background(), path, nextAttemptAt); err != nil {
		t.Fatalf("duplicate reservation should be idempotent: %v", err)
	}
	if err := repository.CancelReservation(context.Background(), path); err != nil {
		t.Fatalf("cancel reservation: %v", err)
	}
	if err := db.First(&stored, "storage_path = ?", path).Error; !errors.Is(err, gorm.ErrRecordNotFound) {
		t.Fatalf("expected reservation to be removed, got %v", err)
	}
}

func newStorageCleanupTestDB(t *testing.T) *gorm.DB {
	t.Helper()
	dsn := fmt.Sprintf("file:%s?mode=memory&cache=shared", uuid.NewString())
	db, err := gorm.Open(sqlite.Open(dsn), &gorm.Config{})
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	if err := db.AutoMigrate(&model.StorageCleanupJob{}); err != nil {
		t.Fatalf("migrate cleanup jobs: %v", err)
	}
	return db
}
