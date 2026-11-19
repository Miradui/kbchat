package middleware

import (
	"net/http"
	"net/http/httptest"
	"slices"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestCORSAlwaysVariesByOrigin(t *testing.T) {
	tests := []struct {
		name          string
		origin        string
		expectedAllow bool
	}{
		{name: "no origin"},
		{name: "allowed origin", origin: "https://ui.example.test", expectedAllow: true},
		{name: "disallowed origin", origin: "https://other.example.test"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gin.SetMode(gin.TestMode)
			router := gin.New()
			router.Use(CORS([]string{"https://ui.example.test"}))
			router.GET("/resource", func(c *gin.Context) {
				c.Header("Vary", "Accept-Encoding")
				c.String(http.StatusOK, "ok")
			})

			req := httptest.NewRequest(http.MethodGet, "/resource", nil)
			if tt.origin != "" {
				req.Header.Set("Origin", tt.origin)
			}
			rec := httptest.NewRecorder()

			router.ServeHTTP(rec, req)

			response := rec.Result()
			defer response.Body.Close()
			vary := response.Header.Values("Vary")
			if !slices.Contains(vary, "Origin") {
				t.Fatalf("expected Vary to include Origin, got %q", vary)
			}
			if !slices.Contains(vary, "Accept-Encoding") {
				t.Fatalf("expected Vary to preserve Accept-Encoding, got %q", vary)
			}
			if got := response.Header.Get("Access-Control-Allow-Origin"); tt.expectedAllow && got != tt.origin {
				t.Fatalf("expected allowed origin %q, got %q", tt.origin, got)
			} else if !tt.expectedAllow && got != "" {
				t.Fatalf("expected no allowed origin, got %q", got)
			}
			if got := response.Header.Get("Access-Control-Expose-Headers"); tt.expectedAllow && got != "Retry-After, X-Trace-ID" {
				t.Fatalf("expected Retry-After and X-Trace-ID to be exposed, got %q", got)
			} else if !tt.expectedAllow && got != "" {
				t.Fatalf("expected no exposed headers, got %q", got)
			}
		})
	}
}

func TestCORSPreservesOriginVaryOnRecoveredPanic(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.Use(gin.Recovery())
	router.Use(CORS([]string{"https://ui.example.test"}))
	router.GET("/resource", func(c *gin.Context) {
		c.Header("Vary", "Accept-Encoding")
		panic("boom")
	})

	req := httptest.NewRequest(http.MethodGet, "/resource", nil)
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	response := rec.Result()
	defer response.Body.Close()
	if response.StatusCode != http.StatusInternalServerError {
		t.Fatalf("expected status %d, got %d", http.StatusInternalServerError, response.StatusCode)
	}
	if vary := response.Header.Values("Vary"); !slices.Contains(vary, "Origin") {
		t.Fatalf("expected Vary to include Origin, got %q", vary)
	}
}
