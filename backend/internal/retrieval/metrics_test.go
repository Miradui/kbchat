package retrieval

import (
	"context"
	"errors"
	"syscall"
	"testing"

	"github.com/google/uuid"

	"kbchat/backend/internal/config"
	"kbchat/backend/internal/dto"
	"kbchat/backend/internal/model"
	"kbchat/backend/internal/observability"
	"kbchat/backend/internal/repository"
	"kbchat/backend/internal/rerank"
)

func recordedSearchResults() []repository.SearchResult {
	score := 0.9
	return []repository.SearchResult{{
		ChunkID:     uuid.New(),
		DocumentID:  uuid.New(),
		Filename:    "manual.md",
		Content:     "退货政策正文",
		VectorScore: score,
	}}
}

func TestSearchRecordsRetrievalEmbeddingAndRerankTimings(t *testing.T) {
	candidates := recordedSearchResults()
	rerankResults := []rerank.Result{{ID: candidates[0].ChunkID.String(), Score: 0.8}}
	service, _ := newTestService(
		config.Config{VectorTopN: 30, RerankTopK: 5, RerankEnabled: true},
		candidates,
		rerankResults,
		nil,
	)
	recorder := observability.NewRecorder()
	service.SetRecorder(recorder)

	if _, err := service.Search(context.Background(), uuid.New(), uuid.New(), dto.SearchRequest{Query: "退货"}); err != nil {
		t.Fatalf("search: %v", err)
	}

	snapshot := recorder.Snapshot()
	for _, metric := range []string{observability.MetricRetrieval, observability.MetricEmbedding, observability.MetricRerank} {
		if snapshot.Durations[metric].Count != 1 {
			t.Fatalf("expected one %s sample, got %#v", metric, snapshot.Durations[metric])
		}
	}
	if snapshot.Providers[observability.ProviderEmbedding].SuccessCount != 1 {
		t.Fatalf("unexpected embedding provider stats: %#v", snapshot.Providers[observability.ProviderEmbedding])
	}
	if snapshot.Providers[observability.ProviderRerank].SuccessCount != 1 {
		t.Fatalf("unexpected rerank provider stats: %#v", snapshot.Providers[observability.ProviderRerank])
	}
	if len(snapshot.RerankFallbacks) != 0 {
		t.Fatalf("a successful rerank must not count as a fallback, got %#v", snapshot.RerankFallbacks)
	}
}

// Degraded retrieval is the case the roadmap calls out explicitly, and it is
// invisible today because the fallback is computed per request and never counted.
func TestSearchRecordsRerankFallbackAndClassifiesTheProviderFailure(t *testing.T) {
	service, _ := newTestService(
		config.Config{VectorTopN: 30, RerankTopK: 5, RerankEnabled: true, RerankFailureMode: "fallback"},
		recordedSearchResults(),
		nil,
		syscall.ECONNREFUSED,
	)
	recorder := observability.NewRecorder()
	service.SetRecorder(recorder)

	res, err := service.Search(context.Background(), uuid.New(), uuid.New(), dto.SearchRequest{Query: "退货"})
	if err != nil {
		t.Fatalf("fallback mode must not fail the search: %v", err)
	}
	if res.RerankFallback == nil || !res.RerankFallback.Used {
		t.Fatalf("expected the response to report a fallback, got %#v", res.RerankFallback)
	}

	snapshot := recorder.Snapshot()
	if snapshot.RerankFallbacks["provider_unavailable"] != 1 {
		t.Fatalf("expected one counted fallback, got %#v", snapshot.RerankFallbacks)
	}
	rerankStats := snapshot.Providers[observability.ProviderRerank]
	if rerankStats.FailureCount != 1 || rerankStats.LastFailureReason != observability.ReasonUnreachable {
		t.Fatalf("unexpected rerank provider stats: %#v", rerankStats)
	}
	// The rerank call failed, so it has no meaningful duration; retrieval as a
	// whole still completed and must be timed.
	if _, ok := snapshot.Durations[observability.MetricRerank]; ok {
		t.Fatalf("a failed rerank must not contribute a duration sample")
	}
	if snapshot.Durations[observability.MetricRetrieval].Count != 1 {
		t.Fatalf("expected retrieval to be timed through the fallback path, got %#v", snapshot.Durations[observability.MetricRetrieval])
	}
}

func TestSearchRecordsEmbeddingFailureAndSkipsLaterMetrics(t *testing.T) {
	chunks := &fakeChunkStore{candidates: recordedSearchResults()}
	kbs := &fakeKnowledgeBaseStore{kb: &model.KnowledgeBase{ID: uuid.New(), OwnerID: uuid.New()}}
	reranker := &fakeReranker{}
	service := NewService(
		config.Config{VectorTopN: 30, RerankTopK: 5, RerankEnabled: true},
		chunks,
		kbs,
		fakeEmbedder{err: errors.New("embedding exploded")},
		reranker,
	)
	recorder := observability.NewRecorder()
	service.SetRecorder(recorder)

	if _, err := service.Search(context.Background(), uuid.New(), uuid.New(), dto.SearchRequest{Query: "退货"}); err == nil {
		t.Fatalf("expected the search to fail")
	}

	snapshot := recorder.Snapshot()
	embedding := snapshot.Providers[observability.ProviderEmbedding]
	if embedding.FailureCount != 1 || embedding.LastFailureReason != observability.ReasonUnavailable {
		t.Fatalf("unexpected embedding provider stats: %#v", embedding)
	}
	if _, ok := snapshot.Durations[observability.MetricEmbedding]; ok {
		t.Fatalf("a failed embedding call must not contribute a duration sample")
	}
	if _, ok := snapshot.Durations[observability.MetricRetrieval]; ok {
		t.Fatalf("retrieval that never completed must not be timed")
	}
}

// An unset recorder is the state of every existing caller, so the instrumented
// path has to behave exactly as before.
func TestSearchWorksWithoutARecorder(t *testing.T) {
	candidates := recordedSearchResults()
	service, _ := newTestService(
		config.Config{VectorTopN: 30, RerankTopK: 5, RerankEnabled: true},
		candidates,
		[]rerank.Result{{ID: candidates[0].ChunkID.String(), Score: 0.8}},
		nil,
	)

	if _, err := service.Search(context.Background(), uuid.New(), uuid.New(), dto.SearchRequest{Query: "退货"}); err != nil {
		t.Fatalf("search without recorder: %v", err)
	}
}
