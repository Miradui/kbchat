package service

import (
	"context"
	"strings"

	"github.com/google/uuid"

	"rag/backend/internal/apperror"
	"rag/backend/internal/dto"
	"rag/backend/internal/repository"
)

type GlobalSearchService struct {
	search *repository.GlobalSearchRepository
}

func NewGlobalSearchService(search *repository.GlobalSearchRepository) *GlobalSearchService {
	return &GlobalSearchService{search: search}
}

func (s *GlobalSearchService) Search(ctx context.Context, ownerID uuid.UUID, query string) (*dto.GlobalSearchResponse, error) {
	query = strings.TrimSpace(query)
	if query == "" {
		return &dto.GlobalSearchResponse{Items: []dto.GlobalSearchResultResponse{}}, nil
	}
	items, err := s.search.Search(ctx, ownerID, query, 20)
	if err != nil {
		return nil, apperror.Internal(err)
	}
	res := dto.GlobalSearchResponse{Items: make([]dto.GlobalSearchResultResponse, 0, len(items))}
	for i := range items {
		res.Items = append(res.Items, toGlobalSearchResponse(&items[i]))
	}
	return &res, nil
}

func toGlobalSearchResponse(item *repository.GlobalSearchResult) dto.GlobalSearchResultResponse {
	documentID := ""
	if item.DocumentID != nil {
		documentID = item.DocumentID.String()
	}
	return dto.GlobalSearchResultResponse{
		Type:              item.Type,
		ID:                item.ID.String(),
		KnowledgeBaseID:   item.KnowledgeBaseID.String(),
		KnowledgeBaseName: item.KnowledgeBaseName,
		DocumentID:        documentID,
		Filename:          item.Filename,
		Title:             item.Title,
		Snippet:           item.Snippet,
	}
}
