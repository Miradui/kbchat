package repository

import (
	"context"
	"errors"
	"github.com/google/uuid"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"kbchat/backend/internal/model"
)

func (r *ChatRepository) HasQuestion(ctx context.Context, sessionID uuid.UUID, question string) (bool, error) {
	var count int64
	err := r.db.WithContext(ctx).Model(&model.ChatMessage{}).Where("session_id = ? AND role = ? AND content = ?", sessionID, "user", question).Count(&count).Error
	return count > 0, err
}
func (r *ChatRepository) QualityIssue(ctx context.Context, actor, sessionID uuid.UUID, key string) (*model.ChatQualityIssue, error) {
	var item model.ChatQualityIssue
	err := r.db.WithContext(ctx).Where("user_id = ? AND session_id = ? AND question_key = ?", actor, sessionID, key).First(&item).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return &item, err
}
func (r *ChatRepository) SaveQualityIssue(ctx context.Context, item *model.ChatQualityIssue) error {
	return r.db.WithContext(ctx).Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "user_id"}, {Name: "session_id"}, {Name: "question_key"}}, DoUpdates: clause.AssignmentColumns([]string{"status", "note", "evaluation_case_id", "evaluation_run_id", "document_ids", "updated_at"})}).Create(item).Error
}
