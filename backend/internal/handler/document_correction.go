package handler

import (
	"github.com/gin-gonic/gin"
	"kbchat/backend/internal/apperror"
	"kbchat/backend/internal/document/parser"
	"kbchat/backend/internal/service"
	"net/http"
)

func (h *DocumentHandler) PDFCorrection(c *gin.Context) {
	actor, ok := currentUserIDOrError(c)
	if !ok {
		return
	}
	id, ok := parseUUIDParam(c, "id", "文档 ID 不合法")
	if !ok {
		return
	}
	res, err := h.documents.PDFCorrection(c.Request.Context(), actor, id)
	if err != nil {
		RespondError(c, err)
		return
	}
	c.JSON(http.StatusOK, res)
}
func (h *DocumentHandler) SavePDFCorrection(c *gin.Context) {
	actor, ok := currentUserIDOrError(c)
	if !ok {
		return
	}
	id, ok := parseUUIDParam(c, "id", "文档 ID 不合法")
	if !ok {
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 6*parser.MaxPDFTextBytes+8192)
	var req service.SavePDFCorrectionRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		RespondError(c, apperror.Validation(map[string]any{"body": "校对内容无效或超出大小限制"}))
		return
	}
	res, err := h.documents.SavePDFCorrection(c.Request.Context(), actor, id, req)
	if err != nil {
		RespondError(c, err)
		return
	}
	c.JSON(http.StatusOK, res)
}
