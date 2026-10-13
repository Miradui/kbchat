package repository

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"kbchat/backend/internal/model"
)

type ChatHistoryCursor struct {
	SessionID uuid.UUID `json:"sessionId"`
	ID        uuid.UUID `json:"id"`
	CreatedAt time.Time `json:"createdAt"`
}

type ChatHistoryQuery struct {
	Limit         int
	Before, Since *ChatHistoryCursor
	Revision      string
}

type ChatHistoryPage struct {
	Items      []model.ChatMessage
	HasMore    bool
	NextCursor *ChatHistoryCursor
	Revision   string
}

// ListMessagePage keeps the first user turn and all of its answer versions
// together. Limit is a soft message limit: a long answer-version group can exceed it.
func (r *ChatRepository) ListMessagePage(ctx context.Context, sessionID uuid.UUID, query ChatHistoryQuery) (ChatHistoryPage, error) {
	page := ChatHistoryPage{Items: []model.ChatMessage{}}
	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		base := func() *gorm.DB { return tx.Model(&model.ChatMessage{}).Where("session_id = ?", sessionID) }
		var latest model.ChatMessage
		err := base().Order("created_at DESC, id DESC").First(&latest).Error
		if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
			return err
		}
		if err == nil {
			page.Revision = latest.ID.String()
		}
		if query.Revision != "" && query.Revision != page.Revision {
			return ErrChatMessageChanged
		}
		if page.Revision == "" {
			return nil
		}

		window := func() *gorm.DB {
			q := base()
			if query.Before != nil {
				q = q.Where("created_at < ? OR (created_at = ? AND id < ?)", query.Before.CreatedAt, query.Before.CreatedAt, query.Before.ID)
			}
			return q
		}
		var start ChatHistoryCursor
		if query.Since != nil {
			var count int64
			if err := base().Where("id = ? AND created_at = ?", query.Since.ID, query.Since.CreatedAt).Count(&count).Error; err != nil {
				return err
			}
			if count == 0 {
				return ErrChatMessageChanged
			}
			start = *query.Since
		} else {
			var tail []model.ChatMessage
			if err := window().Order("created_at DESC, id DESC").Limit(query.Limit).Find(&tail).Error; err != nil {
				return err
			}
			if len(tail) == 0 {
				return nil
			}
			first := tail[len(tail)-1]
			start = ChatHistoryCursor{SessionID: sessionID, ID: first.ID, CreatedAt: first.CreatedAt}
			if first.Role == "assistant" {
				var root model.ChatMessage
				err := base().Where("role <> ?", "assistant").
					Where("created_at < ? OR (created_at = ? AND id < ?)", first.CreatedAt, first.CreatedAt, first.ID).
					Order("created_at DESC, id DESC").First(&root).Error
				if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
					return err
				}
				if err == nil {
					start = ChatHistoryCursor{SessionID: sessionID, ID: root.ID, CreatedAt: root.CreatedAt}
				} else {
					// Legacy orphan answers form one group at the beginning of a thread.
					if err := base().Order("created_at ASC, id ASC").First(&root).Error; err != nil {
						return err
					}
					start = ChatHistoryCursor{SessionID: sessionID, ID: root.ID, CreatedAt: root.CreatedAt}
				}
			}
		}
		if err := window().Where("created_at > ? OR (created_at = ? AND id >= ?)", start.CreatedAt, start.CreatedAt, start.ID).
			Order("created_at ASC, id ASC").Find(&page.Items).Error; err != nil {
			return err
		}
		if len(page.Items) > 0 {
			first := page.Items[0]
			page.NextCursor = &ChatHistoryCursor{SessionID: sessionID, ID: first.ID, CreatedAt: first.CreatedAt}
			var older []uuid.UUID
			if err := base().Where("created_at < ? OR (created_at = ? AND id < ?)", first.CreatedAt, first.CreatedAt, first.ID).
				Limit(1).Pluck("id", &older).Error; err != nil {
				return err
			}
			page.HasMore = len(older) > 0
		}
		// Detect edits/appends between the boundary and content reads as well.
		var final model.ChatMessage
		if err := base().Order("created_at DESC, id DESC").First(&final).Error; err != nil {
			return err
		}
		if final.ID != latest.ID {
			return ErrChatMessageChanged
		}
		return nil
	})
	return page, err
}
