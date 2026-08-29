package handler

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"kbchat/backend/internal/apperror"
	"kbchat/backend/internal/dto"
	"kbchat/backend/internal/service"
)

type KnowledgeBaseCategoryHandler struct {
	categories *service.KnowledgeBaseCategoryService
}

func NewKnowledgeBaseCategoryHandler(categories *service.KnowledgeBaseCategoryService) *KnowledgeBaseCategoryHandler {
	return &KnowledgeBaseCategoryHandler{categories: categories}
}

func (h *KnowledgeBaseCategoryHandler) List(c *gin.Context) {
	userID, ok := currentUserIDOrError(c)
	if !ok {
		return
	}
	res, err := h.categories.ListTree(c.Request.Context(), userID)
	if err != nil {
		RespondError(c, err)
		return
	}
	c.JSON(http.StatusOK, res)
}

func (h *KnowledgeBaseCategoryHandler) Create(c *gin.Context) {
	userID, ok := currentUserIDOrError(c)
	if !ok {
		return
	}
	var req dto.KnowledgeBaseCategoryRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		RespondError(c, apperror.Validation(map[string]any{"body": "请求参数不合法"}))
		return
	}
	res, err := h.categories.Create(c.Request.Context(), userID, req)
	if err != nil {
		RespondError(c, err)
		return
	}
	c.JSON(http.StatusCreated, res)
}

func (h *KnowledgeBaseCategoryHandler) Update(c *gin.Context) {
	userID, ok := currentUserIDOrError(c)
	if !ok {
		return
	}
	id, ok := parseUUIDParam(c, "id", "分类 ID 不合法")
	if !ok {
		return
	}
	var req dto.KnowledgeBaseCategoryRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		RespondError(c, apperror.Validation(map[string]any{"body": "请求参数不合法"}))
		return
	}
	res, err := h.categories.Update(c.Request.Context(), userID, id, req)
	if err != nil {
		RespondError(c, err)
		return
	}
	c.JSON(http.StatusOK, res)
}

func (h *KnowledgeBaseCategoryHandler) Reorder(c *gin.Context) {
	userID, ok := currentUserIDOrError(c)
	if !ok {
		return
	}
	var req dto.KnowledgeBaseCategoryReorderRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		RespondError(c, apperror.Validation(map[string]any{"body": "请求参数不合法"}))
		return
	}
	res, err := h.categories.Reorder(c.Request.Context(), userID, req)
	if err != nil {
		RespondError(c, err)
		return
	}
	c.JSON(http.StatusOK, res)
}

func (h *KnowledgeBaseCategoryHandler) Delete(c *gin.Context) {
	userID, ok := currentUserIDOrError(c)
	if !ok {
		return
	}
	id, ok := parseUUIDParam(c, "id", "分类 ID 不合法")
	if !ok {
		return
	}
	if err := h.categories.Delete(c.Request.Context(), userID, id); err != nil {
		RespondError(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}
