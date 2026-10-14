package service

import (
	"context"
	"github.com/google/uuid"
	"kbchat/backend/internal/dto"
	"kbchat/backend/internal/model"
	"strings"
	"testing"
	"time"
)

func TestBookmarksPersistExactVersionsAndRespectTranscriptAccess(t *testing.T) {
	f := newWorkspaceTestServices(t)
	ctx := context.Background()
	owner := createWorkspaceUser(t, f.db, "bookmark-owner")
	viewer := createWorkspaceUser(t, f.db, "bookmark-viewer")
	kb := createWorkspaceKB(t, f.db, owner.ID, uuid.Nil, "shared", "private", time.Now())
	linked := createWorkspaceKB(t, f.db, owner.ID, uuid.Nil, "linked", "private", time.Now())
	for _, id := range []uuid.UUID{kb.ID, linked.ID} {
		if _, err := f.kbs.AddMember(ctx, owner.ID, id, dto.KnowledgeBaseMemberRequest{UserID: viewer.ID, Role: "viewer"}); err != nil {
			t.Fatal(err)
		}
	}
	session := model.ChatSession{UserID: viewer.ID, KnowledgeBaseID: kb.ID, ScopeMode: "auto", Title: "采购"}
	if err := f.db.Create(&session).Error; err != nil {
		t.Fatal(err)
	}
	if err := f.db.Create(&model.ChatSessionKnowledgeBase{SessionID: session.ID, KnowledgeBaseID: linked.ID}).Error; err != nil {
		t.Fatal(err)
	}
	q := model.ChatMessage{SessionID: session.ID, Role: "user", Content: "question"}
	old := model.ChatMessage{SessionID: session.ID, Role: "assistant", Content: "old answer"}
	newest := model.ChatMessage{SessionID: session.ID, Role: "assistant", Content: "new answer"}
	for _, m := range []*model.ChatMessage{&q, &old, &newest} {
		if err := f.db.Create(m).Error; err != nil {
			t.Fatal(err)
		}
	}
	_, err := f.chats.SaveBookmark(ctx, owner.ID, old.ID, "no")
	assertAppError(t, err, "RESOURCE_NOT_FOUND")
	_, err = f.chats.SaveBookmark(ctx, viewer.ID, q.ID, "")
	assertAppError(t, err, "VALIDATION_ERROR")
	_, err = f.chats.SaveBookmark(ctx, viewer.ID, old.ID, strings.Repeat("字", 4001))
	assertAppError(t, err, "VALIDATION_ERROR")
	first, err := f.chats.SaveBookmark(ctx, viewer.ID, old.ID, " first ")
	if err != nil || first.Note != "first" {
		t.Fatalf("save: %+v %v", first, err)
	}
	updated, err := f.chats.SaveBookmark(ctx, viewer.ID, old.ID, "100%_! 中文笔记")
	if err != nil || !updated.CreatedAt.Equal(first.CreatedAt) {
		t.Fatalf("idempotent save: %+v %v", updated, err)
	}
	list := func(query string, want int64) {
		t.Helper()
		res, err := f.chats.ListBookmarks(ctx, viewer.ID, dto.PersonalListQuery{Q: query, Page: 1, PageSize: 20})
		if err != nil || res.Total != want || int64(len(res.Items)) != want {
			t.Fatalf("list: %+v %v", res, err)
		}
	}
	list("100%_!", 1)
	list("not found", 0)
	messages, err := f.chats.ListMessages(ctx, viewer.ID, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(messages.Items) != 3 {
		t.Fatalf("message count: %+v", messages)
	}
	for _, message := range messages.Items {
		if (message.Bookmark != nil) != (message.ID == old.ID.String()) {
			t.Fatalf("exact version metadata: %+v", message)
		}
	}
	if err = f.db.Model(&session).Update("archived_at", time.Now()).Error; err != nil {
		t.Fatal(err)
	}
	list("", 1)
	if err = f.db.Delete(&session).Error; err != nil {
		t.Fatal(err)
	}
	list("", 0)
	_, err = f.chats.SaveBookmark(ctx, viewer.ID, old.ID, "hidden")
	assertAppError(t, err, "RESOURCE_NOT_FOUND")
	if err = f.db.Unscoped().Model(&model.ChatSession{}).Where("id = ?", session.ID).Update("deleted_at", nil).Error; err != nil {
		t.Fatal(err)
	}
	list("", 1)
	if err = f.kbs.RemoveMember(ctx, owner.ID, linked.ID, viewer.ID); err != nil {
		t.Fatal(err)
	}
	list("", 0)
	err = f.chats.DeleteBookmark(ctx, viewer.ID, old.ID)
	assertAppError(t, err, "RESOURCE_NOT_FOUND")
	if _, err = f.kbs.AddMember(ctx, owner.ID, linked.ID, dto.KnowledgeBaseMemberRequest{UserID: viewer.ID, Role: "viewer"}); err != nil {
		t.Fatal(err)
	}
	list("", 1)
	for i := 0; i < 2; i++ {
		if err = f.chats.DeleteBookmark(ctx, viewer.ID, old.ID); err != nil {
			t.Fatal(err)
		}
	}
	list("", 0)
}
