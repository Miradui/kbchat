package handler

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"kbchat/backend/internal/service"
)

type ActivityHandler struct {
	activities *service.ActivityService
}

func NewActivityHandler(activities *service.ActivityService) *ActivityHandler {
	return &ActivityHandler{activities: activities}
}

func (h *ActivityHandler) List(c *gin.Context) {
	userID, ok := currentUserIDOrError(c)
	if !ok {
		return
	}
	res, err := h.activities.List(c.Request.Context(), userID, queryInt(c, "limit", 20))
	if err != nil {
		RespondError(c, err)
		return
	}
	c.JSON(http.StatusOK, res)
}
