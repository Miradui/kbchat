package service

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/google/uuid"
	"gorm.io/datatypes"
	"kbchat/backend/internal/apperror"
	"kbchat/backend/internal/dto"
	"kbchat/backend/internal/model"
)

func (s *ChatService) buildDocumentScope(ctx context.Context, values []string, baseIDs []uuid.UUID) (datatypes.JSON, error) {
	ids, err := dto.ParseDocumentIDs(values)
	if err != nil || len(ids) == 0 {
		return nil, err
	}
	docs, err := s.chats.FindScopeDocuments(ctx, ids, baseIDs)
	if err != nil {
		return nil, apperror.Internal(err)
	}
	if len(docs) != len(ids) {
		return nil, unavailableDocumentScope()
	}
	byID := map[uuid.UUID]model.Document{}
	for _, d := range docs {
		byID[d.ID] = d
	}
	scope := make([]dto.ChatDocumentResponse, 0, len(ids))
	for _, id := range ids {
		d := byID[id]
		scope = append(scope, dto.ChatDocumentResponse{ID: d.ID.String(), KnowledgeBaseID: d.KnowledgeBaseID.String(), Filename: d.Filename})
	}
	encoded, err := json.Marshal(scope)
	return encoded, err
}
func unavailableDocumentScope() error {
	return apperror.New(409, "DOCUMENT_SCOPE_UNAVAILABLE", "所选文档已删除、移动或不可访问，请重新选择提问范围")
}
func sessionDocuments(session *model.ChatSession) ([]dto.ChatDocumentResponse, error) {
	if len(session.DocumentScope) == 0 {
		return nil, nil
	}
	var docs []dto.ChatDocumentResponse
	if err := json.Unmarshal(session.DocumentScope, &docs); err != nil {
		return nil, apperror.Internal(err)
	}
	if docs == nil || len(docs) > dto.MaxChatDocuments {
		return nil, apperror.Internal(fmt.Errorf("invalid stored document scope"))
	}
	return docs, nil
}
func (s *ChatService) validateSessionDocuments(ctx context.Context, session *model.ChatSession) ([]string, error) {
	docs, err := sessionDocuments(session)
	if err != nil || len(docs) == 0 {
		return nil, err
	}
	values := make([]string, len(docs))
	expected := map[uuid.UUID]string{}
	for i, d := range docs {
		values[i] = d.ID
	}
	ids, err := dto.ParseDocumentIDs(values)
	if err != nil {
		return nil, unavailableDocumentScope()
	}
	for i, id := range ids {
		expected[id] = docs[i].KnowledgeBaseID
	}
	current, err := s.chats.FindScopeDocuments(ctx, ids, session.KnowledgeBaseIDs())
	if err != nil {
		return nil, apperror.Internal(err)
	}
	if len(current) != len(docs) {
		return nil, unavailableDocumentScope()
	}
	for _, d := range current {
		if expected[d.ID] != d.KnowledgeBaseID.String() {
			return nil, unavailableDocumentScope()
		}
	}
	return values, nil
}
