package dto

import (
	"github.com/google/uuid"
	"kbchat/backend/internal/apperror"
)

const MaxChatDocuments = 20

type ChatDocumentResponse struct {
	ID              string `json:"id"`
	KnowledgeBaseID string `json:"knowledgeBaseId"`
	Filename        string `json:"filename"`
}

func ParseDocumentIDs(values []string) ([]uuid.UUID, error) {
	ids := make([]uuid.UUID, 0, len(values))
	seen := map[uuid.UUID]bool{}
	invalid := func() ([]uuid.UUID, error) {
		return nil, apperror.Validation(map[string]any{"documentIds": "请选择 1–20 个不同的有效文档"})
	}
	if values != nil && (len(values) == 0 || len(values) > MaxChatDocuments) {
		return invalid()
	}
	for _, value := range values {
		id, err := uuid.Parse(value)
		if err != nil || id == uuid.Nil || seen[id] {
			return invalid()
		}
		ids = append(ids, id)
		seen[id] = true
	}
	return ids, nil
}
