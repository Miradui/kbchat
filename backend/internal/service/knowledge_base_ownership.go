package service

import (
	"context"
	"errors"
	"github.com/google/uuid"
	"kbchat/backend/internal/access"
	"kbchat/backend/internal/apperror"
	"kbchat/backend/internal/dto"
	"kbchat/backend/internal/repository"
	"net/http"
)

func (s *KnowledgeBaseService) TransferOwnership(ctx context.Context, actorID, kbID uuid.UUID, req dto.TransferOwnershipRequest) (*dto.TransferOwnershipResponse, error) {
	kb, err := s.findKnowledgeBaseForCapability(ctx, actorID, kbID, access.CapKnowledgeBaseTransfer)
	if err != nil {
		return nil, err
	}
	return s.transferOwnership(ctx, actorID, kb.OwnerID, &kbID, req)
}

func (s *KnowledgeBaseService) transferOwnership(ctx context.Context, actorID, ownerID uuid.UUID, kbID *uuid.UUID, req dto.TransferOwnershipRequest) (*dto.TransferOwnershipResponse, error) {
	items, err := s.repo.TransferOwnership(ctx, kbID, ownerID, req.NewOwnerID, actorID, req.KeepPreviousOwnerAsManager)
	switch {
	case errors.Is(err, repository.ErrTransferTargetInvalid):
		return nil, apperror.New(http.StatusBadRequest, "TRANSFER_TARGET_INVALID", "请选择其他启用状态的用户作为新所有者")
	case errors.Is(err, repository.ErrOwnershipChanged):
		return nil, apperror.New(http.StatusConflict, "OWNERSHIP_CHANGED", "知识库所有权或状态已变化，请刷新后重试")
	case errors.Is(err, repository.ErrAdminUserNotFound):
		return nil, apperror.NotFound("USER_NOT_FOUND", "用户不存在")
	case err != nil:
		return nil, apperror.Internal(err)
	}
	if s.activities != nil {
		for _, kb := range items {
			entry := ActivityEntry{Action: "kb.ownership_transferred", ResourceType: "knowledgeBase", ResourceID: kb.ID, ResourceName: kb.Name, KnowledgeBaseID: &kb.ID, KnowledgeBaseName: kb.Name}
			s.activities.Record(ctx, actorID, entry)
			if req.NewOwnerID != actorID {
				s.activities.Record(ctx, req.NewOwnerID, entry)
			}
		}
	}
	return &dto.TransferOwnershipResponse{TransferredCount: len(items)}, nil
}

func (s *AdminUserService) SetOwnershipService(kbs *KnowledgeBaseService) { s.ownership = kbs }

func (s *AdminUserService) TransferKnowledgeBases(ctx context.Context, actorID, ownerID uuid.UUID, req dto.TransferOwnershipRequest) (*dto.TransferOwnershipResponse, error) {
	actor, err := s.users.FindByID(ctx, actorID)
	if err != nil {
		return nil, apperror.Internal(err)
	}
	if actor == nil || actor.Role != "admin" || actor.Status != "active" {
		return nil, apperror.New(http.StatusForbidden, "SYSTEM_ADMIN_REQUIRED", "需要系统管理员权限")
	}
	if s.ownership == nil {
		return nil, apperror.Internal(errors.New("ownership service unavailable"))
	}
	return s.ownership.transferOwnership(ctx, actorID, ownerID, nil, req)
}
