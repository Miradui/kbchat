package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"reflect"
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
	activities     *ActivityRecorder
}

// SetActivityRecorder wires the workspace timeline. Optional; see the
// KnowledgeBaseService counterpart.
func (s *ChatService) SetActivityRecorder(recorder *ActivityRecorder) {
	s.activities = recorder
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

// chatSessionPreviewRunes bounds the preview shipped with each list item so a
// long answer cannot dominate the rail payload.
const chatSessionPreviewRunes = 120

func (s *ChatService) ListSessions(ctx context.Context, userID uuid.UUID, query dto.ChatSessionListQuery) (*dto.ChatSessionListResponse, error) {
	page := query.Page
	if page <= 0 {
		page = 1
	}
	pageSize := query.PageSize
	if pageSize <= 0 {
		pageSize = 20
	}
	if pageSize > 100 {
		pageSize = 100
	}
	query.Q = strings.TrimSpace(query.Q)

	items, total, err := s.chats.ListSessions(ctx, userID, query, (page-1)*pageSize, pageSize)
	if err != nil {
		return nil, apperror.Internal(err)
	}

	res := dto.ChatSessionListResponse{
		Items:    make([]dto.ChatSessionResponse, 0, len(items)),
		Total:    total,
		Page:     page,
		PageSize: pageSize,
	}
	for i := range items {
		messageCount := items[i].MessageCount
		res.Items = append(res.Items, dto.ChatSessionResponse{
			ID:                 items[i].ID.String(),
			KnowledgeBaseID:    items[i].KnowledgeBaseID.String(),
			Title:              items[i].Title,
			CreatedAt:          items[i].CreatedAt,
			UpdatedAt:          items[i].UpdatedAt,
			ArchivedAt:         items[i].ArchivedAt,
			KnowledgeBaseName:  items[i].KnowledgeBaseName,
			MessageCount:       &messageCount,
			LastMessagePreview: truncateRunes(items[i].LastMessagePreview, chatSessionPreviewRunes),
		})
	}
	return &res, nil
}

func truncateRunes(value string, limit int) string {
	value = strings.TrimSpace(value)
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return string(runes[:limit]) + "…"
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

// DeleteSession soft deletes and keeps the messages, matching the knowledge base
// and document recycle bins. See docs/14-frontend-api-gaps.md G15.
func (s *ChatService) DeleteSession(ctx context.Context, userID, sessionID uuid.UUID) error {
	session, err := s.findSession(ctx, userID, sessionID)
	if err != nil {
		return err
	}
	if err := s.chats.DeleteSession(ctx, session.ID); err != nil {
		return apperror.Internal(err)
	}
	s.recordSessionActivity(ctx, userID, ActivityChatSessionDeleted, session)
	return nil
}

func (s *ChatService) ListRecycleBin(ctx context.Context, userID uuid.UUID, page, pageSize int) (*dto.RecycleBinListResponse, error) {
	page, pageSize = normalizedRecyclePage(page, pageSize)
	items, total, err := s.chats.ListDeletedSessions(ctx, userID, (page-1)*pageSize, pageSize)
	if err != nil {
		return nil, apperror.Internal(err)
	}
	res := &dto.RecycleBinListResponse{
		Items:    make([]dto.RecycleBinItemResponse, 0, len(items)),
		Total:    total,
		Page:     page,
		PageSize: pageSize,
	}
	for i := range items {
		res.Items = append(res.Items, dto.RecycleBinItemResponse{
			ResourceType:      "chatSession",
			ID:                items[i].ID.String(),
			Name:              items[i].Title,
			KnowledgeBaseID:   items[i].KnowledgeBaseID.String(),
			KnowledgeBaseName: items[i].KnowledgeBaseName,
			DeletedAt:         items[i].DeletedAt,
		})
	}
	return res, nil
}

func (s *ChatService) RestoreSession(ctx context.Context, userID, sessionID uuid.UUID) (*dto.ChatSessionResponse, error) {
	if _, err := s.findDeletedSession(ctx, userID, sessionID); err != nil {
		return nil, err
	}
	if err := s.chats.RestoreSession(ctx, sessionID); err != nil {
		if errors.Is(err, repository.ErrChatSessionNotDeleted) {
			return nil, apperror.NotFound("RESOURCE_NOT_FOUND", "resource not found")
		}
		return nil, apperror.Internal(err)
	}
	restored, err := s.findSession(ctx, userID, sessionID)
	if err != nil {
		return nil, err
	}
	s.recordSessionActivity(ctx, userID, ActivityChatSessionRestored, restored)
	res := toChatSessionResponse(restored)
	return &res, nil
}

func (s *ChatService) recordSessionActivity(ctx context.Context, userID uuid.UUID, action string, session *model.ChatSession) {
	if s.activities == nil {
		return
	}
	knowledgeBaseName := ""
	if kb, err := s.knowledgeBases.FindByIDAndOwner(ctx, session.KnowledgeBaseID, userID); err == nil && kb != nil {
		knowledgeBaseName = kb.Name
	}
	knowledgeBaseID := session.KnowledgeBaseID
	s.activities.Record(ctx, userID, ActivityEntry{
		Action:            action,
		ResourceType:      "chatSession",
		ResourceID:        session.ID,
		ResourceName:      session.Title,
		KnowledgeBaseID:   &knowledgeBaseID,
		KnowledgeBaseName: knowledgeBaseName,
	})
}

func (s *ChatService) PermanentDeleteSession(ctx context.Context, userID, sessionID uuid.UUID) error {
	if _, err := s.findDeletedSession(ctx, userID, sessionID); err != nil {
		return err
	}
	if err := s.chats.PermanentDeleteSession(ctx, sessionID); err != nil {
		if errors.Is(err, repository.ErrChatSessionNotDeleted) {
			return apperror.NotFound("RESOURCE_NOT_FOUND", "resource not found")
		}
		return apperror.Internal(err)
	}
	return nil
}

func (s *ChatService) EmptyRecycleBin(ctx context.Context, userID uuid.UUID) error {
	if err := s.chats.EmptyDeletedSessions(ctx, userID); err != nil {
		return apperror.Internal(err)
	}
	return nil
}

// findDeletedSession applies the same double ownership check as findSession: the
// session must be the caller's and its knowledge base must still be theirs.
func (s *ChatService) findDeletedSession(ctx context.Context, userID, sessionID uuid.UUID) (*model.ChatSession, error) {
	session, err := s.chats.FindDeletedSessionByIDAndUser(ctx, sessionID, userID)
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

func (s *ChatService) UnarchiveSession(ctx context.Context, userID, sessionID uuid.UUID) (*dto.ChatSessionResponse, error) {
	session, err := s.findSession(ctx, userID, sessionID)
	if err != nil {
		return nil, err
	}
	if session.ArchivedAt == nil {
		res := toChatSessionResponse(session)
		return &res, nil
	}
	if err := s.chats.UnarchiveSession(ctx, session.ID, time.Now()); err != nil {
		return nil, apperror.Internal(err)
	}
	restored, err := s.findSession(ctx, userID, sessionID)
	if err != nil {
		return nil, err
	}
	res := toChatSessionResponse(restored)
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

func (s *ChatService) SetMessageFeedback(
	ctx context.Context,
	userID, messageID uuid.UUID,
	rating string,
) (*dto.ChatMessageFeedbackResponse, error) {
	rating = strings.TrimSpace(rating)
	if rating != "positive" && rating != "negative" {
		return nil, apperror.Validation(map[string]any{"rating": "rating must be positive or negative"})
	}
	message, err := s.chats.FindMessageByIDAndOwner(ctx, messageID, userID)
	if err != nil {
		return nil, apperror.Internal(err)
	}
	if message == nil {
		return nil, apperror.NotFound("RESOURCE_NOT_FOUND", "resource not found")
	}
	if message.Role != "assistant" {
		return nil, apperror.Validation(map[string]any{"messageId": "only assistant messages accept feedback"})
	}
	updatedAt := time.Now().UTC()
	if err := s.chats.UpdateMessageFeedback(ctx, message.ID, rating, updatedAt); err != nil {
		if errors.Is(err, repository.ErrChatMessageNotFound) {
			return nil, apperror.NotFound("RESOURCE_NOT_FOUND", "resource not found")
		}
		return nil, apperror.Internal(err)
	}
	return &dto.ChatMessageFeedbackResponse{
		MessageID: message.ID.String(),
		Rating:    rating,
		UpdatedAt: updatedAt,
	}, nil
}

func (s *ChatService) ExportSession(ctx context.Context, userID, sessionID uuid.UUID) (*ExportFile, error) {
	session, err := s.findSession(ctx, userID, sessionID)
	if err != nil {
		return nil, err
	}
	messages, err := s.chats.ListMessages(ctx, session.ID)
	if err != nil {
		return nil, apperror.Internal(err)
	}
	kb, err := s.knowledgeBases.FindByIDAndOwner(ctx, session.KnowledgeBaseID, userID)
	if err != nil {
		return nil, apperror.Internal(err)
	}
	if kb == nil {
		return nil, apperror.NotFound("RESOURCE_NOT_FOUND", "resource not found")
	}

	var builder strings.Builder
	title := strings.TrimSpace(session.Title)
	if title == "" {
		title = "未命名会话"
	}
	builder.WriteString("# " + title + "\n\n")
	builder.WriteString("知识库：" + kb.Name + "\n\n")
	for i := range messages {
		label := "用户"
		if messages[i].Role == "assistant" {
			label = "助手"
		}
		builder.WriteString("## " + label + "\n\n")
		builder.WriteString(messages[i].Content)
		builder.WriteString("\n\n")
		if messages[i].Role == "assistant" {
			writeExportCitations(&builder, messages[i].Citations)
		}
	}
	return &ExportFile{
		Filename:    "chat-" + session.ID.String() + ".md",
		ContentType: "text/markdown; charset=utf-8",
		Content:     []byte(builder.String()),
	}, nil
}

func writeExportCitations(builder *strings.Builder, raw datatypes.JSON) {
	if len(raw) == 0 {
		return
	}
	var citations []dto.CitationResponse
	if err := json.Unmarshal(raw, &citations); err != nil || len(citations) == 0 {
		return
	}
	builder.WriteString("### 来源\n\n")
	for i := range citations {
		builder.WriteString(fmt.Sprintf("%d. %s", i+1, citations[i].Filename))
		if citations[i].PageNumber != nil {
			builder.WriteString(fmt.Sprintf("（第 %d 页）", *citations[i].PageNumber))
		}
		builder.WriteString("\n")
		if strings.TrimSpace(citations[i].Content) != "" {
			for _, line := range strings.Split(citations[i].Content, "\n") {
				builder.WriteString("   " + line + "\n")
			}
		}
	}
	builder.WriteString("\n")
}

func (s *ChatService) SendMessage(ctx context.Context, userID, sessionID uuid.UUID, req dto.SendChatMessageRequest) (*dto.SendChatMessageResponse, error) {
	session, err := s.findSession(ctx, userID, sessionID)
	if err != nil {
		return nil, err
	}
	content := strings.TrimSpace(req.Content)
	if content == "" {
		return nil, apperror.Validation(map[string]any{"content": "content is required"})
	}
	clientRequestID, err := uuid.Parse(req.ClientRequestID)
	if err != nil {
		return nil, apperror.Validation(map[string]any{"clientRequestId": "client request id is invalid"})
	}

	existing, err := s.chats.FindMessagesByClientRequestID(ctx, session.ID, clientRequestID)
	if err != nil {
		return nil, apperror.Internal(err)
	}
	if len(existing) > 0 {
		return sendMessageResponseFromPair(clientRequestID, content, existing)
	}

	history, err := s.chats.ListMessages(ctx, session.ID)
	if err != nil {
		return nil, apperror.Internal(err)
	}

	generated, err := s.generateAnswer(ctx, userID, session, content, history)
	if err != nil {
		return nil, err
	}

	userMessage, assistantMessage, err := buildChatMessagePair(session.ID, clientRequestID, content, generated)
	if err != nil {
		return nil, err
	}
	if err := s.chats.CreateMessagesIfUnchanged(ctx, chatMessageIDs(history), userMessage, assistantMessage); err != nil {
		existing, lookupErr := s.chats.FindMessagesByClientRequestID(ctx, session.ID, clientRequestID)
		if lookupErr == nil && len(existing) > 0 {
			return sendMessageResponseFromPair(clientRequestID, content, existing)
		}
		if errors.Is(err, repository.ErrChatMessageChanged) {
			return nil, apperror.New(http.StatusConflict, "CHAT_MESSAGE_CHANGED", "conversation changed while the answer was being generated")
		}
		return nil, apperror.Internal(err)
	}
	s.updateSessionTitleIfNeeded(ctx, session, content, generated.answer)

	return &dto.SendChatMessageResponse{
		ClientRequestID:  clientRequestID.String(),
		UserMessage:      toChatMessageResponse(userMessage),
		AssistantMessage: toChatMessageResponse(assistantMessage),
		Answer:           generated.answer,
		Citations:        generated.citations,
		RerankFallback:   generated.rerankFallback,
	}, nil
}

// ChatStreamSink receives the events of a streaming send, in order.
//
// Any method returning an error aborts generation. That is the disconnect path:
// the handler's writes fail once the client is gone, so generation stops instead
// of running to completion for nobody.
type ChatStreamSink interface {
	// Citations fires once, after retrieval and before any delta.
	Citations(citations []dto.CitationResponse) error
	Delta(text string) error
	// Done carries exactly the blocking endpoint's response body.
	Done(res *dto.SendChatMessageResponse) error
}

// SendMessageStream is the streaming twin of SendMessage. It reuses the same
// idempotency contract rather than paralleling it:
//
//   - the `(session_id, client_request_id, role)` partial unique index is still
//     the only thing enforcing "one assistant message per key";
//   - a replayed key with identical content replays the stored pair and calls no
//     provider at all;
//   - a replayed key with different content fails with IDEMPOTENCY_KEY_REUSED
//     before anything is emitted, so the handler can still answer 409.
//
// **Nothing is persisted until generation finishes.** An interrupted stream
// therefore leaves no trace, and the client reconciles by looking the
// clientRequestId up in the message list: absent means it is safe to resend with
// the same id. The alternative — storing the partial text — would put a
// truncated answer into the history that every later turn would then read as
// context. See docs/14-frontend-api-gaps.md G2.
func (s *ChatService) SendMessageStream(
	ctx context.Context,
	userID, sessionID uuid.UUID,
	req dto.SendChatMessageRequest,
	sink ChatStreamSink,
) error {
	session, err := s.findSession(ctx, userID, sessionID)
	if err != nil {
		return err
	}
	content := strings.TrimSpace(req.Content)
	if content == "" {
		return apperror.Validation(map[string]any{"content": "content is required"})
	}
	clientRequestID, err := uuid.Parse(req.ClientRequestID)
	if err != nil {
		return apperror.Validation(map[string]any{"clientRequestId": "client request id is invalid"})
	}

	// Checked before a single byte is emitted, so a conflict is still an HTTP
	// status rather than an event on an already-committed 200 stream.
	existing, err := s.chats.FindMessagesByClientRequestID(ctx, session.ID, clientRequestID)
	if err != nil {
		return apperror.Internal(err)
	}
	if len(existing) > 0 {
		res, err := sendMessageResponseFromPair(clientRequestID, content, existing)
		if err != nil {
			return err
		}
		if err := sink.Citations(res.Citations); err != nil {
			return err
		}
		return sink.Done(res)
	}

	history, err := s.chats.ListMessages(ctx, session.ID)
	if err != nil {
		return apperror.Internal(err)
	}

	generated, err := s.generateAnswerWithHooks(ctx, userID, session, content, history, answerHooks{
		onCitations: sink.Citations,
		onDelta:     sink.Delta,
	})
	if err != nil {
		return err
	}
	// The provider may finish at the same moment the client disconnects. Check
	// cancellation once more before entering the persistence transaction so a
	// user-requested stop cannot commit a response that no longer has a reader.
	if err := ctx.Err(); err != nil {
		return err
	}

	userMessage, assistantMessage, err := buildChatMessagePair(session.ID, clientRequestID, content, generated)
	if err != nil {
		return err
	}
	if err := s.chats.CreateMessagesIfUnchanged(ctx, chatMessageIDs(history), userMessage, assistantMessage); err != nil {
		// A concurrent stream with the same key may have won the unique index.
		// Adopting its pair is what keeps "no second assistant message" true
		// under concurrency, not just under retry.
		stored, lookupErr := s.chats.FindMessagesByClientRequestID(ctx, session.ID, clientRequestID)
		if lookupErr == nil && len(stored) > 0 {
			res, pairErr := sendMessageResponseFromPair(clientRequestID, content, stored)
			if pairErr != nil {
				return pairErr
			}
			if generated.answer != res.Answer ||
				!reflect.DeepEqual(generated.citations, res.Citations) ||
				!reflect.DeepEqual(generated.rerankFallback, res.RerankFallback) {
				// Deltas are already visible, so finishing with another request's
				// stored answer would make one successful stream contradict itself.
				// Keep the outcome unknown; the client will adopt the stored pair
				// during clientRequestId reconciliation.
				return apperror.New(
					http.StatusInternalServerError,
					"CHAT_RESULT_UNCONFIRMED",
					"回答结果需要重新确认",
				)
			}
			return sink.Done(res)
		}
		if errors.Is(err, repository.ErrChatMessageChanged) {
			return apperror.New(http.StatusConflict, "CHAT_MESSAGE_CHANGED", "conversation changed while the answer was being generated")
		}
		return apperror.Internal(err)
	}
	s.updateSessionTitleIfNeeded(ctx, session, content, generated.answer)

	return sink.Done(&dto.SendChatMessageResponse{
		ClientRequestID:  clientRequestID.String(),
		UserMessage:      toChatMessageResponse(userMessage),
		AssistantMessage: toChatMessageResponse(assistantMessage),
		Answer:           generated.answer,
		Citations:        generated.citations,
		RerankFallback:   generated.rerankFallback,
	})
}

// buildChatMessagePair is shared by both send paths so the persisted shape — and
// with it the idempotency key — cannot drift between them.
func buildChatMessagePair(
	sessionID, clientRequestID uuid.UUID,
	content string,
	generated generatedChatAnswer,
) (*model.ChatMessage, *model.ChatMessage, error) {
	userMessage := &model.ChatMessage{
		SessionID:       sessionID,
		ClientRequestID: &clientRequestID,
		Role:            "user",
		Content:         content,
	}
	assistantMessage := &model.ChatMessage{
		SessionID:       sessionID,
		ClientRequestID: &clientRequestID,
		Role:            "assistant",
		Content:         generated.answer,
		Citations:       generated.citationJSON,
	}
	if generated.rerankFallback != nil {
		fallbackJSON, err := json.Marshal(generated.rerankFallback)
		if err != nil {
			return nil, nil, apperror.Internal(err)
		}
		assistantMessage.RerankFallback = datatypes.JSON(fallbackJSON)
	}
	return userMessage, assistantMessage, nil
}

func sendMessageResponseFromPair(clientRequestID uuid.UUID, content string, messages []model.ChatMessage) (*dto.SendChatMessageResponse, error) {
	var userMessage *model.ChatMessage
	var assistantMessage *model.ChatMessage
	for i := range messages {
		switch messages[i].Role {
		case "user":
			userMessage = &messages[i]
		case "assistant":
			assistantMessage = &messages[i]
		}
	}
	if userMessage == nil || assistantMessage == nil {
		return nil, apperror.Internal(fmt.Errorf("incomplete chat message pair for client request %s", clientRequestID))
	}
	if userMessage.Content != content {
		return nil, apperror.New(http.StatusConflict, "IDEMPOTENCY_KEY_REUSED", "clientRequestId has already been used with different content")
	}

	assistantResponse := toChatMessageResponse(assistantMessage)
	var fallback *dto.RerankFallbackResponse
	if len(assistantMessage.RerankFallback) > 0 {
		var stored dto.RerankFallbackResponse
		if err := json.Unmarshal(assistantMessage.RerankFallback, &stored); err != nil {
			return nil, apperror.Internal(err)
		}
		fallback = &stored
	}
	return &dto.SendChatMessageResponse{
		ClientRequestID:  clientRequestID.String(),
		UserMessage:      toChatMessageResponse(userMessage),
		AssistantMessage: assistantResponse,
		Answer:           assistantMessage.Content,
		Citations:        assistantResponse.Citations,
		RerankFallback:   fallback,
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
	if err := s.chats.CreateMessagesIfUnchanged(ctx, chatMessageIDs(messages), assistantMessage); err != nil {
		if errors.Is(err, repository.ErrChatMessageChanged) {
			return nil, apperror.New(http.StatusConflict, "CHAT_MESSAGE_CHANGED", "conversation changed while the answer was being regenerated")
		}
		return nil, apperror.Internal(err)
	}

	return &dto.RegenerateChatMessageResponse{
		Message:        toChatMessageResponse(assistantMessage),
		RerankFallback: generated.rerankFallback,
	}, nil
}

// EditMessageAndRegenerate replaces a user turn and its descendants in one
// repository transaction. AI generation intentionally happens first so a
// provider failure cannot destroy the existing conversation.
func (s *ChatService) EditMessageAndRegenerate(
	ctx context.Context,
	userID, sessionID, messageID uuid.UUID,
	req dto.EditChatMessageRequest,
) (*dto.SendChatMessageResponse, error) {
	session, err := s.findSession(ctx, userID, sessionID)
	if err != nil {
		return nil, err
	}
	if session.ArchivedAt != nil {
		return nil, apperror.Validation(map[string]any{"sessionId": "archived sessions are read-only"})
	}
	content := strings.TrimSpace(req.Content)
	if content == "" {
		return nil, apperror.Validation(map[string]any{"content": "content is required"})
	}
	clientRequestID, err := uuid.Parse(req.ClientRequestID)
	if err != nil {
		return nil, apperror.Validation(map[string]any{"clientRequestId": "client request id is invalid"})
	}

	// A retry after a lost response must replay the already committed pair and
	// must not run retrieval or mutate the conversation a second time.
	existing, err := s.chats.FindMessagesByClientRequestID(ctx, session.ID, clientRequestID)
	if err != nil {
		return nil, apperror.Internal(err)
	}
	if len(existing) > 0 {
		return sendMessageResponseFromPair(clientRequestID, content, existing)
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
	if messages[targetIndex].Role != "user" {
		return nil, apperror.Validation(map[string]any{"messageId": "only user messages can be edited"})
	}

	history := append([]model.ChatMessage(nil), messages[:targetIndex]...)
	generated, err := s.generateAnswer(ctx, userID, session, content, history)
	if err != nil {
		return nil, err
	}
	userMessage, assistantMessage, err := buildChatMessagePair(session.ID, clientRequestID, content, generated)
	if err != nil {
		return nil, err
	}
	userMessage.ID = messages[targetIndex].ID
	userMessage.CreatedAt = messages[targetIndex].CreatedAt
	removeIDs := make([]uuid.UUID, 0, len(messages)-targetIndex-1)
	for i := targetIndex + 1; i < len(messages); i++ {
		removeIDs = append(removeIDs, messages[i].ID)
	}
	if err := s.chats.ReplaceMessageTail(ctx, session.ID, messageID, messages[targetIndex].ClientRequestID, removeIDs, userMessage, assistantMessage); err != nil {
		stored, lookupErr := s.chats.FindMessagesByClientRequestID(ctx, session.ID, clientRequestID)
		if lookupErr == nil && len(stored) > 0 {
			return sendMessageResponseFromPair(clientRequestID, content, stored)
		}
		if errors.Is(err, repository.ErrChatMessageNotFound) {
			return nil, apperror.NotFound("RESOURCE_NOT_FOUND", "resource not found")
		}
		if errors.Is(err, repository.ErrChatMessageChanged) {
			return nil, apperror.New(http.StatusConflict, "CHAT_MESSAGE_CHANGED", "conversation changed while the message was being edited")
		}
		return nil, apperror.Internal(err)
	}
	s.updateSessionTitleIfNeeded(ctx, session, content, generated.answer)
	return &dto.SendChatMessageResponse{
		ClientRequestID:  clientRequestID.String(),
		UserMessage:      toChatMessageResponse(userMessage),
		AssistantMessage: toChatMessageResponse(assistantMessage),
		Answer:           generated.answer,
		Citations:        generated.citations,
		RerankFallback:   generated.rerankFallback,
	}, nil
}

func chatMessageIDs(messages []model.ChatMessage) []uuid.UUID {
	ids := make([]uuid.UUID, 0, len(messages))
	for i := range messages {
		ids = append(ids, messages[i].ID)
	}
	return ids
}

type generatedChatAnswer struct {
	answer         string
	citations      []dto.CitationResponse
	citationJSON   datatypes.JSON
	rerankFallback *dto.RerankFallbackResponse
}

// answerHooks lets the streaming path observe generation without forking it.
//
// Both hooks are optional; with neither set generateAnswer behaves exactly as
// the blocking path always has. Keeping one implementation matters for the
// citation rule: citations must come only from the chunks that went into this
// turn's prompt, and a second code path is the obvious way for that to drift.
type answerHooks struct {
	// onCitations fires once retrieval has settled, before any answer text
	// exists, because the citations are an input to the prompt rather than a
	// product of the completion.
	onCitations func([]dto.CitationResponse) error
	onDelta     func(string) error
}

func (s *ChatService) generateAnswer(ctx context.Context, userID uuid.UUID, session *model.ChatSession, question string, history []model.ChatMessage) (generatedChatAnswer, error) {
	return s.generateAnswerWithHooks(ctx, userID, session, question, history, answerHooks{})
}

// complete runs the chat provider, streaming when both the provider supports it
// and the caller wants deltas. The returned answer is authoritative either way.
func (s *ChatService) complete(ctx context.Context, messages []chatcore.Message, onDelta func(string) error) (string, error) {
	if onDelta != nil {
		if streamer, ok := s.chatProvider.(chatcore.StreamingProvider); ok {
			return streamer.ChatStream(ctx, messages, onDelta)
		}
	}
	answer, err := s.chatProvider.Chat(ctx, messages)
	if err != nil {
		return "", err
	}
	// A non-streaming provider still has to look like a stream to the client, so
	// the whole answer is delivered as a single delta.
	if onDelta != nil && answer != "" {
		if err := onDelta(answer); err != nil {
			return "", err
		}
	}
	return answer, nil
}

func (s *ChatService) generateAnswerWithHooks(
	ctx context.Context,
	userID uuid.UUID,
	session *model.ChatSession,
	question string,
	history []model.ChatMessage,
	hooks answerHooks,
) (generatedChatAnswer, error) {
	intent, err := classifyChatIntent(ctx, s.chatProvider, question, history, s.cfg.ChatHistoryLimit)
	if err != nil {
		return generatedChatAnswer{}, apperror.Wrap(500, "CHAT_COMPLETION_FAILED", "回答生成失败，请稍后重试", err)
	}

	if intent.Intent == chatIntentConversation {
		citations := []dto.CitationResponse{}
		if hooks.onCitations != nil {
			// Announced even when empty: "this answer has no sources" is
			// information the client can act on immediately.
			if err := hooks.onCitations(citations); err != nil {
				return generatedChatAnswer{}, err
			}
		}
		answer, err := s.complete(ctx, buildConversationAnswerMessages(question, history, s.cfg.ChatHistoryLimit), hooks.onDelta)
		if err != nil {
			return generatedChatAnswer{}, chatCompletionError(err)
		}
		citationJSON, err := json.Marshal(citations)
		if err != nil {
			return generatedChatAnswer{}, apperror.Internal(err)
		}
		return generatedChatAnswer{
			answer:       answer,
			citations:    citations,
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
	if hooks.onCitations != nil {
		if err := hooks.onCitations(citations); err != nil {
			return generatedChatAnswer{}, err
		}
	}

	answer := "当前知识库中未找到足够依据回答该问题。"
	if len(searchRes.Items) > 0 {
		answer, err = s.complete(ctx, buildAnswerMessages(question, searchRes.Items, history, s.cfg.ChatHistoryLimit), hooks.onDelta)
		if err != nil {
			return generatedChatAnswer{}, chatCompletionError(err)
		}
	} else if hooks.onDelta != nil {
		// The refusal never reaches the provider, so stream it explicitly rather
		// than letting the client sit on an empty answer until `done`.
		if err := hooks.onDelta(answer); err != nil {
			return generatedChatAnswer{}, err
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

// chatCompletionError keeps a sink or context failure distinguishable from a
// genuine provider failure: the former means the client went away, and dressing
// it up as CHAT_COMPLETION_FAILED would tell the user their question failed when
// it was their connection that did.
func chatCompletionError(err error) error {
	var appErr *apperror.Error
	if errors.As(err, &appErr) {
		return err
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return err
	}
	return apperror.Wrap(500, "CHAT_COMPLETION_FAILED", "回答生成失败，请稍后重试", err)
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
	var clientRequestID *string
	if message.ClientRequestID != nil {
		value := message.ClientRequestID.String()
		clientRequestID = &value
	}
	var feedback *dto.ChatMessageFeedbackResponse
	if message.FeedbackRating != nil && message.FeedbackUpdatedAt != nil {
		feedback = &dto.ChatMessageFeedbackResponse{
			MessageID: message.ID.String(),
			Rating:    *message.FeedbackRating,
			UpdatedAt: *message.FeedbackUpdatedAt,
		}
	}
	return dto.ChatMessageResponse{
		ID:              message.ID.String(),
		SessionID:       message.SessionID.String(),
		ClientRequestID: clientRequestID,
		Role:            message.Role,
		Content:         message.Content,
		Citations:       citations,
		Feedback:        feedback,
		CreatedAt:       message.CreatedAt,
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
