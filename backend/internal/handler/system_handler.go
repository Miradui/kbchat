package handler

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"rag/backend/internal/service"
)

type SystemHandler struct {
	system *service.SystemService
}

func NewSystemHandler(system *service.SystemService) *SystemHandler {
	return &SystemHandler{system: system}
}

func (h *SystemHandler) Capabilities(c *gin.Context) {
	c.JSON(http.StatusOK, h.system.Capabilities())
}
