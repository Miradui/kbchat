package retrieval

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"

	"kbchat/backend/internal/config"
	"kbchat/backend/internal/dto"
	"kbchat/backend/internal/observability"
	"kbchat/backend/internal/repository"
)

func vectorFallbackService(t *testing.T, approximate []repository.SearchResult) (*Service, *fakeChunkStore, *observability.Recorder) {
	t.Helper()
	kb := knowledgeBaseWithRetrievalConfig(t, dto.RetrievalConfig{VectorTopN: 3, RerankTopK: 3})
	service, _, chunks := newTestServiceWithKB(config.Config{VectorTopN: 3, RerankTopK: 3}, kb, approximate, nil, nil)
	recorder := observability.NewRecorder()
	service.SetRecorder(recorder)
	return service, chunks, recorder
}

// An HNSW scan returned one row although the knowledge base holds five: the
// index handed back ef_search neighbours and the filters discarded the rest.
// The stage is rerun exhaustively and the exact rows replace the short ones.
func TestSearchReplacesAShortApproximateResultWithTheExactOne(t *testing.T) {
	near, second, third := uuid.New(), uuid.New(), uuid.New()
	service, chunks, recorder := vectorFallbackService(t, []repository.SearchResult{searchResult(near, 0.9)})
	five := int64(5)
	chunks.searchable = &five
	chunks.exactCandidates = []repository.SearchResult{
		searchResult(near, 0.9), searchResult(second, 0.8), searchResult(third, 0.7), searchResult(uuid.New(), 0.6),
	}

	res, err := service.Search(context.Background(), uuid.New(), uuid.New(), dto.SearchRequest{Query: "policy", Debug: true})
	if err != nil {
		t.Fatalf("search: %v", err)
	}
	if chunks.exactCalls != 1 || chunks.gotExactLimit != 3 {
		t.Fatalf("expected one exact search with limit 3, got %d calls limit %d", chunks.exactCalls, chunks.gotExactLimit)
	}
	if len(res.Items) != 3 || res.Items[0].ChunkID != near.String() || res.Items[1].ChunkID != second.String() || res.Items[2].ChunkID != third.String() {
		t.Fatalf("expected the exact top 3, got %#v", res.Items)
	}
	if res.Debug == nil || !res.Debug.VectorStage.ExactFallback || len(res.Debug.VectorStage.Items) != 3 {
		t.Fatalf("expected the debug vector stage to report the exact fallback, got %#v", res.Debug)
	}
	if got := recorder.Snapshot().VectorExactFallbacks; got != 1 {
		t.Fatalf("expected one recorded fallback, got %d", got)
	}
}

// A knowledge base smaller than vectorTopN legitimately returns fewer rows.
// The count confirms it and no exhaustive search runs.
func TestSearchKeepsAShortResultWhenTheKnowledgeBaseHasNoMore(t *testing.T) {
	service, chunks, recorder := vectorFallbackService(t, []repository.SearchResult{searchResult(uuid.New(), 0.9), searchResult(uuid.New(), 0.8)})

	res, err := service.Search(context.Background(), uuid.New(), uuid.New(), dto.SearchRequest{Query: "policy", Debug: true})
	if err != nil {
		t.Fatalf("search: %v", err)
	}
	if chunks.countCalls != 1 || chunks.exactCalls != 0 {
		t.Fatalf("expected one count and no exact search, got %d counts and %d exact searches", chunks.countCalls, chunks.exactCalls)
	}
	if len(res.Items) != 2 || res.Debug.VectorStage.ExactFallback {
		t.Fatalf("expected the approximate result untouched, got %#v", res)
	}
	if got := recorder.Snapshot().VectorExactFallbacks; got != 0 {
		t.Fatalf("expected no recorded fallback, got %d", got)
	}
}

// A full page cannot be short, so the common path costs no extra query.
func TestSearchSkipsTheCountWhenTheApproximateResultIsFull(t *testing.T) {
	service, chunks, _ := vectorFallbackService(t, []repository.SearchResult{
		searchResult(uuid.New(), 0.9), searchResult(uuid.New(), 0.8), searchResult(uuid.New(), 0.7),
	})
	if _, err := service.Search(context.Background(), uuid.New(), uuid.New(), dto.SearchRequest{Query: "policy"}); err != nil {
		t.Fatalf("search: %v", err)
	}
	if chunks.countCalls != 0 || chunks.exactCalls != 0 {
		t.Fatalf("expected no count or exact search, got %d counts and %d exact searches", chunks.countCalls, chunks.exactCalls)
	}
}

// An empty approximate result is the worst case of the shortfall, not a reason
// to skip the check.
func TestSearchRecoversAnEmptyApproximateResult(t *testing.T) {
	only := uuid.New()
	service, chunks, _ := vectorFallbackService(t, nil)
	one := int64(1)
	chunks.searchable = &one
	chunks.exactCandidates = []repository.SearchResult{searchResult(only, 0.9)}

	res, err := service.Search(context.Background(), uuid.New(), uuid.New(), dto.SearchRequest{Query: "policy"})
	if err != nil {
		t.Fatalf("search: %v", err)
	}
	if len(res.Items) != 1 || res.Items[0].ChunkID != only.String() {
		t.Fatalf("expected the exact row, got %#v", res.Items)
	}
}

func TestSearchFailsWhenTheFallbackQueriesFail(t *testing.T) {
	service, chunks, _ := vectorFallbackService(t, nil)
	chunks.countErr = errors.New("count exploded")
	if _, err := service.Search(context.Background(), uuid.New(), uuid.New(), dto.SearchRequest{Query: "policy"}); err == nil {
		t.Fatal("expected a count failure to fail the search")
	}

	service, chunks, _ = vectorFallbackService(t, nil)
	one := int64(1)
	chunks.searchable = &one
	chunks.exactErr = errors.New("exact exploded")
	if _, err := service.Search(context.Background(), uuid.New(), uuid.New(), dto.SearchRequest{Query: "policy"}); err == nil {
		t.Fatal("expected an exact search failure to fail the search")
	}
}
