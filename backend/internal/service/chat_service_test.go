package service

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"

	"rag/backend/internal/apperror"
	chatcore "rag/backend/internal/chat"
	"rag/backend/internal/config"
	"rag/backend/internal/dto"
	"rag/backend/internal/model"
	"rag/backend/internal/repository"
	titlecore "rag/backend/internal/title"
)

type fakeChatProvider struct {
	response  string
	responses []string
	messages  []chatcore.Message
	calls     [][]chatcore.Message
	err       error
}

func (p *fakeChatProvider) Chat(_ context.Context, messages []chatcore.Message) (string, error) {
	p.messages = messages
	p.calls = append(p.calls, messages)
	if p.err != nil {
		return "", p.err
	}
	if len(p.responses) > 0 {
		response := p.responses[0]
		p.responses = p.responses[1:]
		return response, nil
	}
	return p.response, nil
}

type fakeTitleProvider struct {
	response string
	messages []titlecore.Message
}

func (p *fakeTitleProvider) SummarizeTitle(_ context.Context, messages []titlecore.Message) (string, error) {
	p.messages = messages
	return p.response, nil
}

type fakeChatRetrieval struct {
	response *dto.SearchResponse
	err      error
	calls    []dto.SearchRequest
}

func (r *fakeChatRetrieval) Search(_ context.Context, _ uuid.UUID, _ uuid.UUID, req dto.SearchRequest) (*dto.SearchResponse, error) {
	r.calls = append(r.calls, req)
	if r.err != nil {
		return nil, r.err
	}
	return r.response, nil
}

func TestBuildIntentClassificationMessagesUsesRecentHistory(t *testing.T) {
	history := []model.ChatMessage{
		{Role: "user", Content: "请介绍企业知识库系统。"},
		{Role: "assistant", Content: "它支持文档上传、检索和问答。"},
		{Role: "user", Content: "上传能力怎么样？"},
		{Role: "assistant", Content: "MVP 支持 txt、md、pdf。"},
	}

	messages := buildIntentClassificationMessages("那它的引用怎么展示？", history, 2)

	if len(messages) != 4 {
		t.Fatalf("expected 4 messages, got %d", len(messages))
	}
	if messages[0].Role != "system" {
		t.Fatalf("expected first message role system, got %q", messages[0].Role)
	}
	if messages[1].Content != "上传能力怎么样？" {
		t.Fatalf("expected trimmed history to keep recent user message, got %q", messages[1].Content)
	}
	if messages[2].Content != "MVP 支持 txt、md、pdf。" {
		t.Fatalf("expected trimmed history to keep recent assistant message, got %q", messages[2].Content)
	}
	if messages[3].Role != "user" || !strings.Contains(messages[3].Content, "那它的引用怎么展示？") {
		t.Fatalf("expected final message to ask for intent classification, got %#v", messages[3])
	}
}

func TestBuildAnswerMessagesIncludesHistoryBeforeRAGPrompt(t *testing.T) {
	history := []model.ChatMessage{
		{Role: "user", Content: "系统支持哪些文档？"},
		{Role: "assistant", Content: "MVP 支持 txt、md、pdf。"},
	}
	items := []dto.SearchResultResponse{
		{
			DocumentID:  "doc-1",
			ChunkID:     "chunk-1",
			Filename:    "prd.md",
			Content:     "引用来源必须包含文档名、页码、片段内容和分数。",
			VectorScore: 0.82,
		},
	}

	messages := buildAnswerMessages("它的引用怎么展示？", items, history, 10)

	if len(messages) != 4 {
		t.Fatalf("expected system, 2 history messages, and current RAG prompt, got %d", len(messages))
	}
	if messages[1].Role != "user" || messages[1].Content != "系统支持哪些文档？" {
		t.Fatalf("expected user history after system prompt, got %#v", messages[1])
	}
	if messages[2].Role != "assistant" || messages[2].Content != "MVP 支持 txt、md、pdf。" {
		t.Fatalf("expected assistant history before current RAG prompt, got %#v", messages[2])
	}
	if messages[3].Role != "user" {
		t.Fatalf("expected final message role user, got %q", messages[3].Role)
	}
	if !strings.Contains(messages[3].Content, "它的引用怎么展示？") {
		t.Fatalf("expected final RAG prompt to contain current question, got %q", messages[3].Content)
	}
	if !strings.Contains(messages[3].Content, "引用来源必须包含文档名") {
		t.Fatalf("expected final RAG prompt to contain retrieved chunk, got %q", messages[3].Content)
	}
}

func TestRecentChatHistoryFiltersInvalidAndEmptyMessages(t *testing.T) {
	history := []model.ChatMessage{
		{Role: "system", Content: "internal"},
		{Role: "user", Content: "  "},
		{Role: "user", Content: "第一问"},
		{Role: "assistant", Content: "第一答"},
		{Role: "user", Content: "第二问"},
	}

	recent := recentChatHistory(history, 2)

	if len(recent) != 2 {
		t.Fatalf("expected 2 valid recent messages, got %d", len(recent))
	}
	if recent[0].Content != "第一答" || recent[1].Content != "第二问" {
		t.Fatalf("expected most recent valid user/assistant messages, got %#v", recent)
	}
}

func TestClassifyChatIntentUsesProviderResponse(t *testing.T) {
	provider := &fakeChatProvider{
		response: `{"intent":"conversation","standaloneQuery":"","reason":"用户询问对话历史"}`,
	}
	history := []model.ChatMessage{
		{Role: "user", Content: "你好"},
	}

	intent, err := classifyChatIntent(context.Background(), provider, "随便一个程序不认识的表达", history, 10)
	if err != nil {
		t.Fatalf("classify chat intent returned error: %v", err)
	}
	if intent.Intent != chatIntentConversation {
		t.Fatalf("expected provider-selected conversation intent, got %#v", intent)
	}
	if len(provider.messages) < 3 {
		t.Fatalf("expected classifier prompt to include system, history, and current question, got %#v", provider.messages)
	}
	if provider.messages[1].Content != "你好" {
		t.Fatalf("expected classifier to receive recent history, got %#v", provider.messages)
	}
}

func TestBuildConversationAnswerMessagesUsesHistoryWithoutRAGChunks(t *testing.T) {
	history := []model.ChatMessage{
		{Role: "user", Content: "你好"},
		{Role: "assistant", Content: "你好！请问有什么可以帮你解答的吗？"},
	}

	messages := buildConversationAnswerMessages("我上一句话是什么/", history, 10)

	if len(messages) != 4 {
		t.Fatalf("expected system, 2 history messages, and current question, got %d", len(messages))
	}
	if messages[1].Role != "user" || messages[1].Content != "你好" {
		t.Fatalf("expected user history to be included, got %#v", messages[1])
	}
	if messages[3].Role != "user" || messages[3].Content != "我上一句话是什么/" {
		t.Fatalf("expected current question as final message, got %#v", messages[3])
	}
	for _, message := range messages {
		if strings.Contains(message.Content, "知识片段") || strings.Contains(message.Content, "source:") {
			t.Fatalf("conversation answer should not include RAG chunks, got %q", message.Content)
		}
	}
}

func TestParseChatIntentOutputAcceptsFencedJSON(t *testing.T) {
	intent := parseChatIntentOutput("```json\n{\"intent\":\"knowledge_base\",\"standaloneQuery\":\"RAG 引用来源展示规则\",\"reason\":\"需要查询知识库\"}\n```", "它的引用呢？")

	if intent.Intent != chatIntentKnowledgeBase {
		t.Fatalf("expected knowledge_base intent, got %#v", intent)
	}
	if intent.StandaloneQuery != "RAG 引用来源展示规则" {
		t.Fatalf("expected standalone query from model output, got %#v", intent)
	}
}

func TestParseChatIntentOutputFallsBackToKnowledgeBase(t *testing.T) {
	intent := parseChatIntentOutput("not json", "什么是 RAG？")

	if intent.Intent != chatIntentKnowledgeBase {
		t.Fatalf("expected fallback knowledge_base intent, got %#v", intent)
	}
	if intent.StandaloneQuery != "什么是 RAG？" {
		t.Fatalf("expected fallback standalone query to be original question, got %#v", intent)
	}
}

func TestGenerateSessionTitleUsesDedicatedTitleProvider(t *testing.T) {
	provider := &fakeTitleProvider{response: "报销制度咨询"}

	title, err := generateSessionTitle(context.Background(), provider, "报销发票怎么提交？", "需要在系统中上传发票影像。")
	if err != nil {
		t.Fatalf("generate session title returned error: %v", err)
	}

	if title != "报销制度咨询" {
		t.Fatalf("expected summarized title, got %q", title)
	}
	if len(provider.messages) != 2 {
		t.Fatalf("expected title provider messages, got %#v", provider.messages)
	}
	if provider.messages[0].Role != "system" || !strings.Contains(provider.messages[0].Content, "会话标题") {
		t.Fatalf("expected system title prompt, got %#v", provider.messages[0])
	}
	if !strings.Contains(provider.messages[1].Content, "报销发票怎么提交？") {
		t.Fatalf("expected user question in title prompt, got %#v", provider.messages[1])
	}
}

func TestCleanSessionTitleRemovesQuotesAndFallsBack(t *testing.T) {
	if got := cleanSessionTitle("《报销制度咨询》"); got != "报销制度咨询" {
		t.Fatalf("expected cleaned title, got %q", got)
	}
	if got := cleanSessionTitle("   "); got != defaultChatSessionTitle {
		t.Fatalf("expected default title fallback, got %q", got)
	}
}

func TestSendMessageReturnsRerankFallbackMetadata(t *testing.T) {
	ctx := context.Background()
	db := newChatServiceTestDB(t)
	user := createChatServiceUser(t, db)
	kb := createChatServiceKnowledgeBase(t, db, user.ID)
	session := createChatServiceSession(t, db, user.ID, kb.ID)
	chunkID := uuid.New()
	retrieval := &fakeChatRetrieval{
		response: &dto.SearchResponse{
			Items: []dto.SearchResultResponse{
				{
					ChunkID:     chunkID.String(),
					DocumentID:  uuid.New().String(),
					Filename:    "manual.md",
					Content:     "fallback citation",
					VectorScore: 0.8,
					RerankScore: nil,
				},
			},
			RerankFallback: &dto.RerankFallbackResponse{Used: true, Reason: "rerank failed: provider unavailable"},
		},
	}
	chatProvider := &fakeChatProvider{responses: []string{
		`{"intent":"knowledge_base","standaloneQuery":"policy","reason":"needs docs"}`,
		"answer from fallback chunks",
	}}
	service := NewChatService(
		config.Config{VectorTopN: 30, RerankTopK: 5, RerankEnabled: true, ChatHistoryLimit: 10},
		repository.NewChatRepository(db),
		repository.NewKnowledgeBaseRepository(db),
		retrieval,
		chatProvider,
		nil,
	)

	clientRequestID := uuid.New().String()
	res, err := service.SendMessage(ctx, user.ID, session.ID, dto.SendChatMessageRequest{
		Content:         "question",
		ClientRequestID: clientRequestID,
	})
	if err != nil {
		t.Fatalf("send message: %v", err)
	}

	if res.RerankFallback == nil || !res.RerankFallback.Used {
		t.Fatalf("expected rerank fallback in chat response, got %#v", res.RerankFallback)
	}
	if len(res.Citations) != 1 || res.Citations[0].ChunkID != chunkID.String() {
		t.Fatalf("expected citations from final fallback chunks, got %#v", res.Citations)
	}
	if res.Citations[0].RerankScore != nil {
		t.Fatalf("expected fallback citation rerankScore to stay nil, got %#v", res.Citations[0].RerankScore)
	}
	if res.ClientRequestID != clientRequestID {
		t.Fatalf("expected client request id %q, got %q", clientRequestID, res.ClientRequestID)
	}
	if res.UserMessage.ClientRequestID == nil || *res.UserMessage.ClientRequestID != clientRequestID {
		t.Fatalf("expected user message to expose client request id, got %#v", res.UserMessage)
	}
	if res.AssistantMessage.ClientRequestID == nil || *res.AssistantMessage.ClientRequestID != clientRequestID {
		t.Fatalf("expected assistant message to expose client request id, got %#v", res.AssistantMessage)
	}

	repeated, err := service.SendMessage(ctx, user.ID, session.ID, dto.SendChatMessageRequest{
		Content:         "question",
		ClientRequestID: clientRequestID,
	})
	if err != nil {
		t.Fatalf("repeat send message: %v", err)
	}
	if len(chatProvider.calls) != 2 {
		t.Fatalf("expected duplicate request not to call chat provider again, got %d calls", len(chatProvider.calls))
	}
	if repeated.UserMessage.ID != res.UserMessage.ID || repeated.AssistantMessage.ID != res.AssistantMessage.ID {
		t.Fatalf("expected duplicate request to return persisted message pair, got %#v", repeated)
	}
	if repeated.RerankFallback == nil || !repeated.RerankFallback.Used {
		t.Fatalf("expected duplicate response to rebuild rerank fallback, got %#v", repeated.RerankFallback)
	}
}

func TestSendMessageRejectsClientRequestIDReuseWithDifferentContent(t *testing.T) {
	ctx := context.Background()
	db := newChatServiceTestDB(t)
	user := createChatServiceUser(t, db)
	kb := createChatServiceKnowledgeBase(t, db, user.ID)
	session := createChatServiceSession(t, db, user.ID, kb.ID)
	clientRequestID := uuid.New().String()
	requestID, _ := uuid.Parse(clientRequestID)
	if err := repository.NewChatRepository(db).CreateMessages(ctx,
		&model.ChatMessage{SessionID: session.ID, Role: "user", Content: "original", ClientRequestID: &requestID},
		&model.ChatMessage{SessionID: session.ID, Role: "assistant", Content: "answer", ClientRequestID: &requestID},
	); err != nil {
		t.Fatalf("seed message pair: %v", err)
	}

	chatProvider := &fakeChatProvider{err: errors.New("provider should not be called")}
	service := NewChatService(
		config.Config{ChatHistoryLimit: 10},
		repository.NewChatRepository(db),
		repository.NewKnowledgeBaseRepository(db),
		&fakeChatRetrieval{},
		chatProvider,
		nil,
	)

	_, err := service.SendMessage(ctx, user.ID, session.ID, dto.SendChatMessageRequest{
		Content:         "different",
		ClientRequestID: clientRequestID,
	})
	if err == nil {
		t.Fatal("expected idempotency key reuse to fail")
	}
	var appErr *apperror.Error
	if !errors.As(err, &appErr) || appErr.Status != 409 || appErr.Code != "IDEMPOTENCY_KEY_REUSED" {
		t.Fatalf("expected IDEMPOTENCY_KEY_REUSED conflict, got %#v", err)
	}
	if len(chatProvider.calls) != 0 {
		t.Fatalf("expected conflict to be detected before provider call, got %d calls", len(chatProvider.calls))
	}
}

func TestSendMessageLetsRetrievalUseKnowledgeBaseConfiguration(t *testing.T) {
	ctx := context.Background()
	db := newChatServiceTestDB(t)
	user := createChatServiceUser(t, db)
	kb := createChatServiceKnowledgeBase(t, db, user.ID)
	session := createChatServiceSession(t, db, user.ID, kb.ID)
	retrieval := &fakeChatRetrieval{response: &dto.SearchResponse{Items: []dto.SearchResultResponse{}}}
	chatProvider := &fakeChatProvider{responses: []string{
		`{"intent":"knowledge_base","standaloneQuery":"policy","reason":"needs docs"}`,
	}}
	service := NewChatService(
		config.Config{VectorTopN: 30, RerankTopK: 5, RerankEnabled: true, ChatHistoryLimit: 10},
		repository.NewChatRepository(db),
		repository.NewKnowledgeBaseRepository(db),
		retrieval,
		chatProvider,
		nil,
	)

	if _, err := service.SendMessage(ctx, user.ID, session.ID, dto.SendChatMessageRequest{
		Content:         "question",
		ClientRequestID: uuid.NewString(),
	}); err != nil {
		t.Fatalf("send message: %v", err)
	}
	if len(retrieval.calls) != 1 {
		t.Fatalf("expected one retrieval call, got %#v", retrieval.calls)
	}
	call := retrieval.calls[0]
	if call.VectorTopN != 0 || call.RerankTopK != 0 || call.EnableRerank != nil {
		t.Fatalf("expected chat to leave retrieval overrides empty, got %#v", call)
	}
}

func TestRegenerateMessageRerunsRetrievalAndCreatesNewAssistantMessage(t *testing.T) {
	ctx := context.Background()
	db := newChatServiceTestDB(t)
	user := createChatServiceUser(t, db)
	kb := createChatServiceKnowledgeBase(t, db, user.ID)
	session := createChatServiceSession(t, db, user.ID, kb.ID)
	userMessage := model.ChatMessage{SessionID: session.ID, Role: "user", Content: "original question", CreatedAt: time.Now().Add(-time.Second)}
	oldAssistant := model.ChatMessage{SessionID: session.ID, Role: "assistant", Content: "old answer", CreatedAt: time.Now()}
	if err := db.Create(&userMessage).Error; err != nil {
		t.Fatalf("create user message: %v", err)
	}
	if err := db.Create(&oldAssistant).Error; err != nil {
		t.Fatalf("create assistant message: %v", err)
	}

	chunkID := uuid.New()
	retrieval := &fakeChatRetrieval{
		response: &dto.SearchResponse{
			Items: []dto.SearchResultResponse{
				{
					ChunkID:     chunkID.String(),
					DocumentID:  uuid.New().String(),
					Filename:    "manual.md",
					Content:     "fresh citation",
					VectorScore: 0.9,
				},
			},
		},
	}
	chatProvider := &fakeChatProvider{responses: []string{
		`{"intent":"knowledge_base","standaloneQuery":"rewritten original question","reason":"needs docs"}`,
		"new answer",
	}}
	service := NewChatService(
		config.Config{VectorTopN: 30, RerankTopK: 5, RerankEnabled: true, ChatHistoryLimit: 10},
		repository.NewChatRepository(db),
		repository.NewKnowledgeBaseRepository(db),
		retrieval,
		chatProvider,
		nil,
	)

	res, err := service.RegenerateMessage(ctx, user.ID, session.ID, oldAssistant.ID)
	if err != nil {
		t.Fatalf("regenerate message: %v", err)
	}

	if res.Message.ID == oldAssistant.ID.String() || res.Message.Role != "assistant" || res.Message.Content != "new answer" {
		t.Fatalf("expected a new assistant message response, got %#v", res.Message)
	}
	if len(res.Message.Citations) != 1 || res.Message.Citations[0].ChunkID != chunkID.String() {
		t.Fatalf("expected regenerated citations from fresh retrieval, got %#v", res.Message.Citations)
	}
	if len(retrieval.calls) != 1 || retrieval.calls[0].Query != "rewritten original question" {
		t.Fatalf("expected regenerate to rerun retrieval with standalone query, got %#v", retrieval.calls)
	}
	var count int64
	if err := db.Model(&model.ChatMessage{}).Where("session_id = ?", session.ID).Count(&count).Error; err != nil {
		t.Fatalf("count chat messages: %v", err)
	}
	if count != 3 {
		t.Fatalf("expected regenerate to append one assistant message, got %d messages", count)
	}
}

func TestRegenerateMessageRejectsNonAssistantMessage(t *testing.T) {
	ctx := context.Background()
	db := newChatServiceTestDB(t)
	user := createChatServiceUser(t, db)
	kb := createChatServiceKnowledgeBase(t, db, user.ID)
	session := createChatServiceSession(t, db, user.ID, kb.ID)
	userMessage := model.ChatMessage{SessionID: session.ID, Role: "user", Content: "original question"}
	if err := db.Create(&userMessage).Error; err != nil {
		t.Fatalf("create user message: %v", err)
	}
	service := NewChatService(
		config.Config{VectorTopN: 30, RerankTopK: 5, RerankEnabled: true, ChatHistoryLimit: 10},
		repository.NewChatRepository(db),
		repository.NewKnowledgeBaseRepository(db),
		&fakeChatRetrieval{},
		&fakeChatProvider{},
		nil,
	)

	if _, err := service.RegenerateMessage(ctx, user.ID, session.ID, userMessage.ID); err == nil {
		t.Fatal("expected regenerate to reject user messages")
	}
}

func TestEditMessageAndRegenerateReplacesTail(t *testing.T) {
	ctx := context.Background()
	db := newChatServiceTestDB(t)
	user := createChatServiceUser(t, db)
	kb := createChatServiceKnowledgeBase(t, db, user.ID)
	session := createChatServiceSession(t, db, user.ID, kb.ID)
	baseTime := time.Now().UTC().Add(-time.Minute)
	firstUser := model.ChatMessage{SessionID: session.ID, Role: "user", Content: "old question", CreatedAt: baseTime}
	oldAssistant := model.ChatMessage{SessionID: session.ID, Role: "assistant", Content: "old answer", CreatedAt: baseTime.Add(time.Second)}
	laterUser := model.ChatMessage{SessionID: session.ID, Role: "user", Content: "later question", CreatedAt: baseTime.Add(2 * time.Second)}
	laterAssistant := model.ChatMessage{SessionID: session.ID, Role: "assistant", Content: "later answer", CreatedAt: baseTime.Add(3 * time.Second)}
	for _, message := range []*model.ChatMessage{&firstUser, &oldAssistant, &laterUser, &laterAssistant} {
		if err := db.Create(message).Error; err != nil {
			t.Fatalf("create message: %v", err)
		}
	}
	chunkID := uuid.New()
	retrieval := &fakeChatRetrieval{response: &dto.SearchResponse{Items: []dto.SearchResultResponse{{
		ChunkID: chunkID.String(), DocumentID: uuid.New().String(), Filename: "manual.md", Content: "fresh citation", VectorScore: 0.9,
	}}}}
	provider := &fakeChatProvider{responses: []string{
		`{"intent":"knowledge_base","standaloneQuery":"rewritten edited question","reason":"needs docs"}`,
		"new answer",
	}}
	service := NewChatService(config.Config{VectorTopN: 30, RerankTopK: 5, RerankEnabled: true, ChatHistoryLimit: 10}, repository.NewChatRepository(db), repository.NewKnowledgeBaseRepository(db), retrieval, provider, nil)
	requestID := uuid.NewString()
	res, err := service.EditMessageAndRegenerate(ctx, user.ID, session.ID, firstUser.ID, dto.EditChatMessageRequest{Content: " edited question ", ClientRequestID: requestID})
	if err != nil {
		t.Fatalf("edit message: %v", err)
	}
	if res.UserMessage.ID != firstUser.ID.String() || res.UserMessage.Content != "edited question" || res.AssistantMessage.Content != "new answer" {
		t.Fatalf("unexpected edit response: %#v", res)
	}
	if len(retrieval.calls) != 1 || retrieval.calls[0].Query != "rewritten edited question" {
		t.Fatalf("expected retrieval for edited content, got %#v", retrieval.calls)
	}
	var messages []model.ChatMessage
	if err := db.Where("session_id = ?", session.ID).Order("created_at asc").Find(&messages).Error; err != nil {
		t.Fatalf("list edited messages: %v", err)
	}
	if len(messages) != 2 || messages[0].ID != firstUser.ID || messages[0].Content != "edited question" || messages[1].Role != "assistant" {
		t.Fatalf("expected target and one fresh assistant after tail replacement, got %#v", messages)
	}
}

func TestEditMessageAndRegenerateKeepsOldMessagesWhenGenerationFails(t *testing.T) {
	ctx := context.Background()
	db := newChatServiceTestDB(t)
	user := createChatServiceUser(t, db)
	kb := createChatServiceKnowledgeBase(t, db, user.ID)
	session := createChatServiceSession(t, db, user.ID, kb.ID)
	userMessage := model.ChatMessage{SessionID: session.ID, Role: "user", Content: "old question"}
	assistantMessage := model.ChatMessage{SessionID: session.ID, Role: "assistant", Content: "old answer"}
	if err := db.Create(&userMessage).Error; err != nil {
		t.Fatalf("create user message: %v", err)
	}
	if err := db.Create(&assistantMessage).Error; err != nil {
		t.Fatalf("create assistant message: %v", err)
	}
	service := NewChatService(config.Config{VectorTopN: 30, RerankTopK: 5, RerankEnabled: true, ChatHistoryLimit: 10}, repository.NewChatRepository(db), repository.NewKnowledgeBaseRepository(db), &fakeChatRetrieval{}, &fakeChatProvider{err: errors.New("provider unavailable")}, nil)
	if _, err := service.EditMessageAndRegenerate(ctx, user.ID, session.ID, userMessage.ID, dto.EditChatMessageRequest{Content: "new question", ClientRequestID: uuid.NewString()}); err == nil {
		t.Fatal("expected generation failure")
	}
	var messages []model.ChatMessage
	if err := db.Where("session_id = ?", session.ID).Order("created_at asc").Find(&messages).Error; err != nil {
		t.Fatalf("list messages: %v", err)
	}
	if len(messages) != 2 || messages[0].Content != "old question" || messages[1].Content != "old answer" {
		t.Fatalf("generation failure must preserve old conversation, got %#v", messages)
	}
}

func TestEditMessageAndRegenerateIsIdempotent(t *testing.T) {
	ctx := context.Background()
	db := newChatServiceTestDB(t)
	user := createChatServiceUser(t, db)
	kb := createChatServiceKnowledgeBase(t, db, user.ID)
	session := createChatServiceSession(t, db, user.ID, kb.ID)
	userMessage := model.ChatMessage{SessionID: session.ID, Role: "user", Content: "old question"}
	assistantMessage := model.ChatMessage{SessionID: session.ID, Role: "assistant", Content: "old answer"}
	if err := db.Create(&userMessage).Error; err != nil {
		t.Fatalf("create user message: %v", err)
	}
	if err := db.Create(&assistantMessage).Error; err != nil {
		t.Fatalf("create assistant message: %v", err)
	}
	provider := &fakeChatProvider{responses: []string{
		`{"intent":"knowledge_base","standaloneQuery":"edited question","reason":"needs docs"}`,
		"new answer",
	}}
	service := NewChatService(config.Config{VectorTopN: 30, RerankTopK: 5, RerankEnabled: true, ChatHistoryLimit: 10}, repository.NewChatRepository(db), repository.NewKnowledgeBaseRepository(db), &fakeChatRetrieval{response: &dto.SearchResponse{Items: []dto.SearchResultResponse{{ChunkID: uuid.NewString(), DocumentID: uuid.NewString(), Filename: "manual.md", Content: "supporting fact", VectorScore: 0.9}}}}, provider, nil)
	request := dto.EditChatMessageRequest{Content: "edited question", ClientRequestID: uuid.NewString()}
	first, err := service.EditMessageAndRegenerate(ctx, user.ID, session.ID, userMessage.ID, request)
	if err != nil {
		t.Fatalf("first edit: %v", err)
	}
	second, err := service.EditMessageAndRegenerate(ctx, user.ID, session.ID, userMessage.ID, request)
	if err != nil {
		t.Fatalf("idempotent edit retry: %v", err)
	}
	if first.AssistantMessage.ID != second.AssistantMessage.ID || len(provider.calls) != 2 {
		t.Fatalf("retry should replay pair without regenerating, first=%#v second=%#v calls=%d", first, second, len(provider.calls))
	}
}

func TestEditMessageAndRegenerateRejectsArchivedSession(t *testing.T) {
	ctx := context.Background()
	db := newChatServiceTestDB(t)
	user := createChatServiceUser(t, db)
	kb := createChatServiceKnowledgeBase(t, db, user.ID)
	session := createChatServiceSession(t, db, user.ID, kb.ID)
	archivedAt := time.Now().UTC()
	if err := db.Model(&model.ChatSession{}).Where("id = ?", session.ID).Update("archived_at", archivedAt).Error; err != nil {
		t.Fatalf("archive session: %v", err)
	}
	message := model.ChatMessage{SessionID: session.ID, Role: "user", Content: "question"}
	if err := db.Create(&message).Error; err != nil {
		t.Fatalf("create message: %v", err)
	}
	service := NewChatService(config.Config{}, repository.NewChatRepository(db), repository.NewKnowledgeBaseRepository(db), &fakeChatRetrieval{}, &fakeChatProvider{}, nil)
	if _, err := service.EditMessageAndRegenerate(ctx, user.ID, session.ID, message.ID, dto.EditChatMessageRequest{Content: "edited", ClientRequestID: uuid.NewString()}); err == nil {
		t.Fatal("expected archived session edit to be rejected")
	}
}

func newChatServiceTestDB(t *testing.T) *gorm.DB {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatalf("open sqlite db: %v", err)
	}
	if err := db.AutoMigrate(
		&model.User{},
		&model.KnowledgeBase{},
		&model.ChatSession{},
		&model.ChatMessage{},
	); err != nil {
		t.Fatalf("auto migrate: %v", err)
	}
	// AutoMigrate does not reproduce the partial unique index from
	// migrations/010_chat_message_idempotency.sql on SQLite, so without this the
	// idempotency guarantee would be untested: the service-level lookup catches
	// a sequential retry, but only the index catches a genuine concurrent race.
	if err := db.Exec(`
		CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_messages_session_client_role
		ON chat_messages(session_id, client_request_id, role)
		WHERE client_request_id IS NOT NULL AND role IN ('user', 'assistant')
	`).Error; err != nil {
		t.Fatalf("create chat message idempotency index: %v", err)
	}
	return db
}

func createChatServiceUser(t *testing.T, db *gorm.DB) model.User {
	t.Helper()
	user := model.User{Username: "owner", PasswordHash: "hash", DisplayName: "Owner"}
	if err := db.Create(&user).Error; err != nil {
		t.Fatalf("create user: %v", err)
	}
	return user
}

func createChatServiceKnowledgeBase(t *testing.T, db *gorm.DB, ownerID uuid.UUID) model.KnowledgeBase {
	t.Helper()
	kb := model.KnowledgeBase{Name: "kb", OwnerID: ownerID, Visibility: "private"}
	if err := db.Create(&kb).Error; err != nil {
		t.Fatalf("create knowledge base: %v", err)
	}
	return kb
}

func createChatServiceSession(t *testing.T, db *gorm.DB, userID, kbID uuid.UUID) model.ChatSession {
	t.Helper()
	session := model.ChatSession{UserID: userID, KnowledgeBaseID: kbID, Title: "session"}
	if err := db.Create(&session).Error; err != nil {
		t.Fatalf("create chat session: %v", err)
	}
	return session
}
