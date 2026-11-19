package middleware

import (
	"time"

	"github.com/gin-gonic/gin"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"
	"go.uber.org/zap"
	"kbchat/backend/internal/observability"
)

func RequestLogger(logger *zap.Logger, metrics *observability.Recorder) gin.HandlerFunc {
	return func(c *gin.Context) {
		start := time.Now()
		c.Set("requestStartedAt", start)
		ctx := c.Request.Context()
		if id := observability.TraceID(ctx); id != "" {
			c.Header("X-Trace-ID", id)
		}
		c.Next()
		if elapsed, ok := c.Get("firstVisibleDuration"); ok {
			metrics.ObserveDuration(ctx, observability.MetricChatFirstVisibleText, elapsed.(time.Duration))
		}

		span := trace.SpanFromContext(ctx)
		outcome, streaming := c.Get("streamOutcome")
		if !streaming {
			outcome = "completed"
			if c.Writer.Status() >= 400 {
				outcome = "failed"
			}
		}
		span.SetAttributes(attribute.String("app.outcome", outcome.(string)))
		metrics.RecordRequest(ctx, c.Request.Method, c.FullPath(), c.Writer.Status(), outcome.(string), time.Since(start))
		observability.Log(ctx, logger).Info("http request",
			zap.String("outcome", outcome.(string)),
			zap.String("method", c.Request.Method),
			zap.String("path", c.Request.URL.Path),
			zap.Int("status", c.Writer.Status()),
			zap.Duration("latency", time.Since(start)),
			zap.String("client_ip", c.ClientIP()),
		)
	}
}
