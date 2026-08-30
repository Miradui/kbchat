package service

import (
	"context"

	"github.com/google/uuid"

	"kbchat/backend/internal/access"
	"kbchat/backend/internal/apperror"
	"kbchat/backend/internal/model"
	"kbchat/backend/internal/repository"
)

// knowledgeBaseAccess is the outcome of one authorization decision.
type knowledgeBaseAccess struct {
	knowledgeBase *model.KnowledgeBase
	role          access.Role
}

// authorizeKnowledgeBase loads a knowledge base and decides whether the actor may
// exercise a capability on it.
//
// A free function rather than a method: DocumentService, ChatService and
// KnowledgeBaseService all need it, and all three already hold a
// *KnowledgeBaseRepository. Making it a method on one of them would mean either
// injecting that service into the others or duplicating the decision.
//
// This replaces the repository-level `WHERE owner_id = ?` predicates as the
// authorization boundary. That is a real loss of safety: a missed call site is
// now an authorization hole with no compile-time signal, where before it was a
// query that returned nothing. The compensation is the contract tests, which
// assert the status code for every resource id under cross-user access, a deleted
// knowledge base, and a revoked membership.
func authorizeKnowledgeBase(
	ctx context.Context,
	repo *repository.KnowledgeBaseRepository,
	actorID, kbID uuid.UUID,
	capability access.Capability,
) (knowledgeBaseAccess, error) {
	kb, err := repo.FindByID(ctx, kbID)
	if err != nil {
		return knowledgeBaseAccess{}, apperror.Internal(err)
	}
	if kb == nil {
		// FindByID already excludes soft-deleted rows, so a deleted knowledge base
		// is indistinguishable from a missing one here. That is intended: while it
		// is in the recycle bin, its documents and sessions are not reachable by
		// anybody, owner included. Restoring it goes through the deleted-row path.
		return knowledgeBaseAccess{}, apperror.NotFound("KNOWLEDGE_BASE_NOT_FOUND", "知识库不存在")
	}
	return authorizeLoadedKnowledgeBase(ctx, repo, actorID, kb, capability)
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
	if kb == nil {
		return knowledgeBaseAccess{}, apperror.NotFound("KNOWLEDGE_BASE_NOT_FOUND", "知识库不存在")
	}

	role := access.RoleOwner
	if kb.OwnerID != actorID {
		// Only looked up for non-owners: the owner's standing cannot be changed by a
		// member row, so reading one would be a query per request for nothing.
		stored, err := repo.FindMemberRole(ctx, kb.ID, actorID)
		if err != nil {
			return knowledgeBaseAccess{}, apperror.Internal(err)
		}
		role = access.Resolve(kb.OwnerID, actorID, access.Role(stored))
	}

	if role == access.RoleNone {
		// 404 rather than 403 for a caller with no standing at all: a 403 would
		// confirm that this id exists, which is exactly what someone probing ids
		// wants to learn.
		return knowledgeBaseAccess{}, apperror.NotFound("KNOWLEDGE_BASE_NOT_FOUND", "知识库不存在")
	}
	if !access.Allows(role, capability) {
		// 403 here, because this caller can already see the knowledge base. Hiding
		// the resource from someone who demonstrably has access to it would only
		// make a permission error look like a bug.
		return knowledgeBaseAccess{}, forbiddenCapability(role, capability)
	}
	return knowledgeBaseAccess{knowledgeBase: kb, role: role}, nil
}

// forbiddenCapability builds the 403 for a caller who has access to the knowledge
// base but not enough of it.
//
// The details carry the actor's role and what was required, because "无权限访问该资源"
// alone leaves the user unable to tell whether to ask for a higher role or stop
// trying. Neither value is sensitive: both are already visible to this caller
// through the permissions roster.
func forbiddenCapability(role access.Role, capability access.Capability) *apperror.Error {
	err := apperror.Forbidden()
	err.Message = capabilityMessage(capability)
	err.Details = map[string]any{
		"role":         string(role),
		"capability":   string(capability),
		"requiredRole": string(access.MinRole(capability)),
	}
	return err
}

// capabilityMessage explains what the caller cannot do, in the terms they saw it.
//
// Kept as an explicit map rather than derived from the capability name so the
// wording is in the product's language; an unmapped capability falls back to the
// generic message rather than leaking a constant like "content.purge" into the UI.
func capabilityMessage(capability access.Capability) string {
	messages := map[access.Capability]string{
		access.CapKnowledgeBaseRead:   "没有该知识库的访问权限",
		access.CapKnowledgeBaseSearch: "没有该知识库的检索权限",
		access.CapKnowledgeBaseWrite:  "只有管理员可以修改知识库设置",
		access.CapKnowledgeBaseDelete: "只有所有者可以删除知识库",
		access.CapDocumentRead:        "没有该知识库文档的访问权限",
		access.CapDocumentDownload:    "只有编辑者及以上可以下载原始文件",
		access.CapContentWrite:        "只有编辑者及以上可以修改知识库内容",
		access.CapContentPurge:        "只有管理员可以永久删除",
		access.CapChatUse:             "没有该知识库的提问权限",
		access.CapChatExport:          "没有该会话的导出权限",
		access.CapFeedbackWrite:       "没有该知识库的评价权限",
		access.CapQualityRead:         "只有管理员可以查看质量数据",
		access.CapMembersRead:         "只有管理员可以查看成员",
		access.CapMembersWrite:        "只有管理员可以管理成员",
	}
	if message, ok := messages[capability]; ok {
		return message
	}
	return "无权限访问该资源"
}
