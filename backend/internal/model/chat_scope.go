package model

import "github.com/google/uuid"

const (
	ChatScopeAuto   = "auto"
	ChatScopeManual = "manual"
)

func (s *ChatSession) IsAutomatic() bool { return s.ScopeMode == ChatScopeAuto }

// ChatSessionKnowledgeBase stores additional bases. The first base remains in
// chat_sessions.knowledge_base_id for compatibility and usage attribution.
type ChatSessionKnowledgeBase struct {
	SessionID       uuid.UUID     `gorm:"type:uuid;primaryKey"`
	KnowledgeBaseID uuid.UUID     `gorm:"type:uuid;primaryKey;index"`
	KnowledgeBase   KnowledgeBase `gorm:"foreignKey:KnowledgeBaseID;constraint:OnDelete:RESTRICT"`
}

func (s *ChatSession) KnowledgeBaseIDs() []uuid.UUID {
	ids := []uuid.UUID{s.KnowledgeBaseID}
	for _, link := range s.KnowledgeBaseLinks {
		if link.KnowledgeBaseID != s.KnowledgeBaseID {
			ids = append(ids, link.KnowledgeBaseID)
		}
	}
	return ids
}
