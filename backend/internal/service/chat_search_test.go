package service

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"

	"kbchat/backend/internal/dto"
	"kbchat/backend/internal/model"
)

func TestChatSearchVisibilityArchiveAndAllKnowledgeBaseDependencies(t *testing.T) {
	f := newWorkspaceTestServices(t)
	ctx := context.Background()
	owner := createWorkspaceUser(t, f.db, "search-owner")
	viewer := createWorkspaceUser(t, f.db, "search-viewer")
	other := createWorkspaceUser(t, f.db, "search-other")
	kb := createWorkspaceKB(t, f.db, owner.ID, uuid.Nil, "shared", "private", time.Now())
	linked := createWorkspaceKB(t, f.db, owner.ID, uuid.Nil, "dependency", "private", time.Now())
	owned := createWorkspaceKB(t, f.db, viewer.ID, uuid.Nil, "own", "private", time.Now())
	for _, id := range []uuid.UUID{kb.ID, linked.ID} {
		if _, err := f.kbs.AddMember(ctx, owner.ID, id, dto.KnowledgeBaseMemberRequest{UserID: viewer.ID, Role: "viewer"}); err != nil {
			t.Fatal(err)
		}
	}
	makeSession := func(userID, kbID uuid.UUID, title string) model.ChatSession {
		s := model.ChatSession{UserID: userID, KnowledgeBaseID: kbID, ScopeMode: "manual", Title: title}
		if err := f.db.Create(&s).Error; err != nil {
			t.Fatal(err)
		}
		if err := f.db.Create(&model.ChatMessage{SessionID: s.ID, Role: "assistant", Content: "only searchable needle"}).Error; err != nil {
			t.Fatal(err)
		}
		return s
	}
	active := makeSession(viewer.ID, kb.ID, "active")
	archived := makeSession(viewer.ID, owned.ID, "archived")
	if err := f.db.Model(&archived).Update("archived_at", time.Now()).Error; err != nil {
		t.Fatal(err)
	}
	deleted := makeSession(viewer.ID, kb.ID, "deleted")
	if err := f.db.Delete(&deleted).Error; err != nil {
		t.Fatal(err)
	}
	makeSession(other.ID, kb.ID, "someone else's messages")
	multi := makeSession(viewer.ID, kb.ID, "automatic dependencies")
	if err := f.db.Model(&multi).Update("scope_mode", "auto").Error; err != nil {
		t.Fatal(err)
	}
	if err := f.db.Create(&model.ChatSessionKnowledgeBase{SessionID: multi.ID, KnowledgeBaseID: linked.ID}).Error; err != nil {
		t.Fatal(err)
	}
	search := func(want int64) *dto.ChatMessageSearchResponse {
		t.Helper()
		res, err := f.chats.SearchMessages(ctx, viewer.ID, dto.ChatMessageSearchQuery{Q: "needle", Page: 1, PageSize: 20})
		if err != nil || res.Total != want || int64(len(res.Items)) != want {
			t.Fatalf("search: %+v %v", res, err)
		}
		return res
	}
	search(3)
	_, err := f.chats.SearchMessages(ctx, owner.ID, dto.ChatMessageSearchQuery{Q: "needle", SessionID: &active.ID, Page: 1, PageSize: 20})
	assertAppError(t, err, "RESOURCE_NOT_FOUND")
	if err := f.kbs.RemoveMember(ctx, owner.ID, linked.ID, viewer.ID); err != nil {
		t.Fatal(err)
	}
	search(2)
	_, err = f.chats.ListMessagePage(ctx, viewer.ID, multi.ID, dto.ChatMessagePageQuery{Limit: 50, Around: uuid.NewString()})
	assertAppError(t, err, "RESOURCE_NOT_FOUND")
	if err := f.kbs.RemoveMember(ctx, owner.ID, kb.ID, viewer.ID); err != nil {
		t.Fatal(err)
	}
	result := search(1)
	if result.Items[0].SessionID != archived.ID.String() || result.Items[0].ArchivedAt == nil {
		t.Fatalf("archived own session missing: %+v", result)
	}
	if err := f.db.Delete(&owned).Error; err != nil {
		t.Fatal(err)
	}
	search(0)
}

func TestChatSearchLiteralMatchingBoundedExcerptsAndStablePages(t *testing.T) {
	f := newWorkspaceTestServices(t)
	ctx := context.Background()
	owner := createWorkspaceUser(t, f.db, "search-literal")
	kb := createWorkspaceKB(t, f.db, owner.ID, uuid.Nil, "history", "private", time.Now())
	session := model.ChatSession{UserID: owner.ID, KnowledgeBaseID: kb.ID, Title: "title-only-sentinel"}
	if err := f.db.Create(&session).Error; err != nil {
		t.Fatal(err)
	}
	stamp := time.Date(2026, 10, 13, 0, 0, 0, 0, time.UTC)
	for i, content := range []string{strings.Repeat("😀中文", 100) + " A+B 100%_! " + strings.Repeat("正文", 100), "a+b alternative 100xx!", "A+B third", "old version A+B"} {
		role := "assistant"
		if i == 0 {
			role = "user"
		}
		m := model.ChatMessage{ID: uuid.MustParse(fmt.Sprintf("00000000-0000-0000-0000-%012d", i+1)), SessionID: session.ID, Role: role, Content: content, CreatedAt: stamp}
		if err := f.db.Create(&m).Error; err != nil {
			t.Fatal(err)
		}
	}
	query := dto.ChatMessageSearchQuery{Q: " 100%_! ", Page: 1, PageSize: 2}
	res, err := f.chats.SearchMessages(ctx, owner.ID, query)
	if err != nil || res.Total != 1 || res.Items[0].Excerpt.Match != "100%_!" || utf8.RuneCountInString(res.Items[0].Excerpt.Before) > 41 || utf8.RuneCountInString(res.Items[0].Excerpt.After) > 81 {
		t.Fatalf("literal wildcard and excerpt: %+v %v", res, err)
	}
	query.Q = "a+b"
	var ids []string
	for page := 1; page <= 3; page++ {
		query.Page = page
		res, err = f.chats.SearchMessages(ctx, owner.ID, query)
		if err != nil || res.Total != 4 {
			t.Fatalf("page %d: %+v %v", page, res, err)
		}
		for _, item := range res.Items {
			ids = append(ids, item.MessageID)
		}
	}
	if len(ids) != 4 || !strings.HasSuffix(ids[0], "4") || !strings.HasSuffix(ids[3], "1") {
		t.Fatalf("latest-first ties: %v", ids)
	}
	query.Page, query.SessionID = 1, &session.ID
	res, err = f.chats.SearchMessages(ctx, owner.ID, query)
	if err != nil || !strings.HasSuffix(res.Items[0].MessageID, "1") {
		t.Fatalf("session chronological order: %+v %v", res, err)
	}
	query.Q = "title-only-sentinel"
	res, err = f.chats.SearchMessages(ctx, owner.ID, query)
	if err != nil || res.Total != 0 || res.Items == nil {
		t.Fatalf("message-only empty result: %+v %v", res, err)
	}
	for _, term := range []string{" ", strings.Repeat("字", 201)} {
		query.Q = term
		_, err = f.chats.SearchMessages(ctx, owner.ID, query)
		assertAppError(t, err, "VALIDATION_ERROR")
	}
	for _, term := range []string{"字", "😀"} {
		excerpt := chatSearchExcerpt(strings.Repeat(term, 100)+"<MATCH>"+strings.Repeat(term, 100), "<match>")
		if excerpt.Match != "<MATCH>" || !utf8.ValidString(excerpt.Before) || !utf8.ValidString(excerpt.After) {
			t.Fatalf("unicode excerpt: %+v", excerpt)
		}
	}
}
