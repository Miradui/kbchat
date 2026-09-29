package dto

import (
	"github.com/google/uuid"
	"kbchat/backend/internal/apperror"
)

const MaxChatKnowledgeBases = 5

// ParseKnowledgeBaseIDs rejects ambiguous, duplicate or unbounded scopes before
// any authorization or model work. The first ID is the usage attribution base.
func ParseKnowledgeBaseIDs(primary string, values []string) ([]uuid.UUID, error) {
	if values == nil && primary != "" {
		values = []string{primary}
	}
	invalid := func() ([]uuid.UUID, error) {
		return nil, apperror.Validation(map[string]any{"knowledgeBaseIds": "provide 1 to 5 unique knowledge base IDs; knowledgeBaseId must match the first ID when both are supplied"})
	}
	if len(values) == 0 || len(values) > MaxChatKnowledgeBases {
		return invalid()
	}
	ids := make([]uuid.UUID, 0, len(values))
	seen := map[uuid.UUID]bool{}
	for _, value := range values {
		id, err := uuid.Parse(value)
		if err != nil || id == uuid.Nil || seen[id] {
			return invalid()
		}
		seen[id] = true
		ids = append(ids, id)
	}
	if primary != "" {
		id, err := uuid.Parse(primary)
		if err != nil || id != ids[0] {
			return invalid()
		}
	}
	return ids, nil
}

type ChatKnowledgeBaseResponse struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type MultiSearchRequest struct {
	KnowledgeBaseIDs []string `json:"knowledgeBaseIds"`
	SearchRequest
}
