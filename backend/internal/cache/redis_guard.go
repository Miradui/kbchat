package cache

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

// ErrRedisCoolingDown is returned without contacting Redis after a connection
// failure. Consumers retain their existing cache/limiter failure policies.
var ErrRedisCoolingDown = errors.New("redis temporarily unavailable; recovery probe pending")

// One guard belongs to one client, shared by cache, limiter and health probes.
// Only one command probes recovery after the cooldown. Generations prevent a
// late command from closing a circuit opened by a newer failure.
type redisGuard struct {
	timeout, cooldown time.Duration
	now               func() time.Time
	mu                sync.Mutex
	until             time.Time
	probing           bool
	generation        uint64
}

type redisGuardContextKey struct{}

func (g *redisGuard) DialHook(next redis.DialHook) redis.DialHook { return next }

func (g *redisGuard) ProcessHook(next redis.ProcessHook) redis.ProcessHook {
	return func(ctx context.Context, cmd redis.Cmder) error {
		return g.run(ctx, func(ctx context.Context) error { return next(ctx, cmd) })
	}
}

func (g *redisGuard) ProcessPipelineHook(next redis.ProcessPipelineHook) redis.ProcessPipelineHook {
	return func(ctx context.Context, cmds []redis.Cmder) error {
		return g.run(ctx, func(ctx context.Context) error { return next(ctx, cmds) })
	}
}

func (g *redisGuard) run(ctx context.Context, next func(context.Context) error) error {
	// go-redis reuses hooks for HELLO/AUTH/SELECT during connection setup.
	// Those commands share the outer deadline and must not contend for its probe.
	if ctx.Value(redisGuardContextKey{}) == g {
		return next(ctx)
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	g.mu.Lock()
	if g.probing || g.now().Before(g.until) {
		g.mu.Unlock()
		return ErrRedisCoolingDown
	}
	probe := !g.until.IsZero()
	if probe {
		g.probing = true
	}
	generation := g.generation
	g.mu.Unlock()

	opCtx, cancel := context.WithTimeout(context.WithValue(ctx, redisGuardContextKey{}, g), g.timeout)
	defer cancel()
	err := next(opCtx)

	g.mu.Lock()
	defer g.mu.Unlock()
	if generation != g.generation {
		return err
	}
	if ctx.Err() != nil {
		// A canceled caller is not evidence that Redis is unavailable. Release a
		// recovery probe so the next caller can try, without starting a cooldown.
		if probe {
			g.probing = false
		}
		return err
	}
	var serverError redis.Error
	healthy := err == nil || errors.Is(err, redis.Nil) || errors.As(err, &serverError)
	if !healthy {
		g.generation++
		g.until = g.now().Add(g.cooldown)
		g.probing = false
	} else if probe {
		g.generation++
		g.until = time.Time{}
		g.probing = false
	}
	return err
}
