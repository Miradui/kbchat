package repository

import (
	"context"
	"github.com/google/uuid"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"kbchat/backend/internal/model"
)

// The primary base is checked by existing joins. A transcript is reachable only
// when every additional base is also live and grants the required capability.
func reachableChatLinks(userID uuid.UUID, roles []string) clause.Expression {
	return clause.Expr{SQL: `NOT EXISTS (
		SELECT 1 FROM chat_session_knowledge_bases AS links
		LEFT JOIN knowledge_bases AS linked_kb ON linked_kb.id = links.knowledge_base_id
		WHERE links.session_id = chat_sessions.id AND (
			linked_kb.id IS NULL OR linked_kb.deleted_at IS NOT NULL OR
			(linked_kb.owner_id <> ? AND NOT EXISTS (
				SELECT 1 FROM knowledge_base_members AS linked_member
				WHERE linked_member.knowledge_base_id = linked_kb.id
				AND linked_member.user_id = ? AND linked_member.role IN ?
			))
		))`, Vars: []any{userID, userID, roles}}
}

// Quality views are per-base operator views. Cross-base transcripts cannot be
// attributed to one base without exposing another base's content to its manager.
const singleBaseChatSQL = `chat_sessions.scope_mode <> 'auto' AND NOT EXISTS (SELECT 1 FROM chat_session_knowledge_bases AS links WHERE links.session_id = chat_sessions.id)`

// Remember every base supplied to an automatic answer before exposing its
// content. Links only accumulate, including on an interrupted generation, so
// later scope changes cannot make a restricted transcript reachable again.
func (r *ChatRepository) AddSessionKnowledgeBases(ctx context.Context, session *model.ChatSession, links []model.ChatSessionKnowledgeBase) error {
	if len(links) == 0 {
		return nil
	}
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		current, err := lockWritableChatSession(tx, session.ID)
		if err != nil {
			return err
		}
		if current.UserID != session.UserID {
			return gorm.ErrRecordNotFound
		}
		for i := range links {
			links[i].SessionID = session.ID
		}
		return tx.Omit("KnowledgeBase").Clauses(clause.OnConflict{DoNothing: true}).Create(&links).Error
	})
}

func chatContainsBase(db *gorm.DB, id uuid.UUID) *gorm.DB {
	return db.Where(`chat_sessions.knowledge_base_id = ? OR EXISTS (
		SELECT 1 FROM chat_session_knowledge_bases AS links
		WHERE links.session_id = chat_sessions.id AND links.knowledge_base_id = ?
	)`, id, id)
}

func (r *ChatRepository) loadListLinks(ctx context.Context, items []ChatSessionListItem) error {
	if len(items) == 0 {
		return nil
	}
	ids := make([]uuid.UUID, 0, len(items))
	for _, item := range items {
		ids = append(ids, item.ID)
	}
	var links []model.ChatSessionKnowledgeBase
	if err := r.db.WithContext(ctx).Preload("KnowledgeBase").Where("session_id IN ?", ids).
		Order("knowledge_base_id").Find(&links).Error; err != nil {
		return err
	}
	byID := map[uuid.UUID][]model.ChatSessionKnowledgeBase{}
	for _, link := range links {
		byID[link.SessionID] = append(byID[link.SessionID], link)
	}
	for i := range items {
		items[i].KnowledgeBaseLinks = byID[items[i].ID]
	}
	return nil
}
