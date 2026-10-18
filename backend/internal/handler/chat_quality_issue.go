package handler

import (
	"github.com/gin-gonic/gin"
	"kbchat/backend/internal/apperror"
	"kbchat/backend/internal/dto"
	"net/http"
)

func (h *ChatHandler) QualityIssue(c *gin.Context) {
	actor, id, ok := userAndSessionID(c)
	if !ok {
		return
	}
	res, err := h.chats.GetQualityIssue(c.Request.Context(), actor, id, c.Query("question"))
	if err != nil {
		RespondError(c, err)
		return
	}
	c.JSON(http.StatusOK, res)
}
func (h *ChatHandler) SaveQualityIssue(c *gin.Context) {
	actor, id, ok := userAndSessionID(c)
	if !ok {
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 64000)
	var req dto.ChatQualityIssueRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		RespondError(c, apperror.Validation(map[string]any{"body": "无效的处理记录"}))
		return
	}
	res, err := h.chats.SaveQualityIssue(c.Request.Context(), actor, id, req)
	if err != nil {
		RespondError(c, err)
		return
	}
	c.JSON(http.StatusOK, res)
}
