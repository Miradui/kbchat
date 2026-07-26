package handler

import (
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"

	"rag/backend/internal/apperror"
	"rag/backend/internal/dto"
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
	req := dto.GlobalSearchRequest{Query: c.Query("q"), Type: c.DefaultQuery("type", "all")}
	var parseErr error
	if value := c.Query("page"); value != "" {
		req.Page, parseErr = strconv.Atoi(value)
		if parseErr != nil {
			RespondError(c, apperror.Validation(map[string]any{"page": "page must be an integer"}))
			return
		}
	}
	if value := c.Query("pageSize"); value != "" {
		req.PageSize, parseErr = strconv.Atoi(value)
		if parseErr != nil {
			RespondError(c, apperror.Validation(map[string]any{"pageSize": "pageSize must be an integer"}))
			return
		}
	}
	if req.Query == "" {
		RespondError(c, apperror.Validation(map[string]any{"q": "查询不能为空"}))
		return
	}
	res, err := h.search.Search(c.Request.Context(), userID, req)
	if err != nil {
		RespondError(c, err)
		return
	}
	c.JSON(http.StatusOK, res)
}
