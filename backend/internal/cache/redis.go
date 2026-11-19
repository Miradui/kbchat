package cache

import (
	"context"
	"time"

	"github.com/redis/go-redis/extra/redisotel/v9"
	"github.com/redis/go-redis/v9"

	"kbchat/backend/internal/config"
)

func Open(cfg config.Config) *redis.Client {
	timeout, cooldown := cfg.RedisOperationTimeout, cfg.RedisFailureCooldown
	if timeout <= 0 {
		timeout = config.DefaultRedisOperationTimeout
	}
	if cooldown <= 0 {
		cooldown = config.DefaultRedisFailureCooldown
	}
	client := redis.NewClient(&redis.Options{
		Addr:                  cfg.RedisAddr,
		Password:              cfg.RedisPassword,
		DB:                    cfg.RedisDB,
		MaxRetries:            -1,
		DialerRetries:         1,
		DialTimeout:           timeout,
		ReadTimeout:           timeout,
		WriteTimeout:          timeout,
		PoolTimeout:           timeout,
		ContextTimeoutEnabled: true,
	})
	client.AddHook(&redisGuard{timeout: timeout, cooldown: cooldown, now: time.Now})
	// The concrete client is supported by redisotel; command values stay private.
	_ = redisotel.InstrumentTracing(client, redisotel.WithDBStatement(false))
	return client
}

func Ping(ctx context.Context, client *redis.Client) error {
	return client.Ping(ctx).Err()
}
