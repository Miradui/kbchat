package service

import (
	"context"
	"github.com/google/uuid"
	"gorm.io/datatypes"
	"kbchat/backend/internal/dto"
	"kbchat/backend/internal/model"
	"strings"
	"testing"
	"time"
)

type multiChatFixtureRetrieval struct {
	items []dto.SearchResultResponse
	ids   []uuid.UUID
	after func()
}

func (f *multiChatFixtureRetrieval) Search(context.Context, uuid.UUID, uuid.UUID, dto.SearchRequest) (*dto.SearchResponse, error) {
	panic("cross-base chat used single-base retrieval")
}
func (f *multiChatFixtureRetrieval) SearchMany(_ context.Context, _ uuid.UUID, ids []uuid.UUID, _ dto.SearchRequest) (*dto.SearchResponse, error) {
	f.ids = ids
	if f.after != nil {
		f.after()
	}
	return &dto.SearchResponse{Items: f.items}, nil
}

func TestMultiChatLifecycleAuthorizationAndQualityIsolation(t *testing.T) {
	ctx := context.Background()
	f := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, f.db, "multi-owner")
	viewer := createWorkspaceUser(t, f.db, "multi-viewer")
	a := createWorkspaceKB(t, f.db, owner.ID, uuid.Nil, "制度", "private", time.Now())
	b := createWorkspaceKB(t, f.db, owner.ID, uuid.Nil, "产品", "private", time.Now())
	for _, id := range []uuid.UUID{a.ID, b.ID} {
		if _, err := f.kbs.AddMember(ctx, owner.ID, id, dto.KnowledgeBaseMemberRequest{UserID: viewer.ID, Role: "viewer"}); err != nil {
			t.Fatal(err)
		}
	}
	f.db.Model(&a).Update("answer_config", datatypes.JSON(`{"systemPromptAddition":"PRIMARY-ONLY-PROMPT","allowGeneralKnowledge":true}`))
	ret := &multiChatFixtureRetrieval{items: []dto.SearchResultResponse{{KnowledgeBaseID: a.ID.String(), KnowledgeBaseName: a.Name, ChunkID: uuid.NewString(), DocumentID: uuid.NewString(), Content: "保留35天"}, {KnowledgeBaseID: b.ID.String(), KnowledgeBaseName: b.Name, ChunkID: uuid.NewString(), DocumentID: uuid.NewString(), Content: "恢复18分钟"}}}
	provider := &fakeChatProvider{response: "两个库的答案 [source: 1] [source: 2]"}
	f.chats.retrieval = ret
	f.chats.chatProvider = provider
	session, err := f.chats.CreateSession(ctx, viewer.ID, dto.CreateChatSessionRequest{KnowledgeBaseIDs: []string{a.ID.String(), b.ID.String()}})
	if err != nil {
		t.Fatal(err)
	}
	sid := uuid.MustParse(session.ID)
	if len(session.KnowledgeBases) != 2 || session.KnowledgeBases[1].Name != b.Name {
		t.Fatalf("scope response: %+v", session)
	}
	answer, err := f.chats.SendMessage(ctx, viewer.ID, sid, dto.SendChatMessageRequest{Content: "跨库问题", ClientRequestID: uuid.NewString()})
	if err != nil {
		t.Fatal(err)
	}
	if len(ret.ids) != 2 || len(answer.Citations) != 2 || answer.Citations[1].KnowledgeBaseID != b.ID.String() {
		t.Fatal("lost cross-base scope or citation")
	}
	for _, msg := range provider.messages {
		if strings.Contains(msg.Content, "PRIMARY-ONLY-PROMPT") {
			t.Fatal("multi-base answer inherited single-base policy")
		}
	}
	for _, id := range []uuid.UUID{a.ID, b.ID} {
		list, err := f.chats.ListSessions(ctx, viewer.ID, dto.ChatSessionListQuery{KnowledgeBaseID: &id})
		if err != nil || list.Total != 1 || len(list.Items[0].KnowledgeBaseIDs) != 2 {
			t.Fatalf("filter by either base: %+v %v", list, err)
		}
	}
	if _, err := f.chats.GetSession(ctx, owner.ID, sid); err == nil {
		t.Fatal("base owner read another user's session")
	}
	file, err := f.chats.ExportSession(ctx, viewer.ID, sid)
	if err != nil || !strings.Contains(string(file.Content), "制度、产品") {
		t.Fatalf("export scope: %v", err)
	}
	if _, err := f.chats.SetMessageFeedback(ctx, viewer.ID, uuid.MustParse(answer.AssistantMessage.ID), "negative"); err != nil {
		t.Fatal(err)
	}
	quality, err := f.chats.GetQualityOverview(ctx, owner.ID, dto.ChatQualityOverviewQuery{Period: "month", KnowledgeBaseID: &a.ID})
	if err != nil || quality.AnswerCount != 0 {
		t.Fatalf("cross-base text leaks into quality: %+v %v", quality, err)
	}
	if _, err := f.chats.RegenerateMessage(ctx, viewer.ID, sid, uuid.MustParse(answer.AssistantMessage.ID)); err != nil {
		t.Fatal(err)
	}
	if _, err := f.chats.EditMessageAndRegenerate(ctx, viewer.ID, sid, uuid.MustParse(answer.UserMessage.ID), dto.EditChatMessageRequest{Content: "更新问题", ClientRequestID: uuid.NewString()}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.chats.ArchiveSession(ctx, viewer.ID, sid); err != nil {
		t.Fatal(err)
	}
	if _, err := f.chats.UnarchiveSession(ctx, viewer.ID, sid); err != nil {
		t.Fatal(err)
	}
	if err := f.chats.DeleteSession(ctx, viewer.ID, sid); err != nil {
		t.Fatal(err)
	}
	if _, err := f.chats.RestoreSession(ctx, viewer.ID, sid); err != nil {
		t.Fatal(err)
	}
	if err := f.db.Where("knowledge_base_id = ? AND user_id = ?", b.ID, viewer.ID).Delete(&model.KnowledgeBaseMember{}).Error; err != nil {
		t.Fatal(err)
	}
	for _, call := range []func() error{
		func() error { _, e := f.chats.GetSession(ctx, viewer.ID, sid); return e },
		func() error { _, e := f.chats.ListMessages(ctx, viewer.ID, sid); return e },
		func() error { _, e := f.chats.ExportSession(ctx, viewer.ID, sid); return e },
		func() error {
			_, e := f.chats.SendMessage(ctx, viewer.ID, sid, dto.SendChatMessageRequest{Content: "secret", ClientRequestID: uuid.NewString()})
			return e
		},
		func() error {
			_, e := f.chats.SetMessageFeedback(ctx, viewer.ID, uuid.MustParse(answer.AssistantMessage.ID), "positive")
			return e
		},
	} {
		if err := call(); err == nil {
			t.Fatal("revoked secondary base still accessible")
		}
	}
	list, err := f.chats.ListSessions(ctx, viewer.ID, dto.ChatSessionListQuery{})
	if err != nil || list.Total != 0 {
		t.Fatalf("revoked transcript remains in rail: %+v %v", list, err)
	}
}

func TestMultiChatDoesNotShrinkWhenSecondaryBaseDeleted(t *testing.T) {
	ctx := context.Background()
	f := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, f.db, "delete-owner")
	a := createWorkspaceKB(t, f.db, owner.ID, uuid.Nil, "a", "private", time.Now())
	b := createWorkspaceKB(t, f.db, owner.ID, uuid.Nil, "b", "private", time.Now())
	res, err := f.chats.CreateSession(ctx, owner.ID, dto.CreateChatSessionRequest{KnowledgeBaseIDs: []string{a.ID.String(), b.ID.String()}})
	if err != nil {
		t.Fatal(err)
	}
	sid := uuid.MustParse(res.ID)
	if err := f.kbs.Delete(ctx, owner.ID, b.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.chats.GetSession(ctx, owner.ID, sid); err == nil {
		t.Fatal("deleted secondary base ignored")
	}
	if err := f.kbs.Restore(ctx, owner.ID, b.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.chats.GetSession(ctx, owner.ID, sid); err != nil {
		t.Fatal(err)
	}
	if err := f.kbs.Delete(ctx, owner.ID, b.ID); err != nil {
		t.Fatal(err)
	}
	if err := f.kbs.PermanentDelete(ctx, owner.ID, b.ID); err != nil {
		t.Fatal(err)
	}
	var count int64
	f.db.Unscoped().Model(&model.ChatSession{}).Where("id = ?", sid).Count(&count)
	if count != 0 {
		t.Fatal("permanent base deletion left cross-base transcript")
	}
}

func TestMultiChatStreamRechecksRevokedSecondaryBeforeCitations(t *testing.T) {
	ctx := context.Background()
	f := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, f.db, "stream-owner")
	viewer := createWorkspaceUser(t, f.db, "stream-viewer")
	a := createWorkspaceKB(t, f.db, owner.ID, uuid.Nil, "a", "private", time.Now())
	b := createWorkspaceKB(t, f.db, owner.ID, uuid.Nil, "b", "private", time.Now())
	for _, id := range []uuid.UUID{a.ID, b.ID} {
		if _, err := f.kbs.AddMember(ctx, owner.ID, id, dto.KnowledgeBaseMemberRequest{UserID: viewer.ID, Role: "viewer"}); err != nil {
			t.Fatal(err)
		}
	}
	res, err := f.chats.CreateSession(ctx, viewer.ID, dto.CreateChatSessionRequest{KnowledgeBaseIDs: []string{a.ID.String(), b.ID.String()}})
	if err != nil {
		t.Fatal(err)
	}
	ret := &multiChatFixtureRetrieval{items: []dto.SearchResultResponse{{KnowledgeBaseID: b.ID.String(), Content: "secret"}}}
	f.chats.retrieval = ret
	f.chats.chatProvider = &streamingChatProvider{fakeChatProvider: fakeChatProvider{response: "answer"}}
	ret.after = func() {
		if err := f.db.Where("knowledge_base_id = ? AND user_id = ?", b.ID, viewer.ID).Delete(&model.KnowledgeBaseMember{}).Error; err != nil {
			t.Fatal(err)
		}
	}
	sink := &recordedStream{}
	err = f.chats.SendMessageStream(ctx, viewer.ID, uuid.MustParse(res.ID), dto.SendChatMessageRequest{Content: "q", ClientRequestID: uuid.NewString()}, sink)
	if err == nil || len(sink.citations) != 0 || len(sink.deltas) != 0 || len(sink.done) != 0 {
		t.Fatalf("revoked content emitted: %v %+v", err, sink)
	}
	var n int64
	f.db.Model(&model.ChatMessage{}).Count(&n)
	if n != 0 {
		t.Fatal("revoked answer persisted")
	}
}
