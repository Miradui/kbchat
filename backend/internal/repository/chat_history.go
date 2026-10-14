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
	Limit                int
	Before, After, Since *ChatHistoryCursor
	Around               *uuid.UUID
	Revision             string
}

type ChatHistoryPage struct {
	Items       []model.ChatMessage
	HasMore     bool
	NextCursor  *ChatHistoryCursor
	HasNewer    bool
	NewerCursor *ChatHistoryCursor
	Revision    string
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
			if query.Around != nil {
				return ErrChatMessageNotFound
			}
			return nil
		}

		start, end := latest, latest
		if query.Since != nil {
			start = model.ChatMessage{}
			if err := base().Where("id = ? AND created_at = ?", query.Since.ID, query.Since.CreatedAt).First(&start).Error; err != nil {
				if errors.Is(err, gorm.ErrRecordNotFound) {
					return ErrChatMessageChanged
				}
				return err
			}
		} else {
			var sample []model.ChatMessage
			switch {
			case query.Around != nil:
				var target model.ChatMessage
				if err := base().Where("id = ?", *query.Around).First(&target).Error; err != nil {
					if errors.Is(err, gorm.ErrRecordNotFound) {
						return ErrChatMessageNotFound
					}
					return err
				}
				if err := base().Select("id, created_at, role").Where("created_at < ? OR (created_at = ? AND id <= ?)", target.CreatedAt, target.CreatedAt, target.ID).
					Order("created_at DESC, id DESC").Limit(query.Limit/2 + 1).Find(&sample).Error; err != nil {
					return err
				}
				if len(sample) == 0 {
					return ErrChatMessageChanged
				}
				start, end = sample[len(sample)-1], target
				if remaining := query.Limit - len(sample); remaining > 0 {
					sample = nil
					if err := base().Select("id, created_at, role").Where("created_at > ? OR (created_at = ? AND id > ?)", target.CreatedAt, target.CreatedAt, target.ID).
						Order("created_at ASC, id ASC").Limit(remaining).Find(&sample).Error; err != nil {
						return err
					}
					if len(sample) > 0 {
						end = sample[len(sample)-1]
					}
				}
			case query.After != nil:
				var count int64
				if err := base().Where("id = ? AND created_at = ?", query.After.ID, query.After.CreatedAt).Count(&count).Error; err != nil {
					return err
				}
				if count == 0 {
					return ErrChatMessageChanged
				}
				if err := base().Select("id, created_at, role").Where("created_at > ? OR (created_at = ? AND id > ?)", query.After.CreatedAt, query.After.CreatedAt, query.After.ID).
					Order("created_at ASC, id ASC").Limit(query.Limit).Find(&sample).Error; err != nil {
					return err
				}
				if len(sample) == 0 {
					return nil
				}
				start, end = sample[0], sample[len(sample)-1]
			default:
				window := base().Select("id, created_at, role")
				if query.Before != nil {
					window = window.Where("created_at < ? OR (created_at = ? AND id < ?)", query.Before.CreatedAt, query.Before.CreatedAt, query.Before.ID)
				}
				if err := window.Order("created_at DESC, id DESC").Limit(query.Limit).Find(&sample).Error; err != nil {
					return err
				}
				if len(sample) == 0 {
					return nil
				}
				start, end = sample[len(sample)-1], sample[0]
			}
			if start.Role == "assistant" {
				var root model.ChatMessage
				err := base().Where("role <> ?", "assistant").
					Where("created_at < ? OR (created_at = ? AND id < ?)", start.CreatedAt, start.CreatedAt, start.ID).
					Order("created_at DESC, id DESC").First(&root).Error
				if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
					return err
				}
				if err == nil {
					start = root
				} else {
					// Legacy orphan answers form one group at the beginning of a thread.
					if err := base().Order("created_at ASC, id ASC").First(&root).Error; err != nil {
						return err
					}
					start = root
				}
			}
			// A window may end mid-turn. Include every answer version up to
			// (but not including) the next question, so the UI never invents groups.
			if query.Around != nil || query.After != nil {
				var next model.ChatMessage
				err := base().Select("id, created_at").Where("role <> ?", "assistant").
					Where("created_at > ? OR (created_at = ? AND id > ?)", end.CreatedAt, end.CreatedAt, end.ID).
					Order("created_at ASC, id ASC").First(&next).Error
				if errors.Is(err, gorm.ErrRecordNotFound) {
					end = latest
				} else if err != nil {
					return err
				} else {
					end = model.ChatMessage{}
					if err := base().Select("id, created_at").Where("created_at < ? OR (created_at = ? AND id < ?)", next.CreatedAt, next.CreatedAt, next.ID).
						Order("created_at DESC, id DESC").First(&end).Error; err != nil {
						return err
					}
				}
			}
		}
		if err := base().Where("created_at > ? OR (created_at = ? AND id >= ?)", start.CreatedAt, start.CreatedAt, start.ID).
			Where("created_at < ? OR (created_at = ? AND id <= ?)", end.CreatedAt, end.CreatedAt, end.ID).
			Order("created_at ASC, id ASC").Find(&page.Items).Error; err != nil {
			return err
		}
		if len(page.Items) > 0 {
			first := page.Items[0]
			page.NextCursor = &ChatHistoryCursor{SessionID: sessionID, ID: first.ID, CreatedAt: first.CreatedAt}
			last := page.Items[len(page.Items)-1]
			page.NewerCursor = &ChatHistoryCursor{SessionID: sessionID, ID: last.ID, CreatedAt: last.CreatedAt}
			page.HasNewer = last.ID != latest.ID
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
