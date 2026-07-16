package service

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"gorm.io/datatypes"

	"rag/backend/internal/apperror"
	chatcore "rag/backend/internal/chat"
	"rag/backend/internal/config"
	"rag/backend/internal/dto"
	"rag/backend/internal/model"
	"rag/backend/internal/repository"
	titlecore "rag/backend/internal/title"
)

type chatRetrievalService interface {
	Search(ctx context.Context, ownerID, kbID uuid.UUID, req dto.SearchRequest) (*dto.SearchResponse, error)
}

type ChatService struct {
	cfg            config.Config
	chats          *repository.ChatRepository
	knowledgeBases *repository.KnowledgeBaseRepository
	retrieval      chatRetrievalService
	chatProvider   chatcore.Provider
	titleProvider  titlecore.Provider
}

const (
	chatIntentConversation  = "conversation"
	chatIntentKnowledgeBase = "knowledge_base"
	defaultChatSessionTitle = "新会话"
)

type chatIntentDecision struct {
	Intent          string `json:"intent"`
	StandaloneQuery string `json:"standaloneQuery"`
	Reason          string `json:"reason"`
}

func NewChatService(
	cfg config.Config,
	chats *repository.ChatRepository,
	knowledgeBases *repository.KnowledgeBaseRepository,
	retrieval chatRetrievalService,
	chatProvider chatcore.Provider,
	titleProvider titlecore.Provider,
) *ChatService {
	return &ChatService{
		cfg:            cfg,
		chats:          chats,
		knowledgeBases: knowledgeBases,
		retrieval:      retrieval,
		chatProvider:   chatProvider,
		titleProvider:  titleProvider,
	}
}

func (s *ChatService) CreateSession(ctx context.Context, userID uuid.UUID, req dto.CreateChatSessionRequest) (*dto.ChatSessionResponse, error) {
	kbID, err := uuid.Parse(req.KnowledgeBaseID)
	if err != nil {
		return nil, apperror.Validation(map[string]any{"knowledgeBaseId": "knowledge base id is invalid"})
	}

	kb, err := s.knowledgeBases.FindByIDAndOwner(ctx, kbID, userID)
	if err != nil {
		return nil, apperror.Internal(err)
	}
	if kb == nil {
		return nil, apperror.NotFound("KNOWLEDGE_BASE_NOT_FOUND", "knowledge base not found")
	}

	title := strings.TrimSpace(req.Title)
	if title == "" {
		title = defaultChatSessionTitle
	}
	session := &model.ChatSession{
		UserID:          userID,
		KnowledgeBaseID: kbID,
		Title:           title,
	}
	if err := s.chats.CreateSession(ctx, session); err != nil {
		return nil, apperror.Internal(err)
	}

	res := toChatSessionResponse(session)
	return &res, nil
}

func (s *ChatService) ListSessions(ctx context.Context, userID uuid.UUID) (*dto.ChatSessionListResponse, error) {
	sessions, err := s.chats.ListSessions(ctx, userID)
	if err != nil {
		return nil, apperror.Internal(err)
	}

	res := dto.ChatSessionListResponse{Items: make([]dto.ChatSessionResponse, 0, len(sessions))}
	for i := range sessions {
		res.Items = append(res.Items, toChatSessionResponse(&sessions[i]))
	}
	return &res, nil
}

func (s *ChatService) GetSession(ctx context.Context, userID, sessionID uuid.UUID) (*dto.ChatSessionResponse, error) {
	session, err := s.findSession(ctx, userID, sessionID)
	if err != nil {
		return nil, err
	}
	res := toChatSessionResponse(session)
	return &res, nil
}

func (s *ChatService) UpdateSession(ctx context.Context, userID, sessionID uuid.UUID, req dto.UpdateChatSessionRequest) (*dto.ChatSessionResponse, error) {
	session, err := s.findSession(ctx, userID, sessionID)
	if err != nil {
		return nil, err
	}
	title := strings.TrimSpace(req.Title)
	if title == "" {
		return nil, apperror.Validation(map[string]any{"title": "title is required"})
	}
	if err := s.chats.UpdateSessionTitle(ctx, session.ID, title); err != nil {
		return nil, apperror.Internal(err)
	}
	session.Title = title
	updated, err := s.findSession(ctx, userID, sessionID)
	if err != nil {
		return nil, err
	}
	res := toChatSessionResponse(updated)
	return &res, nil
}

func (s *ChatService) DeleteSession(ctx context.Context, userID, sessionID uuid.UUID) error {
	session, err := s.findSession(ctx, userID, sessionID)
	if err != nil {
		return err
	}
	if err := s.chats.DeleteSession(ctx, session.ID); err != nil {
		return apperror.Internal(err)
	}
	return nil
}

func (s *ChatService) ArchiveSession(ctx context.Context, userID, sessionID uuid.UUID) (*dto.ChatSessionResponse, error) {
	session, err := s.findSession(ctx, userID, sessionID)
	if err != nil {
		return nil, err
	}
	if session.ArchivedAt != nil {
		res := toChatSessionResponse(session)
		return &res, nil
	}
	if err := s.chats.ArchiveSession(ctx, session.ID, time.Now()); err != nil {
		return nil, apperror.Internal(err)
	}
	archived, err := s.findSession(ctx, userID, sessionID)
	if err != nil {
		return nil, err
	}
	res := toChatSessionResponse(archived)
	return &res, nil
}

func (s *ChatService) ListMessages(ctx context.Context, userID, sessionID uuid.UUID) (*dto.ChatMessageListResponse, error) {
	session, err := s.findSession(ctx, userID, sessionID)
	if err != nil {
		return nil, err
	}

	messages, err := s.chats.ListMessages(ctx, session.ID)
	if err != nil {
		return nil, apperror.Internal(err)
	}

	res := dto.ChatMessageListResponse{Items: make([]dto.ChatMessageResponse, 0, len(messages))}
	for i := range messages {
		res.Items = append(res.Items, toChatMessageResponse(&messages[i]))
	}
	return &res, nil
}

func (s *ChatService) SendMessage(ctx context.Context, userID, sessionID uuid.UUID, req dto.SendChatMessageRequest) (*dto.SendChatMessageResponse, error) {
	session, err := s.findSession(ctx, userID, sessionID)
	if err != nil {
		return nil, err
	}

	history, err := s.chats.ListMessages(ctx, session.ID)
	if err != nil {
		return nil, apperror.Internal(err)
	}

	generated, err := s.generateAnswer(ctx, userID, session, req.Content, history)
	if err != nil {
		return nil, err
	}

	userMessage := &model.ChatMessage{
		SessionID: session.ID,
		Role:      "user",
		Content:   req.Content,
	}
	assistantMessage := &model.ChatMessage{
		SessionID: session.ID,
		Role:      "assistant",
		Content:   generated.answer,
		Citations: generated.citationJSON,
	}
	if err := s.chats.CreateMessages(ctx, userMessage, assistantMessage); err != nil {
		return nil, apperror.Internal(err)
	}
	s.updateSessionTitleIfNeeded(ctx, session, req.Content, generated.answer)

	return &dto.SendChatMessageResponse{
		Answer:         generated.answer,
		Citations:      generated.citations,
		RerankFallback: generated.rerankFallback,
	}, nil
}

func (s *ChatService) RegenerateMessage(ctx context.Context, userID, sessionID, messageID uuid.UUID) (*dto.RegenerateChatMessageResponse, error) {
	session, err := s.findSession(ctx, userID, sessionID)
	if err != nil {
		return nil, err
	}

	messages, err := s.chats.ListMessages(ctx, session.ID)
	if err != nil {
		return nil, apperror.Internal(err)
	}

	targetIndex := -1
	for i := range messages {
		if messages[i].ID == messageID {
			targetIndex = i
			break
		}
	}
	if targetIndex < 0 {
		return nil, apperror.NotFound("RESOURCE_NOT_FOUND", "resource not found")
	}
	if messages[targetIndex].Role != "assistant" {
		return nil, apperror.Validation(map[string]any{"messageId": "only assistant messages can be regenerated"})
	}

	userIndex := -1
	for i := targetIndex - 1; i >= 0; i-- {
		if messages[i].Role == "user" && strings.TrimSpace(messages[i].Content) != "" {
			userIndex = i
			break
		}
	}
	if userIndex < 0 {
		return nil, apperror.Validation(map[string]any{"messageId": "assistant message has no previous user message"})
	}

	question := messages[userIndex].Content
	history := append([]model.ChatMessage(nil), messages[:userIndex]...)
	generated, err := s.generateAnswer(ctx, userID, session, question, history)
	if err != nil {
		return nil, err
	}

	assistantMessage := &model.ChatMessage{
		SessionID: session.ID,
		Role:      "assistant",
		Content:   generated.answer,
		Citations: generated.citationJSON,
	}
	if err := s.chats.CreateMessages(ctx, assistantMessage); err != nil {
		return nil, apperror.Internal(err)
	}

	return &dto.RegenerateChatMessageResponse{
		Message:        toChatMessageResponse(assistantMessage),
		RerankFallback: generated.rerankFallback,
	}, nil
}

type generatedChatAnswer struct {
	answer         string
	citations      []dto.CitationResponse
	citationJSON   datatypes.JSON
	rerankFallback *dto.RerankFallbackResponse
}

func (s *ChatService) generateAnswer(ctx context.Context, userID uuid.UUID, session *model.ChatSession, question string, history []model.ChatMessage) (generatedChatAnswer, error) {
	intent, err := classifyChatIntent(ctx, s.chatProvider, question, history, s.cfg.ChatHistoryLimit)
	if err != nil {
		return generatedChatAnswer{}, apperror.Wrap(500, "CHAT_COMPLETION_FAILED", "chat completion failed", err)
	}

	if intent.Intent == chatIntentConversation {
		answer, err := s.chatProvider.Chat(ctx, buildConversationAnswerMessages(question, history, s.cfg.ChatHistoryLimit))
		if err != nil {
			return generatedChatAnswer{}, apperror.Wrap(500, "CHAT_COMPLETION_FAILED", "chat completion failed", err)
		}
		citationJSON, err := json.Marshal([]dto.CitationResponse{})
		if err != nil {
			return generatedChatAnswer{}, apperror.Internal(err)
		}
		return generatedChatAnswer{
			answer:       answer,
			citations:    []dto.CitationResponse{},
			citationJSON: datatypes.JSON(citationJSON),
		}, nil
	}

	if s.retrieval == nil {
		return generatedChatAnswer{}, apperror.New(500, "INTERNAL_ERROR", "retrieval service is not configured")
	}

	retrievalQuery := strings.TrimSpace(intent.StandaloneQuery)
	if retrievalQuery == "" {
		retrievalQuery = question
	}

	searchRes, err := s.retrieval.Search(ctx, userID, session.KnowledgeBaseID, dto.SearchRequest{
		Query: retrievalQuery,
	})
	if err != nil {
		return generatedChatAnswer{}, err
	}

	citations := citationsFromSearch(searchRes.Items)
	answer := "当前知识库中未找到足够依据回答该问题。"
	if len(searchRes.Items) > 0 {
		answer, err = s.chatProvider.Chat(ctx, buildAnswerMessages(question, searchRes.Items, history, s.cfg.ChatHistoryLimit))
		if err != nil {
			return generatedChatAnswer{}, apperror.Wrap(500, "CHAT_COMPLETION_FAILED", "chat completion failed", err)
		}
	}

	citationJSON, err := json.Marshal(citations)
	if err != nil {
		return generatedChatAnswer{}, apperror.Internal(err)
	}

	return generatedChatAnswer{
		answer:         answer,
		citations:      citations,
		citationJSON:   datatypes.JSON(citationJSON),
		rerankFallback: searchRes.RerankFallback,
	}, nil
}

func (s *ChatService) findSession(ctx context.Context, userID, sessionID uuid.UUID) (*model.ChatSession, error) {
	session, err := s.chats.FindSessionByIDAndUser(ctx, sessionID, userID)
	if err != nil {
		return nil, apperror.Internal(err)
	}
	if session == nil {
		return nil, apperror.NotFound("RESOURCE_NOT_FOUND", "resource not found")
	}

	kb, err := s.knowledgeBases.FindByIDAndOwner(ctx, session.KnowledgeBaseID, userID)
	if err != nil {
		return nil, apperror.Internal(err)
	}
	if kb == nil {
		return nil, apperror.NotFound("RESOURCE_NOT_FOUND", "resource not found")
	}
	return session, nil
}

func (s *ChatService) updateSessionTitleIfNeeded(ctx context.Context, session *model.ChatSession, question string, answer string) {
	if s.titleProvider == nil || !shouldGenerateSessionTitle(session.Title) {
		return
	}
	title, err := generateSessionTitle(ctx, s.titleProvider, question, answer)
	if err != nil || title == "" || title == defaultChatSessionTitle {
		return
	}
	if err := s.chats.UpdateSessionTitle(ctx, session.ID, title); err != nil {
		return
	}
	session.Title = title
}

func shouldGenerateSessionTitle(title string) bool {
	title = strings.TrimSpace(title)
	return title == "" || title == defaultChatSessionTitle
}

func generateSessionTitle(ctx context.Context, provider titlecore.Provider, question string, answer string) (string, error) {
	raw, err := provider.SummarizeTitle(ctx, buildSessionTitleMessages(question, answer))
	if err != nil {
		return "", err
	}
	return cleanSessionTitle(raw), nil
}

func buildSessionTitleMessages(question string, answer string) []titlecore.Message {
	return []titlecore.Message{
		{Role: "system", Content: strings.Join([]string{
			"你是企业知识库问答系统的会话标题生成器。",
			"请根据用户问题和助手回答生成一个简短的会话标题。",
			"只输出标题本身，不要输出 JSON、Markdown、引号或解释。",
			"标题使用用户提问语言，长度控制在 3 到 20 个字符。",
		}, "\n")},
		{Role: "user", Content: strings.Join([]string{
			"用户问题：",
			strings.TrimSpace(question),
			"",
			"助手回答：",
			strings.TrimSpace(answer),
		}, "\n")},
	}
}

func cleanSessionTitle(raw string) string {
	title := strings.TrimSpace(raw)
	title = strings.TrimPrefix(title, "```")
	title = strings.TrimSuffix(title, "```")
	title = strings.TrimSpace(title)
	if strings.Contains(title, "\n") {
		title = strings.TrimSpace(strings.Split(title, "\n")[0])
	}
	title = strings.TrimPrefix(title, "标题：")
	title = strings.TrimPrefix(title, "标题:")
	title = strings.TrimSpace(title)
	title = strings.Trim(title, "\"'“”‘’《》<>【】[]")
	title = strings.TrimSpace(title)
	if title == "" {
		return defaultChatSessionTitle
	}

	runes := []rune(title)
	if len(runes) > 30 {
		title = string(runes[:30])
	}
	return title
}

func toChatSessionResponse(session *model.ChatSession) dto.ChatSessionResponse {
	return dto.ChatSessionResponse{
		ID:              session.ID.String(),
		KnowledgeBaseID: session.KnowledgeBaseID.String(),
		Title:           session.Title,
		CreatedAt:       session.CreatedAt,
		UpdatedAt:       session.UpdatedAt,
		ArchivedAt:      session.ArchivedAt,
	}
}

func toChatMessageResponse(message *model.ChatMessage) dto.ChatMessageResponse {
	citations := []dto.CitationResponse{}
	if len(message.Citations) > 0 {
		_ = json.Unmarshal(message.Citations, &citations)
	}
	return dto.ChatMessageResponse{
		ID:        message.ID.String(),
		SessionID: message.SessionID.String(),
		Role:      message.Role,
		Content:   message.Content,
		Citations: citations,
		CreatedAt: message.CreatedAt,
	}
}

func citationsFromSearch(items []dto.SearchResultResponse) []dto.CitationResponse {
	citations := make([]dto.CitationResponse, 0, len(items))
	for _, item := range items {
		citations = append(citations, dto.CitationResponse{
			DocumentID:  item.DocumentID,
			ChunkID:     item.ChunkID,
			Filename:    item.Filename,
			PageNumber:  item.PageNumber,
			Content:     item.Content,
			VectorScore: item.VectorScore,
			RerankScore: item.RerankScore,
		})
	}
	return citations
}

func systemPrompt() string {
	return strings.Join([]string{
		"你是企业知识库问答助手。",
		"只能基于提供的知识片段回答问题。",
		"可以参考历史对话理解用户当前问题中的代词、省略和上下文。",
		"历史对话不能替代知识片段作为事实依据。",
		"引用来源只能来自本轮提供的知识片段。",
		"如果知识片段不足以回答，请明确说明无法从当前知识库确认。",
		"不要编造事实，不要编造引用来源。",
	}, "\n")
}

func classifyChatIntent(ctx context.Context, provider chatcore.Provider, question string, history []model.ChatMessage, historyLimit int) (chatIntentDecision, error) {
	raw, err := provider.Chat(ctx, buildIntentClassificationMessages(question, history, historyLimit))
	if err != nil {
		return chatIntentDecision{}, err
	}
	return parseChatIntentOutput(raw, question), nil
}

func buildIntentClassificationMessages(question string, history []model.ChatMessage, historyLimit int) []chatcore.Message {
	messages := []chatcore.Message{
		{Role: "system", Content: strings.Join([]string{
			"你是企业知识库问答系统的意图分类器和检索问题改写器。",
			"你必须只输出 JSON，不要输出 Markdown，不要输出解释。",
			"JSON 格式：{\"intent\":\"conversation|knowledge_base\",\"standaloneQuery\":\"...\",\"reason\":\"...\"}",
			"intent=conversation：用户只是在问候、询问对话历史、询问上一句话、要求回顾聊天进度，且不需要知识库事实依据。",
			"intent=knowledge_base：用户询问企业知识库内容、要求基于资料回答，或当前问题需要检索文档才能可靠回答。",
			"knowledge_base 时 standaloneQuery 必须是结合历史对话改写后的独立检索问题。",
			"conversation 时 standaloneQuery 必须为空字符串。",
			"不确定时选择 knowledge_base。",
		}, "\n")},
	}
	messages = append(messages, recentChatHistory(history, historyLimit)...)
	messages = append(messages, chatcore.Message{
		Role:    "user",
		Content: "当前用户问题：\n" + strings.TrimSpace(question),
	})
	return messages
}

func parseChatIntentOutput(raw string, question string) chatIntentDecision {
	decision := chatIntentDecision{}
	content := extractJSONObject(raw)
	if content != "" {
		_ = json.Unmarshal([]byte(content), &decision)
	}

	decision.Intent = strings.ToLower(strings.TrimSpace(decision.Intent))
	switch decision.Intent {
	case chatIntentConversation:
		decision.StandaloneQuery = ""
	case chatIntentKnowledgeBase:
		decision.StandaloneQuery = strings.TrimSpace(decision.StandaloneQuery)
	default:
		decision.Intent = chatIntentKnowledgeBase
		decision.StandaloneQuery = ""
	}

	if decision.Intent == chatIntentKnowledgeBase && decision.StandaloneQuery == "" {
		decision.StandaloneQuery = strings.TrimSpace(question)
	}
	decision.Reason = strings.TrimSpace(decision.Reason)
	return decision
}

func extractJSONObject(raw string) string {
	content := strings.TrimSpace(raw)
	start := strings.Index(content, "{")
	end := strings.LastIndex(content, "}")
	if start < 0 || end < start {
		return ""
	}
	return content[start : end+1]
}

func buildAnswerMessages(question string, items []dto.SearchResultResponse, history []model.ChatMessage, historyLimit int) []chatcore.Message {
	messages := []chatcore.Message{
		{Role: "system", Content: systemPrompt()},
	}
	messages = append(messages, recentChatHistory(history, historyLimit)...)
	messages = append(messages, chatcore.Message{
		Role:    "user",
		Content: buildRAGPrompt(question, items),
	})
	return messages
}

func buildConversationAnswerMessages(question string, history []model.ChatMessage, historyLimit int) []chatcore.Message {
	messages := []chatcore.Message{
		{Role: "system", Content: strings.Join([]string{
			"你是企业知识库问答系统中的聊天助手。",
			"当前问题只涉及对话本身、问候或上下文回顾时，可以直接基于历史对话回答。",
			"不要引用知识库片段，不要编造不存在的历史消息。",
			"如果历史对话不足以回答，请明确说明没有足够的对话历史。",
		}, "\n")},
	}
	messages = append(messages, recentChatHistory(history, historyLimit)...)
	messages = append(messages, chatcore.Message{
		Role:    "user",
		Content: strings.TrimSpace(question),
	})
	return messages
}

func recentChatHistory(history []model.ChatMessage, limit int) []chatcore.Message {
	if limit <= 0 {
		return nil
	}

	valid := make([]chatcore.Message, 0, len(history))
	for _, message := range history {
		role := strings.TrimSpace(message.Role)
		content := strings.TrimSpace(message.Content)
		if content == "" || (role != "user" && role != "assistant") {
			continue
		}
		valid = append(valid, chatcore.Message{
			Role:    role,
			Content: content,
		})
	}

	if len(valid) <= limit {
		return valid
	}
	return valid[len(valid)-limit:]
}

func buildRAGPrompt(question string, items []dto.SearchResultResponse) string {
	var builder strings.Builder
	builder.WriteString("用户问题：\n")
	builder.WriteString(question)
	builder.WriteString("\n\n知识片段：\n")
	for i, item := range items {
		builder.WriteString(fmt.Sprintf("[source: %d]\n", i+1))
		builder.WriteString("documentId: " + item.DocumentID + "\n")
		builder.WriteString("chunkId: " + item.ChunkID + "\n")
		builder.WriteString("filename: " + item.Filename + "\n")
		if item.PageNumber != nil {
			builder.WriteString(fmt.Sprintf("pageNumber: %d\n", *item.PageNumber))
		}
		builder.WriteString("content: " + item.Content + "\n\n")
	}
	builder.WriteString("请基于以上知识片段回答用户问题。")
	return builder.String()
}
