package service

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"kbchat/backend/internal/dto"
	"kbchat/backend/internal/model"
)

func TestChatHistoryPaginationContractAndOwnership(t *testing.T) {
	ctx := context.Background()
	f := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, f.db, "history-owner")
	viewer := createWorkspaceUser(t, f.db, "history-viewer")
	kb := createWorkspaceKB(t, f.db, owner.ID, uuid.Nil, "history", "private", time.Now())
	if _, err := f.kbs.AddMember(ctx, owner.ID, kb.ID, dto.KnowledgeBaseMemberRequest{UserID: viewer.ID, Role: "viewer"}); err != nil {
		t.Fatal(err)
	}
	session, err := f.chats.CreateSession(ctx, viewer.ID, dto.CreateChatSessionRequest{KnowledgeBaseID: kb.ID.String()})
	if err != nil {
		t.Fatal(err)
	}
	sid := uuid.MustParse(session.ID)
	for i := 0; i < 8; i++ {
		role := "user"
		if i%2 == 1 {
			role = "assistant"
		}
		if err := f.db.Create(&model.ChatMessage{SessionID: sid, Role: role, Content: "history", CreatedAt: time.Now().Add(time.Duration(i) * time.Second)}).Error; err != nil {
			t.Fatal(err)
		}
	}
	page, err := f.chats.ListMessagePage(ctx, viewer.ID, sid, dto.ChatMessagePageQuery{Limit: 3})
	if err != nil || len(page.Items) != 4 || !page.HasMore || page.NextCursor == "" {
		t.Fatalf("page: %+v %v", page, err)
	}
	older, err := f.chats.ListMessagePage(ctx, viewer.ID, sid, dto.ChatMessagePageQuery{Limit: 3, Before: page.NextCursor, Revision: page.Revision})
	if err != nil || len(older.Items) != 4 || older.HasMore {
		t.Fatalf("older: %+v %v", older, err)
	}
	full, err := f.chats.ListMessages(ctx, viewer.ID, sid)
	if err != nil || len(full.Items) != 8 {
		t.Fatalf("legacy full read changed: %+v %v", full, err)
	}
	for _, query := range []dto.ChatMessagePageQuery{{Limit: 0}, {Limit: 101}, {Limit: 50, Before: "invalid"}, {Limit: 50, Before: page.NextCursor, Since: page.NextCursor}, {Limit: 50, Revision: "invalid"}} {
		_, err := f.chats.ListMessagePage(ctx, viewer.ID, sid, query)
		assertAppError(t, err, "VALIDATION_ERROR")
	}
	other, err := f.chats.CreateSession(ctx, viewer.ID, dto.CreateChatSessionRequest{KnowledgeBaseID: kb.ID.String()})
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.chats.ListMessagePage(ctx, viewer.ID, uuid.MustParse(other.ID), dto.ChatMessagePageQuery{Limit: 50, Before: page.NextCursor})
	assertAppError(t, err, "VALIDATION_ERROR")
	_, err = f.chats.ListMessagePage(ctx, owner.ID, sid, dto.ChatMessagePageQuery{Limit: 50})
	assertAppError(t, err, "RESOURCE_NOT_FOUND")
	if err := f.kbs.RemoveMember(ctx, owner.ID, kb.ID, viewer.ID); err != nil {
		t.Fatal(err)
	}
	for _, query := range []dto.ChatMessagePageQuery{{Limit: 50}, {Limit: 50, Before: page.NextCursor}, {Limit: 50, Since: page.NextCursor}} {
		_, err := f.chats.ListMessagePage(ctx, viewer.ID, sid, query)
		assertAppError(t, err, "RESOURCE_NOT_FOUND")
	}
}
