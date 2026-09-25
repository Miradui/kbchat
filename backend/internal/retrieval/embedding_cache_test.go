package retrieval

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	miniredis "github.com/alicebob/miniredis/v2"
	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"

	cachepkg "kbchat/backend/internal/cache"
	"kbchat/backend/internal/config"
	"kbchat/backend/internal/dto"
	"kbchat/backend/internal/model"
	"kbchat/backend/internal/observability"
	"kbchat/backend/internal/repository"
)

type countingEmbedder struct {
	calls  int
	texts  [][]string
	vector []float32
	err    error
}

func (f *countingEmbedder) EmbedTexts(_ context.Context, texts []string) ([][]float32, error) {
	f.calls++
	f.texts = append(f.texts, append([]string(nil), texts...))
	if f.err != nil {
		return nil, f.err
	}
	return [][]float32{append([]float32(nil), f.vector...)}, nil
}

type fakeEmbeddingCache struct {
	vector    []float32
	hit       bool
	getErr    error
	setErr    error
	getModel  string
	getQuery  string
	setModel  string
	setQuery  string
	setVector []float32
	setTTL    time.Duration
	setCalls  int
}

func (f *fakeEmbeddingCache) Get(_ context.Context, model, query string) ([]float32, bool, error) {
	f.getModel = model
	f.getQuery = query
	return append([]float32(nil), f.vector...), f.hit, f.getErr
}

func (f *fakeEmbeddingCache) Set(_ context.Context, model, query string, vector []float32, ttl time.Duration) error {
	f.setCalls++
	f.setModel = model
	f.setQuery = query
	f.setVector = append([]float32(nil), vector...)
	f.setTTL = ttl
	return f.setErr
}

func newEmbeddingCacheTestService(embedder *countingEmbedder, embeddingCache queryEmbeddingCache, recorder *observability.Recorder) *Service {
	kbID := uuid.New()
	service := NewService(
		config.Config{
			EmbeddingModel:    "embedding-model",
			EmbeddingCacheTTL: 24 * time.Hour,
			VectorTopN:        30,
			RerankTopK:        5,
		},
		&fakeChunkStore{candidates: []repository.SearchResult{searchResult(uuid.New(), 0.9)}},
		&fakeKnowledgeBaseStore{memberRole: "viewer", kb: &model.KnowledgeBase{ID: kbID, OwnerID: uuid.New()}},
		embedder,
		&fakeReranker{},
	)
	service.SetEmbeddingCache(embeddingCache)
	service.SetRecorder(recorder)
	return service
}

func TestSearchEmbeddingCacheHitSkipsProvider(t *testing.T) {
	embedder := &countingEmbedder{vector: []float32{9, 9, 9}}
	embeddingCache := &fakeEmbeddingCache{hit: true, vector: []float32{0.1, 0.2, 0.3}}
	recorder := observability.NewRecorder()
	service := newEmbeddingCacheTestService(embedder, embeddingCache, recorder)

	if _, err := service.Search(context.Background(), uuid.New(), uuid.New(), dto.SearchRequest{Query: "  退款\n政策  "}); err != nil {
		t.Fatalf("search: %v", err)
	}
	if embedder.calls != 0 {
		t.Fatalf("expected cache hit to skip provider, got %d calls", embedder.calls)
	}
	// The key namespaces by model, dimension and endpoint so a configuration
	// change cannot serve vectors from the previous setup.
	if embeddingCache.getQuery != "退款 政策" || !strings.HasPrefix(embeddingCache.getModel, "embedding-model:0:") {
		t.Fatalf("unexpected cache lookup model=%q query=%q", embeddingCache.getModel, embeddingCache.getQuery)
	}
	snapshot := recorder.Snapshot()
	if snapshot.EmbeddingCacheResult.Hits != 1 {
		t.Fatalf("expected one cache hit, got %#v", snapshot.EmbeddingCacheResult)
	}
	if _, ok := snapshot.Providers[observability.ProviderEmbedding]; ok {
		t.Fatalf("cache hit must not count as an embedding provider call")
	}
}

func TestSearchEmbeddingCacheMissCallsProviderAndWritesValue(t *testing.T) {
	embedder := &countingEmbedder{vector: []float32{0.4, 0.5}}
	embeddingCache := &fakeEmbeddingCache{}
	recorder := observability.NewRecorder()
	service := newEmbeddingCacheTestService(embedder, embeddingCache, recorder)

	if _, err := service.Search(context.Background(), uuid.New(), uuid.New(), dto.SearchRequest{Query: "  员工\t 手册 "}); err != nil {
		t.Fatalf("search: %v", err)
	}
	if embedder.calls != 1 || !reflect.DeepEqual(embedder.texts, [][]string{{"员工 手册"}}) {
		t.Fatalf("unexpected provider calls: count=%d texts=%q", embedder.calls, embedder.texts)
	}
	if embeddingCache.setCalls != 1 || embeddingCache.setQuery != "员工 手册" || embeddingCache.setTTL != 24*time.Hour {
		t.Fatalf("unexpected cache write: %#v", embeddingCache)
	}
	if !reflect.DeepEqual(embeddingCache.setVector, embedder.vector) {
		t.Fatalf("expected provider vector to be cached, got %v", embeddingCache.setVector)
	}
	snapshot := recorder.Snapshot()
	if snapshot.EmbeddingCacheResult.Misses != 1 || snapshot.Providers[observability.ProviderEmbedding].SuccessCount != 1 {
		t.Fatalf("unexpected cache/provider metrics: cache=%#v provider=%#v", snapshot.EmbeddingCacheResult, snapshot.Providers[observability.ProviderEmbedding])
	}
}

func TestSearchEmbeddingCacheFailureFallsBackToProvider(t *testing.T) {
	embedder := &countingEmbedder{vector: []float32{0.7}}
	embeddingCache := &fakeEmbeddingCache{getErr: errors.New("redis unavailable"), setErr: errors.New("redis unavailable")}
	recorder := observability.NewRecorder()
	service := newEmbeddingCacheTestService(embedder, embeddingCache, recorder)

	if _, err := service.Search(context.Background(), uuid.New(), uuid.New(), dto.SearchRequest{Query: "policy"}); err != nil {
		t.Fatalf("cache failure must not fail retrieval: %v", err)
	}
	if embedder.calls != 1 {
		t.Fatalf("expected provider fallback, got %d calls", embedder.calls)
	}
	if got := recorder.Snapshot().EmbeddingCacheResult.Errors; got != 2 {
		t.Fatalf("expected failed read and write to be counted, got %d", got)
	}
}

func TestSecondIdenticalSearchUsesRedisEmbeddingCache(t *testing.T) {
	server := miniredis.RunT(t)
	redisClient := redis.NewClient(&redis.Options{Addr: server.Addr()})
	t.Cleanup(func() { _ = redisClient.Close() })
	embedder := &countingEmbedder{vector: []float32{0.2, 0.4, 0.6}}
	recorder := observability.NewRecorder()
	service := newEmbeddingCacheTestService(embedder, cachepkg.NewEmbeddingCache(redisClient), recorder)

	for attempt := 1; attempt <= 2; attempt++ {
		if _, err := service.Search(context.Background(), uuid.New(), uuid.New(), dto.SearchRequest{Query: "  相同\n 问题 "}); err != nil {
			t.Fatalf("search attempt %d: %v", attempt, err)
		}
	}
	if embedder.calls != 1 {
		t.Fatalf("expected the second search to skip the provider, got %d calls", embedder.calls)
	}
	stats := recorder.Snapshot()
	if stats.EmbeddingCacheResult.Misses != 1 || stats.EmbeddingCacheResult.Hits != 1 {
		t.Fatalf("unexpected cache metrics: %#v", stats.EmbeddingCacheResult)
	}
	if stats.Providers[observability.ProviderEmbedding].SuccessCount != 1 {
		t.Fatalf("cache hit must not increment provider metrics: %#v", stats.Providers[observability.ProviderEmbedding])
	}
}
