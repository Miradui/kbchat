package service

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"kbchat/backend/internal/dto"
	"kbchat/backend/internal/model"
)

type automaticRetrievalFixture struct {
	multiChatFixtureRetrieval
	scopes  [][]uuid.UUID
	queries []string
}

func (f *automaticRetrievalFixture) SearchAutomatic(ctx context.Context, actor uuid.UUID, ids []uuid.UUID, req dto.SearchRequest) (*dto.SearchResponse, error) {
	f.scopes = append(f.scopes, slices.Clone(ids))
	f.queries = append(f.queries, req.Query)
	return f.SearchMany(ctx, actor, ids, req)
}

func TestAutomaticChatRefreshesScopeAndKeepsHistoricalPermissions(t *testing.T) {
	ctx := context.Background()
	f := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, f.db, "auto-owner")
	viewer := createWorkspaceUser(t, f.db, "auto-viewer")
	bases := []model.KnowledgeBase{}
	for i := 0; i < 7; i++ {
		kb := createWorkspaceKB(t, f.db, owner.ID, uuid.Nil, fmt.Sprintf("库%d", i), "private", time.Now())
		bases = append(bases, kb)
		if _, err := f.kbs.AddMember(ctx, owner.ID, kb.ID, dto.KnowledgeBaseMemberRequest{UserID: viewer.ID, Role: "viewer"}); err != nil {
			t.Fatal(err)
		}
	}
	hidden := createWorkspaceKB(t, f.db, owner.ID, uuid.Nil, "未授权库", "public", time.Now())
	res, err := f.chats.CreateSession(ctx, viewer.ID, dto.CreateChatSessionRequest{})
	if err != nil {
		t.Fatal(err)
	}
	if res.ScopeMode != model.ChatScopeAuto || len(res.KnowledgeBaseIDs) != 1 {
		t.Fatalf("default scope: %+v", res)
	}
	sid := uuid.MustParse(res.ID)
	ret := &automaticRetrievalFixture{}
	f.chats.retrieval = ret
	provider := &streamingChatProvider{fakeChatProvider: fakeChatProvider{responses: []string{
		`{"intent":"knowledge_base","standaloneQuery":"制度规定"}`, "制度回答 [source: 1]",
		`{"intent":"knowledge_base","standaloneQuery":"产品恢复时间"}`, "产品回答 [source: 1]",
	}}}
	f.chats.chatProvider = provider
	item := func(kb model.KnowledgeBase) dto.SearchResultResponse {
		return dto.SearchResultResponse{KnowledgeBaseID: kb.ID.String(), KnowledgeBaseName: kb.Name, ChunkID: uuid.NewString(), DocumentID: uuid.NewString(), Content: kb.Name + "的依据", Filename: "规则.md"}
	}
	ret.items = []dto.SearchResultResponse{item(bases[0])}
	firstRequest := dto.SendChatMessageRequest{Content: "制度规定？", ClientRequestID: uuid.NewString()}
	first, err := f.chats.SendMessage(ctx, viewer.ID, sid, firstRequest)
	if err != nil {
		t.Fatal(err)
	}
	if len(ret.scopes[0]) != 7 || slices.Contains(ret.scopes[0], hidden.ID) || first.Citations[0].KnowledgeBaseID != bases[0].ID.String() {
		t.Fatalf("invalid scope or citations: %+v %+v", ret.scopes, first)
	}
	// A library created/granted after the first question is eligible next turn.
	added := createWorkspaceKB(t, f.db, owner.ID, uuid.Nil, "新产品库", "private", time.Now())
	if _, err = f.kbs.AddMember(ctx, owner.ID, added.ID, dto.KnowledgeBaseMemberRequest{UserID: viewer.ID, Role: "viewer"}); err != nil {
		t.Fatal(err)
	}
	// Revoking a library never used in a prompt must not block this transcript.
	if err = f.db.Where("knowledge_base_id = ? AND user_id = ?", bases[2].ID, viewer.ID).Delete(&model.KnowledgeBaseMember{}).Error; err != nil {
		t.Fatal(err)
	}
	ret.items = []dto.SearchResultResponse{item(added)}
	sink := &recordedStream{}
	if err = f.chats.SendMessageStream(ctx, viewer.ID, sid, dto.SendChatMessageRequest{Content: "产品呢？", ClientRequestID: uuid.NewString()}, sink); err != nil {
		t.Fatal(err)
	}
	if len(ret.scopes) != 2 || !slices.Contains(ret.scopes[1], added.ID) || slices.Contains(ret.scopes[1], bases[2].ID) || ret.queries[1] != "产品恢复时间" {
		t.Fatalf("scope/query was pinned: %+v %+v", ret.scopes, ret.queries)
	}
	if len(sink.done) != 1 || len(sink.citations) != 1 || sink.citations[0][0].KnowledgeBaseID != added.ID.String() {
		t.Fatalf("stream sources: %+v", sink)
	}
	lastPrompt := provider.messages[len(provider.messages)-1].Content
	if !strings.Contains(lastPrompt, added.Name+"的依据") || strings.Contains(lastPrompt, bases[0].Name+"的依据") {
		t.Fatalf("stale prompt evidence: %s", lastPrompt)
	}
	// Idempotent retry replays the original answer, without new scope/model work.
	if _, err = f.chats.SendMessage(ctx, viewer.ID, sid, firstRequest); err != nil || len(ret.scopes) != 2 {
		t.Fatalf("replay re-retrieved: %v", err)
	}
	detail, err := f.chats.GetSession(ctx, viewer.ID, sid)
	if err != nil || detail.ScopeMode != "auto" || !slices.Contains(detail.KnowledgeBaseIDs, added.ID.String()) {
		t.Fatalf("missing dependencies: %+v %v", detail, err)
	}
	list, err := f.chats.ListSessions(ctx, viewer.ID, dto.ChatSessionListQuery{})
	if err != nil || len(list.Items) != 1 || list.Items[0].ScopeMode != "auto" {
		t.Fatalf("list: %+v %v", list, err)
	}
	if err = f.db.Where("knowledge_base_id = ? AND user_id = ?", added.ID, viewer.ID).Delete(&model.KnowledgeBaseMember{}).Error; err != nil {
		t.Fatal(err)
	}
	if _, err = f.chats.GetSession(ctx, viewer.ID, sid); err == nil {
		t.Fatal("historical sources exposed after revocation")
	}
	if _, err = f.chats.ExportSession(ctx, viewer.ID, sid); err == nil {
		t.Fatal("revoked export allowed")
	}
	list, err = f.chats.ListSessions(ctx, viewer.ID, dto.ChatSessionListQuery{})
	if err != nil || len(list.Items) != 0 {
		t.Fatalf("revoked list: %+v %v", list, err)
	}
}

func TestAutomaticChatRejectsInvalidModesAndKeepsManualScope(t *testing.T) {
	ctx := context.Background()
	f := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, f.db, "auto-validation")
	if _, err := f.chats.CreateSession(ctx, owner.ID, dto.CreateChatSessionRequest{}); err == nil {
		t.Fatal("created without accessible knowledge bases")
	}
	a := createWorkspaceKB(t, f.db, owner.ID, uuid.Nil, "a", "private", time.Now())
	createWorkspaceKB(t, f.db, owner.ID, uuid.Nil, "b", "private", time.Now())
	for _, req := range []dto.CreateChatSessionRequest{{ScopeMode: "invalid"}, {ScopeMode: "manual"}, {ScopeMode: "auto", KnowledgeBaseID: a.ID.String()}, {ScopeMode: "auto", KnowledgeBaseIDs: []string{a.ID.String()}}} {
		if _, err := f.chats.CreateSession(ctx, owner.ID, req); err == nil {
			t.Fatalf("accepted invalid mode: %+v", req)
		}
	}
	res, err := f.chats.CreateSession(ctx, owner.ID, dto.CreateChatSessionRequest{KnowledgeBaseID: a.ID.String()})
	if err != nil || res.ScopeMode != "manual" {
		t.Fatalf("legacy manual scope: %+v %v", res, err)
	}
	ret := &fakeChatRetrieval{response: &dto.SearchResponse{Items: []dto.SearchResultResponse{}}}
	f.chats.retrieval = ret
	f.chats.chatProvider = &fakeChatProvider{response: "answer"}
	if _, err = f.chats.SendMessage(ctx, owner.ID, uuid.MustParse(res.ID), dto.SendChatMessageRequest{Content: "q", ClientRequestID: uuid.NewString()}); err != nil || len(ret.calls) != 1 {
		t.Fatalf("manual chat did not retain single-base path: %v", err)
	}
}

func TestAutomaticChatRechecksNewSourcesBeforeStreaming(t *testing.T) {
	ctx := context.Background()
	f := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, f.db, "auto-stream-owner")
	viewer := createWorkspaceUser(t, f.db, "auto-stream-viewer")
	b := createWorkspaceKB(t, f.db, owner.ID, uuid.Nil, "source", "private", time.Now())
	a := createWorkspaceKB(t, f.db, viewer.ID, uuid.Nil, "anchor", "private", time.Now().Add(time.Hour))
	if _, err := f.kbs.AddMember(ctx, owner.ID, b.ID, dto.KnowledgeBaseMemberRequest{UserID: viewer.ID, Role: "viewer"}); err != nil {
		t.Fatal(err)
	}
	res, err := f.chats.CreateSession(ctx, viewer.ID, dto.CreateChatSessionRequest{})
	if err != nil || res.KnowledgeBaseID != a.ID.String() {
		t.Fatalf("create: %+v %v", res, err)
	}
	ret := &automaticRetrievalFixture{multiChatFixtureRetrieval: multiChatFixtureRetrieval{items: []dto.SearchResultResponse{{KnowledgeBaseID: b.ID.String(), Content: "restricted"}}}}
	ret.after = func() {
		if err := f.db.Where("knowledge_base_id = ? AND user_id = ?", b.ID, viewer.ID).Delete(&model.KnowledgeBaseMember{}).Error; err != nil {
			t.Fatal(err)
		}
	}
	f.chats.retrieval = ret
	f.chats.chatProvider = &streamingChatProvider{fakeChatProvider: fakeChatProvider{response: "answer"}}
	sink := &recordedStream{}
	err = f.chats.SendMessageStream(ctx, viewer.ID, uuid.MustParse(res.ID), dto.SendChatMessageRequest{Content: "q", ClientRequestID: uuid.NewString()}, sink)
	if err == nil || len(sink.citations) != 0 || len(sink.deltas) != 0 || len(sink.done) != 0 {
		t.Fatalf("revoked content emitted: %v %+v", err, sink)
	}
}

func TestAutomaticChatRegenerationAndEditRefreshSourcesAndExcludeQuality(t *testing.T) {
	ctx := context.Background()
	f := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, f.db, "auto-edit-owner")
	a := createWorkspaceKB(t, f.db, owner.ID, uuid.Nil, "制度", "private", time.Now())
	res, err := f.chats.CreateSession(ctx, owner.ID, dto.CreateChatSessionRequest{})
	if err != nil {
		t.Fatal(err)
	}
	sid := uuid.MustParse(res.ID)
	ret := &automaticRetrievalFixture{multiChatFixtureRetrieval: multiChatFixtureRetrieval{items: []dto.SearchResultResponse{{KnowledgeBaseID: a.ID.String(), KnowledgeBaseName: a.Name, ChunkID: uuid.NewString(), DocumentID: uuid.NewString(), Content: "制度依据"}}}}
	f.chats.retrieval = ret
	f.chats.chatProvider = &fakeChatProvider{response: "有依据的回答 [source: 1]"}
	first, err := f.chats.SendMessage(ctx, owner.ID, sid, dto.SendChatMessageRequest{Content: "q", ClientRequestID: uuid.NewString()})
	if err != nil {
		t.Fatal(err)
	}
	quality, err := f.chats.GetQualityOverview(ctx, owner.ID, dto.ChatQualityOverviewQuery{Period: "month", KnowledgeBaseID: &a.ID})
	if err != nil || quality.AnswerCount != 0 {
		t.Fatalf("single-source automatic chat leaked to quality: %+v %v", quality, err)
	}
	b := createWorkspaceKB(t, f.db, owner.ID, uuid.Nil, "产品", "private", time.Now())
	ret.items = []dto.SearchResultResponse{{KnowledgeBaseID: b.ID.String(), KnowledgeBaseName: b.Name, ChunkID: uuid.NewString(), DocumentID: uuid.NewString(), Content: "产品依据"}}
	regenerated, err := f.chats.RegenerateMessage(ctx, owner.ID, sid, uuid.MustParse(first.AssistantMessage.ID))
	if err != nil {
		t.Fatal(err)
	}
	if len(ret.scopes) != 2 || !slices.Contains(ret.scopes[1], b.ID) || regenerated.Message.Citations[0].KnowledgeBaseID != b.ID.String() {
		t.Fatalf("regeneration did not refresh scope: %+v", regenerated)
	}
	if _, err := f.chats.EditMessageAndRegenerate(ctx, owner.ID, sid, uuid.MustParse(first.UserMessage.ID), dto.EditChatMessageRequest{Content: "改问产品", ClientRequestID: uuid.NewString()}); err != nil {
		t.Fatal(err)
	}
	if len(ret.scopes) != 3 || ret.queries[2] != "改问产品" {
		t.Fatalf("edit did not re-retrieve: %+v", ret.queries)
	}
	if err := f.kbs.Delete(ctx, owner.ID, a.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.chats.GetSession(ctx, owner.ID, sid); err == nil {
		t.Fatal("source dependency was dropped when editing")
	}
	if err := f.kbs.Restore(ctx, owner.ID, a.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.chats.GetSession(ctx, owner.ID, sid); err != nil {
		t.Fatal(err)
	}
}
