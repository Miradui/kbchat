package middleware

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/gin-gonic/gin"
	"github.com/redis/go-redis/v9"

	"kbchat/backend/internal/cache"
)

type rateLimitResponse struct {
	Code    string `json:"code"`
	Details struct {
		RetryAfter int `json:"retryAfter"`
	} `json:"details"`
}

type rateLimitRecorderStub struct {
	scopes []string
}

func (r *rateLimitRecorderStub) RecordRateLimitTrigger(scope string) {
	r.scopes = append(r.scopes, scope)
}

func TestRateLimitMiddlewareRejectsAfterWindowLimit(t *testing.T) {
	gin.SetMode(gin.TestMode)
	server := miniredis.RunT(t)
	client := redis.NewClient(&redis.Options{Addr: server.Addr()})
	t.Cleanup(func() { _ = client.Close() })
	recorder := &rateLimitRecorderStub{}
	router := gin.New()
	router.Use(RateLimit(cache.NewFixedWindowRateLimiter(client), RateLimitOptions{
		Scope:       RateLimitScopeLogin,
		Limit:       2,
		Window:      time.Minute,
		FailureMode: RateLimitFailureModeOpen,
		Key:         func(*gin.Context) (string, error) { return "203.0.113.8", nil },
		Recorder:    recorder,
	}))
	router.POST("/login", func(c *gin.Context) { c.Status(http.StatusNoContent) })

	for attempt := 1; attempt <= 2; attempt++ {
		response := performRateLimitedRequest(router)
		if response.Code != http.StatusNoContent {
			t.Fatalf("attempt %d: expected status %d, got %d", attempt, http.StatusNoContent, response.Code)
		}
	}

	response := performRateLimitedRequest(router)
	if response.Code != http.StatusTooManyRequests {
		t.Fatalf("expected status %d, got %d", http.StatusTooManyRequests, response.Code)
	}
	if retryAfter := response.Header().Get("Retry-After"); retryAfter != "60" {
		t.Fatalf("expected Retry-After 60, got %q", retryAfter)
	}
	var payload rateLimitResponse
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if payload.Code != "RATE_LIMITED" || payload.Details.RetryAfter != 60 {
		t.Fatalf("unexpected response payload: %+v", payload)
	}
	if len(recorder.scopes) != 1 || recorder.scopes[0] != RateLimitScopeLogin {
		t.Fatalf("unexpected recorded scopes: %v", recorder.scopes)
	}
}

func TestRateLimitMiddlewareFailureModes(t *testing.T) {
	gin.SetMode(gin.TestMode)
	tests := []struct {
		name           string
		mode           RateLimitFailureMode
		expectedStatus int
	}{
		{name: "open allows request", mode: RateLimitFailureModeOpen, expectedStatus: http.StatusNoContent},
		{name: "closed rejects request", mode: RateLimitFailureModeClosed, expectedStatus: http.StatusServiceUnavailable},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			server := miniredis.RunT(t)
			client := redis.NewClient(&redis.Options{
				Addr:         server.Addr(),
				MaxRetries:   -1,
				DialTimeout:  50 * time.Millisecond,
				ReadTimeout:  50 * time.Millisecond,
				WriteTimeout: 50 * time.Millisecond,
			})
			t.Cleanup(func() { _ = client.Close() })
			server.Close()

			router := gin.New()
			router.Use(RateLimit(cache.NewFixedWindowRateLimiter(client), RateLimitOptions{
				Scope:       RateLimitScopeChat,
				Limit:       30,
				Window:      time.Minute,
				FailureMode: tt.mode,
				Key:         func(*gin.Context) (string, error) { return "user-1", nil },
			}))
			router.POST("/messages", func(c *gin.Context) { c.Status(http.StatusNoContent) })

			request := httptest.NewRequest(http.MethodPost, "/messages", nil)
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request)

			if response.Code != tt.expectedStatus {
				t.Fatalf("expected status %d, got %d", tt.expectedStatus, response.Code)
			}
			if tt.mode == RateLimitFailureModeClosed {
				if retryAfter := response.Header().Get("Retry-After"); retryAfter != "" {
					t.Fatalf("expected no Retry-After on Redis failure, got %q", retryAfter)
				}
				var payload rateLimitResponse
				if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
					t.Fatalf("decode response: %v", err)
				}
				if payload.Code != "RATE_LIMIT_UNAVAILABLE" {
					t.Fatalf("unexpected error code %q", payload.Code)
				}
			}
		})
	}
}

func TestClientIPResolverTrustsOnlyConfiguredProxyCIDRs(t *testing.T) {
	resolver, err := NewClientIPResolver([]string{"10.0.0.0/8", "192.0.2.0/24", "2001:db8::/32"})
	if err != nil {
		t.Fatalf("NewClientIPResolver returned error: %v", err)
	}

	tests := []struct {
		name       string
		remoteAddr string
		forwarded  []string
		expected   string
	}{
		{
			name:       "untrusted peer ignores forwarded header",
			remoteAddr: "198.51.100.10:3210",
			forwarded:  []string{"203.0.113.20"},
			expected:   "198.51.100.10",
		},
		{
			name:       "trusted peer uses forwarded client",
			remoteAddr: "10.1.2.3:443",
			forwarded:  []string{"203.0.113.20"},
			expected:   "203.0.113.20",
		},
		{
			name:       "trusted proxy chain stops at first untrusted address",
			remoteAddr: "10.1.2.3:443",
			forwarded:  []string{"203.0.113.20, 192.0.2.50"},
			expected:   "203.0.113.20",
		},
		{
			name:       "spoofed leftmost address cannot cross untrusted hop",
			remoteAddr: "10.1.2.3:443",
			forwarded:  []string{"198.51.100.99, 203.0.113.20"},
			expected:   "203.0.113.20",
		},
		{
			name:       "malformed forwarded header falls back to peer",
			remoteAddr: "10.1.2.3:443",
			forwarded:  []string{"not-an-ip"},
			expected:   "10.1.2.3",
		},
		{
			name:       "multiple forwarded headers form one chain",
			remoteAddr: "10.1.2.3:443",
			forwarded:  []string{"203.0.113.20", "192.0.2.50"},
			expected:   "203.0.113.20",
		},
		{
			name:       "IPv6 remote address is parsed",
			remoteAddr: "[2001:db8::5]:443",
			forwarded:  []string{"2001:db9::10"},
			expected:   "2001:db9::10",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, "/login", nil)
			request.RemoteAddr = tt.remoteAddr
			for _, value := range tt.forwarded {
				request.Header.Add("X-Forwarded-For", value)
			}
			got, err := resolver.Resolve(request)
			if err != nil {
				t.Fatalf("Resolve returned error: %v", err)
			}
			if got != tt.expected {
				t.Fatalf("expected %q, got %q", tt.expected, got)
			}
		})
	}
}

func TestClientIPResolverWithoutTrustedProxiesIgnoresForwardedHeader(t *testing.T) {
	resolver, err := NewClientIPResolver(nil)
	if err != nil {
		t.Fatalf("NewClientIPResolver returned error: %v", err)
	}
	request := httptest.NewRequest(http.MethodPost, "/login", nil)
	request.RemoteAddr = "198.51.100.10:3210"
	request.Header.Set("X-Forwarded-For", "203.0.113.20")

	got, err := resolver.Resolve(request)
	if err != nil {
		t.Fatalf("Resolve returned error: %v", err)
	}
	if got != "198.51.100.10" {
		t.Fatalf("expected direct peer, got %q", got)
	}
}

func TestNewClientIPResolverRejectsInvalidCIDR(t *testing.T) {
	if _, err := NewClientIPResolver([]string{"10.0.0.1"}); err == nil {
		t.Fatal("expected invalid CIDR error")
	}
}

func performRateLimitedRequest(router http.Handler) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodPost, "/login", nil)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	return response
}
