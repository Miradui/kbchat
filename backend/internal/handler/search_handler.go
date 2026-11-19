package handler

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"kbchat/backend/internal/apperror"
	"kbchat/backend/internal/dto"
	"kbchat/backend/internal/retrieval"
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
	if err := bindJSON(c, &req); err != nil {
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

func (h *SearchHandler) SearchMany(c *gin.Context) {
	userID, ok := currentUserIDOrError(c)
	if !ok {
		return
	}
	var req dto.MultiSearchRequest
	if err := bindJSON(c, &req); err != nil {
		RespondError(c, apperror.Validation(map[string]any{"body": "request body is invalid"}))
		return
	}
	ids, err := dto.ParseKnowledgeBaseIDs("", req.KnowledgeBaseIDs)
	if err != nil {
		RespondError(c, err)
		return
	}
	res, err := h.retrieval.SearchMany(c.Request.Context(), userID, ids, req.SearchRequest)
	if err != nil {
		RespondError(c, err)
		return
	}
	c.JSON(http.StatusOK, res)
}
