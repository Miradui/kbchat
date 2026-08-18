package repository

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"rag/backend/internal/dto"
	"rag/backend/internal/model"
)

type ChatRepository struct {
	db *gorm.DB
}

// ErrChatSessionNotDeleted means a restore or permanent delete lost a race and
// the session is no longer present in the recycle bin.
var ErrChatSessionNotDeleted = errors.New("chat session is not in the recycle bin")

// ErrChatMessageNotFound means an owner-scoped message disappeared between the
// read and the field-level feedback update.
var ErrChatMessageNotFound = errors.New("chat message not found")

// ErrChatMessageChanged means another write changed the target or its tail
// after the service loaded the conversation.
var ErrChatMessageChanged = errors.New("chat message changed concurrently")

func NewChatRepository(db *gorm.DB) *ChatRepository {
	return &ChatRepository{db: db}
}

func (r *ChatRepository) CreateSession(ctx context.Context, session *model.ChatSession) error {
	return r.db.WithContext(ctx).Create(session).Error
}

type ChatSessionListItem struct {
	ID                 uuid.UUID
	KnowledgeBaseID    uuid.UUID
	KnowledgeBaseName  string
	Title              string
	CreatedAt          time.Time
	UpdatedAt          time.Time
	ArchivedAt         *time.Time
	MessageCount       int64
	LastMessagePreview string
}

// ListSessions returns one page of the caller's sessions. Ownership is enforced
// twice on purpose: the session must belong to the user and the knowledge base
// behind it must still be owned by the same user and not deleted.
func (r *ChatRepository) ListSessions(ctx context.Context, userID uuid.UUID, query dto.ChatSessionListQuery, offset, limit int) ([]ChatSessionListItem, int64, error) {
	base := func() *gorm.DB {
		db := r.db.WithContext(ctx).
			Model(&model.ChatSession{}).
			Joins("JOIN knowledge_bases ON knowledge_bases.id = chat_sessions.knowledge_base_id").
			Where("chat_sessions.user_id = ?", userID).
			Where("knowledge_bases.owner_id = ?", userID).
			Where("knowledge_bases.deleted_at IS NULL").
			Where("chat_sessions.deleted_at IS NULL")
		if query.Archived {
			db = db.Where("chat_sessions.archived_at IS NOT NULL")
		} else {
			db = db.Where("chat_sessions.archived_at IS NULL")
		}
		if query.KnowledgeBaseID != nil {
			db = db.Where("chat_sessions.knowledge_base_id = ?", *query.KnowledgeBaseID)
		}
		if query.Q != "" {
			db = db.Where("LOWER(chat_sessions.title) LIKE ?", "%"+strings.ToLower(query.Q)+"%")
		}
		return db
	}

	var total int64
	if err := base().Count(&total).Error; err != nil {
		return nil, 0, err
	}

	// Correlated subqueries instead of GROUP BY: the message aggregates stay
	// independent of the knowledge base join and work the same on SQLite.
	var items []ChatSessionListItem
	err := base().
		Select(`
			chat_sessions.id AS id,
			chat_sessions.knowledge_base_id AS knowledge_base_id,
			knowledge_bases.name AS knowledge_base_name,
			chat_sessions.title AS title,
			chat_sessions.created_at AS created_at,
			chat_sessions.updated_at AS updated_at,
			chat_sessions.archived_at AS archived_at,
			(
				SELECT COUNT(*) FROM chat_messages
				WHERE chat_messages.session_id = chat_sessions.id
			) AS message_count,
			(
				SELECT chat_messages.content FROM chat_messages
				WHERE chat_messages.session_id = chat_sessions.id
				ORDER BY chat_messages.created_at DESC, chat_messages.id DESC
				LIMIT 1
			) AS last_message_preview
		`).
		Order("chat_sessions.updated_at desc").
		Limit(limit).
		Offset(offset).
		Scan(&items).Error
	return items, total, err
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
		Where("id = ? AND archived_at IS NULL", sessionID).
		Updates(map[string]any{
			"archived_at": archivedAt,
			"updated_at":  archivedAt,
		}).Error
}

func (r *ChatRepository) UnarchiveSession(ctx context.Context, sessionID uuid.UUID, updatedAt time.Time) error {
	return r.db.WithContext(ctx).
		Model(&model.ChatSession{}).
		Where("id = ? AND archived_at IS NOT NULL", sessionID).
		Updates(map[string]any{
			"archived_at": nil,
			"updated_at":  updatedAt,
		}).Error
}

// DeleteSession soft deletes. Messages are deliberately kept: the session can be
// restored from the recycle bin, and a restored session with no history would be
// indistinguishable from a new one. Permanent deletion is what clears them.
func (r *ChatRepository) DeleteSession(ctx context.Context, sessionID uuid.UUID) error {
	return r.db.WithContext(ctx).
		Where("id = ?", sessionID).
		Delete(&model.ChatSession{}).Error
}

func (r *ChatRepository) FindDeletedSessionByIDAndUser(ctx context.Context, sessionID, userID uuid.UUID) (*model.ChatSession, error) {
	var session model.ChatSession
	err := r.db.WithContext(ctx).
		Unscoped().
		Where("id = ? AND user_id = ?", sessionID, userID).
		Where("deleted_at IS NOT NULL").
		First(&session).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return &session, err
}

func (r *ChatRepository) RestoreSession(ctx context.Context, sessionID uuid.UUID) error {
	result := r.db.WithContext(ctx).
		Unscoped().
		Model(&model.ChatSession{}).
		Where("id = ? AND deleted_at IS NOT NULL", sessionID).
		Update("deleted_at", nil)
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return ErrChatSessionNotDeleted
	}
	return nil
}

type RecycleChatSessionItem struct {
	ID                uuid.UUID
	KnowledgeBaseID   uuid.UUID
	KnowledgeBaseName string
	Title             string
	DeletedAt         time.Time
}

// ListDeletedSessions mirrors the knowledge base and document recycle bins: the
// owning knowledge base must still exist and belong to the caller, so a session
// whose knowledge base was itself deleted is not offered for restore here.
func (r *ChatRepository) ListDeletedSessions(ctx context.Context, userID uuid.UUID, offset, limit int) ([]RecycleChatSessionItem, int64, error) {
	base := func() *gorm.DB {
		return deletedChatSessionsScope(r.db.WithContext(ctx), userID)
	}

	var total int64
	if err := base().Count(&total).Error; err != nil {
		return nil, 0, err
	}

	var items []RecycleChatSessionItem
	err := base().
		Select(`
			chat_sessions.id AS id,
			chat_sessions.knowledge_base_id AS knowledge_base_id,
			knowledge_bases.name AS knowledge_base_name,
			chat_sessions.title AS title,
			chat_sessions.deleted_at AS deleted_at
		`).
		Order("chat_sessions.deleted_at desc, chat_sessions.id asc").
		Limit(limit).
		Offset(offset).
		Scan(&items).Error
	return items, total, err
}

// PermanentDeleteSession drops the session and its messages for good.
func (r *ChatRepository) PermanentDeleteSession(ctx context.Context, sessionID uuid.UUID) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := lockDeletedChatSession(tx, sessionID); err != nil {
			return err
		}
		return permanentDeleteChatSessions(tx, []uuid.UUID{sessionID})
	})
}

// EmptyDeletedSessions clears the caller's chat recycle bin in one transaction,
// keeping the all-or-nothing semantics of the other empty endpoints.
func (r *ChatRepository) EmptyDeletedSessions(ctx context.Context, userID uuid.UUID) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var ids []uuid.UUID
		if err := deletedChatSessionsScope(tx, userID).
			Clauses(clause.Locking{
				Strength: "UPDATE",
				Table:    clause.Table{Name: "chat_sessions"},
			}).
			Pluck("chat_sessions.id", &ids).Error; err != nil {
			return err
		}
		return permanentDeleteChatSessions(tx, ids)
	})
}

func lockDeletedChatSession(tx *gorm.DB, sessionID uuid.UUID) error {
	var session model.ChatSession
	if err := tx.
		Unscoped().
		Select("id").
		Clauses(clause.Locking{Strength: "UPDATE"}).
		Where("id = ? AND deleted_at IS NOT NULL", sessionID).
		First(&session).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return ErrChatSessionNotDeleted
		}
		return err
	}
	return nil
}

// deletedChatSessionsScope is the definition of the chat recycle bin. Listing
// and destructive bulk operations must share it exactly: sessions under a
// deleted or no-longer-owned knowledge base are intentionally hidden until that
// knowledge base becomes visible to the owner again.
func deletedChatSessionsScope(db *gorm.DB, userID uuid.UUID) *gorm.DB {
	return db.
		Unscoped().
		Model(&model.ChatSession{}).
		Joins("JOIN knowledge_bases ON knowledge_bases.id = chat_sessions.knowledge_base_id").
		Where("chat_sessions.user_id = ?", userID).
		Where("knowledge_bases.owner_id = ?", userID).
		Where("knowledge_bases.deleted_at IS NULL").
		Where("chat_sessions.deleted_at IS NOT NULL")
}

func permanentDeleteChatSessions(tx *gorm.DB, sessionIDs []uuid.UUID) error {
	if len(sessionIDs) == 0 {
		return nil
	}
	if err := tx.Where("session_id IN ?", sessionIDs).Delete(&model.ChatMessage{}).Error; err != nil {
		return err
	}
	return tx.Unscoped().Where("id IN ?", sessionIDs).Delete(&model.ChatSession{}).Error
}

func (r *ChatRepository) ListMessages(ctx context.Context, sessionID uuid.UUID) ([]model.ChatMessage, error) {
	var messages []model.ChatMessage
	err := r.db.WithContext(ctx).
		Where("session_id = ?", sessionID).
		Order("created_at asc, id asc").
		Find(&messages).Error
	return messages, err
}

// FindMessageByIDAndOwner applies the same visibility rule as the chat page:
// the session and its knowledge base must both still be visible to their owner.
func (r *ChatRepository) FindMessageByIDAndOwner(ctx context.Context, messageID, ownerID uuid.UUID) (*model.ChatMessage, error) {
	var message model.ChatMessage
	err := r.db.WithContext(ctx).
		Model(&model.ChatMessage{}).
		Select("chat_messages.*").
		Joins("JOIN chat_sessions ON chat_sessions.id = chat_messages.session_id").
		Joins("JOIN knowledge_bases ON knowledge_bases.id = chat_sessions.knowledge_base_id").
		Where("chat_messages.id = ?", messageID).
		Where("chat_sessions.user_id = ?", ownerID).
		Where("chat_sessions.deleted_at IS NULL").
		Where("knowledge_bases.owner_id = ?", ownerID).
		Where("knowledge_bases.deleted_at IS NULL").
		First(&message).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return &message, err
}

// UpdateMessageFeedback is deliberately field-level so it cannot overwrite
// message content, citations or a concurrently persisted rerank fallback.
func (r *ChatRepository) UpdateMessageFeedback(
	ctx context.Context,
	messageID uuid.UUID,
	rating string,
	updatedAt time.Time,
) error {
	result := r.db.WithContext(ctx).
		Model(&model.ChatMessage{}).
		Where("id = ? AND role = ?", messageID, "assistant").
		Updates(map[string]any{
			"feedback_rating":     rating,
			"feedback_updated_at": updatedAt,
		})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return ErrChatMessageNotFound
	}
	return nil
}

func (r *ChatRepository) FindMessagesByClientRequestID(ctx context.Context, sessionID, clientRequestID uuid.UUID) ([]model.ChatMessage, error) {
	var messages []model.ChatMessage
	err := r.db.WithContext(ctx).
		Where("session_id = ? AND client_request_id = ?", sessionID, clientRequestID).
		Order("created_at asc, id asc").
		Find(&messages).Error
	return messages, err
}

func (r *ChatRepository) CreateMessage(ctx context.Context, message *model.ChatMessage) error {
	return r.db.WithContext(ctx).Create(message).Error
}

func (r *ChatRepository) CreateMessages(ctx context.Context, messages ...*model.ChatMessage) error {
	return r.createMessages(ctx, nil, false, messages...)
}

func (r *ChatRepository) CreateMessagesIfUnchanged(
	ctx context.Context,
	expectedMessageIDs []uuid.UUID,
	messages ...*model.ChatMessage,
) error {
	return r.createMessages(ctx, expectedMessageIDs, true, messages...)
}

func (r *ChatRepository) createMessages(
	ctx context.Context,
	expectedMessageIDs []uuid.UUID,
	checkSnapshot bool,
	messages ...*model.ChatMessage,
) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if len(messages) > 0 {
			var session model.ChatSession
			if err := tx.Select("id").Clauses(clause.Locking{Strength: "UPDATE"}).
				Where("id = ?", messages[0].SessionID).First(&session).Error; err != nil {
				return err
			}
			if checkSnapshot {
				var current []model.ChatMessage
				if err := tx.Select("id").Where("session_id = ?", messages[0].SessionID).
					Order("created_at asc, id asc").Find(&current).Error; err != nil {
					return err
				}
				if !sameUUIDs(messageIDs(current), expectedMessageIDs) {
					return ErrChatMessageChanged
				}
			}
		}
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

// ReplaceMessageTail updates an existing user turn and atomically removes the
// messages that followed it before creating the regenerated assistant turn.
// IDs are supplied by the service from its ordered snapshot so this operation
// never guesses ordering from timestamps or UUID values.
func (r *ChatRepository) ReplaceMessageTail(
	ctx context.Context,
	sessionID, targetMessageID uuid.UUID,
	expectedClientRequestID *uuid.UUID,
	expectedTailIDs []uuid.UUID,
	userMessage *model.ChatMessage,
	assistantMessage *model.ChatMessage,
) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var session model.ChatSession
		if err := tx.Select("id").Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("id = ?", sessionID).First(&session).Error; err != nil {
			return err
		}
		var current []model.ChatMessage
		if err := tx.Where("session_id = ?", sessionID).
			Order("created_at asc, id asc").Find(&current).Error; err != nil {
			return err
		}
		targetIndex := -1
		for i := range current {
			if current[i].ID == targetMessageID {
				targetIndex = i
				break
			}
		}
		if targetIndex < 0 || current[targetIndex].Role != "user" {
			return ErrChatMessageNotFound
		}
		if !sameOptionalUUID(current[targetIndex].ClientRequestID, expectedClientRequestID) ||
			!sameUUIDs(messageIDs(current[targetIndex+1:]), expectedTailIDs) {
			return ErrChatMessageChanged
		}
		target := current[targetIndex]

		if len(expectedTailIDs) > 0 {
			if err := tx.Where("session_id = ? AND id IN ?", sessionID, expectedTailIDs).
				Delete(&model.ChatMessage{}).Error; err != nil {
				return err
			}
		}

		if err := tx.Model(&target).Updates(map[string]any{
			"client_request_id":   userMessage.ClientRequestID,
			"content":             userMessage.Content,
			"citations":           userMessage.Citations,
			"rerank_fallback":     userMessage.RerankFallback,
			"feedback_rating":     nil,
			"feedback_updated_at": nil,
		}).Error; err != nil {
			return err
		}

		if err := tx.Create(assistantMessage).Error; err != nil {
			return err
		}
		return tx.Model(&model.ChatSession{}).
			Where("id = ?", sessionID).
			Update("updated_at", time.Now()).Error
	})
}

func messageIDs(messages []model.ChatMessage) []uuid.UUID {
	ids := make([]uuid.UUID, 0, len(messages))
	for i := range messages {
		ids = append(ids, messages[i].ID)
	}
	return ids
}

func sameUUIDs(left, right []uuid.UUID) bool {
	if len(left) != len(right) {
		return false
	}
	for i := range left {
		if left[i] != right[i] {
			return false
		}
	}
	return true
}

func sameOptionalUUID(left, right *uuid.UUID) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}
