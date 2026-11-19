package handler

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

// Ordinary API objects are bounded before JSON decoding, including chunked
// requests. Document text/OCR/import endpoints keep their explicit larger limits.
func bindJSON(c *gin.Context, target any) error {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 1<<20)
	return c.ShouldBindJSON(target)
}
