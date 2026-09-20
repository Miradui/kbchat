package middleware

import (
	"context"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"kbchat/backend/internal/auth"
	"kbchat/backend/internal/config"
)

type UserStatusChecker interface {
	IsActive(context.Context, uuid.UUID) (bool, error)
}

const CurrentUserIDKey = "currentUserID"

func AuthRequired(cfg config.Config, checkers ...UserStatusChecker) gin.HandlerFunc {
	return func(c *gin.Context) {
		header := c.GetHeader("Authorization")
		tokenString := strings.TrimPrefix(header, "Bearer ")
		if header == "" || tokenString == header || tokenString == "" {
			respondUnauthorized(c)
			c.Abort()
			return
		}

		claims, err := auth.ParseToken(cfg, tokenString)
		if err != nil {
			respondUnauthorized(c)
			c.Abort()
			return
		}

		userID, err := uuid.Parse(claims.UserID)
		if err != nil {
			respondUnauthorized(c)
			c.Abort()
			return
		}
		if len(checkers) > 0 && checkers[0] != nil {
			active, statusErr := checkers[0].IsActive(c.Request.Context(), userID)
			if statusErr == nil && !active {
				respondUnauthorized(c)
				c.Abort()
				return
			}
		}

		c.Set(CurrentUserIDKey, userID)
		c.Next()
	}
}

func respondUnauthorized(c *gin.Context) {
	c.JSON(http.StatusUnauthorized, gin.H{
		"code":    "UNAUTHORIZED",
		"message": "请先登录",
		"details": gin.H{},
	})
}

func CurrentUserID(c *gin.Context) (uuid.UUID, bool) {
	value, ok := c.Get(CurrentUserIDKey)
	if !ok {
		return uuid.Nil, false
	}

	userID, ok := value.(uuid.UUID)
	return userID, ok
}
