package handler

import (
	"github.com/gin-gonic/gin"
	"kbchat/backend/internal/apperror"
	"kbchat/backend/internal/dto"
	"net/http"
)

func personalListQuery(c *gin.Context) (dto.PersonalListQuery, bool) {
	p := struct {
		Q        string `form:"q"`
		Page     int    `form:"page" binding:"gte=1,lte=1000000"`
		PageSize int    `form:"pageSize" binding:"gte=1,lte=100"`
	}{Page: 1, PageSize: 20}
	if err := c.ShouldBindQuery(&p); err != nil {
		RespondError(c, apperror.Validation(map[string]any{"query": "invalid list parameters"}))
		return dto.PersonalListQuery{}, false
	}
	return dto.PersonalListQuery{Q: p.Q, Page: p.Page, PageSize: p.PageSize}, true
}
func (h *ChatHandler) ListBookmarks(c *gin.Context) {
	userID, ok := currentUserIDOrError(c)
	if !ok {
		return
	}
	q, ok := personalListQuery(c)
	if !ok {
		return
	}
	res, err := h.chats.ListBookmarks(c.Request.Context(), userID, q)
	if err != nil {
		RespondError(c, err)
		return
	}
	c.JSON(http.StatusOK, res)
}
func (h *ChatHandler) SaveBookmark(c *gin.Context) {
	userID, ok := currentUserIDOrError(c)
	if !ok {
		return
	}
	id, ok := parseUUIDParam(c, "messageId", "invalid message id")
	if !ok {
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 100*1024)
	var req dto.SaveChatBookmarkRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		RespondError(c, apperror.Validation(map[string]any{"body": "invalid bookmark"}))
		return
	}
	res, err := h.chats.SaveBookmark(c.Request.Context(), userID, id, req.Note)
	if err != nil {
		RespondError(c, err)
		return
	}
	c.JSON(http.StatusOK, res)
}
func (h *ChatHandler) DeleteBookmark(c *gin.Context) {
	userID, ok := currentUserIDOrError(c)
	if !ok {
		return
	}
	id, ok := parseUUIDParam(c, "messageId", "invalid message id")
	if !ok {
		return
	}
	if err := h.chats.DeleteBookmark(c.Request.Context(), userID, id); err != nil {
		RespondError(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}
