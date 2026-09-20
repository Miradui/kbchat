package handler

import (
	"github.com/gin-gonic/gin"

	"kbchat/backend/internal/apperror"
	"kbchat/backend/internal/middleware"
	"kbchat/backend/internal/service"
)

func RequireSystemAdmin(admins *service.SystemAdminService) gin.HandlerFunc {
	return func(c *gin.Context) {
		userID, ok := middleware.CurrentUserID(c)
		if !ok {
			RespondError(c, apperror.Unauthorized())
			c.Abort()
			return
		}
		if err := admins.Authorize(c.Request.Context(), userID); err != nil {
			RespondError(c, err)
			c.Abort()
			return
		}
		c.Next()
	}
}
