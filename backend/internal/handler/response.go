package handler

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"
	"kbchat/backend/internal/apperror"
	"kbchat/backend/internal/observability"
)

func RespondError(c *gin.Context, err error) {
	status, payload := errorPayload(err)
	trace.SpanFromContext(c.Request.Context()).SetAttributes(attribute.String("app.error_code", payload.Code))
	c.JSON(status, gin.H{
		"traceId": observability.TraceID(c.Request.Context()),
		"code":    payload.Code,
		"message": payload.Message,
		"details": payload.Details,
	})
}

// errorPayload maps an error onto the public error shape. It is shared with the
// SSE `error` event so a streamed failure reads identically to a JSON one — the
// frontend's error handling keys off `code`, and two mappings would let those
// drift apart.
func errorPayload(err error) (int, *apperror.Error) {
	var appErr *apperror.Error
	if errors.As(err, &appErr) {
		return appErr.Status, appErr
	}
	return http.StatusInternalServerError, &apperror.Error{
		Status:  http.StatusInternalServerError,
		Code:    "INTERNAL_ERROR",
		Message: "系统内部错误",
		Details: map[string]any{},
	}
}
