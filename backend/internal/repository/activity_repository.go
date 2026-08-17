package repository

import (
	"context"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"rag/backend/internal/model"
)

type ActivityRepository struct {
	db *gorm.DB
}

func NewActivityRepository(db *gorm.DB) *ActivityRepository {
	return &ActivityRepository{db: db}
}

func (r *ActivityRepository) Create(ctx context.Context, activity *model.Activity) error {
	return r.db.WithContext(ctx).Create(activity).Error
}

// ListByUser returns the caller's newest entries. The id tiebreak keeps the
// order stable when several events share a timestamp.
func (r *ActivityRepository) ListByUser(ctx context.Context, userID uuid.UUID, limit int) ([]model.Activity, error) {
	var items []model.Activity
	err := r.db.WithContext(ctx).
		Where("user_id = ?", userID).
		Order("created_at desc, id desc").
		Limit(limit).
		Find(&items).Error
	return items, err
}
