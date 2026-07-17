package middleware

import (
	"bufio"
	"net"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
)

var defaultCORSAllowedOrigins = []string{
	"http://127.0.0.1:5173",
	"http://localhost:5173",
}

func CORS(allowedOrigins []string) gin.HandlerFunc {
	if len(allowedOrigins) == 0 {
		allowedOrigins = defaultCORSAllowedOrigins
	}
	allowed := make(map[string]struct{}, len(allowedOrigins))
	for _, origin := range allowedOrigins {
		if origin = strings.TrimSpace(origin); origin != "" {
			allowed[origin] = struct{}{}
		}
	}

	return func(c *gin.Context) {
		writer := &varyOriginWriter{ResponseWriter: c.Writer}
		c.Writer = writer
		writer.ensureVaryOrigin()
		origin := c.GetHeader("Origin")
		if _, ok := allowed[origin]; !ok {
			c.Next()
			writer.ensureVaryOrigin()
			return
		}

		c.Header("Access-Control-Allow-Origin", origin)
		c.Header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
		c.Header("Access-Control-Allow-Headers", "Authorization, Content-Type")
		if c.Request.Method == http.MethodOptions {
			c.AbortWithStatus(http.StatusNoContent)
			return
		}
		c.Next()
		writer.ensureVaryOrigin()
	}
}

type varyOriginWriter struct {
	gin.ResponseWriter
}

func (w *varyOriginWriter) Write(data []byte) (int, error) {
	w.ensureVaryOrigin()
	return w.ResponseWriter.Write(data)
}

func (w *varyOriginWriter) WriteString(data string) (int, error) {
	w.ensureVaryOrigin()
	return w.ResponseWriter.WriteString(data)
}

func (w *varyOriginWriter) WriteHeaderNow() {
	w.ensureVaryOrigin()
	w.ResponseWriter.WriteHeaderNow()
}

func (w *varyOriginWriter) Flush() {
	w.ensureVaryOrigin()
	w.ResponseWriter.Flush()
}

func (w *varyOriginWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	w.ensureVaryOrigin()
	return w.ResponseWriter.Hijack()
}

func (w *varyOriginWriter) ensureVaryOrigin() {
	for _, value := range w.Header().Values("Vary") {
		for _, field := range strings.Split(value, ",") {
			if strings.EqualFold(strings.TrimSpace(field), "Origin") {
				return
			}
		}
	}
	w.Header().Add("Vary", "Origin")
}
