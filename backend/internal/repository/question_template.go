package repository

import (
	"context"
	"github.com/google/uuid"
	"gorm.io/gorm"
	"kbchat/backend/internal/dto"
	"kbchat/backend/internal/model"
	"strings"
	"time"
)

func (r *ChatRepository) ListQuestionTemplates(ctx context.Context, userID uuid.UUID, q dto.PersonalListQuery) ([]model.QuestionTemplate, int64, error) {
	base := func() *gorm.DB {
		db := r.db.WithContext(ctx).Model(&model.QuestionTemplate{}).Where("user_id = ?", userID)
		if q.Q != "" {
			p := "%" + strings.NewReplacer("!", "!!", "%", "!%", "_", "!_").Replace(strings.ToLower(q.Q)) + "%"
			db = db.Where("LOWER(title) LIKE ? ESCAPE '!' OR LOWER(body) LIKE ? ESCAPE '!'", p, p)
		}
		return db
	}
	var total int64
	if err := base().Count(&total).Error; err != nil {
		return nil, 0, err
	}
	items := []model.QuestionTemplate{}
	err := base().Order("updated_at DESC, id DESC").Offset((q.Page - 1) * q.PageSize).Limit(q.PageSize).Find(&items).Error
	return items, total, err
}
func (r *ChatRepository) CreateQuestionTemplate(ctx context.Context, item *model.QuestionTemplate) error {
	return r.db.WithContext(ctx).Create(item).Error
}
func (r *ChatRepository) UpdateQuestionTemplate(ctx context.Context, userID, id uuid.UUID, title, body string) (*model.QuestionTemplate, error) {
	var item model.QuestionTemplate
	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		result := tx.Model(&model.QuestionTemplate{}).Where("id = ? AND user_id = ?", id, userID).Updates(map[string]any{"title": title, "body": body, "updated_at": time.Now().UTC()})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return gorm.ErrRecordNotFound
		}
		return tx.Where("id = ? AND user_id = ?", id, userID).First(&item).Error
	})
	return &item, err
}
func (r *ChatRepository) DeleteQuestionTemplate(ctx context.Context, userID, id uuid.UUID) error {
	result := r.db.WithContext(ctx).Where("id = ? AND user_id = ?", id, userID).Delete(&model.QuestionTemplate{})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return gorm.ErrRecordNotFound
	}
	return nil
}
