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

func (s *GlobalSearchService) Search(ctx context.Context, ownerID uuid.UUID, req dto.GlobalSearchRequest) (*dto.GlobalSearchResponse, error) {
	query := strings.TrimSpace(req.Query)
	if query == "" {
		return nil, apperror.Validation(map[string]any{"q": "查询不能为空"})
	}
	resultType := strings.TrimSpace(req.Type)
	if resultType == "" {
		resultType = "all"
	}
	if resultType != "all" && resultType != "knowledgeBase" && resultType != "document" && resultType != "chunk" {
		return nil, apperror.Validation(map[string]any{"type": "type must be one of all, knowledgeBase, document, chunk"})
	}
	page := req.Page
	if page <= 0 {
		page = 1
	}
	pageSize := req.PageSize
	if pageSize <= 0 {
		pageSize = 20
	}
	if pageSize > 100 {
		pageSize = 100
	}
	items, total, err := s.search.Search(ctx, ownerID, query, resultType, (page-1)*pageSize, pageSize)
	if err != nil {
		return nil, apperror.Internal(err)
	}
	res := dto.GlobalSearchResponse{
		Items:    make([]dto.GlobalSearchResultResponse, 0, len(items)),
		Total:    total,
		Page:     page,
		PageSize: pageSize,
	}
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
