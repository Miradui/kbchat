package repository

import (
	"context"
	"github.com/google/uuid"
	"kbchat/backend/internal/access"
	"kbchat/backend/internal/model"
)

// ListChatKnowledgeBases is deliberately unpaginated: UI page sizes and the
// manual selection limit must never silently narrow automatic retrieval.
func (r *KnowledgeBaseRepository) ListChatKnowledgeBases(ctx context.Context, userID uuid.UUID) ([]model.KnowledgeBase, error) {
	var items []model.KnowledgeBase
	err := r.db.WithContext(ctx).Model(&model.KnowledgeBase{}).
		Where(reachableKnowledgeBaseCondition(r.db, userID, access.MemberRolesWith(access.CapChatUse))).
		Where("knowledge_bases.deleted_at IS NULL").
		Order("knowledge_bases.created_at DESC, knowledge_bases.id").Find(&items).Error
	return items, err
}
