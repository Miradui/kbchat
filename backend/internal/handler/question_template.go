package handler

import (
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"kbchat/backend/internal/apperror"
	"kbchat/backend/internal/dto"
	"net/http"
)

func (h *ChatHandler) ListQuestionTemplates(c *gin.Context) {
	user, ok := currentUserIDOrError(c)
	if !ok {
		return
	}
	q, ok := personalListQuery(c)
	if !ok {
		return
	}
	res, err := h.chats.ListQuestionTemplates(c.Request.Context(), user, q)
	if err != nil {
		RespondError(c, err)
		return
	}
	c.JSON(http.StatusOK, res)
}
func (h *ChatHandler) SaveQuestionTemplate(c *gin.Context) {
	user, ok := currentUserIDOrError(c)
	if !ok {
		return
	}
	var id *uuid.UUID
	if c.Param("templateId") != "" {
		value, ok := parseUUIDParam(c, "templateId", "模板 ID 不合法")
		if !ok {
			return
		}
		id = &value
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 100*1024)
	var req dto.SaveQuestionTemplateRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		RespondError(c, apperror.Validation(map[string]any{"body": "模板内容无效或过大"}))
		return
	}
	res, err := h.chats.SaveQuestionTemplate(c.Request.Context(), user, id, req)
	if err != nil {
		RespondError(c, err)
		return
	}
	status := http.StatusOK
	if id == nil {
		status = http.StatusCreated
	}
	c.JSON(status, res)
}
func (h *ChatHandler) DeleteQuestionTemplate(c *gin.Context) {
	user, ok := currentUserIDOrError(c)
	if !ok {
		return
	}
	id, ok := parseUUIDParam(c, "templateId", "模板 ID 不合法")
	if !ok {
		return
	}
	if err := h.chats.DeleteQuestionTemplate(c.Request.Context(), user, id); err != nil {
		RespondError(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}
