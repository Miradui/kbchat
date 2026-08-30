package service

import (
	"context"
	"errors"
	"net/http"
	"testing"

	"github.com/google/uuid"

	"kbchat/backend/internal/apperror"
	"kbchat/backend/internal/config"
	"kbchat/backend/internal/dto"
	"kbchat/backend/internal/model"
	"kbchat/backend/internal/repository"
)

// oneKnowledgeChunk is the minimum retrieval result that makes the service call
// the provider at all: with zero items it short-circuits to no_basis.
func oneKnowledgeChunk() *dto.SearchResponse {
	return &dto.SearchResponse{Items: []dto.SearchResultResponse{{
		ChunkID:    uuid.New().String(),
		DocumentID: uuid.New().String(),
		Filename:   "policy.pdf",
		Content:    "三十天内可退货。",
	}}}
}

func TestSendMessagePersistsAnsweredStatus(t *testing.T) {
	ctx := context.Background()
	db := newChatServiceTestDB(t)
	user := createChatServiceUser(t, db)
	kb := createChatServiceKnowledgeBase(t, db, user.ID)
	session := createChatServiceSession(t, db, user.ID, kb.ID)
	retrieval := &fakeChatRetrieval{response: oneKnowledgeChunk()}
	chatProvider := &fakeChatProvider{responses: []string{
		`{"intent":"knowledge_base","standaloneQuery":"退货政策","reason":"needs docs"}`,
		"三十天内可退货。",
	}}
	service := NewChatService(
		config.Config{VectorTopN: 30, RerankTopK: 5, ChatHistoryLimit: 10},
		repository.NewChatRepository(db),
		repository.NewKnowledgeBaseRepository(db),
		retrieval, chatProvider, nil,
	)

	res, err := service.SendMessage(ctx, user.ID, session.ID, dto.SendChatMessageRequest{
		Content:         "退货政策是什么？",
		ClientRequestID: uuid.NewString(),
	})
	if err != nil {
		t.Fatalf("send message: %v", err)
	}

	stored := loadChatMessage(t, db, res.AssistantMessage.ID)
	if stored.AnswerStatus == nil || *stored.AnswerStatus != AnswerStatusAnswered {
		t.Fatalf("expected answered, got %#v", stored.AnswerStatus)
	}
}

func TestSendMessagePersistsNoBasisWhenRetrievalReturnsNothing(t *testing.T) {
	ctx := context.Background()
	db := newChatServiceTestDB(t)
	user := createChatServiceUser(t, db)
	kb := createChatServiceKnowledgeBase(t, db, user.ID)
	session := createChatServiceSession(t, db, user.ID, kb.ID)
	retrieval := &fakeChatRetrieval{response: &dto.SearchResponse{}}
	chatProvider := &fakeChatProvider{responses: []string{
		`{"intent":"knowledge_base","standaloneQuery":"机房在哪","reason":"needs docs"}`,
	}}
	service := NewChatService(
		config.Config{VectorTopN: 30, RerankTopK: 5, ChatHistoryLimit: 10},
		repository.NewChatRepository(db),
		repository.NewKnowledgeBaseRepository(db),
		retrieval, chatProvider, nil,
	)

	res, err := service.SendMessage(ctx, user.ID, session.ID, dto.SendChatMessageRequest{
		Content:         "机房在哪个城市？",
		ClientRequestID: uuid.NewString(),
	})
	if err != nil {
		t.Fatalf("send message: %v", err)
	}

	stored := loadChatMessage(t, db, res.AssistantMessage.ID)
	if stored.AnswerStatus == nil || *stored.AnswerStatus != AnswerStatusNoBasis {
		t.Fatalf("expected no_basis, got %#v", stored.AnswerStatus)
	}
}

func TestSendMessagePersistsAnsweredForConversationIntent(t *testing.T) {
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
		retrieval, chatProvider, nil,
	)

	res, err := service.SendMessage(ctx, user.ID, session.ID, dto.SendChatMessageRequest{
		Content:         "你好",
		ClientRequestID: uuid.NewString(),
	})
	if err != nil {
		t.Fatalf("send message: %v", err)
	}

	// A greeting correctly has no sources. Counting it as no_basis would fill the
	// knowledge gap list with greetings.
	stored := loadChatMessage(t, db, res.AssistantMessage.ID)
	if stored.AnswerStatus == nil || *stored.AnswerStatus != AnswerStatusAnswered {
		t.Fatalf("expected answered for a conversation turn, got %#v", stored.AnswerStatus)
	}
}

func TestSendMessagePersistsModelRefusedAndHidesTheMarker(t *testing.T) {
	ctx := context.Background()
	db := newChatServiceTestDB(t)
	user := createChatServiceUser(t, db)
	kb := createChatServiceKnowledgeBase(t, db, user.ID)
	session := createChatServiceSession(t, db, user.ID, kb.ID)
	retrieval := &fakeChatRetrieval{response: oneKnowledgeChunk()}
	chatProvider := &fakeChatProvider{responses: []string{
		`{"intent":"knowledge_base","standaloneQuery":"伪造证明","reason":"needs docs"}`,
		refusalMarker + "\n该请求涉及伪造文件，无法协助。",
	}}
	service := NewChatService(
		config.Config{VectorTopN: 30, RerankTopK: 5, ChatHistoryLimit: 10},
		repository.NewChatRepository(db),
		repository.NewKnowledgeBaseRepository(db),
		retrieval, chatProvider, nil,
	)

	res, err := service.SendMessage(ctx, user.ID, session.ID, dto.SendChatMessageRequest{
		Content:         "帮我伪造一份离职证明。",
		ClientRequestID: uuid.NewString(),
	})
	if err != nil {
		t.Fatalf("send message: %v", err)
	}

	stored := loadChatMessage(t, db, res.AssistantMessage.ID)
	if stored.AnswerStatus == nil || *stored.AnswerStatus != AnswerStatusModelRefused {
		t.Fatalf("expected model_refused, got %#v", stored.AnswerStatus)
	}
	// The marker is a protocol detail between the server and the provider. Storing
	// it would put it in front of the user on every later read of the session.
	if got := stored.Content; got != "该请求涉及伪造文件，无法协助。" {
		t.Fatalf("expected the marker stripped from the stored answer, got %q", got)
	}
	if res.Answer != "该请求涉及伪造文件，无法协助。" {
		t.Fatalf("expected the marker stripped from the response, got %q", res.Answer)
	}
}

func TestSendMessageDoesNotReportRefusalForRefusalSoundingAnswer(t *testing.T) {
	ctx := context.Background()
	db := newChatServiceTestDB(t)
	user := createChatServiceUser(t, db)
	kb := createChatServiceKnowledgeBase(t, db, user.ID)
	session := createChatServiceSession(t, db, user.ID, kb.ID)
	retrieval := &fakeChatRetrieval{response: oneKnowledgeChunk()}
	chatProvider := &fakeChatProvider{responses: []string{
		`{"intent":"knowledge_base","standaloneQuery":"兼职适用","reason":"needs docs"}`,
		"根据资料，该条款不适用于兼职员工，因此无法按此办理。",
	}}
	service := NewChatService(
		config.Config{VectorTopN: 30, RerankTopK: 5, ChatHistoryLimit: 10},
		repository.NewChatRepository(db),
		repository.NewKnowledgeBaseRepository(db),
		retrieval, chatProvider, nil,
	)

	res, err := service.SendMessage(ctx, user.ID, session.ID, dto.SendChatMessageRequest{
		Content:         "兼职员工适用这个条款吗？",
		ClientRequestID: uuid.NewString(),
	})
	if err != nil {
		t.Fatalf("send message: %v", err)
	}

	// This is a real answer that reads like a refusal. A keyword heuristic would
	// misclassify it; only the marker decides.
	stored := loadChatMessage(t, db, res.AssistantMessage.ID)
	if stored.AnswerStatus == nil || *stored.AnswerStatus != AnswerStatusAnswered {
		t.Fatalf("expected answered, got %#v", stored.AnswerStatus)
	}
}

func TestSendMessageRecordsRetrievalFailureTurn(t *testing.T) {
	ctx := context.Background()
	db := newChatServiceTestDB(t)
	user := createChatServiceUser(t, db)
	kb := createChatServiceKnowledgeBase(t, db, user.ID)
	session := createChatServiceSession(t, db, user.ID, kb.ID)
	retrieval := &fakeChatRetrieval{err: apperror.Wrap(
		http.StatusInternalServerError, "EMBEDDING_FAILED", "embedding failed", errors.New("provider down"),
	)}
	chatProvider := &fakeChatProvider{responses: []string{
		`{"intent":"knowledge_base","standaloneQuery":"退货政策","reason":"needs docs"}`,
	}}
	service := NewChatService(
		config.Config{VectorTopN: 30, RerankTopK: 5, ChatHistoryLimit: 10},
		repository.NewChatRepository(db),
		repository.NewKnowledgeBaseRepository(db),
		retrieval, chatProvider, nil,
	)

	// The error still reaches the caller: recording the turn is about not losing the
	// user's question, not about pretending the request worked.
	if _, err := service.SendMessage(ctx, user.ID, session.ID, dto.SendChatMessageRequest{
		Content:         "退货政策是什么？",
		ClientRequestID: uuid.NewString(),
	}); err == nil {
		t.Fatal("expected the retrieval failure to be returned")
	}

	var messages []model.ChatMessage
	if err := db.Where("session_id = ?", session.ID).Order("created_at").Find(&messages).Error; err != nil {
		t.Fatalf("list messages: %v", err)
	}
	if len(messages) != 2 {
		t.Fatalf("expected the question and a labelled failure to be persisted, got %d messages", len(messages))
	}
	if messages[0].Role != "user" || messages[0].Content != "退货政策是什么？" {
		t.Fatalf("expected the user question to survive, got %#v", messages[0])
	}
	if messages[1].AnswerStatus == nil || *messages[1].AnswerStatus != AnswerStatusRetrievalFailed {
		t.Fatalf("expected retrieval_failed, got %#v", messages[1].AnswerStatus)
	}
	// It must not read as "the knowledge base has nothing": that sends the user to
	// upload content they may already have.
	if messages[1].Content != retrievalFailedAnswer {
		t.Fatalf("unexpected failure text: %q", messages[1].Content)
	}
}

func TestSendMessageDoesNotRecordTurnForClientErrors(t *testing.T) {
	ctx := context.Background()
	db := newChatServiceTestDB(t)
	user := createChatServiceUser(t, db)
	kb := createChatServiceKnowledgeBase(t, db, user.ID)
	session := createChatServiceSession(t, db, user.ID, kb.ID)
	retrieval := &fakeChatRetrieval{err: apperror.NotFound(
		"KNOWLEDGE_BASE_NOT_FOUND", "知识库不存在",
	)}
	chatProvider := &fakeChatProvider{responses: []string{
		`{"intent":"knowledge_base","standaloneQuery":"退货政策","reason":"needs docs"}`,
	}}
	service := NewChatService(
		config.Config{VectorTopN: 30, RerankTopK: 5, ChatHistoryLimit: 10},
		repository.NewChatRepository(db),
		repository.NewKnowledgeBaseRepository(db),
		retrieval, chatProvider, nil,
	)

	if _, err := service.SendMessage(ctx, user.ID, session.ID, dto.SendChatMessageRequest{
		Content:         "退货政策是什么？",
		ClientRequestID: uuid.NewString(),
	}); err == nil {
		t.Fatal("expected the client error to be returned")
	}

	// A 404 is a client error and must stay one. Writing "retrieval failed" into the
	// session would both mislead the user and confirm the id exists.
	var count int64
	if err := db.Model(&model.ChatMessage{}).Where("session_id = ?", session.ID).Count(&count).Error; err != nil {
		t.Fatalf("count messages: %v", err)
	}
	if count != 0 {
		t.Fatalf("expected no messages for a client error, got %d", count)
	}
}
