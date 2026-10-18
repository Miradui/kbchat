package service

import (
	"context"
	"github.com/google/uuid"
	"kbchat/backend/internal/access"
	"kbchat/backend/internal/apperror"
	"kbchat/backend/internal/dto"
	"kbchat/backend/internal/model"
)

type multiChatRetrievalService interface {
	SearchMany(context.Context, uuid.UUID, []uuid.UUID, dto.SearchRequest) (*dto.SearchResponse, error)
}

type automaticChatRetrievalService interface {
	SearchAutomatic(context.Context, uuid.UUID, []uuid.UUID, dto.SearchRequest) (*dto.SearchResponse, error)
}

func chatScopeMode(session *model.ChatSession) string {
	if session.IsAutomatic() {
		return model.ChatScopeAuto
	}
	return model.ChatScopeManual
}

func (s *ChatService) searchAutomaticSession(ctx context.Context, userID uuid.UUID, session *model.ChatSession, req dto.SearchRequest) (*dto.SearchResponse, error) {
	automatic, ok := s.retrieval.(automaticChatRetrievalService)
	if !ok {
		return nil, apperror.New(500, "INTERNAL_ERROR", "automatic retrieval is not configured")
	}
	bases, err := s.knowledgeBases.ListChatKnowledgeBases(ctx, userID)
	if err != nil {
		return nil, apperror.Internal(err)
	}
	ids := make([]uuid.UUID, 0, len(bases))
	allowed := make(map[uuid.UUID]model.KnowledgeBase, len(bases))
	for _, kb := range bases {
		ids = append(ids, kb.ID)
		allowed[kb.ID] = kb
	}
	if len(ids) == 0 {
		return nil, apperror.NotFound("RESOURCE_NOT_FOUND", "resource not found")
	}
	res, err := automatic.SearchAutomatic(ctx, userID, ids, req)
	if err != nil {
		return nil, err
	}
	seen := map[uuid.UUID]bool{}
	for _, id := range session.KnowledgeBaseIDs() {
		seen[id] = true
	}
	links := []model.ChatSessionKnowledgeBase{}
	for _, item := range res.Items {
		id, err := uuid.Parse(item.KnowledgeBaseID)
		kb, exists := allowed[id]
		if err != nil || !exists {
			return nil, apperror.New(500, "INTERNAL_ERROR", "retrieval returned a base outside the authorized scope")
		}
		if _, err := s.authorizeKnowledgeBase(ctx, userID, id, access.CapChatUse); err != nil {
			return nil, apperror.NotFound("RESOURCE_NOT_FOUND", "resource not found")
		}
		if !seen[id] {
			links = append(links, model.ChatSessionKnowledgeBase{SessionID: session.ID, KnowledgeBaseID: id, KnowledgeBase: kb})
			seen[id] = true
		}
	}
	if session.ID != uuid.Nil {
		if err := s.chats.AddSessionKnowledgeBases(ctx, session, links); err != nil {
			return nil, apperror.Internal(err)
		}
	}
	session.KnowledgeBaseLinks = append(session.KnowledgeBaseLinks, links...)
	return res, nil
}

func (s *ChatService) searchSession(ctx context.Context, userID uuid.UUID, session *model.ChatSession, req dto.SearchRequest) (*dto.SearchResponse, error) {
	var err error
	req.DocumentIDs, err = s.validateSessionDocuments(ctx, session)
	if err != nil {
		return nil, err
	}
	if session.IsAutomatic() {
		return s.searchAutomaticSession(ctx, userID, session, req)
	}
	if len(session.KnowledgeBaseLinks) == 0 {
		return s.retrieval.Search(ctx, userID, session.KnowledgeBaseID, req)
	}
	multi, ok := s.retrieval.(multiChatRetrievalService)
	if !ok {
		return nil, apperror.New(500, "INTERNAL_ERROR", "multi-base retrieval is not configured")
	}
	return multi.SearchMany(ctx, userID, session.KnowledgeBaseIDs(), req)
}
