package repository

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"rag/backend/internal/model"
)

type ChatRepository struct {
	db *gorm.DB
}

func NewChatRepository(db *gorm.DB) *ChatRepository {
	return &ChatRepository{db: db}
}

func (r *ChatRepository) CreateSession(ctx context.Context, session *model.ChatSession) error {
	return r.db.WithContext(ctx).Create(session).Error
}

func (r *ChatRepository) ListSessions(ctx context.Context, userID uuid.UUID) ([]model.ChatSession, error) {
	var sessions []model.ChatSession
	err := r.db.WithContext(ctx).
		Where("user_id = ?", userID).
		Where("deleted_at IS NULL").
		Where("archived_at IS NULL").
		Order("updated_at desc").
		Find(&sessions).Error
	return sessions, err
}

func (r *ChatRepository) FindSessionByIDAndUser(ctx context.Context, sessionID, userID uuid.UUID) (*model.ChatSession, error) {
	var session model.ChatSession
	err := r.db.WithContext(ctx).
		Where("id = ? AND user_id = ?", sessionID, userID).
		Where("deleted_at IS NULL").
		First(&session).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return &session, err
}

func (r *ChatRepository) UpdateSessionTitle(ctx context.Context, sessionID uuid.UUID, title string) error {
	return r.db.WithContext(ctx).
		Model(&model.ChatSession{}).
		Where("id = ?", sessionID).
		Updates(map[string]any{
			"title":      title,
			"updated_at": time.Now(),
		}).Error
}

func (r *ChatRepository) ArchiveSession(ctx context.Context, sessionID uuid.UUID, archivedAt time.Time) error {
	return r.db.WithContext(ctx).
		Model(&model.ChatSession{}).
		Where("id = ?", sessionID).
		Updates(map[string]any{
			"archived_at": archivedAt,
			"updated_at":  archivedAt,
		}).Error
}

func (r *ChatRepository) DeleteSession(ctx context.Context, sessionID uuid.UUID) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("session_id = ?", sessionID).Delete(&model.ChatMessage{}).Error; err != nil {
			return err
		}
		return tx.Unscoped().Delete(&model.ChatSession{ID: sessionID}).Error
	})
}

func (r *ChatRepository) ListMessages(ctx context.Context, sessionID uuid.UUID) ([]model.ChatMessage, error) {
	var messages []model.ChatMessage
	err := r.db.WithContext(ctx).
		Where("session_id = ?", sessionID).
		Order("created_at asc").
		Find(&messages).Error
	return messages, err
}

func (r *ChatRepository) CreateMessage(ctx context.Context, message *model.ChatMessage) error {
	return r.db.WithContext(ctx).Create(message).Error
}

func (r *ChatRepository) CreateMessages(ctx context.Context, messages ...*model.ChatMessage) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		for _, message := range messages {
			if err := tx.Create(message).Error; err != nil {
				return err
			}
		}
		if len(messages) > 0 {
			return tx.Model(&model.ChatSession{}).
				Where("id = ?", messages[0].SessionID).
				Update("updated_at", time.Now()).Error
		}
		return nil
	})
}
