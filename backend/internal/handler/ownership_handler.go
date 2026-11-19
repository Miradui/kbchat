package handler

import (
	"github.com/gin-gonic/gin"
	"kbchat/backend/internal/apperror"
	"kbchat/backend/internal/dto"
	"net/http"
)

func (h *KnowledgeBaseHandler) TransferOwnership(c *gin.Context) {
	actor, id, ok := userAndKnowledgeBaseID(c)
	if !ok {
		return
	}
	var req dto.TransferOwnershipRequest
	if err := bindJSON(c, &req); err != nil {
		RespondError(c, apperror.Validation(map[string]any{"body": "请选择新所有者"}))
		return
	}
	res, err := h.knowledgeBases.TransferOwnership(c.Request.Context(), actor, id, req)
	if err != nil {
		RespondError(c, err)
		return
	}
	c.JSON(http.StatusOK, res)
}

func (h *AdminUserHandler) TransferKnowledgeBases(c *gin.Context) {
	actor, id, ok := adminUserIDs(c)
	if !ok {
		return
	}
	var req dto.TransferOwnershipRequest
	if err := bindJSON(c, &req); err != nil {
		RespondError(c, apperror.Validation(map[string]any{"body": "请选择新所有者"}))
		return
	}
	res, err := h.users.TransferKnowledgeBases(c.Request.Context(), actor, id, req)
	if err != nil {
		RespondError(c, err)
		return
	}
	c.JSON(http.StatusOK, res)
}
