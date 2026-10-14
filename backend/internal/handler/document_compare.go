package handler

import (
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"kbchat/backend/internal/apperror"
	"net/http"
)

func (h *DocumentHandler) Versions(c *gin.Context) {
	actor, ok := currentUserIDOrError(c)
	if !ok {
		return
	}
	id, ok := parseUUIDParam(c, "id", "文档 ID 不合法")
	if !ok {
		return
	}
	res, err := h.documents.Versions(c.Request.Context(), actor, id)
	if err != nil {
		RespondError(c, err)
		return
	}
	c.JSON(http.StatusOK, res)
}
func (h *DocumentHandler) Compare(c *gin.Context) {
	actor, ok := currentUserIDOrError(c)
	if !ok {
		return
	}
	id, ok := parseUUIDParam(c, "id", "文档 ID 不合法")
	if !ok {
		return
	}
	base, err := uuid.Parse(c.Query("baseId"))
	if err != nil {
		RespondError(c, apperror.Validation(map[string]any{"baseId": "请选择有效的基准版本"}))
		return
	}
	res, err := h.documents.Compare(c.Request.Context(), actor, base, id)
	if err != nil {
		RespondError(c, err)
		return
	}
	c.JSON(http.StatusOK, res)
}
