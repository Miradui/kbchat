package router

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	miniredis "github.com/alicebob/miniredis/v2"
	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"

	"kbchat/backend/internal/auth"
	"kbchat/backend/internal/cache"
	"kbchat/backend/internal/config"
	"kbchat/backend/internal/logger"
	"kbchat/backend/internal/model"
	"kbchat/backend/internal/observability"
	"kbchat/backend/internal/storage"
)

func TestLoginRouteReturns429OnEleventhAttempt(t *testing.T) {
	server := miniredis.RunT(t)
	redisClient := redis.NewClient(&redis.Options{Addr: server.Addr()})
	t.Cleanup(func() { _ = redisClient.Close() })
	db := testDB(t)
	if err := db.AutoMigrate(&model.User{}); err != nil {
		t.Fatalf("migrate users: %v", err)
	}
	cfg := rateLimitRouterConfig()
	recorder := observability.NewRecorder()
	r := NewWithStorageAndDependencies(cfg, db, logger.New(cfg), storage.NewLocalStorage(t.TempDir()), Dependencies{
		RateLimiter: cache.NewFixedWindowRateLimiter(redisClient),
		Metrics:     recorder,
	})

	for attempt := 1; attempt <= 11; attempt++ {
		req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", strings.NewReader(`{"username":"missing-user","password":"wrong-password"}`))
		req.RemoteAddr = "203.0.113.8:41234"
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)

		if attempt <= 10 && rec.Code == http.StatusTooManyRequests {
			t.Fatalf("attempt %d was limited too early", attempt)
		}
		if attempt == 11 {
			assertRateLimitedResponse(t, rec, "60")
		}
	}
	if got := recorder.Snapshot().RateLimitTriggers[observability.RateLimitScopeLogin]; got != 1 {
		t.Fatalf("expected one login rate-limit trigger, got %d", got)
	}
}

func TestOnlyChatGenerationRoutesUseUserRateLimit(t *testing.T) {
	server := miniredis.RunT(t)
	redisClient := redis.NewClient(&redis.Options{Addr: server.Addr()})
	t.Cleanup(func() { _ = redisClient.Close() })
	cfg := rateLimitRouterConfig()
	cfg.RateLimitChatPerMinute = 1
	recorder := observability.NewRecorder()
	r := NewWithStorageAndDependencies(cfg, testDB(t), logger.New(cfg), storage.NewLocalStorage(t.TempDir()), Dependencies{
		RateLimiter: cache.NewFixedWindowRateLimiter(redisClient),
		Metrics:     recorder,
	})

	limited := []string{
		"/api/v1/chat/sessions/" + uuid.NewString() + "/messages",
		"/api/v1/chat/sessions/" + uuid.NewString() + "/messages/stream",
		"/api/v1/chat/sessions/" + uuid.NewString() + "/messages/" + uuid.NewString() + "/regenerate",
	}
	for _, path := range limited {
		t.Run(path, func(t *testing.T) {
			userID := uuid.New()
			token, err := auth.GenerateToken(cfg, userID, "user")
			if err != nil {
				t.Fatalf("generate token: %v", err)
			}
			first := authenticatedPost(t, r, path, token, `{}`)
			if first.Code == http.StatusTooManyRequests {
				t.Fatal("first request was limited")
			}
			second := authenticatedPost(t, r, path, token, `{}`)
			assertRateLimitedResponse(t, second, "60")
		})
	}

	userID := uuid.New()
	token, err := auth.GenerateToken(cfg, userID, "user")
	if err != nil {
		t.Fatalf("generate unrestricted token: %v", err)
	}
	first := authenticatedPost(t, r, "/api/v1/chat/sessions", token, `{}`)
	second := authenticatedPost(t, r, "/api/v1/chat/sessions", token, `{}`)
	if first.Code == http.StatusTooManyRequests || second.Code == http.StatusTooManyRequests {
		t.Fatalf("session creation must remain outside chat generation limit: first=%d second=%d", first.Code, second.Code)
	}
	if got := recorder.Snapshot().RateLimitTriggers[observability.RateLimitScopeChat]; got != uint64(len(limited)) {
		t.Fatalf("expected %d chat rate-limit triggers, got %d", len(limited), got)
	}
}

func rateLimitRouterConfig() config.Config {
	return config.Config{
		AppEnv:                  "test",
		JWTSecret:               "this-is-a-long-router-test-secret-1234",
		JWTExpiresIn:            "1h",
		RateLimitEnabled:        true,
		RateLimitLoginPerMinute: 10,
		RateLimitChatPerMinute:  30,
		RateLimitFailureMode:    "open",
		EmbeddingCacheTTL:       24 * time.Hour,
	}
}

func authenticatedPost(t *testing.T, handler http.Handler, path, token, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec
}

func assertRateLimitedResponse(t *testing.T, recorder *httptest.ResponseRecorder, retryAfter string) {
	t.Helper()
	if recorder.Code != http.StatusTooManyRequests {
		t.Fatalf("expected status 429, got %d: %s", recorder.Code, recorder.Body.String())
	}
	if got := recorder.Header().Get("Retry-After"); got != retryAfter {
		t.Fatalf("expected Retry-After %q, got %q", retryAfter, got)
	}
	var payload struct {
		Code    string         `json:"code"`
		Details map[string]any `json:"details"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode rate-limit response: %v", err)
	}
	if payload.Code != "RATE_LIMITED" || payload.Details["retryAfter"] == nil {
		t.Fatalf("unexpected rate-limit payload: %#v", payload)
	}
}
