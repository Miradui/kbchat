package service

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"

	"kbchat/backend/internal/access"
	"kbchat/backend/internal/dto"
	"kbchat/backend/internal/model"
)

// A viewer is the lowest role that can ask questions, which is the point of being
// given a knowledge base at all: chat.use, chat.export and feedback.write are the
// three capabilities they hold beyond reading.
func TestViewerCanChatInASharedKnowledgeBase(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, services.db, "owner")
	viewer := createWorkspaceUser(t, services.db, "viewer")
	kb := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "chat-kb", "private", time.Now())
	if _, err := services.kbs.AddMember(ctx, owner.ID, kb.ID, dto.KnowledgeBaseMemberRequest{
		UserID: viewer.ID,
		Role:   string(access.RoleViewer),
	}); err != nil {
		t.Fatalf("add viewer: %v", err)
	}

	session, err := services.chats.CreateSession(ctx, viewer.ID, dto.CreateChatSessionRequest{
		KnowledgeBaseID: kb.ID.String(),
		Title:           "viewer session",
	})
	if err != nil {
		t.Fatalf("viewer create session: %v", err)
	}
	sessionID := mustParseUUID(t, session.ID)

	if _, err := services.chats.GetSession(ctx, viewer.ID, sessionID); err != nil {
		t.Fatalf("viewer get session: %v", err)
	}
	if _, err := services.chats.ExportSession(ctx, viewer.ID, sessionID); err != nil {
		t.Fatalf("viewer export session: %v", err)
	}
	list, err := services.chats.ListSessions(ctx, viewer.ID, dto.ChatSessionListQuery{})
	if err != nil {
		t.Fatalf("viewer list sessions: %v", err)
	}
	if list.Total != 1 {
		t.Fatalf("viewer sees %d sessions, want 1", list.Total)
	}

	message := model.ChatMessage{SessionID: sessionID, Role: "assistant", Content: "answer"}
	if err := services.db.Create(&message).Error; err != nil {
		t.Fatalf("create assistant message: %v", err)
	}
	if _, err := services.chats.SetMessageFeedback(ctx, viewer.ID, message.ID, "negative"); err != nil {
		t.Fatalf("viewer feedback: %v", err)
	}
}

// A session is the caller's own row, but it is not a standing permission on the
// knowledge base. Once membership is revoked the transcript quotes content the
// caller no longer has access to, so the session has to go dark with it.
func TestRevokedMemberLosesTheirExistingChatSessions(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, services.db, "owner")
	viewer := createWorkspaceUser(t, services.db, "viewer")
	kb := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "chat-kb", "private", time.Now())
	if _, err := services.kbs.AddMember(ctx, owner.ID, kb.ID, dto.KnowledgeBaseMemberRequest{
		UserID: viewer.ID,
		Role:   string(access.RoleViewer),
	}); err != nil {
		t.Fatalf("add viewer: %v", err)
	}
	session, err := services.chats.CreateSession(ctx, viewer.ID, dto.CreateChatSessionRequest{
		KnowledgeBaseID: kb.ID.String(),
	})
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	sessionID := mustParseUUID(t, session.ID)
	message := model.ChatMessage{SessionID: sessionID, Role: "assistant", Content: "answer"}
	if err := services.db.Create(&message).Error; err != nil {
		t.Fatalf("create assistant message: %v", err)
	}

	if err := services.kbs.RemoveMember(ctx, owner.ID, kb.ID, viewer.ID); err != nil {
		t.Fatalf("remove member: %v", err)
	}

	_, err = services.chats.GetSession(ctx, viewer.ID, sessionID)
	assertAppError(t, err, "RESOURCE_NOT_FOUND")
	_, err = services.chats.ExportSession(ctx, viewer.ID, sessionID)
	assertAppError(t, err, "RESOURCE_NOT_FOUND")
	_, err = services.chats.SetMessageFeedback(ctx, viewer.ID, message.ID, "positive")
	assertAppError(t, err, "RESOURCE_NOT_FOUND")
	_, err = services.chats.CreateSession(ctx, viewer.ID, dto.CreateChatSessionRequest{
		KnowledgeBaseID: kb.ID.String(),
	})
	assertAppError(t, err, "KNOWLEDGE_BASE_NOT_FOUND")

	list, err := services.chats.ListSessions(ctx, viewer.ID, dto.ChatSessionListQuery{})
	if err != nil {
		t.Fatalf("list sessions after revoke: %v", err)
	}
	if list.Total != 0 {
		t.Fatalf("former member sees %d sessions, want 0", list.Total)
	}
}

// A capability on the knowledge base is not a right to somebody else's transcript.
// chat_sessions.user_id stays the boundary, so even the owner cannot open a member's
// session, and the answer is 404 rather than 403 -- a session id is not the owner's
// resource to be told about at all.
func TestNobodyElseCanReadAMembersSession(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, services.db, "owner")
	viewer := createWorkspaceUser(t, services.db, "viewer")
	manager := createWorkspaceUser(t, services.db, "manager")
	kb := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "chat-kb", "private", time.Now())
	for user, role := range map[uuid.UUID]access.Role{viewer.ID: access.RoleViewer, manager.ID: access.RoleManager} {
		if _, err := services.kbs.AddMember(ctx, owner.ID, kb.ID, dto.KnowledgeBaseMemberRequest{
			UserID: user,
			Role:   string(role),
		}); err != nil {
			t.Fatalf("add member: %v", err)
		}
	}
	session, err := services.chats.CreateSession(ctx, viewer.ID, dto.CreateChatSessionRequest{
		KnowledgeBaseID: kb.ID.String(),
	})
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	sessionID := mustParseUUID(t, session.ID)

	for name, actor := range map[string]uuid.UUID{"owner": owner.ID, "manager": manager.ID} {
		_, err := services.chats.GetSession(ctx, actor, sessionID)
		assertAppError(t, err, "RESOURCE_NOT_FOUND")
		_, err = services.chats.ExportSession(ctx, actor, sessionID)
		assertAppError(t, err, "RESOURCE_NOT_FOUND")
		if err := services.chats.DeleteSession(ctx, actor, sessionID); err == nil {
			t.Fatalf("%s deleted a member's session", name)
		}
	}
}

// Quality data aggregates what other people asked and how they rated the answers, so
// it stops at manager even though an editor can change the content those answers
// came from.
func TestQualityViewsRequireManagerOnTheFilteredKnowledgeBase(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, services.db, "owner")
	editor := createWorkspaceUser(t, services.db, "editor")
	manager := createWorkspaceUser(t, services.db, "manager")
	stranger := createWorkspaceUser(t, services.db, "stranger")
	kb := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "quality-kb", "private", time.Now())
	for user, role := range map[uuid.UUID]access.Role{editor.ID: access.RoleEditor, manager.ID: access.RoleManager} {
		if _, err := services.kbs.AddMember(ctx, owner.ID, kb.ID, dto.KnowledgeBaseMemberRequest{
			UserID: user,
			Role:   string(role),
		}); err != nil {
			t.Fatalf("add member: %v", err)
		}
	}
	query := dto.ChatQualityOverviewQuery{KnowledgeBaseID: &kb.ID}

	_, err := services.chats.GetQualityOverview(ctx, editor.ID, query)
	assertAppError(t, err, "FORBIDDEN")
	assertRequiredRole(t, err, access.RoleManager)
	_, err = services.chats.ListNegativeFeedback(ctx, editor.ID, dto.ChatQualityFeedbackQuery{KnowledgeBaseID: &kb.ID})
	assertAppError(t, err, "FORBIDDEN")
	_, err = services.chats.ListKnowledgeGaps(ctx, editor.ID, dto.ChatKnowledgeGapQuery{KnowledgeBaseID: &kb.ID})
	assertAppError(t, err, "FORBIDDEN")

	// A stranger gets 404: they must not learn the knowledge base exists.
	_, err = services.chats.GetQualityOverview(ctx, stranger.ID, query)
	assertAppError(t, err, "KNOWLEDGE_BASE_NOT_FOUND")

	for name, actor := range map[string]uuid.UUID{"owner": owner.ID, "manager": manager.ID} {
		if _, err := services.chats.GetQualityOverview(ctx, actor, query); err != nil {
			t.Fatalf("%s quality overview: %v", name, err)
		}
	}
}
