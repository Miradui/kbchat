package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"kbchat/backend/internal/apperror"
	"kbchat/backend/internal/dto"
	"kbchat/backend/internal/service"
)

type ChatHandler struct {
	chats *service.ChatService
}

func NewChatHandler(chats *service.ChatService) *ChatHandler {
	return &ChatHandler{chats: chats}
}

func (h *ChatHandler) CreateSession(c *gin.Context) {
	userID, ok := currentUserIDOrError(c)
	if !ok {
		return
	}

	var req dto.CreateChatSessionRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		RespondError(c, apperror.Validation(map[string]any{"body": "request body is invalid"}))
		return
	}

	res, err := h.chats.CreateSession(c.Request.Context(), userID, req)
	if err != nil {
		RespondError(c, err)
		return
	}

	c.JSON(http.StatusCreated, res)
}

func (h *ChatHandler) ListSessions(c *gin.Context) {
	userID, ok := currentUserIDOrError(c)
	if !ok {
		return
	}

	var knowledgeBaseID *uuid.UUID
	if value := c.Query("knowledgeBaseId"); value != "" {
		parsed, err := uuid.Parse(value)
		if err != nil {
			RespondError(c, apperror.Validation(map[string]any{"knowledgeBaseId": "知识库 ID 不合法"}))
			return
		}
		knowledgeBaseID = &parsed
	}

	archived, ok := queryBool(c, "archived", false)
	if !ok {
		RespondError(c, apperror.Validation(map[string]any{"archived": "archived 只接受 true 或 false"}))
		return
	}

	res, err := h.chats.ListSessions(c.Request.Context(), userID, dto.ChatSessionListQuery{
		KnowledgeBaseID: knowledgeBaseID,
		Archived:        archived,
		Q:               c.Query("q"),
		Page:            queryInt(c, "page", 1),
		PageSize:        queryInt(c, "pageSize", 20),
	})
	if err != nil {
		RespondError(c, err)
		return
	}

	c.JSON(http.StatusOK, res)
}

func queryBool(c *gin.Context, name string, fallback bool) (bool, bool) {
	value := c.Query(name)
	if value == "" {
		return fallback, true
	}
	parsed, err := strconv.ParseBool(value)
	if err != nil {
		return fallback, false
	}
	return parsed, true
}

func (h *ChatHandler) GetSession(c *gin.Context) {
	userID, sessionID, ok := userAndSessionID(c)
	if !ok {
		return
	}
	res, err := h.chats.GetSession(c.Request.Context(), userID, sessionID)
	if err != nil {
		RespondError(c, err)
		return
	}
	c.JSON(http.StatusOK, res)
}

func (h *ChatHandler) UpdateSession(c *gin.Context) {
	userID, sessionID, ok := userAndSessionID(c)
	if !ok {
		return
	}
	var req dto.UpdateChatSessionRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		RespondError(c, apperror.Validation(map[string]any{"body": "request body is invalid"}))
		return
	}
	res, err := h.chats.UpdateSession(c.Request.Context(), userID, sessionID, req)
	if err != nil {
		RespondError(c, err)
		return
	}
	c.JSON(http.StatusOK, res)
}

func (h *ChatHandler) DeleteSession(c *gin.Context) {
	userID, sessionID, ok := userAndSessionID(c)
	if !ok {
		return
	}
	if err := h.chats.DeleteSession(c.Request.Context(), userID, sessionID); err != nil {
		RespondError(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}

func (h *ChatHandler) ListRecycleBin(c *gin.Context) {
	userID, ok := currentUserIDOrError(c)
	if !ok {
		return
	}
	page, pageSize := queryInt(c, "page", 1), queryInt(c, "pageSize", 20)
	res, err := h.chats.ListRecycleBin(c.Request.Context(), userID, page, pageSize)
	if err != nil {
		RespondError(c, err)
		return
	}
	c.JSON(http.StatusOK, res)
}

func (h *ChatHandler) RestoreSession(c *gin.Context) {
	userID, sessionID, ok := userAndSessionID(c)
	if !ok {
		return
	}
	res, err := h.chats.RestoreSession(c.Request.Context(), userID, sessionID)
	if err != nil {
		RespondError(c, err)
		return
	}
	c.JSON(http.StatusOK, res)
}

func (h *ChatHandler) PermanentDeleteSession(c *gin.Context) {
	userID, sessionID, ok := userAndSessionID(c)
	if !ok {
		return
	}
	if err := h.chats.PermanentDeleteSession(c.Request.Context(), userID, sessionID); err != nil {
		RespondError(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}

func (h *ChatHandler) EmptyRecycleBin(c *gin.Context) {
	userID, ok := currentUserIDOrError(c)
	if !ok {
		return
	}
	if err := h.chats.EmptyRecycleBin(c.Request.Context(), userID); err != nil {
		RespondError(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}

func (h *ChatHandler) ArchiveSession(c *gin.Context) {
	userID, sessionID, ok := userAndSessionID(c)
	if !ok {
		return
	}
	res, err := h.chats.ArchiveSession(c.Request.Context(), userID, sessionID)
	if err != nil {
		RespondError(c, err)
		return
	}
	c.JSON(http.StatusOK, res)
}

func (h *ChatHandler) UnarchiveSession(c *gin.Context) {
	userID, sessionID, ok := userAndSessionID(c)
	if !ok {
		return
	}
	res, err := h.chats.UnarchiveSession(c.Request.Context(), userID, sessionID)
	if err != nil {
		RespondError(c, err)
		return
	}
	c.JSON(http.StatusOK, res)
}

func (h *ChatHandler) ListMessages(c *gin.Context) {
	userID, sessionID, ok := userAndSessionID(c)
	if !ok {
		return
	}

	res, err := h.chats.ListMessages(c.Request.Context(), userID, sessionID)
	if err != nil {
		RespondError(c, err)
		return
	}

	c.JSON(http.StatusOK, res)
}

func (h *ChatHandler) SetMessageFeedback(c *gin.Context) {
	userID, ok := currentUserIDOrError(c)
	if !ok {
		return
	}
	messageID, ok := parseUUIDParam(c, "messageId", "message id is invalid")
	if !ok {
		return
	}
	var req dto.SetChatMessageFeedbackRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		RespondError(c, apperror.Validation(map[string]any{"body": "request body is invalid"}))
		return
	}
	res, err := h.chats.SetMessageFeedback(c.Request.Context(), userID, messageID, req.Rating)
	if err != nil {
		RespondError(c, err)
		return
	}
	c.JSON(http.StatusOK, res)
}

func (h *ChatHandler) QualityOverview(c *gin.Context) {
	userID, ok := currentUserIDOrError(c)
	if !ok {
		return
	}
	period, ok := qualityPeriod(c)
	if !ok {
		return
	}
	knowledgeBaseID, ok := optionalUUIDQuery(c, "knowledgeBaseId")
	if !ok {
		return
	}
	res, err := h.chats.GetQualityOverview(c.Request.Context(), userID, dto.ChatQualityOverviewQuery{
		Period:          period,
		KnowledgeBaseID: knowledgeBaseID,
	})
	if err != nil {
		RespondError(c, err)
		return
	}
	c.JSON(http.StatusOK, res)
}

func (h *ChatHandler) ListNegativeFeedback(c *gin.Context) {
	userID, ok := currentUserIDOrError(c)
	if !ok {
		return
	}
	period, ok := qualityPeriod(c)
	if !ok {
		return
	}
	knowledgeBaseID, ok := optionalUUIDQuery(c, "knowledgeBaseId")
	if !ok {
		return
	}
	var hasCitations *bool
	if value := c.Query("hasCitations"); value != "" {
		parsed, err := strconv.ParseBool(value)
		if err != nil {
			RespondError(c, apperror.Validation(map[string]any{"hasCitations": "hasCitations 只接受 true 或 false"}))
			return
		}
		hasCitations = &parsed
	}
	res, err := h.chats.ListNegativeFeedback(c.Request.Context(), userID, dto.ChatQualityFeedbackQuery{
		Period:          period,
		KnowledgeBaseID: knowledgeBaseID,
		HasCitations:    hasCitations,
		Page:            queryInt(c, "page", 1),
		PageSize:        queryInt(c, "pageSize", 20),
	})
	if err != nil {
		RespondError(c, err)
		return
	}
	c.JSON(http.StatusOK, res)
}

func qualityPeriod(c *gin.Context) (string, bool) {
	period := c.Query("period")
	if period == "" {
		return "month", true
	}
	if period != "day" && period != "month" {
		RespondError(c, apperror.Validation(map[string]any{"period": "period 只接受 day 或 month"}))
		return "", false
	}
	return period, true
}

func optionalUUIDQuery(c *gin.Context, name string) (*uuid.UUID, bool) {
	value := c.Query(name)
	if value == "" {
		return nil, true
	}
	parsed, err := uuid.Parse(value)
	if err != nil {
		RespondError(c, apperror.Validation(map[string]any{name: name + " is invalid"}))
		return nil, false
	}
	return &parsed, true
}

func (h *ChatHandler) ExportSession(c *gin.Context) {
	userID, sessionID, ok := userAndSessionID(c)
	if !ok {
		return
	}
	exported, err := h.chats.ExportSession(c.Request.Context(), userID, sessionID)
	if err != nil {
		RespondError(c, err)
		return
	}
	c.Header("Content-Disposition", fmt.Sprintf("attachment; filename=%q", exported.Filename))
	c.Data(http.StatusOK, exported.ContentType, exported.Content)
}

func (h *ChatHandler) SendMessage(c *gin.Context) {
	userID, sessionID, ok := userAndSessionID(c)
	if !ok {
		return
	}

	var req dto.SendChatMessageRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		RespondError(c, apperror.Validation(map[string]any{"body": "request body is invalid"}))
		return
	}

	res, err := h.chats.SendMessage(c.Request.Context(), userID, sessionID, req)
	if err != nil {
		RespondError(c, err)
		return
	}

	c.JSON(http.StatusOK, res)
}

// SendMessageStream is the SSE twin of SendMessage.
//
// The whole design hinges on one boundary: everything that can legitimately fail
// with an HTTP status — auth, validation, a reused idempotency key — is settled
// by the service before it emits anything. Once the first event goes out the
// status is committed to 200, so later failures can only be reported as an
// `error` event. sseSink.wrote is what tells the two apart.
func (h *ChatHandler) SendMessageStream(c *gin.Context) {
	userID, sessionID, ok := userAndSessionID(c)
	if !ok {
		return
	}

	var req dto.SendChatMessageRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		RespondError(c, apperror.Validation(map[string]any{"body": "request body is invalid"}))
		return
	}

	sink := &sseSink{c: c}
	err := h.chats.SendMessageStream(c.Request.Context(), userID, sessionID, req, sink)
	if err == nil {
		return
	}

	if !sink.wrote {
		RespondError(c, err)
		return
	}
	// The client hanging up is not an error worth reporting to it.
	if sink.failed || errors.Is(err, context.Canceled) {
		return
	}
	sink.emitError(err)
}

// sseSink writes the event stream. Headers are deferred to the first event so a
// pre-stream failure can still choose its own status code.
type sseSink struct {
	c      *gin.Context
	wrote  bool
	failed bool
}

func (s *sseSink) Citations(citations []dto.CitationResponse) error {
	return s.emit("citations", gin.H{"citations": citations})
}

func (s *sseSink) Delta(text string) error {
	return s.emit("delta", gin.H{"text": text})
}

func (s *sseSink) Done(res *dto.SendChatMessageResponse) error {
	return s.emit("done", res)
}

func (s *sseSink) emitError(err error) {
	status, payload := errorPayload(err)
	_ = s.emit("error", gin.H{
		"status":  status,
		"code":    payload.Code,
		"message": payload.Message,
		"details": payload.Details,
	})
}

func (s *sseSink) emit(event string, payload any) error {
	if s.failed {
		return context.Canceled
	}
	if !s.wrote {
		header := s.c.Writer.Header()
		header.Set("Content-Type", "text/event-stream; charset=utf-8")
		header.Set("Cache-Control", "no-cache")
		header.Set("Connection", "keep-alive")
		// Without this an nginx in front would buffer the whole stream and
		// hand the client one blob at the end, which defeats the point.
		header.Set("X-Accel-Buffering", "no")
		s.c.Writer.WriteHeader(http.StatusOK)
		s.wrote = true
	}

	body, err := json.Marshal(payload)
	if err != nil {
		s.failed = true
		return err
	}
	// Payloads are JSON, so they never contain a raw newline; one data line is
	// always enough.
	if _, err := fmt.Fprintf(s.c.Writer, "event: %s\ndata: %s\n\n", event, body); err != nil {
		s.failed = true
		return err
	}
	s.c.Writer.Flush()

	// A flushed write to a dead connection is not reliably an error on every
	// platform, so the request context is checked as well.
	if err := s.c.Request.Context().Err(); err != nil {
		s.failed = true
		return err
	}
	return nil
}

func (h *ChatHandler) RegenerateMessage(c *gin.Context) {
	userID, sessionID, ok := userAndSessionID(c)
	if !ok {
		return
	}

	messageID, ok := parseUUIDParam(c, "messageId", "message id is invalid")
	if !ok {
		return
	}

	res, err := h.chats.RegenerateMessage(c.Request.Context(), userID, sessionID, messageID)
	if err != nil {
		RespondError(c, err)
		return
	}

	c.JSON(http.StatusOK, res)
}

func (h *ChatHandler) EditMessage(c *gin.Context) {
	userID, sessionID, ok := userAndSessionID(c)
	if !ok {
		return
	}
	messageID, ok := parseUUIDParam(c, "messageId", "message id is invalid")
	if !ok {
		return
	}
	var req dto.EditChatMessageRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		RespondError(c, apperror.Validation(map[string]any{"body": "request body is invalid"}))
		return
	}
	res, err := h.chats.EditMessageAndRegenerate(c.Request.Context(), userID, sessionID, messageID, req)
	if err != nil {
		RespondError(c, err)
		return
	}
	c.JSON(http.StatusOK, res)
}

func userAndSessionID(c *gin.Context) (uuid.UUID, uuid.UUID, bool) {
	userID, ok := currentUserIDOrError(c)
	if !ok {
		return uuid.Nil, uuid.Nil, false
	}

	sessionID, ok := parseUUIDParam(c, "id", "session id is invalid")
	if !ok {
		return uuid.Nil, uuid.Nil, false
	}

	return userID, sessionID, true
}
