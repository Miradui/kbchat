package service

import (
	"context"

	"github.com/google/uuid"

	"kbchat/backend/internal/access"
	"kbchat/backend/internal/apperror"
	"kbchat/backend/internal/model"
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
	if _, err := authorizeKnowledgeBase(ctx, s.knowledgeBases, userID, session.KnowledgeBaseID, capability); err != nil {
		return apperror.NotFound("RESOURCE_NOT_FOUND", "resource not found")
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
