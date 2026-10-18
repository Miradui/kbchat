package handler

import (
	"github.com/gin-gonic/gin"
	"kbchat/backend/internal/apperror"
	"net/http"
)

func (h *DocumentHandler) VersionStatus(c *gin.Context) {
	actor, ok := currentUserIDOrError(c)
	if !ok {
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 8192)
	var request struct {
		DocumentIDs []string `json:"documentIds"`
	}
	if err := c.ShouldBindJSON(&request); err != nil {
		RespondError(c, apperror.Validation(map[string]any{"body": "无效的版本查询"}))
		return
	}
	result, err := h.documents.VersionStatus(c.Request.Context(), actor, request.DocumentIDs)
	if err != nil {
		RespondError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"items": result})
}
