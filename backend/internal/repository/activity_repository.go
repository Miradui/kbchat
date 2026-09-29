package repository

import (
	"context"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"kbchat/backend/internal/model"
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

// AdminActivity is an administrator action with the acting account's names.
type AdminActivity struct {
	model.Activity
	ActorUsername    string
	ActorDisplayName string
}

// ListAdmin returns system-administration entries (action prefix "admin.")
// from every administrator, newest first. Knowledge-base activity of other
// users is never included: this listing exists for account management audit,
// not as a way to read other people's timelines.
func (r *ActivityRepository) ListAdmin(ctx context.Context, offset, limit int) ([]AdminActivity, int64, error) {
	base := r.db.WithContext(ctx).Model(&model.Activity{}).Where("activities.action LIKE ?", "admin.%")
	var total int64
	if err := base.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	var items []AdminActivity
	err := base.
		Select("activities.*, users.username AS actor_username, users.display_name AS actor_display_name").
		Joins("LEFT JOIN users ON users.id = activities.user_id").
		Order("activities.created_at desc, activities.id desc").
		Offset(offset).
		Limit(limit).
		Scan(&items).Error
	return items, total, err
}
