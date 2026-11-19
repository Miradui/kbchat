package handler

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"kbchat/backend/internal/apperror"
	"kbchat/backend/internal/dto"
	"kbchat/backend/internal/service"
)

type KnowledgeBaseTagHandler struct {
	tags *service.KnowledgeBaseTagService
}

func NewKnowledgeBaseTagHandler(tags *service.KnowledgeBaseTagService) *KnowledgeBaseTagHandler {
	return &KnowledgeBaseTagHandler{tags: tags}
}

func (h *KnowledgeBaseTagHandler) List(c *gin.Context) {
	userID, ok := currentUserIDOrError(c)
	if !ok {
		return
	}
	res, err := h.tags.List(c.Request.Context(), userID)
	if err != nil {
		RespondError(c, err)
		return
	}
	c.JSON(http.StatusOK, res)
}

func (h *KnowledgeBaseTagHandler) Create(c *gin.Context) {
	userID, ok := currentUserIDOrError(c)
	if !ok {
		return
	}
	var req dto.KnowledgeBaseTagRequest
	if err := bindJSON(c, &req); err != nil {
		RespondError(c, apperror.Validation(map[string]any{"body": "请求参数不合法"}))
		return
	}
	res, err := h.tags.Create(c.Request.Context(), userID, req.Name)
	if err != nil {
		RespondError(c, err)
		return
	}
	c.JSON(http.StatusCreated, res)
}

func (h *KnowledgeBaseTagHandler) Update(c *gin.Context) {
	userID, ok := currentUserIDOrError(c)
	if !ok {
		return
	}
	id, ok := parseUUIDParam(c, "id", "标签 ID 不合法")
	if !ok {
		return
	}
	var req dto.KnowledgeBaseTagRequest
	if err := bindJSON(c, &req); err != nil {
		RespondError(c, apperror.Validation(map[string]any{"body": "请求参数不合法"}))
		return
	}
	res, err := h.tags.Update(c.Request.Context(), userID, id, req.Name)
	if err != nil {
		RespondError(c, err)
		return
	}
	c.JSON(http.StatusOK, res)
}

func (h *KnowledgeBaseTagHandler) Delete(c *gin.Context) {
	userID, ok := currentUserIDOrError(c)
	if !ok {
		return
	}
	id, ok := parseUUIDParam(c, "id", "标签 ID 不合法")
	if !ok {
		return
	}
	if err := h.tags.Delete(c.Request.Context(), userID, id); err != nil {
		RespondError(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}
