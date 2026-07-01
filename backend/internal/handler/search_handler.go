package handler

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"rag/backend/internal/apperror"
	"rag/backend/internal/dto"
	"rag/backend/internal/retrieval"
)

type SearchHandler struct {
	retrieval *retrieval.Service
}

func NewSearchHandler(retrieval *retrieval.Service) *SearchHandler {
	return &SearchHandler{retrieval: retrieval}
}

func (h *SearchHandler) Search(c *gin.Context) {
	userID, ok := currentUserIDOrError(c)
	if !ok {
		return
	}

	kbID, ok := parseUUIDParam(c, "id", "knowledge base id is invalid")
	if !ok {
		return
	}

	var req dto.SearchRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		RespondError(c, apperror.Validation(map[string]any{"body": "request body is invalid"}))
		return
	}

	res, err := h.retrieval.Search(c.Request.Context(), userID, kbID, req)
	if err != nil {
		RespondError(c, err)
		return
	}

	c.JSON(http.StatusOK, res)
}
