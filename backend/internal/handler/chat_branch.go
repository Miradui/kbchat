package handler

import (
	"github.com/gin-gonic/gin"
	"kbchat/backend/internal/apperror"
	"kbchat/backend/internal/dto"
	"net/http"
)

func (h *ChatHandler) CreateBranch(c *gin.Context) {
	user, ok := currentUserIDOrError(c)
	if !ok {
		return
	}
	session, ok := parseUUIDParam(c, "id", "会话 ID 不合法")
	if !ok {
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 16*1024)
	var req dto.CreateChatBranchRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		RespondError(c, apperror.Validation(map[string]any{"body": "分支请求不合法"}))
		return
	}
	res, err := h.chats.CreateBranch(c.Request.Context(), user, session, req)
	if err != nil {
		RespondError(c, err)
		return
	}
	c.JSON(http.StatusCreated, res)
}
