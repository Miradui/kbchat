package cache

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

const embeddingVectorEncodingVersion byte = 1

// EmbeddingCache stores query vectors in Redis. Values use a small versioned
// binary envelope so float32 values make a lossless round trip without the
// allocation and precision ambiguity of JSON.
type EmbeddingCache struct {
	client *redis.Client
}

func NewEmbeddingCache(client *redis.Client) *EmbeddingCache {
	return &EmbeddingCache{client: client}
}

// Get returns (nil, false, nil) for a cache miss. Corrupt or unsupported values
// are errors and callers should fall back to the provider rather than use them.
func (c *EmbeddingCache) Get(ctx context.Context, model, query string) ([]float32, bool, error) {
	if c == nil || c.client == nil {
		return nil, false, errors.New("embedding cache is not configured")
	}
	value, err := c.client.Get(ctx, embeddingCacheKey(model, query)).Bytes()
	if errors.Is(err, redis.Nil) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	vector, err := decodeEmbeddingVector(value)
	if err != nil {
		return nil, false, err
	}
	return vector, true, nil
}

func (c *EmbeddingCache) Set(ctx context.Context, model, query string, vector []float32, ttl time.Duration) error {
	if c == nil || c.client == nil {
		return errors.New("embedding cache is not configured")
	}
	if ttl <= 0 {
		return errors.New("embedding cache TTL must be greater than zero")
	}
	value, err := encodeEmbeddingVector(vector)
	if err != nil {
		return err
	}
	return c.client.Set(ctx, embeddingCacheKey(model, query), value, ttl).Err()
}

func embeddingCacheKey(model, query string) string {
	digest := sha256.Sum256([]byte(NormalizeEmbeddingQuery(query)))
	return "embed:" + strings.TrimSpace(model) + ":" + hex.EncodeToString(digest[:])
}

// NormalizeEmbeddingQuery removes differences caused solely by surrounding or
// repeated Unicode whitespace. Retrieval embeds this same normalized value, so
// two queries that share a key always share the vector the key represents.
func NormalizeEmbeddingQuery(query string) string {
	return strings.Join(strings.Fields(query), " ")
}

func encodeEmbeddingVector(vector []float32) ([]byte, error) {
	if len(vector) == 0 {
		return nil, errors.New("embedding vector is empty")
	}
	value := make([]byte, 5+len(vector)*4)
	value[0] = embeddingVectorEncodingVersion
	binary.LittleEndian.PutUint32(value[1:5], uint32(len(vector)))
	for i, item := range vector {
		binary.LittleEndian.PutUint32(value[5+i*4:], math.Float32bits(item))
	}
	return value, nil
}

func decodeEmbeddingVector(value []byte) ([]float32, error) {
	if len(value) < 5 {
		return nil, errors.New("embedding cache value is truncated")
	}
	if value[0] != embeddingVectorEncodingVersion {
		return nil, fmt.Errorf("unsupported embedding cache version %d", value[0])
	}
	count := uint64(binary.LittleEndian.Uint32(value[1:5]))
	expected := uint64(5) + count*4
	if count == 0 || expected != uint64(len(value)) {
		return nil, errors.New("embedding cache value has invalid length")
	}
	vector := make([]float32, int(count))
	for i := range vector {
		vector[i] = math.Float32frombits(binary.LittleEndian.Uint32(value[5+i*4:]))
	}
	return vector, nil
}
