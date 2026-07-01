package handler

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"rag/backend/internal/service"
)

type UserHandler struct {
	users *service.UserService
}

func NewUserHandler(users *service.UserService) *UserHandler {
	return &UserHandler{users: users}
}

func (h *UserHandler) Search(c *gin.Context) {
	res, err := h.users.Search(c.Request.Context(), c.Query("q"), queryInt(c, "limit", 20))
	if err != nil {
		RespondError(c, err)
		return
	}
	c.JSON(http.StatusOK, res)
}
