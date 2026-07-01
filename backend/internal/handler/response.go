package handler

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"

	"rag/backend/internal/apperror"
)

func RespondError(c *gin.Context, err error) {
	var appErr *apperror.Error
	if errors.As(err, &appErr) {
		c.JSON(appErr.Status, gin.H{
			"code":    appErr.Code,
			"message": appErr.Message,
			"details": appErr.Details,
		})
		return
	}

	c.JSON(http.StatusInternalServerError, gin.H{
		"code":    "INTERNAL_ERROR",
		"message": "系统内部错误",
		"details": gin.H{},
	})
}
