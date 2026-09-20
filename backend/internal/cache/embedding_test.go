package cache

import (
	"context"
	"reflect"
	"testing"
	"time"

	miniredis "github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
)

func TestEmbeddingCacheRoundTripUsesNormalizedQueryAndExpires(t *testing.T) {
	server := miniredis.RunT(t)
	client := redis.NewClient(&redis.Options{Addr: server.Addr()})
	t.Cleanup(func() { _ = client.Close() })
	cache := NewEmbeddingCache(client)
	want := []float32{0.125, -4.5, 100.25}

	if err := cache.Set(context.Background(), "embed-model", "  退款\n  政策 ", want, time.Hour); err != nil {
		t.Fatalf("set cache: %v", err)
	}
	got, hit, err := cache.Get(context.Background(), "embed-model", "退款 政策")
	if err != nil {
		t.Fatalf("get cache: %v", err)
	}
	if !hit || !reflect.DeepEqual(got, want) {
		t.Fatalf("expected exact cached vector %v, got hit=%v vector=%v", want, hit, got)
	}

	server.FastForward(time.Hour)
	if _, hit, err := cache.Get(context.Background(), "embed-model", "退款 政策"); err != nil || hit {
		t.Fatalf("expected expired cache miss, got hit=%v err=%v", hit, err)
	}
}

func TestEmbeddingCacheSeparatesModels(t *testing.T) {
	server := miniredis.RunT(t)
	client := redis.NewClient(&redis.Options{Addr: server.Addr()})
	t.Cleanup(func() { _ = client.Close() })
	cache := NewEmbeddingCache(client)

	if err := cache.Set(context.Background(), "model-a", "same query", []float32{1}, time.Hour); err != nil {
		t.Fatalf("set cache: %v", err)
	}
	if _, hit, err := cache.Get(context.Background(), "model-b", "same query"); err != nil || hit {
		t.Fatalf("expected model-specific miss, got hit=%v err=%v", hit, err)
	}
}

func TestEmbeddingCacheRejectsCorruptValue(t *testing.T) {
	server := miniredis.RunT(t)
	client := redis.NewClient(&redis.Options{Addr: server.Addr()})
	t.Cleanup(func() { _ = client.Close() })
	query := "corrupt"
	if err := client.Set(context.Background(), embeddingCacheKey("model", query), []byte{1, 2, 3}, time.Hour).Err(); err != nil {
		t.Fatalf("seed corrupt value: %v", err)
	}

	if _, hit, err := NewEmbeddingCache(client).Get(context.Background(), "model", query); err == nil || hit {
		t.Fatalf("expected corrupt cache error, got hit=%v err=%v", hit, err)
	}
}
