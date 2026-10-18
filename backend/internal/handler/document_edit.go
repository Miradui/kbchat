package handler

import (
	"github.com/gin-gonic/gin"
	"kbchat/backend/internal/apperror"
	"kbchat/backend/internal/service"
	"net/http"
)

func (h *DocumentHandler) EditableText(c *gin.Context) {
	actor, ok := currentUserIDOrError(c)
	if !ok {
		return
	}
	id, ok := parseUUIDParam(c, "id", "文档 ID 不合法")
	if !ok {
		return
	}
	res, err := h.documents.EditableText(c.Request.Context(), actor, id)
	if err != nil {
		RespondError(c, err)
		return
	}
	c.JSON(http.StatusOK, res)
}
func (h *DocumentHandler) SaveTextRevision(c *gin.Context) {
	actor, ok := currentUserIDOrError(c)
	if !ok {
		return
	}
	id, ok := parseUUIDParam(c, "id", "文档 ID 不合法")
	if !ok {
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 6*service.MaxEditableTextBytes+1024)
	var req service.SaveDocumentTextRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		RespondError(c, apperror.Validation(map[string]any{"body": "无效的文本保存请求"}))
		return
	}
	res, err := h.documents.SaveTextRevision(c.Request.Context(), actor, id, req)
	if err != nil {
		RespondError(c, err)
		return
	}
	c.JSON(http.StatusOK, res)
}
