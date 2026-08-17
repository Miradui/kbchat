package service

import (
	"context"
	"net/http"

	"github.com/google/uuid"

	"rag/backend/internal/apperror"
	"rag/backend/internal/dto"
	"rag/backend/internal/model"
	"rag/backend/internal/repository"
)

type KnowledgeBaseCategoryService struct {
	categories     *repository.KnowledgeBaseCategoryRepository
	knowledgeBases *repository.KnowledgeBaseRepository
}

func NewKnowledgeBaseCategoryService(
	categories *repository.KnowledgeBaseCategoryRepository,
	knowledgeBases *repository.KnowledgeBaseRepository,
) *KnowledgeBaseCategoryService {
	return &KnowledgeBaseCategoryService{
		categories:     categories,
		knowledgeBases: knowledgeBases,
	}
}

func (s *KnowledgeBaseCategoryService) Create(ctx context.Context, ownerID uuid.UUID, req dto.KnowledgeBaseCategoryRequest) (*dto.KnowledgeBaseCategoryResponse, error) {
	if err := s.ensureParent(ctx, ownerID, req.ParentID, uuid.Nil); err != nil {
		return nil, err
	}

	category := &model.KnowledgeBaseCategory{
		OwnerID:   ownerID,
		ParentID:  req.ParentID,
		Name:      req.Name,
		SortOrder: req.SortOrder,
	}
	if err := s.categories.Create(ctx, category); err != nil {
		return nil, apperror.Internal(err)
	}
	res := toCategoryResponse(category)
	return &res, nil
}

func (s *KnowledgeBaseCategoryService) ListTree(ctx context.Context, ownerID uuid.UUID) (*dto.KnowledgeBaseCategoryListResponse, error) {
	items, err := s.categories.ListByOwner(ctx, ownerID)
	if err != nil {
		return nil, apperror.Internal(err)
	}
	directCounts, err := s.knowledgeBases.CountByCategoryGrouped(ctx, ownerID)
	if err != nil {
		return nil, apperror.Internal(err)
	}

	byParent := make(map[uuid.UUID][]dto.KnowledgeBaseCategoryResponse)
	roots := make([]dto.KnowledgeBaseCategoryResponse, 0)
	for i := range items {
		res := toCategoryResponse(&items[i])
		if items[i].ParentID == nil {
			roots = append(roots, res)
			continue
		}
		byParent[*items[i].ParentID] = append(byParent[*items[i].ParentID], res)
	}
	// Attach children bottom-up so each node's total can absorb its subtree in
	// the same pass.
	var attach func([]dto.KnowledgeBaseCategoryResponse) []dto.KnowledgeBaseCategoryResponse
	attach = func(nodes []dto.KnowledgeBaseCategoryResponse) []dto.KnowledgeBaseCategoryResponse {
		for i := range nodes {
			nodes[i].Children = attach(byParent[nodes[i].ID])
			direct := directCounts[nodes[i].ID]
			total := direct
			for j := range nodes[i].Children {
				if nodes[i].Children[j].TotalCount != nil {
					total += *nodes[i].Children[j].TotalCount
				}
			}
			nodes[i].DirectCount = &direct
			nodes[i].TotalCount = &total
		}
		return nodes
	}

	return &dto.KnowledgeBaseCategoryListResponse{Items: attach(roots)}, nil
}

func (s *KnowledgeBaseCategoryService) Update(ctx context.Context, ownerID, id uuid.UUID, req dto.KnowledgeBaseCategoryRequest) (*dto.KnowledgeBaseCategoryResponse, error) {
	category, err := s.findCategory(ctx, ownerID, id)
	if err != nil {
		return nil, err
	}
	if err := s.ensureParent(ctx, ownerID, req.ParentID, id); err != nil {
		return nil, err
	}

	category.Name = req.Name
	category.ParentID = req.ParentID
	category.SortOrder = req.SortOrder
	if err := s.categories.Update(ctx, category); err != nil {
		return nil, apperror.Internal(err)
	}
	res := toCategoryResponse(category)
	return &res, nil
}

func (s *KnowledgeBaseCategoryService) Delete(ctx context.Context, ownerID, id uuid.UUID) error {
	category, err := s.findCategory(ctx, ownerID, id)
	if err != nil {
		return err
	}
	hasChildren, err := s.categories.HasChildren(ctx, id)
	if err != nil {
		return apperror.Internal(err)
	}
	if hasChildren {
		return apperror.New(http.StatusConflict, "CATEGORY_NOT_EMPTY", "category has child categories")
	}
	count, err := s.knowledgeBases.CountByCategory(ctx, ownerID, id)
	if err != nil {
		return apperror.Internal(err)
	}
	if count > 0 {
		return apperror.New(http.StatusConflict, "CATEGORY_NOT_EMPTY", "category has knowledge bases")
	}
	if err := s.categories.Delete(ctx, category); err != nil {
		return apperror.Internal(err)
	}
	return nil
}

func (s *KnowledgeBaseCategoryService) Reorder(ctx context.Context, ownerID uuid.UUID, req dto.KnowledgeBaseCategoryReorderRequest) (*dto.KnowledgeBaseBatchResultResponse, error) {
	if len(req.Items) == 0 {
		return nil, apperror.Validation(map[string]any{"items": "category items are required"})
	}

	existing, err := s.categories.ListByOwner(ctx, ownerID)
	if err != nil {
		return nil, apperror.Internal(err)
	}
	if len(existing) != len(req.Items) {
		return nil, apperror.Validation(map[string]any{"items": "complete owner category tree is required"})
	}

	existingSet := make(map[uuid.UUID]model.KnowledgeBaseCategory, len(existing))
	for i := range existing {
		existingSet[existing[i].ID] = existing[i]
	}

	submittedSet := make(map[uuid.UUID]struct{}, len(req.Items))
	updatedItems := make([]model.KnowledgeBaseCategory, 0, len(req.Items))
	for i := range req.Items {
		current, ok := existingSet[req.Items[i].ID]
		if !ok {
			return nil, apperror.NotFound("CATEGORY_NOT_FOUND", "category not found")
		}
		if _, duplicated := submittedSet[req.Items[i].ID]; duplicated {
			return nil, apperror.Validation(map[string]any{"items": "duplicate category id"})
		}
		submittedSet[req.Items[i].ID] = struct{}{}
		updatedItems = append(updatedItems, model.KnowledgeBaseCategory{
			ID:        current.ID,
			OwnerID:   ownerID,
			Name:      current.Name,
			ParentID:  req.Items[i].ParentID,
			SortOrder: req.Items[i].SortOrder,
		})
	}

	for i := range updatedItems {
		if updatedItems[i].ParentID == nil {
			continue
		}
		if *updatedItems[i].ParentID == updatedItems[i].ID {
			return nil, apperror.Validation(map[string]any{"parentId": "parent category cannot be self"})
		}
		if _, ok := submittedSet[*updatedItems[i].ParentID]; !ok {
			return nil, apperror.Validation(map[string]any{"items": "parent category must be included in the submitted tree"})
		}
	}

	if hasCategoryCycle(updatedItems) {
		return nil, apperror.Validation(map[string]any{"items": "category tree cannot contain cycles"})
	}

	if err := s.categories.ReplaceTree(ctx, ownerID, updatedItems); err != nil {
		return nil, apperror.Internal(err)
	}
	return &dto.KnowledgeBaseBatchResultResponse{ProcessedCount: len(updatedItems)}, nil
}

func (s *KnowledgeBaseCategoryService) ensureParent(ctx context.Context, ownerID uuid.UUID, parentID *uuid.UUID, selfID uuid.UUID) error {
	if parentID == nil {
		return nil
	}
	if *parentID == selfID {
		return apperror.Validation(map[string]any{"parentId": "parent category cannot be self"})
	}
	parent, err := s.categories.FindByIDAndOwner(ctx, *parentID, ownerID)
	if err != nil {
		return apperror.Internal(err)
	}
	if parent == nil {
		return apperror.NotFound("CATEGORY_NOT_FOUND", "category not found")
	}
	return nil
}

func (s *KnowledgeBaseCategoryService) findCategory(ctx context.Context, ownerID, id uuid.UUID) (*model.KnowledgeBaseCategory, error) {
	category, err := s.categories.FindByIDAndOwner(ctx, id, ownerID)
	if err != nil {
		return nil, apperror.Internal(err)
	}
	if category == nil {
		return nil, apperror.NotFound("CATEGORY_NOT_FOUND", "category not found")
	}
	return category, nil
}

func toCategoryResponse(category *model.KnowledgeBaseCategory) dto.KnowledgeBaseCategoryResponse {
	return dto.KnowledgeBaseCategoryResponse{
		ID:        category.ID,
		ParentID:  category.ParentID,
		Name:      category.Name,
		SortOrder: category.SortOrder,
		CreatedAt: category.CreatedAt,
		UpdatedAt: category.UpdatedAt,
	}
}

func hasCategoryCycle(items []model.KnowledgeBaseCategory) bool {
	parentByID := make(map[uuid.UUID]*uuid.UUID, len(items))
	for i := range items {
		parentByID[items[i].ID] = items[i].ParentID
	}

	const (
		notVisited = 0
		visiting   = 1
		visited    = 2
	)
	state := make(map[uuid.UUID]int, len(items))

	var visit func(uuid.UUID) bool
	visit = func(id uuid.UUID) bool {
		switch state[id] {
		case visiting:
			return true
		case visited:
			return false
		}
		state[id] = visiting
		parentID := parentByID[id]
		if parentID != nil {
			if _, ok := parentByID[*parentID]; ok && visit(*parentID) {
				return true
			}
		}
		state[id] = visited
		return false
	}

	for id := range parentByID {
		if state[id] == notVisited && visit(id) {
			return true
		}
	}
	return false
}
