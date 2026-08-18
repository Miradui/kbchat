package repository

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"rag/backend/internal/model"
)

const storageCleanupLockTimeout = 5 * time.Minute

var ErrStorageCleanupLeaseLost = errors.New("storage cleanup lease lost")

type StorageCleanupRepository struct {
	db *gorm.DB
}

func NewStorageCleanupRepository(db *gorm.DB) *StorageCleanupRepository {
	return &StorageCleanupRepository{db: db}
}

func (r *StorageCleanupRepository) ClaimPending(ctx context.Context) (*model.StorageCleanupJob, error) {
	var claimed *model.StorageCleanupJob
	now := time.Now()
	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var job model.StorageCleanupJob
		query := tx.
			Where("next_attempt_at IS NULL OR next_attempt_at <= ?", now).
			Where("locked_at IS NULL OR locked_at <= ?", now.Add(-storageCleanupLockTimeout)).
			Order("created_at asc, id asc")
		if tx.Dialector.Name() == "postgres" {
			query = query.Clauses(clause.Locking{Strength: "UPDATE", Options: "SKIP LOCKED"})
		}
		result := query.Limit(1).Find(&job)
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected == 0 {
			return nil
		}
		leaseToken := uuid.New()
		if err := tx.Model(&model.StorageCleanupJob{}).
			Where("id = ?", job.ID).
			Updates(map[string]any{"locked_at": now, "lease_token": leaseToken}).Error; err != nil {
			return err
		}
		job.LockedAt = &now
		job.LeaseToken = &leaseToken
		claimed = &job
		return nil
	})
	return claimed, err
}

func (r *StorageCleanupRepository) Complete(ctx context.Context, id, leaseToken uuid.UUID) error {
	result := r.db.WithContext(ctx).
		Where("id = ? AND lease_token = ?", id, leaseToken).
		Delete(&model.StorageCleanupJob{})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return ErrStorageCleanupLeaseLost
	}
	return nil
}

func (r *StorageCleanupRepository) Retry(ctx context.Context, id, leaseToken uuid.UUID, retryCount int, nextAttemptAt time.Time, message string) error {
	result := r.db.WithContext(ctx).
		Model(&model.StorageCleanupJob{}).
		Where("id = ? AND lease_token = ?", id, leaseToken).
		Updates(map[string]any{
			"retry_count":     retryCount,
			"next_attempt_at": nextAttemptAt,
			"locked_at":       nil,
			"lease_token":     nil,
			"last_error":      message,
		})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return ErrStorageCleanupLeaseLost
	}
	return nil
}

func enqueueStorageCleanup(tx *gorm.DB, paths []string) error {
	for _, storagePath := range paths {
		storagePath = strings.TrimSpace(storagePath)
		if storagePath == "" {
			continue
		}
		job := model.StorageCleanupJob{StoragePath: storagePath}
		if err := tx.Clauses(clause.OnConflict{
			Columns:   []clause.Column{{Name: "storage_path"}},
			DoNothing: true,
		}).Create(&job).Error; err != nil {
			return err
		}
	}
	return nil
}
