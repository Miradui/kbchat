package service

import (
	"context"

	"github.com/google/uuid"

	"kbchat/backend/internal/access"
	"kbchat/backend/internal/apperror"
	"kbchat/backend/internal/authz"
	"kbchat/backend/internal/model"
	"kbchat/backend/internal/repository"
)

// knowledgeBaseAccess is the outcome of one authorization decision.
type knowledgeBaseAccess struct {
	knowledgeBase *model.KnowledgeBase
	role          access.Role
}

// authorizeKnowledgeBase decides whether the actor may exercise a capability on a
// knowledge base.
//
// The decision itself lives in internal/authz because retrieval needs the same
// one and cannot import this package. What stays here is the adaptation: a free
// function rather than a method, because DocumentService, ChatService and
// KnowledgeBaseService all need it and all three already hold a
// *KnowledgeBaseRepository.
func authorizeKnowledgeBase(
	ctx context.Context,
	repo *repository.KnowledgeBaseRepository,
	actorID, kbID uuid.UUID,
	capability access.Capability,
) (knowledgeBaseAccess, error) {
	decision, err := authz.KnowledgeBase(ctx, repo, actorID, kbID, capability)
	return knowledgeBaseAccess{knowledgeBase: decision.KnowledgeBase, role: decision.Role}, err
}

// authorizeLoadedKnowledgeBase is authorizeKnowledgeBase for a knowledge base the
// caller already has in hand, so a request does not read the same row twice.
//
// It is also the only entry point that can authorize a soft-deleted knowledge
// base, which the restore path needs.
func authorizeLoadedKnowledgeBase(
	ctx context.Context,
	repo *repository.KnowledgeBaseRepository,
	actorID uuid.UUID,
	kb *model.KnowledgeBase,
	capability access.Capability,
) (knowledgeBaseAccess, error) {
	decision, err := authz.LoadedKnowledgeBase(ctx, repo, actorID, kb, capability)
	return knowledgeBaseAccess{knowledgeBase: decision.KnowledgeBase, role: decision.Role}, err
}

// forbiddenCapability builds the 403 for a caller who has access to the knowledge
// base but not enough of it.
func forbiddenCapability(role access.Role, capability access.Capability) *apperror.Error {
	return authz.ForbiddenCapability(role, capability)
}
