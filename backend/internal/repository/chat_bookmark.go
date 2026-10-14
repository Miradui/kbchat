package repository

import (
	"context"
	"github.com/google/uuid"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"kbchat/backend/internal/dto"
	"kbchat/backend/internal/model"
	"strings"
	"time"
)

type ChatBookmarkItem struct {
	ChatMessageSearchItem
	Note              string
	BookmarkedAt      time.Time
	BookmarkUpdatedAt time.Time
}

func (r *ChatRepository) SaveBookmark(ctx context.Context, bookmark *model.ChatBookmark) error {
	if err := r.db.WithContext(ctx).Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "message_id"}},
		DoUpdates: clause.AssignmentColumns([]string{"note", "updated_at"})}).Create(bookmark).Error; err != nil {
		return err
	}
	return r.db.WithContext(ctx).Where("message_id = ? AND user_id = ?", bookmark.MessageID, bookmark.UserID).First(bookmark).Error
}
func (r *ChatRepository) DeleteBookmark(ctx context.Context, userID, messageID uuid.UUID) error {
	return r.db.WithContext(ctx).Where("message_id = ? AND user_id = ?", messageID, userID).Delete(&model.ChatBookmark{}).Error
}

// Messages have already been authorized as one user's transcript. Load metadata
// in bounded batches, including for the legacy complete-history endpoint.
func (r *ChatRepository) LoadBookmarks(ctx context.Context, userID uuid.UUID, messages []model.ChatMessage) error {
	for start := 0; start < len(messages); start += 500 {
		end := min(start+500, len(messages))
		ids := make([]uuid.UUID, 0, end-start)
		for _, m := range messages[start:end] {
			ids = append(ids, m.ID)
		}
		var bookmarks []model.ChatBookmark
		if err := r.db.WithContext(ctx).Where("user_id = ? AND message_id IN ?", userID, ids).Find(&bookmarks).Error; err != nil {
			return err
		}
		byID := map[uuid.UUID]*model.ChatBookmark{}
		for i := range bookmarks {
			byID[bookmarks[i].MessageID] = &bookmarks[i]
		}
		for i := start; i < end; i++ {
			messages[i].Bookmark = byID[messages[i].ID]
		}
	}
	return nil
}

func (r *ChatRepository) ListBookmarks(ctx context.Context, userID uuid.UUID, roles []string, q dto.PersonalListQuery) ([]ChatBookmarkItem, int64, error) {
	base := func() *gorm.DB {
		db := r.db.WithContext(ctx).Model(&model.ChatBookmark{}).
			Joins("JOIN chat_messages ON chat_messages.id = chat_bookmarks.message_id").
			Joins("JOIN chat_sessions ON chat_sessions.id = chat_messages.session_id").
			Joins("JOIN knowledge_bases ON knowledge_bases.id = chat_sessions.knowledge_base_id").
			Where("chat_bookmarks.user_id = ? AND chat_sessions.user_id = ? AND chat_sessions.deleted_at IS NULL", userID, userID).
			Where("chat_messages.role = ? AND knowledge_bases.deleted_at IS NULL", "assistant").
			Where(reachableKnowledgeBaseCondition(r.db, userID, roles)).Where(reachableChatLinks(userID, roles))
		if q.Q != "" {
			pattern := "%" + strings.NewReplacer("!", "!!", "%", "!%", "_", "!_").Replace(strings.ToLower(q.Q)) + "%"
			db = db.Where("LOWER(chat_messages.content) LIKE ? ESCAPE '!' OR LOWER(chat_bookmarks.note) LIKE ? ESCAPE '!' OR LOWER(chat_sessions.title) LIKE ? ESCAPE '!'", pattern, pattern, pattern)
		}
		return db
	}
	var total int64
	if err := base().Count(&total).Error; err != nil {
		return nil, 0, err
	}
	items := []ChatBookmarkItem{}
	err := base().Select(`chat_messages.id AS message_id, chat_messages.session_id, chat_sessions.title AS session_title,
 chat_sessions.archived_at, chat_messages.role, chat_messages.content, chat_messages.created_at,
 chat_bookmarks.note, chat_bookmarks.created_at AS bookmarked_at, chat_bookmarks.updated_at AS bookmark_updated_at`).
		Order("chat_bookmarks.created_at DESC, chat_bookmarks.message_id DESC").Offset((q.Page - 1) * q.PageSize).Limit(q.PageSize).Scan(&items).Error
	return items, total, err
}
