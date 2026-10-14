package handler

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"kbchat/backend/internal/apperror"
	"kbchat/backend/internal/dto"
)

func (h *ChatHandler) SearchMessages(c *gin.Context) {
	userID, ok := currentUserIDOrError(c)
	if !ok {
		return
	}
	params := struct {
		Q         string `form:"q"`
		SessionID string `form:"sessionId" binding:"omitempty,uuid"`
		Page      int    `form:"page" binding:"gte=1,lte=1000000"`
		PageSize  int    `form:"pageSize" binding:"gte=1,lte=100"`
	}{Page: 1, PageSize: 20}
	if err := c.ShouldBindQuery(&params); err != nil {
		RespondError(c, apperror.Validation(map[string]any{"search": "search parameters are invalid"}))
		return
	}
	query := dto.ChatMessageSearchQuery{Q: params.Q, Page: params.Page, PageSize: params.PageSize}
	if params.SessionID != "" {
		id, _ := uuid.Parse(params.SessionID)
		query.SessionID = &id
	}
	res, err := h.chats.SearchMessages(c.Request.Context(), userID, query)
	if err != nil {
		RespondError(c, err)
		return
	}
	c.JSON(http.StatusOK, res)
}
