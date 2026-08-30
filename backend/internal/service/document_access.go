package service

import (
	"context"
	"errors"

	"github.com/google/uuid"

	"kbchat/backend/internal/access"
	"kbchat/backend/internal/apperror"
	"kbchat/backend/internal/model"
)

// authorizeDocument loads a document by id alone and then decides access from its
// knowledge base.
//
// The old path looked documents up with `JOIN knowledge_bases ... WHERE owner_id = ?`,
// which made every document endpoint owner-only and unreachable for a member of a
// shared knowledge base. Splitting the lookup from the decision is what lets a
// viewer read a document while only an editor downloads the original file.
//
// A document whose knowledge base is missing or soft-deleted resolves to
// DOCUMENT_NOT_FOUND rather than KNOWLEDGE_BASE_NOT_FOUND: the caller asked about a
// document id, and answering about a different resource would tell them the
// document exists.
func (s *DocumentService) authorizeDocument(
	ctx context.Context,
	actorID, documentID uuid.UUID,
	capability access.Capability,
) (*model.Document, error) {
	document, err := s.documents.FindByID(ctx, documentID)
	if err != nil {
		return nil, apperror.Internal(err)
	}
	if document == nil {
		return nil, apperror.NotFound("DOCUMENT_NOT_FOUND", "document not found")
	}
	if _, err := s.authorizeKnowledgeBase(ctx, actorID, document.KnowledgeBaseID, capability); err != nil {
		return nil, documentAccessError(err)
	}
	return document, nil
}

// authorizeDeletedDocument is authorizeDocument for a row in the recycle bin.
//
// Restore and permanent delete need it, and neither can use the live lookup: the
// document is soft-deleted, so FindByID excludes it.
func (s *DocumentService) authorizeDeletedDocument(
	ctx context.Context,
	actorID, documentID uuid.UUID,
	capability access.Capability,
) (*model.Document, error) {
	document, err := s.documents.FindDeletedByID(ctx, documentID)
	if err != nil {
		return nil, apperror.Internal(err)
	}
	if document == nil {
		return nil, apperror.NotFound("DOCUMENT_NOT_FOUND", "document not found")
	}
	if _, err := s.authorizeKnowledgeBase(ctx, actorID, document.KnowledgeBaseID, capability); err != nil {
		return nil, documentAccessError(err)
	}
	return document, nil
}

// authorizeKnowledgeBase is the knowledge-base-level check, for the endpoints that
// name a knowledge base instead of a document (upload, list, empty recycle bin).
func (s *DocumentService) authorizeKnowledgeBase(
	ctx context.Context,
	actorID, kbID uuid.UUID,
	capability access.Capability,
) (knowledgeBaseAccess, error) {
	return authorizeKnowledgeBase(ctx, s.knowledgeBases, actorID, kbID, capability)
}

// ensureDocumentsCapability checks a batch, stopping at the first id the actor
// cannot touch.
//
// All-or-nothing on purpose: a batch that silently skipped the documents the caller
// may not touch would report a processed count that does not match what happened,
// and the caller has no way to tell which ids were dropped.
func (s *DocumentService) ensureDocumentsCapability(
	ctx context.Context,
	actorID uuid.UUID,
	ids []uuid.UUID,
	capability access.Capability,
	deleted bool,
) error {
	for _, id := range ids {
		var err error
		if deleted {
			_, err = s.authorizeDeletedDocument(ctx, actorID, id, capability)
		} else {
			_, err = s.authorizeDocument(ctx, actorID, id, capability)
		}
		if err != nil {
			return err
		}
	}
	return nil
}

// documentAccessError rewrites a knowledge-base 404 into a document 404.
//
// A 403 is passed through unchanged: it is already about a capability, and its
// details name the role the caller holds, which is the useful part.
func documentAccessError(err error) error {
	var appErr *apperror.Error
	if errors.As(err, &appErr) && appErr.Code == "KNOWLEDGE_BASE_NOT_FOUND" {
		return apperror.NotFound("DOCUMENT_NOT_FOUND", "document not found")
	}
	return err
}
