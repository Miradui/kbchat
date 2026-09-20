package cache

import (
	"context"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

var errInvalidRateLimit = errors.New("invalid rate limit configuration")

// RateLimitResult describes the decision made for one fixed-window counter.
// RetryAfter is only populated when the request is rejected.
type RateLimitResult struct {
	Allowed    bool
	RetryAfter time.Duration
	Count      int64
}

// RateLimiter is the small interface consumed by HTTP middleware. Keeping the
// Redis implementation behind it makes the failure policy independently
// testable and keeps callers from depending on go-redis command types.
type RateLimiter interface {
	Allow(ctx context.Context, scope, key string, limit int, window time.Duration) (RateLimitResult, error)
}

// FixedWindowRateLimiter stores counters in Redis. The Lua script makes the
// first INCR and its EXPIRE one atomic operation, so a process interruption
// cannot leave a counter without a window.
type FixedWindowRateLimiter struct {
	client redis.Scripter
}

var fixedWindowScript = redis.NewScript(`
local count = redis.call("INCR", KEYS[1])
local window = tonumber(ARGV[1])

if count == 1 then
  redis.call("EXPIRE", KEYS[1], window)
end

local ttl = redis.call("TTL", KEYS[1])
if ttl < 0 then
  redis.call("EXPIRE", KEYS[1], window)
  ttl = window
end

return {count, ttl}
`)

func NewFixedWindowRateLimiter(client *redis.Client) *FixedWindowRateLimiter {
	if client == nil {
		return &FixedWindowRateLimiter{}
	}
	return &FixedWindowRateLimiter{client: client}
}

func (l *FixedWindowRateLimiter) Allow(
	ctx context.Context,
	scope string,
	key string,
	limit int,
	window time.Duration,
) (RateLimitResult, error) {
	if l == nil || l.client == nil {
		return RateLimitResult{}, errors.New("rate limiter Redis client is not configured")
	}

	scope = strings.TrimSpace(scope)
	key = strings.TrimSpace(key)
	if scope == "" || key == "" || limit <= 0 || window <= 0 {
		return RateLimitResult{}, fmt.Errorf(
			"%w: scope and key must be non-empty, limit and window must be positive",
			errInvalidRateLimit,
		)
	}

	windowSeconds := int64(math.Ceil(window.Seconds()))
	if windowSeconds < 1 {
		windowSeconds = 1
	}

	values, err := fixedWindowScript.Run(
		ctx,
		l.client,
		[]string{rateLimitKey(scope, key)},
		windowSeconds,
	).Int64Slice()
	if err != nil {
		return RateLimitResult{}, fmt.Errorf("increment rate limit counter: %w", err)
	}
	if len(values) != 2 {
		return RateLimitResult{}, fmt.Errorf("increment rate limit counter: unexpected Lua result length %d", len(values))
	}

	count, ttlSeconds := values[0], values[1]
	result := RateLimitResult{Allowed: count <= int64(limit), Count: count}
	if !result.Allowed {
		if ttlSeconds < 1 {
			ttlSeconds = 1
		}
		result.RetryAfter = time.Duration(ttlSeconds) * time.Second
	}
	return result, nil
}

func rateLimitKey(scope, key string) string {
	return "ratelimit:" + scope + ":" + key
}
