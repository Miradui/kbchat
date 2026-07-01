package handler

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"rag/backend/internal/apperror"
	"rag/backend/internal/dto"
	"rag/backend/internal/service"
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

	res, err := h.chats.ListSessions(c.Request.Context(), userID)
	if err != nil {
		RespondError(c, err)
		return
	}

	c.JSON(http.StatusOK, res)
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

func (h *ChatHandler) ArchiveSession(c *gin.Context) {
	userID, sessionID, ok := userAndSessionID(c)
	if !ok {
		return
	}
	if err := h.chats.ArchiveSession(c.Request.Context(), userID, sessionID); err != nil {
		RespondError(c, err)
		return
	}
	c.Status(http.StatusNoContent)
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
