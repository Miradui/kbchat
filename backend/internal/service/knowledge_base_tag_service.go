package service

import (
	"context"
	"net/http"
	"strings"

	"github.com/google/uuid"

	"kbchat/backend/internal/apperror"
	"kbchat/backend/internal/dto"
	"kbchat/backend/internal/model"
	"kbchat/backend/internal/repository"
)

type KnowledgeBaseTagService struct {
	tags     *repository.KnowledgeBaseTagRepository
	bindings *repository.KnowledgeBaseTagBindingRepository
}

func NewKnowledgeBaseTagService(tags *repository.KnowledgeBaseTagRepository, bindings *repository.KnowledgeBaseTagBindingRepository) *KnowledgeBaseTagService {
	return &KnowledgeBaseTagService{tags: tags, bindings: bindings}
}

func (s *KnowledgeBaseTagService) Create(ctx context.Context, ownerID uuid.UUID, name string) (*dto.KnowledgeBaseTagResponse, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return nil, apperror.Validation(map[string]any{"name": "标签名称不能为空"})
	}

	tag := &model.KnowledgeBaseTag{OwnerID: ownerID, Name: name}
	if err := s.tags.Create(ctx, tag); err != nil {
		return nil, apperror.Internal(err)
	}
	res := toTagResponse(tag)
	// A freshly created tag is bound to nothing yet.
	zero := int64(0)
	res.KnowledgeBaseCount = &zero
	return &res, nil
}

func (s *KnowledgeBaseTagService) List(ctx context.Context, ownerID uuid.UUID) (*dto.KnowledgeBaseTagListResponse, error) {
	items, err := s.tags.ListByOwner(ctx, ownerID)
	if err != nil {
		return nil, apperror.Internal(err)
	}
	counts, err := s.tags.CountBindingsByOwner(ctx, ownerID)
	if err != nil {
		return nil, apperror.Internal(err)
	}
	res := dto.KnowledgeBaseTagListResponse{Items: make([]dto.KnowledgeBaseTagResponse, 0, len(items))}
	for i := range items {
		item := toTagResponse(&items[i])
		count := counts[items[i].ID]
		item.KnowledgeBaseCount = &count
		res.Items = append(res.Items, item)
	}
	return &res, nil
}

func (s *KnowledgeBaseTagService) Update(ctx context.Context, ownerID, id uuid.UUID, name string) (*dto.KnowledgeBaseTagResponse, error) {
	tag, err := s.findTag(ctx, ownerID, id)
	if err != nil {
		return nil, err
	}
	name = strings.TrimSpace(name)
	if name == "" {
		return nil, apperror.Validation(map[string]any{"name": "标签名称不能为空"})
	}
	tag.Name = name
	if err := s.tags.Update(ctx, tag); err != nil {
		return nil, apperror.Internal(err)
	}
	count, err := s.tags.CountBindings(ctx, ownerID, tag.ID)
	if err != nil {
		return nil, apperror.Internal(err)
	}
	res := toTagResponse(tag)
	res.KnowledgeBaseCount = &count
	return &res, nil
}

func (s *KnowledgeBaseTagService) Delete(ctx context.Context, ownerID, id uuid.UUID) error {
	tag, err := s.findTag(ctx, ownerID, id)
	if err != nil {
		return err
	}
	count, err := s.tags.CountBindings(ctx, ownerID, tag.ID)
	if err != nil {
		return apperror.Internal(err)
	}
	if count > 0 {
		return apperror.New(http.StatusConflict, "TAG_NOT_EMPTY", "标签仍被知识库引用，不能删除")
	}
	if err := s.tags.Delete(ctx, tag); err != nil {
		return apperror.Internal(err)
	}
	return nil
}

func (s *KnowledgeBaseTagService) ReplaceKnowledgeBaseTags(ctx context.Context, ownerID, kbID uuid.UUID, tagIDs []uuid.UUID) error {
	if len(tagIDs) == 0 {
		return s.bindings.ReplaceForKnowledgeBase(ctx, kbID, nil)
	}
	items, err := s.tags.FindByIDsAndOwner(ctx, ownerID, tagIDs)
	if err != nil {
		return apperror.Internal(err)
	}
	if len(items) != len(tagIDs) {
		return apperror.NotFound("TAG_NOT_FOUND", "标签不存在")
	}
	return s.bindings.ReplaceForKnowledgeBase(ctx, kbID, tagIDs)
}

func (s *KnowledgeBaseTagService) findTag(ctx context.Context, ownerID, id uuid.UUID) (*model.KnowledgeBaseTag, error) {
	tag, err := s.tags.FindByIDAndOwner(ctx, id, ownerID)
	if err != nil {
		return nil, apperror.Internal(err)
	}
	if tag == nil {
		return nil, apperror.NotFound("TAG_NOT_FOUND", "标签不存在")
	}
	return tag, nil
}

func toTagResponse(tag *model.KnowledgeBaseTag) dto.KnowledgeBaseTagResponse {
	return dto.KnowledgeBaseTagResponse{
		ID:        tag.ID,
		Name:      tag.Name,
		CreatedAt: tag.CreatedAt,
		UpdatedAt: tag.UpdatedAt,
	}
}
