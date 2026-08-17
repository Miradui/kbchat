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

func (h *GlobalSearchHandler) Suggest(c *gin.Context) {
	userID, ok := currentUserIDOrError(c)
	if !ok {
		return
	}
	req := dto.SearchSuggestRequest{Query: c.Query("q")}
	if value := c.Query("limit"); value != "" {
		limit, err := strconv.Atoi(value)
		if err != nil {
			RespondError(c, apperror.Validation(map[string]any{"limit": "limit must be an integer"}))
			return
		}
		req.Limit = limit
	}
	if req.Query == "" {
		RespondError(c, apperror.Validation(map[string]any{"q": "查询不能为空"}))
		return
	}
	res, err := h.search.Suggest(c.Request.Context(), userID, req)
	if err != nil {
		RespondError(c, err)
		return
	}
	c.JSON(http.StatusOK, res)
}

func (h *GlobalSearchHandler) Export(c *gin.Context) {
	userID, ok := currentUserIDOrError(c)
	if !ok {
		return
	}
	req := dto.GlobalSearchRequest{Query: c.Query("q"), Type: c.DefaultQuery("type", "all")}
	if req.Query == "" {
		RespondError(c, apperror.Validation(map[string]any{"q": "查询不能为空"}))
		return
	}
	exported, err := h.search.Export(c.Request.Context(), userID, req)
	if err != nil {
		RespondError(c, err)
		return
	}
	c.Header("Content-Disposition", "attachment; filename=\""+exported.Filename+"\"")
	c.Data(http.StatusOK, exported.ContentType, exported.Content)
}
