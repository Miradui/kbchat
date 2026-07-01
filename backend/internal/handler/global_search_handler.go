package handler

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"rag/backend/internal/apperror"
	"rag/backend/internal/service"
)

type GlobalSearchHandler struct {
	search *service.GlobalSearchService
}

func NewGlobalSearchHandler(search *service.GlobalSearchService) *GlobalSearchHandler {
	return &GlobalSearchHandler{search: search}
}

func (h *GlobalSearchHandler) Search(c *gin.Context) {
	userID, ok := currentUserIDOrError(c)
	if !ok {
		return
	}
	query := c.Query("q")
	if query == "" {
		RespondError(c, apperror.Validation(map[string]any{"q": "查询不能为空"}))
		return
	}
	res, err := h.search.Search(c.Request.Context(), userID, query)
	if err != nil {
		RespondError(c, err)
		return
	}
	c.JSON(http.StatusOK, res)
}
