package service

import (
	"context"
	"errors"
	"net/http"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"kbchat/backend/internal/access"
	"kbchat/backend/internal/apperror"
	"kbchat/backend/internal/model"
	"kbchat/backend/internal/repository"
)

// authorizeSession checks both halves of a chat session's access: the session must
// belong to the caller, and the caller must hold the capability on its knowledge
// base.
//
// Both are needed and neither implies the other. Session ownership is not a
// permission on the knowledge base -- a session outlives the membership that
// created it, so a revoked member must stop being able to ask new questions through
// their old session. And a capability on the knowledge base is not a right to
// someone else's transcript: chat_sessions.user_id stays the boundary there, which
// is why a manager cannot read a colleague's conversation.
//
// Every failure is RESOURCE_NOT_FOUND rather than a knowledge base code: the caller
// named a session id, so that is the resource the answer should be about.
func (s *ChatService) authorizeSession(
	ctx context.Context,
	userID, sessionID uuid.UUID,
	capability access.Capability,
) (*model.ChatSession, error) {
	session, err := s.chats.FindSessionByIDAndUser(ctx, sessionID, userID)
	if err != nil {
		return nil, apperror.Internal(err)
	}
	if session == nil {
		return nil, apperror.NotFound("RESOURCE_NOT_FOUND", "resource not found")
	}
	return session, s.authorizeSessionKnowledgeBase(ctx, userID, session, capability)
}

// authorizeWritableSession is authorizeSession plus the archived check that every
// path appending or replacing messages must pass.
//
// Archived sessions are read-only in the UI and in EditMessageAndRegenerate, but
// send, stream and regenerate used to skip the check. Besides letting a stale tab
// keep writing to an archived transcript, the automatic scope then tried to
// register a newly hit knowledge base through AddSessionKnowledgeBases, whose row
// lock excludes archived sessions; that surfaced as a 500 and was recorded as a
// retrieval_failed answer inside the archived conversation. One assertion here
// removes the whole class.
func (s *ChatService) authorizeWritableSession(
	ctx context.Context,
	userID, sessionID uuid.UUID,
	capability access.Capability,
) (*model.ChatSession, error) {
	session, err := s.authorizeSession(ctx, userID, sessionID, capability)
	if err != nil {
		return nil, err
	}
	if session.ArchivedAt != nil {
		return nil, chatWriteError(repository.ErrChatSessionArchived)
	}
	return session, nil
}

// Entry checks and transactional write conflicts expose the same state error.
func chatWriteError(err error) error {
	if errors.Is(err, repository.ErrChatSessionArchived) {
		return apperror.New(http.StatusConflict, "CHAT_SESSION_ARCHIVED", "会话已归档，请取消归档后重试")
	}
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return apperror.NotFound("RESOURCE_NOT_FOUND", "resource not found")
	}
	return apperror.Internal(err)
}

// authorizeDeletedSession is authorizeSession for a session in the recycle bin.
func (s *ChatService) authorizeDeletedSession(
	ctx context.Context,
	userID, sessionID uuid.UUID,
	capability access.Capability,
) (*model.ChatSession, error) {
	session, err := s.chats.FindDeletedSessionByIDAndUser(ctx, sessionID, userID)
	if err != nil {
		return nil, apperror.Internal(err)
	}
	if session == nil {
		return nil, apperror.NotFound("RESOURCE_NOT_FOUND", "resource not found")
	}
	return session, s.authorizeSessionKnowledgeBase(ctx, userID, session, capability)
}

// authorizeSessionKnowledgeBase resolves the knowledge base side of a session check
// and flattens every outcome to RESOURCE_NOT_FOUND.
//
// A 403 is deliberately not passed through here. Sessions only need chat.use and
// chat.export, which every role from viewer up holds, so the reachable-but-forbidden
// case cannot arise for a member; a caller who fails this check has no standing on
// the knowledge base at all, and telling them apart from a bad session id would leak
// that the id exists.
func (s *ChatService) authorizeSessionKnowledgeBase(
	ctx context.Context,
	userID uuid.UUID,
	session *model.ChatSession,
	capability access.Capability,
) error {
	if session.ID != uuid.Nil && session.IsAutomatic() && !session.DeletedAt.Valid {
		// A concurrent turn may have registered additional prompt sources.
		current, err := s.chats.FindSessionByIDAndUser(ctx, session.ID, userID)
		if err != nil {
			return apperror.Internal(err)
		}
		if current == nil {
			return apperror.NotFound("RESOURCE_NOT_FOUND", "resource not found")
		}
		session.KnowledgeBaseLinks = current.KnowledgeBaseLinks
	}
	for _, kbID := range session.KnowledgeBaseIDs() {
		if _, err := authorizeKnowledgeBase(ctx, s.knowledgeBases, userID, kbID, capability); err != nil {
			return apperror.NotFound("RESOURCE_NOT_FOUND", "resource not found")
		}
	}
	return nil
}

// authorizeKnowledgeBase is the knowledge-base-level check, for the endpoints that
// name a knowledge base rather than a session: creating a session, and the quality
// views filtered to one knowledge base.
func (s *ChatService) authorizeKnowledgeBase(
	ctx context.Context,
	actorID, kbID uuid.UUID,
	capability access.Capability,
) (knowledgeBaseAccess, error) {
	return authorizeKnowledgeBase(ctx, s.knowledgeBases, actorID, kbID, capability)
}
