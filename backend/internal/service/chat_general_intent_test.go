package service

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"gorm.io/datatypes"

	"kbchat/backend/internal/config"
	"kbchat/backend/internal/dto"
	"kbchat/backend/internal/model"
	"kbchat/backend/internal/repository"
)

func TestParseChatIntentOutputAcceptsGeneral(t *testing.T) {
	decision := parseChatIntentOutput(`{"intent":"general","standaloneQuery":"ignored","reason":"通用概念"}`, "什么是向量检索？")
	if decision.Intent != chatIntentGeneral {
		t.Fatalf("expected general, got %q", decision.Intent)
	}
	if decision.StandaloneQuery != "" {
		t.Fatalf("general must not carry a retrieval query, got %q", decision.StandaloneQuery)
	}
}

// A general question is not expected to be in the knowledge base, so the turn
// answers from the model's own knowledge and never pays for retrieval. The
// answer is deliberately un-cited: it has no chunk to point at.
func TestGeneralIntentAnswersWithoutRetrievalAndWithoutCitations(t *testing.T) {
	ctx := context.Background()
	db := newChatServiceTestDB(t)
	user := createChatServiceUser(t, db)
	kb := createChatServiceKnowledgeBase(t, db, user.ID)
	session := createChatServiceSession(t, db, user.ID, kb.ID)
	retrieval := &fakeChatRetrieval{response: oneKnowledgeChunk()}
	chatProvider := &fakeChatProvider{responses: []string{
		`{"intent":"general","reason":"通用概念"}`,
		"检索增强生成是在生成前先检索相关片段的方法。",
	}}
	service := NewChatService(
		config.Config{VectorTopN: 30, RerankTopK: 5, ChatHistoryLimit: 10},
		repository.NewChatRepository(db),
		repository.NewKnowledgeBaseRepository(db),
		retrieval, chatProvider,
	)

	res, err := service.SendMessage(ctx, user.ID, session.ID, dto.SendChatMessageRequest{
		Content:         "什么是检索增强生成？",
		ClientRequestID: uuid.NewString(),
	})
	if err != nil {
		t.Fatalf("send message: %v", err)
	}

	if len(retrieval.calls) != 0 {
		t.Fatalf("general turn ran retrieval: %#v", retrieval.calls)
	}
	if len(chatProvider.calls) != 2 {
		t.Fatalf("expected intent and answer calls only, got %d", len(chatProvider.calls))
	}
	if len(res.Citations) != 0 {
		t.Fatalf("general answer must not carry citations: %#v", res.Citations)
	}

	stored := loadChatMessage(t, db, res.AssistantMessage.ID)
	if stored.Intent == nil || *stored.Intent != chatIntentGeneral {
		t.Fatalf("expected stored general intent, got %#v", stored.Intent)
	}
	if stored.AnswerStatus == nil || *stored.AnswerStatus != AnswerStatusAnswered {
		t.Fatalf("expected answered, got %#v", stored.AnswerStatus)
	}
	if stored.RetrievalQuery != nil {
		t.Fatalf("general turn must not store a retrieval query, got %q", *stored.RetrievalQuery)
	}
}

// A base that allows general knowledge prefers a labelled answer over a bare
// refusal, so an empty result still reaches the model. A strict base never does:
// the refusal is answered locally and costs no generation call.
func TestKnowledgeBaseTurnWithoutEvidenceHonorsGeneralKnowledgeSetting(t *testing.T) {
	cases := []struct {
		name         string
		allowGeneral bool
		wantCalls    int
		wantStatus   string
	}{
		{name: "strict base refuses locally", allowGeneral: false, wantCalls: 1, wantStatus: AnswerStatusNoBasis},
		{name: "permissive base answers", allowGeneral: true, wantCalls: 2, wantStatus: AnswerStatusAnswered},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			ctx := context.Background()
			db := newChatServiceTestDB(t)
			user := createChatServiceUser(t, db)
			kb := createChatServiceKnowledgeBase(t, db, user.ID)
			session := createChatServiceSession(t, db, user.ID, kb.ID)
			if testCase.allowGeneral {
				if err := db.Model(&model.KnowledgeBase{}).Where("id = ?", kb.ID).
					Update("answer_config", datatypes.JSON(`{"allowGeneralKnowledge":true}`)).Error; err != nil {
					t.Fatalf("enable general knowledge: %v", err)
				}
			}
			retrieval := &fakeChatRetrieval{response: &dto.SearchResponse{}}
			chatProvider := &fakeChatProvider{responses: []string{
				`{"intent":"knowledge_base","standaloneQuery":"公积金提取流程","reason":"涉及本组织规则"}`,
				"知识库没有相关流程，以下为常识补充（非知识库依据）：一般需本人身份证与提取申请表。",
			}}
			service := NewChatService(
				config.Config{VectorTopN: 30, RerankTopK: 5, ChatHistoryLimit: 10},
				repository.NewChatRepository(db),
				repository.NewKnowledgeBaseRepository(db),
				retrieval, chatProvider,
			)

			res, err := service.SendMessage(ctx, user.ID, session.ID, dto.SendChatMessageRequest{
				Content:         "我们这边公积金怎么提取？",
				ClientRequestID: uuid.NewString(),
			})
			if err != nil {
				t.Fatalf("send message: %v", err)
			}
			if len(chatProvider.calls) != testCase.wantCalls {
				t.Fatalf("expected %d provider calls, got %d", testCase.wantCalls, len(chatProvider.calls))
			}

			stored := loadChatMessage(t, db, res.AssistantMessage.ID)
			if stored.AnswerStatus == nil || *stored.AnswerStatus != testCase.wantStatus {
				t.Fatalf("expected %s, got %#v", testCase.wantStatus, stored.AnswerStatus)
			}
			if !testCase.allowGeneral {
				return
			}
			// The empty result is stated in the prompt rather than silently
			// omitted, so the model answers a recorded absence of evidence.
			prompt := chatProvider.calls[1][len(chatProvider.calls[1])-1].Content
			if !strings.Contains(prompt, "本轮未检索到知识片段") {
				t.Fatalf("prompt must state that no chunk was retrieved: %s", prompt)
			}
			if len(res.Citations) != 0 {
				t.Fatalf("an answer without evidence must not gain citations: %#v", res.Citations)
			}
		})
	}
}

// In a multi-base turn no single base owns the prompt, but the permission to add
// un-cited text still has to come from somewhere: every base whose chunks reached
// the answer must agree, because the supplement sits next to all of them.
func TestMultiBaseTurnRequiresEveryContributorToAllowGeneralKnowledge(t *testing.T) {
	cases := []struct {
		name         string
		allowPrimary bool
		allowLinked  bool
	}{
		{name: "one contributor forbids it", allowPrimary: true, allowLinked: false},
		{name: "every contributor allows it", allowPrimary: true, allowLinked: true},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			ctx := context.Background()
			f := newWorkspaceTestServices(t)
			owner := createWorkspaceUser(t, f.db, "contributors-owner")
			primary := createWorkspaceKB(t, f.db, owner.ID, uuid.Nil, "制度", "private", time.Now())
			linked := createWorkspaceKB(t, f.db, owner.ID, uuid.Nil, "产品", "private", time.Now())
			for kb, allowed := range map[uuid.UUID]bool{primary.ID: testCase.allowPrimary, linked.ID: testCase.allowLinked} {
				config := datatypes.JSON(`{"allowGeneralKnowledge":false}`)
				if allowed {
					config = datatypes.JSON(`{"allowGeneralKnowledge":true}`)
				}
				if err := f.db.Model(&model.KnowledgeBase{}).Where("id = ?", kb).Update("answer_config", config).Error; err != nil {
					t.Fatalf("set answer config: %v", err)
				}
			}

			f.chats.retrieval = &multiChatFixtureRetrieval{items: []dto.SearchResultResponse{
				{KnowledgeBaseID: primary.ID.String(), KnowledgeBaseName: primary.Name, ChunkID: uuid.NewString(), DocumentID: uuid.NewString(), Content: "保留35天"},
				{KnowledgeBaseID: linked.ID.String(), KnowledgeBaseName: linked.Name, ChunkID: uuid.NewString(), DocumentID: uuid.NewString(), Content: "恢复18分钟"},
			}}
			provider := &fakeChatProvider{responses: []string{
				`{"intent":"knowledge_base","standaloneQuery":"保留多久","reason":"涉及本组织资料"}`,
				"保留35天 [source: 1]，恢复18分钟 [source: 2]。",
			}}
			f.chats.chatProvider = provider

			session, err := f.chats.CreateSession(ctx, owner.ID, dto.CreateChatSessionRequest{KnowledgeBaseIDs: []string{primary.ID.String(), linked.ID.String()}})
			if err != nil {
				t.Fatal(err)
			}
			if _, err := f.chats.SendMessage(ctx, owner.ID, uuid.MustParse(session.ID), dto.SendChatMessageRequest{Content: "保留多久？", ClientRequestID: uuid.NewString()}); err != nil {
				t.Fatal(err)
			}

			if len(provider.calls) != 2 {
				t.Fatalf("expected intent and answer calls, got %d", len(provider.calls))
			}
			system := provider.calls[1][0].Content
			permitted := strings.Contains(system, "允许补充常识时")
			strict := strings.Contains(system, "当前为严格依据模式")
			if testCase.allowLinked && (!permitted || strict) {
				t.Fatalf("every contributor allowed general knowledge but the prompt is strict: %s", system)
			}
			if !testCase.allowLinked && (!strict || permitted) {
				t.Fatalf("a contributor forbade general knowledge but the prompt permits it: %s", system)
			}
		})
	}
}

// The knowledge base switch is the answer config's only setting that survives
// into an automatic turn: the prompt, model and temperature of one base cannot
// represent several, but the permission to answer without evidence can.
func TestAutomaticTurnReadsGeneralKnowledgeFromContributors(t *testing.T) {
	ctx := context.Background()
	f := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, f.db, "automatic-contributor-owner")
	base := createWorkspaceKB(t, f.db, owner.ID, uuid.Nil, "手册", "private", time.Now())
	if err := f.db.Model(&model.KnowledgeBase{}).Where("id = ?", base.ID).
		Update("answer_config", datatypes.JSON(`{"allowGeneralKnowledge":true,"systemPromptAddition":"AUTOMATIC-ONLY-PROMPT"}`)).Error; err != nil {
		t.Fatalf("set answer config: %v", err)
	}

	f.chats.retrieval = &automaticRetrievalFixture{multiChatFixtureRetrieval: multiChatFixtureRetrieval{items: []dto.SearchResultResponse{
		{KnowledgeBaseID: base.ID.String(), KnowledgeBaseName: base.Name, ChunkID: uuid.NewString(), DocumentID: uuid.NewString(), Content: "手册正文"},
	}}}
	provider := &fakeChatProvider{responses: []string{
		`{"intent":"knowledge_base","standaloneQuery":"规定","reason":"涉及本组织资料"}`,
		"手册正文 [source: 1]。",
	}}
	f.chats.chatProvider = provider

	session, err := f.chats.CreateSession(ctx, owner.ID, dto.CreateChatSessionRequest{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.chats.SendMessage(ctx, owner.ID, uuid.MustParse(session.ID), dto.SendChatMessageRequest{Content: "规定是什么？", ClientRequestID: uuid.NewString()}); err != nil {
		t.Fatal(err)
	}

	if len(provider.calls) != 2 {
		t.Fatalf("expected intent and answer calls, got %d", len(provider.calls))
	}
	system := provider.calls[1][0].Content
	if !strings.Contains(system, "允许补充常识时") {
		t.Fatalf("automatic turn ignored the contributor's permission: %s", system)
	}
	if strings.Contains(system, "AUTOMATIC-ONLY-PROMPT") {
		t.Fatalf("automatic turn inherited a single base's prompt addition: %s", system)
	}
}
