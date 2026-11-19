package service

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"kbchat/backend/internal/config"
	"kbchat/backend/internal/dto"
	"kbchat/backend/internal/model"
	"kbchat/backend/internal/repository"
)

func TestNormalizeRetrievalQuery(t *testing.T) {
	cases := []struct {
		name  string
		query string
		want  string
	}{
		{name: "empty stays empty", query: "", want: ""},
		{name: "trims and lowercases", query: "  Return Policy  ", want: "returnpolicy"},
		{name: "drops trailing punctuation", query: "如何退货？", want: "如何退货"},
		{
			name:  "cjk spacing is irrelevant",
			query: "退货 政策",
			want:  "退货政策",
		},
		{
			name:  "symbols are dropped",
			query: "退款 ≥ 30 天?",
			want:  "退款30天",
		},
		{
			name:  "punctuation only is not groupable",
			query: "？？？ ---",
			want:  "",
		},
		{name: "full width punctuation", query: "发票，需要吗！", want: "发票需要吗"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if got := normalizeRetrievalQuery(testCase.query); got != testCase.want {
				t.Fatalf("normalizeRetrievalQuery(%q) = %q, want %q", testCase.query, got, testCase.want)
			}
		})
	}
}

// "退货 政策" and "退货政策" are different strings but the same question, so they
// must normalize into one cluster key. This is the property the whole
// repeated_rewrite category depends on.
func TestNormalizeRetrievalQueryGroupsRewordings(t *testing.T) {
	variants := []string{"退货政策", "退货 政策", "退货政策？", "  退货政策  "}
	want := normalizeRetrievalQuery(variants[0])
	if want == "" {
		t.Fatal("expected a groupable normalized form")
	}
	for _, variant := range variants[1:] {
		if got := normalizeRetrievalQuery(variant); got != want {
			t.Fatalf("expected %q to normalize to %q, got %q", variant, want, got)
		}
	}
}

func TestSendMessagePersistsKnowledgeIntentAndRetrievalQuery(t *testing.T) {
	ctx := context.Background()
	db := newChatServiceTestDB(t)
	user := createChatServiceUser(t, db)
	kb := createChatServiceKnowledgeBase(t, db, user.ID)
	session := createChatServiceSession(t, db, user.ID, kb.ID)
	retrieval := &fakeChatRetrieval{response: &dto.SearchResponse{
		Items: []dto.SearchResultResponse{{
			ChunkID:    uuid.New().String(),
			DocumentID: uuid.New().String(),
			Filename:   "policy.pdf",
			Content:    "三十天内可退货。",
		}},
	}}
	chatProvider := &fakeChatProvider{responses: []string{
		`{"intent":"knowledge_base","standaloneQuery":"退货 政策","reason":"needs docs"}`,
		"三十天内可退货。",
	}}
	service := NewChatService(
		config.Config{VectorTopN: 30, RerankTopK: 5, ChatHistoryLimit: 10},
		repository.NewChatRepository(db),
		repository.NewKnowledgeBaseRepository(db),
		retrieval,
		chatProvider,
	)

	res, err := service.SendMessage(ctx, user.ID, session.ID, dto.SendChatMessageRequest{
		Content:         "退货政策是什么？",
		ClientRequestID: uuid.NewString(),
	})
	if err != nil {
		t.Fatalf("send message: %v", err)
	}

	stored := loadChatMessage(t, db, res.AssistantMessage.ID)
	if stored.Intent == nil || *stored.Intent != chatIntentKnowledgeBase {
		t.Fatalf("expected knowledge_base intent, got %#v", stored.Intent)
	}
	if stored.RetrievalQuery == nil || *stored.RetrievalQuery != "退货 政策" {
		t.Fatalf("expected the canonical retrieval query verbatim, got %#v", stored.RetrievalQuery)
	}
	// The normalized column is what clustering groups on, so it must drop the space.
	if stored.RetrievalQueryNorm == nil || *stored.RetrievalQueryNorm != "退货政策" {
		t.Fatalf("expected normalized retrieval query, got %#v", stored.RetrievalQueryNorm)
	}
}

func TestSendMessagePersistsConversationIntentWithoutRetrievalQuery(t *testing.T) {
	ctx := context.Background()
	db := newChatServiceTestDB(t)
	user := createChatServiceUser(t, db)
	kb := createChatServiceKnowledgeBase(t, db, user.ID)
	session := createChatServiceSession(t, db, user.ID, kb.ID)
	retrieval := &fakeChatRetrieval{response: &dto.SearchResponse{}}
	chatProvider := &fakeChatProvider{responses: []string{
		`{"intent":"conversation","reason":"greeting"}`,
		"你好，我可以帮你查询知识库。",
	}}
	service := NewChatService(
		config.Config{ChatHistoryLimit: 10},
		repository.NewChatRepository(db),
		repository.NewKnowledgeBaseRepository(db),
		retrieval,
		chatProvider,
	)

	res, err := service.SendMessage(ctx, user.ID, session.ID, dto.SendChatMessageRequest{
		Content:         "你好",
		ClientRequestID: uuid.NewString(),
	})
	if err != nil {
		t.Fatalf("send message: %v", err)
	}
	if len(retrieval.calls) != 0 {
		t.Fatalf("conversation intent must skip retrieval, got %d calls", len(retrieval.calls))
	}

	stored := loadChatMessage(t, db, res.AssistantMessage.ID)
	if stored.Intent == nil || *stored.Intent != chatIntentConversation {
		t.Fatalf("expected conversation intent, got %#v", stored.Intent)
	}
	// No retrieval ran, so recording a query would claim something that never happened
	// and would also make this answer eligible for rewrite clustering.
	if stored.RetrievalQuery != nil || stored.RetrievalQueryNorm != nil {
		t.Fatalf("expected no retrieval query on a conversation answer, got %#v / %#v",
			stored.RetrievalQuery, stored.RetrievalQueryNorm)
	}
}

func TestRegenerateMessagePersistsProvenanceWithoutClientRequestID(t *testing.T) {
	ctx := context.Background()
	db := newChatServiceTestDB(t)
	user := createChatServiceUser(t, db)
	kb := createChatServiceKnowledgeBase(t, db, user.ID)
	session := createChatServiceSession(t, db, user.ID, kb.ID)
	retrieval := &fakeChatRetrieval{response: &dto.SearchResponse{
		Items: []dto.SearchResultResponse{{
			ChunkID:    uuid.New().String(),
			DocumentID: uuid.New().String(),
			Filename:   "policy.pdf",
			Content:    "三十天内可退货。",
		}},
	}}
	chatProvider := &fakeChatProvider{responses: []string{
		`{"intent":"knowledge_base","standaloneQuery":"退货政策","reason":"needs docs"}`,
		"第一次回答",
		`{"intent":"knowledge_base","standaloneQuery":"退货政策","reason":"needs docs"}`,
		"重新生成的回答",
	}}
	service := NewChatService(
		config.Config{VectorTopN: 30, RerankTopK: 5, ChatHistoryLimit: 10},
		repository.NewChatRepository(db),
		repository.NewKnowledgeBaseRepository(db),
		retrieval,
		chatProvider,
	)

	sent, err := service.SendMessage(ctx, user.ID, session.ID, dto.SendChatMessageRequest{
		Content:         "退货政策是什么？",
		ClientRequestID: uuid.NewString(),
	})
	if err != nil {
		t.Fatalf("send message: %v", err)
	}
	assistantID, err := uuid.Parse(sent.AssistantMessage.ID)
	if err != nil {
		t.Fatalf("parse assistant id: %v", err)
	}
	regenerated, err := service.RegenerateMessage(ctx, user.ID, session.ID, assistantID)
	if err != nil {
		t.Fatalf("regenerate message: %v", err)
	}

	stored := loadChatMessage(t, db, regenerated.Message.ID)
	if stored.Intent == nil || *stored.Intent != chatIntentKnowledgeBase {
		t.Fatalf("expected regenerated answer to record its intent, got %#v", stored.Intent)
	}
	if stored.RetrievalQueryNorm == nil || *stored.RetrievalQueryNorm != "退货政策" {
		t.Fatalf("expected regenerated answer to record its retrieval query, got %#v", stored.RetrievalQueryNorm)
	}
	// Regenerations must stay out of rewrite clustering: the user asked once, so
	// counting each retry as a rephrasing would invent a knowledge gap. A nil
	// client_request_id is exactly what the cluster query filters on.
	if stored.ClientRequestID != nil {
		t.Fatalf("expected regenerated answer to carry no client request id, got %#v", stored.ClientRequestID)
	}
}

func loadChatMessage(t *testing.T, db *gorm.DB, id string) model.ChatMessage {
	t.Helper()
	var message model.ChatMessage
	if err := db.First(&message, "id = ?", id).Error; err != nil {
		t.Fatalf("load chat message %s: %v", id, err)
	}
	return message
}
