package middleware

import (
	"errors"
	"fmt"
	"math"
	"net"
	"net/http"
	"net/netip"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"go.uber.org/zap"

	"kbchat/backend/internal/cache"
)

const (
	RateLimitScopeLogin = "login"
	RateLimitScopeChat  = "chat"
)

type RateLimitFailureMode string

const (
	RateLimitFailureModeOpen   RateLimitFailureMode = "open"
	RateLimitFailureModeClosed RateLimitFailureMode = "closed"
)

type RateLimitKeyFunc func(c *gin.Context) (string, error)

type RateLimitRecorder interface {
	RecordRateLimitTrigger(scope string)
}

type RateLimitOptions struct {
	Scope       string
	Limit       int
	Window      time.Duration
	FailureMode RateLimitFailureMode
	Key         RateLimitKeyFunc
	Logger      *zap.Logger
	Recorder    RateLimitRecorder
}

// NormalizeRateLimitFailureMode applies the documented fail-open default.
func NormalizeRateLimitFailureMode(value string) RateLimitFailureMode {
	if strings.EqualFold(strings.TrimSpace(value), string(RateLimitFailureModeClosed)) {
		return RateLimitFailureModeClosed
	}
	return RateLimitFailureModeOpen
}

// RateLimit builds middleware for either an unauthenticated key (such as the
// resolved client IP) or an authenticated key (such as CurrentUserKey).
func RateLimit(limiter cache.RateLimiter, options RateLimitOptions) gin.HandlerFunc {
	return func(c *gin.Context) {
		key, err := resolveRateLimitKey(c, options.Key)
		if err == nil && limiter == nil {
			err = errors.New("rate limiter is not configured")
		}

		var result cache.RateLimitResult
		if err == nil {
			result, err = limiter.Allow(c.Request.Context(), options.Scope, key, options.Limit, options.Window)
		}
		if err != nil {
			logRateLimitFailure(options.Logger, options.Scope, err, options.FailureMode)
			if options.FailureMode == RateLimitFailureModeClosed {
				rejectRateLimiterUnavailable(c)
				return
			}
			c.Next()
			return
		}

		if !result.Allowed {
			rejectRateLimited(c, options.Scope, retryAfterSeconds(result.RetryAfter), options.Recorder)
			return
		}

		c.Next()
	}
}

func CurrentUserKey(c *gin.Context) (string, error) {
	userID, ok := CurrentUserID(c)
	if !ok || userID == uuid.Nil {
		return "", errors.New("current user is not available for rate limiting")
	}
	return userID.String(), nil
}

func resolveRateLimitKey(c *gin.Context, keyFunc RateLimitKeyFunc) (string, error) {
	if keyFunc == nil {
		return "", errors.New("rate limit key resolver is not configured")
	}
	key, err := keyFunc(c)
	if err != nil {
		return "", fmt.Errorf("resolve rate limit key: %w", err)
	}
	key = strings.TrimSpace(key)
	if key == "" {
		return "", errors.New("resolve rate limit key: empty key")
	}
	return key, nil
}

func rejectRateLimited(c *gin.Context, scope string, retryAfter int, recorder RateLimitRecorder) {
	if retryAfter < 1 {
		retryAfter = 1
	}
	if recorder != nil {
		recorder.RecordRateLimitTrigger(scope)
	}
	c.Header("Retry-After", strconv.Itoa(retryAfter))
	c.AbortWithStatusJSON(http.StatusTooManyRequests, gin.H{
		"code":    "RATE_LIMITED",
		"message": "请求过于频繁，请稍后重试",
		"details": gin.H{"retryAfter": retryAfter},
	})
}

func rejectRateLimiterUnavailable(c *gin.Context) {
	c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{
		"code":    "RATE_LIMIT_UNAVAILABLE",
		"message": "请求频率校验暂时不可用，请稍后重试",
		"details": gin.H{},
	})
}

func retryAfterSeconds(duration time.Duration) int {
	seconds := int(math.Ceil(duration.Seconds()))
	if seconds < 1 {
		return 1
	}
	return seconds
}

func logRateLimitFailure(logger *zap.Logger, scope string, err error, mode RateLimitFailureMode) {
	if logger == nil {
		return
	}
	logger.Warn("rate limiter unavailable",
		zap.String("scope", scope),
		zap.String("failure_mode", string(mode)),
		zap.Error(err),
	)
}

// ClientIPResolver trusts X-Forwarded-For only when the direct network peer is
// in a configured proxy CIDR. It then walks the proxy chain from right to left,
// stopping at the first untrusted address so a client-supplied leftmost value
// cannot override the address appended by a trusted proxy.
type ClientIPResolver struct {
	trustedProxyCIDRs []netip.Prefix
}

func NewClientIPResolver(cidrs []string) (*ClientIPResolver, error) {
	resolver := &ClientIPResolver{trustedProxyCIDRs: make([]netip.Prefix, 0, len(cidrs))}
	for _, raw := range cidrs {
		raw = strings.TrimSpace(raw)
		if raw == "" {
			continue
		}
		prefix, err := netip.ParsePrefix(raw)
		if err != nil {
			return nil, fmt.Errorf("parse trusted proxy CIDR %q: %w", raw, err)
		}
		resolver.trustedProxyCIDRs = append(resolver.trustedProxyCIDRs, prefix.Masked())
	}
	return resolver, nil
}

func (r *ClientIPResolver) Key(c *gin.Context) (string, error) {
	return r.Resolve(c.Request)
}

func (r *ClientIPResolver) Resolve(request *http.Request) (string, error) {
	if request == nil {
		return "", errors.New("request is nil")
	}

	peer, err := parseIP(request.RemoteAddr)
	if err != nil {
		return "", fmt.Errorf("parse remote address: %w", err)
	}
	if r == nil || !r.isTrusted(peer) {
		return peer.String(), nil
	}

	forwarded, valid := parseXForwardedFor(request.Header.Values("X-Forwarded-For"))
	if !valid || len(forwarded) == 0 {
		return peer.String(), nil
	}
	for index := len(forwarded) - 1; index >= 0; index-- {
		if !r.isTrusted(forwarded[index]) {
			return forwarded[index].String(), nil
		}
	}
	return forwarded[0].String(), nil
}

func (r *ClientIPResolver) isTrusted(address netip.Addr) bool {
	address = address.Unmap()
	for _, prefix := range r.trustedProxyCIDRs {
		candidate := address
		if prefix.Addr().Is4() {
			candidate = address.Unmap()
		}
		if prefix.Contains(candidate) {
			return true
		}
	}
	return false
}

func parseXForwardedFor(headerValues []string) ([]netip.Addr, bool) {
	if len(headerValues) == 0 {
		return nil, true
	}
	parts := strings.Split(strings.Join(headerValues, ","), ",")
	addresses := make([]netip.Addr, 0, len(parts))
	for _, part := range parts {
		address, err := parseIP(strings.TrimSpace(part))
		if err != nil {
			return nil, false
		}
		addresses = append(addresses, address)
	}
	return addresses, true
}

func parseIP(value string) (netip.Addr, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return netip.Addr{}, errors.New("address is empty")
	}

	if address, err := netip.ParseAddr(value); err == nil {
		return address.Unmap(), nil
	}
	if host, _, err := net.SplitHostPort(value); err == nil {
		address, parseErr := netip.ParseAddr(strings.Trim(host, "[]"))
		if parseErr == nil {
			return address.Unmap(), nil
		}
	}
	if strings.HasPrefix(value, "[") && strings.HasSuffix(value, "]") {
		if address, err := netip.ParseAddr(strings.Trim(value, "[]")); err == nil {
			return address.Unmap(), nil
		}
	}
	return netip.Addr{}, fmt.Errorf("%q is not an IP address", value)
}
