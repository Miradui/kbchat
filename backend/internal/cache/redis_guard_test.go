package cache

import (
	"context"
	"errors"
	"io"
	"net"
	"sync"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"

	"kbchat/backend/internal/config"
)

func TestRedisGuardBoundsSilentServerAndSkipsOtherConsumers(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	stop := make(chan struct{})
	var workers sync.WaitGroup
	workers.Add(1)
	go func() {
		defer workers.Done()
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			workers.Add(1)
			go func() { defer workers.Done(); defer conn.Close(); <-stop }()
		}
	}()
	t.Cleanup(func() { listener.Close(); close(stop); workers.Wait() })
	client := Open(config.Config{RedisAddr: listener.Addr().String(), RedisOperationTimeout: 50 * time.Millisecond})
	t.Cleanup(func() { client.Close() })
	ec := NewEmbeddingCache(client)
	start := time.Now()
	if _, _, err := ec.Get(context.Background(), "model", "query"); err == nil {
		t.Fatal("silent server should time out")
	}
	if elapsed := time.Since(start); elapsed > 500*time.Millisecond {
		t.Fatalf("silent server blocked for %s", elapsed)
	}
	if err := ec.Set(context.Background(), "model", "query", []float32{1}, time.Minute); !errors.Is(err, ErrRedisCoolingDown) {
		t.Fatalf("cache write retried during outage: %v", err)
	}
	if _, err := NewFixedWindowRateLimiter(client).Allow(context.Background(), "login", "user", 1, time.Minute); !errors.Is(err, ErrRedisCoolingDown) {
		t.Fatalf("limiter did not share cooldown: %v", err)
	}
	if err := Ping(context.Background(), client); !errors.Is(err, ErrRedisCoolingDown) {
		t.Fatalf("health probe bypassed cooldown: %v", err)
	}
}

func TestRedisGuardRecoverySupportsHandshakeCacheAndLua(t *testing.T) {
	server := miniredis.RunT(t)
	client := Open(config.Config{RedisAddr: server.Addr(), RedisOperationTimeout: 200 * time.Millisecond, RedisFailureCooldown: 30 * time.Millisecond})
	t.Cleanup(func() { client.Close() })
	ec := NewEmbeddingCache(client)
	if _, hit, err := ec.Get(context.Background(), "m", "q"); err != nil || hit {
		t.Fatalf("cache miss: hit=%v err=%v", hit, err)
	}
	limiter := NewFixedWindowRateLimiter(client)
	if result, err := limiter.Allow(context.Background(), "login", "u", 1, time.Minute); err != nil || !result.Allowed {
		t.Fatalf("Lua NOSCRIPT fallback failed: %+v %v", result, err)
	}
	server.Close()
	if err := Ping(context.Background(), client); err == nil {
		t.Fatal("expected connection failure")
	}
	if err := server.Restart(); err != nil {
		t.Fatal(err)
	}
	if err := Ping(context.Background(), client); !errors.Is(err, ErrRedisCoolingDown) {
		t.Fatalf("expected cooldown before recovery: %v", err)
	}
	time.Sleep(40 * time.Millisecond)
	if err := Ping(context.Background(), client); err != nil {
		t.Fatalf("recovery handshake failed: %v", err)
	}
	if err := ec.Set(context.Background(), "m", "q", []float32{1}, time.Minute); err != nil {
		t.Fatal(err)
	}
	if _, hit, err := ec.Get(context.Background(), "m", "q"); err != nil || !hit {
		t.Fatalf("cache did not recover: hit=%v err=%v", hit, err)
	}
	if result, err := limiter.Allow(context.Background(), "chat", "u", 1, time.Minute); err != nil || !result.Allowed {
		t.Fatalf("limiter did not recover: %+v %v", result, err)
	}
	if result, err := limiter.Allow(context.Background(), "chat", "u", 1, time.Minute); err != nil || result.Allowed || result.RetryAfter <= 0 {
		t.Fatalf("limit not enforced after recovery: %+v %v", result, err)
	}
}

func TestRedisGuardAllowsOnlyOneRecoveryProbeAndIgnoresLateSuccess(t *testing.T) {
	now := time.Now()
	g := &redisGuard{timeout: time.Second, cooldown: time.Second, now: func() time.Time { return now }}
	started, release, done := make(chan struct{}), make(chan struct{}), make(chan error, 1)
	go func() {
		done <- g.run(context.Background(), func(context.Context) error { close(started); <-release; return nil })
	}()
	<-started
	_ = g.run(context.Background(), func(context.Context) error { return io.EOF })
	close(release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if err := g.run(context.Background(), func(context.Context) error { t.Error("late success reopened circuit"); return nil }); !errors.Is(err, ErrRedisCoolingDown) {
		t.Fatal(err)
	}
	now = now.Add(time.Second)
	started, release = make(chan struct{}), make(chan struct{})
	go func() {
		done <- g.run(context.Background(), func(context.Context) error { close(started); <-release; return nil })
	}()
	<-started
	var contenders sync.WaitGroup
	for i := 0; i < 20; i++ {
		contenders.Add(1)
		go func() {
			defer contenders.Done()
			if err := g.run(context.Background(), func(context.Context) error { t.Error("concurrent recovery probe"); return nil }); !errors.Is(err, ErrRedisCoolingDown) {
				t.Error(err)
			}
		}()
	}
	contenders.Wait()
	close(release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if err := g.run(context.Background(), func(context.Context) error { return nil }); err != nil {
		t.Fatalf("successful probe did not reopen: %v", err)
	}
}

func TestRedisGuardCancellationAndRedisRepliesDoNotPoisonClient(t *testing.T) {
	g := &redisGuard{timeout: time.Second, cooldown: time.Second, now: time.Now}
	ctx, cancel := context.WithCancel(context.Background())
	err := g.run(ctx, func(ctx context.Context) error { cancel(); return ctx.Err() })
	if !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	for _, reply := range []error{redis.Nil, redis.ErrNoScript, nil} {
		if err := g.run(context.Background(), func(context.Context) error { return reply }); err != reply {
			t.Fatalf("ordinary reply poisoned client: %v", err)
		}
	}
}
