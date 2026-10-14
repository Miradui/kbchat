package repository

import (
	"context"
	"strings"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"kbchat/backend/internal/dto"
	"kbchat/backend/internal/model"
)

type ChatMessageSearchItem struct {
	MessageID    uuid.UUID
	SessionID    uuid.UUID
	SessionTitle string
	ArchivedAt   *time.Time
	Role         string
	Content      string
	CreatedAt    time.Time
}

func (r *ChatRepository) SearchMessages(ctx context.Context, userID uuid.UUID, roles []string, query dto.ChatMessageSearchQuery) ([]ChatMessageSearchItem, int64, error) {
	// Treat SQL wildcards and the escape character as literal user input.
	pattern := "%" + strings.NewReplacer("!", "!!", "%", "!%", "_", "!_").Replace(strings.ToLower(query.Q)) + "%"
	base := func() *gorm.DB {
		db := r.db.WithContext(ctx).Model(&model.ChatMessage{}).
			Joins("JOIN chat_sessions ON chat_sessions.id = chat_messages.session_id").
			Joins("JOIN knowledge_bases ON knowledge_bases.id = chat_sessions.knowledge_base_id").
			Where("chat_sessions.user_id = ? AND chat_sessions.deleted_at IS NULL", userID).
			Where("knowledge_bases.deleted_at IS NULL").
			Where(reachableKnowledgeBaseCondition(r.db, userID, roles)).
			Where(reachableChatLinks(userID, roles)).
			Where("chat_messages.role IN ?", []string{"user", "assistant"}).
			Where("LOWER(chat_messages.content) LIKE ? ESCAPE '!'", pattern)
		if query.SessionID != nil {
			db = db.Where("chat_sessions.id = ?", *query.SessionID)
		}
		return db
	}
	var total int64
	if err := base().Count(&total).Error; err != nil {
		return nil, 0, err
	}
	order := "chat_messages.created_at DESC, chat_messages.id DESC"
	if query.SessionID != nil {
		order = "chat_messages.created_at ASC, chat_messages.id ASC"
	}
	items := []ChatMessageSearchItem{}
	err := base().Select(`chat_messages.id AS message_id, chat_messages.session_id, chat_sessions.title AS session_title,
		chat_sessions.archived_at, chat_messages.role, chat_messages.content, chat_messages.created_at`).
		Order(order).Offset((query.Page - 1) * query.PageSize).Limit(query.PageSize).Scan(&items).Error
	return items, total, err
}
