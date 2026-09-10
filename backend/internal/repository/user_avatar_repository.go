package repository

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"kbchat/backend/internal/model"
)

func (r *UserRepository) FindAvatar(ctx context.Context, userID uuid.UUID) (*model.UserAvatar, error) {
	var avatar model.UserAvatar
	err := r.db.WithContext(ctx).Where("user_id = ?", userID).First(&avatar).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return &avatar, err
}

// ReplaceAvatar serializes avatar writes on the user row. Profile and password
// fields are deliberately excluded. Passing nil removes the avatar.
func (r *UserRepository) ReplaceAvatar(ctx context.Context, userID uuid.UUID, avatar *model.UserAvatar, avatarURL string) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		result := tx.Model(&model.User{}).Where("id = ?", userID).
			Updates(map[string]any{"avatar_url": avatarURL, "updated_at": time.Now()})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return gorm.ErrRecordNotFound
		}
		if avatar == nil {
			return tx.Where("user_id = ?", userID).Delete(&model.UserAvatar{}).Error
		}
		return tx.Clauses(clause.OnConflict{
			Columns:   []clause.Column{{Name: "user_id"}},
			DoUpdates: clause.AssignmentColumns([]string{"version", "data", "updated_at"}),
		}).Create(avatar).Error
	})
}
