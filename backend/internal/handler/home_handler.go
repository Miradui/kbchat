package handler

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"kbchat/backend/internal/service"
)

type HomeHandler struct {
	home *service.HomeService
}

func NewHomeHandler(home *service.HomeService) *HomeHandler {
	return &HomeHandler{home: home}
}

func (h *HomeHandler) Summary(c *gin.Context) {
	userID, ok := currentUserIDOrError(c)
	if !ok {
		return
	}
	res, err := h.home.Summary(c.Request.Context(), userID, c.Query("period"))
	if err != nil {
		RespondError(c, err)
		return
	}
	c.JSON(http.StatusOK, res)
}
