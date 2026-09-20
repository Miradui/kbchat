package cache

import (
	"context"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
)

func TestFixedWindowRateLimiterRejectsAfterLimit(t *testing.T) {
	server := miniredis.RunT(t)
	client := redis.NewClient(&redis.Options{Addr: server.Addr()})
	t.Cleanup(func() { _ = client.Close() })
	limiter := NewFixedWindowRateLimiter(client)

	first, err := limiter.Allow(context.Background(), "login", "203.0.113.8", 2, time.Minute)
	if err != nil {
		t.Fatalf("first Allow returned error: %v", err)
	}
	if !first.Allowed || first.Count != 1 || first.RetryAfter != 0 {
		t.Fatalf("unexpected first result: %+v", first)
	}

	second, err := limiter.Allow(context.Background(), "login", "203.0.113.8", 2, time.Minute)
	if err != nil {
		t.Fatalf("second Allow returned error: %v", err)
	}
	if !second.Allowed || second.Count != 2 {
		t.Fatalf("unexpected second result: %+v", second)
	}

	third, err := limiter.Allow(context.Background(), "login", "203.0.113.8", 2, time.Minute)
	if err != nil {
		t.Fatalf("third Allow returned error: %v", err)
	}
	if third.Allowed || third.Count != 3 {
		t.Fatalf("unexpected third result: %+v", third)
	}
	if third.RetryAfter != time.Minute {
		t.Fatalf("expected one-minute retry, got %s", third.RetryAfter)
	}

	const redisKey = "ratelimit:login:203.0.113.8"
	if !server.Exists(redisKey) {
		t.Fatalf("expected Redis key %q", redisKey)
	}
	if ttl := server.TTL(redisKey); ttl != time.Minute {
		t.Fatalf("expected one-minute TTL, got %s", ttl)
	}
}

func TestFixedWindowRateLimiterResetsAfterExpiry(t *testing.T) {
	server := miniredis.RunT(t)
	client := redis.NewClient(&redis.Options{Addr: server.Addr()})
	t.Cleanup(func() { _ = client.Close() })
	limiter := NewFixedWindowRateLimiter(client)

	if result, err := limiter.Allow(context.Background(), "chat", "user-1", 1, 30*time.Second); err != nil || !result.Allowed {
		t.Fatalf("expected first request to pass, result=%+v err=%v", result, err)
	}
	server.FastForward(10 * time.Second)
	if result, err := limiter.Allow(context.Background(), "chat", "user-1", 1, 30*time.Second); err != nil || result.Allowed || result.RetryAfter != 20*time.Second {
		t.Fatalf("expected second request to be rejected, result=%+v err=%v", result, err)
	}

	server.FastForward(20 * time.Second)

	result, err := limiter.Allow(context.Background(), "chat", "user-1", 1, 30*time.Second)
	if err != nil {
		t.Fatalf("Allow after expiry returned error: %v", err)
	}
	if !result.Allowed || result.Count != 1 {
		t.Fatalf("expected a fresh window, got %+v", result)
	}
}

func TestNewFixedWindowRateLimiterHandlesNilClient(t *testing.T) {
	limiter := NewFixedWindowRateLimiter(nil)
	if _, err := limiter.Allow(context.Background(), "login", "203.0.113.8", 1, time.Minute); err == nil {
		t.Fatal("expected missing Redis client error")
	}
}

func TestFixedWindowRateLimiterReportsRedisFailure(t *testing.T) {
	server := miniredis.RunT(t)
	client := redis.NewClient(&redis.Options{
		Addr:         server.Addr(),
		MaxRetries:   -1,
		DialTimeout:  50 * time.Millisecond,
		ReadTimeout:  50 * time.Millisecond,
		WriteTimeout: 50 * time.Millisecond,
	})
	t.Cleanup(func() { _ = client.Close() })
	limiter := NewFixedWindowRateLimiter(client)
	server.Close()

	if _, err := limiter.Allow(context.Background(), "login", "203.0.113.8", 2, time.Minute); err == nil {
		t.Fatal("expected Redis failure to be returned")
	}
}

func TestFixedWindowRateLimiterRejectsInvalidInputs(t *testing.T) {
	server := miniredis.RunT(t)
	client := redis.NewClient(&redis.Options{Addr: server.Addr()})
	t.Cleanup(func() { _ = client.Close() })
	limiter := NewFixedWindowRateLimiter(client)

	tests := []struct {
		name   string
		scope  string
		key    string
		limit  int
		window time.Duration
	}{
		{name: "empty scope", key: "key", limit: 1, window: time.Minute},
		{name: "empty key", scope: "login", limit: 1, window: time.Minute},
		{name: "zero limit", scope: "login", key: "key", window: time.Minute},
		{name: "zero window", scope: "login", key: "key", limit: 1},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := limiter.Allow(context.Background(), tt.scope, tt.key, tt.limit, tt.window); err == nil {
				t.Fatal("expected invalid input error")
			}
		})
	}
}
