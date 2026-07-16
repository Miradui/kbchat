package retrieval

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"

	"rag/backend/internal/apperror"
	"rag/backend/internal/config"
	"rag/backend/internal/dto"
	"rag/backend/internal/model"
	"rag/backend/internal/repository"
	"rag/backend/internal/rerank"
)

type fakeKnowledgeBaseStore struct {
	kb  *model.KnowledgeBase
	err error
}

func (f *fakeKnowledgeBaseStore) FindByIDAndOwner(context.Context, uuid.UUID, uuid.UUID) (*model.KnowledgeBase, error) {
	return f.kb, f.err
}

type fakeChunkStore struct {
	candidates []repository.SearchResult
	err        error
	gotLimit   int
}

func (f *fakeChunkStore) SearchByVector(_ context.Context, _ uuid.UUID, _ []float32, limit int) ([]repository.SearchResult, error) {
	f.gotLimit = limit
	return append([]repository.SearchResult(nil), f.candidates...), f.err
}

type fakeEmbedder struct {
	err error
}

func (f fakeEmbedder) EmbedTexts(context.Context, []string) ([][]float32, error) {
	if f.err != nil {
		return nil, f.err
	}
	return [][]float32{{0.1, 0.2, 0.3}}, nil
}

type fakeReranker struct {
	results []rerank.Result
	err     error
	called  bool
}

func (f *fakeReranker) Rerank(_ context.Context, _ string, _ []rerank.Document) ([]rerank.Result, error) {
	f.called = true
	if f.err != nil {
		return nil, f.err
	}
	return f.results, nil
}

func TestSearchRerankSuccessSortsByRerankScoreAndTruncatesTopK(t *testing.T) {
	chunkA, chunkB, chunkC := uuid.New(), uuid.New(), uuid.New()
	service, reranker := newTestService(config.Config{
		RerankEnabled:     true,
		RerankFailureMode: "strict",
		VectorTopN:        3,
		RerankTopK:        2,
	}, []repository.SearchResult{
		searchResult(chunkA, 0.91),
		searchResult(chunkB, 0.88),
		searchResult(chunkC, 0.80),
	}, []rerank.Result{
		{ID: chunkC.String(), Score: 0.99},
		{ID: chunkA.String(), Score: 0.72},
		{ID: chunkB.String(), Score: 0.13},
	}, nil)

	res, err := service.Search(context.Background(), uuid.New(), uuid.New(), dto.SearchRequest{Query: "policy"})
	if err != nil {
		t.Fatalf("Search returned error: %v", err)
	}

	if !reranker.called {
		t.Fatal("expected reranker to be called")
	}
	if len(res.Items) != 2 {
		t.Fatalf("expected 2 items, got %d", len(res.Items))
	}
	if res.Items[0].ChunkID != chunkC.String() || res.Items[1].ChunkID != chunkA.String() {
		t.Fatalf("expected rerank order [C A], got [%s %s]", res.Items[0].ChunkID, res.Items[1].ChunkID)
	}
	if res.Items[0].RerankScore == nil || *res.Items[0].RerankScore != 0.99 {
		t.Fatalf("expected first rerank score 0.99, got %#v", res.Items[0].RerankScore)
	}
	if res.RerankFallback != nil {
		t.Fatalf("expected no fallback metadata, got %#v", res.RerankFallback)
	}
}

func TestSearchStrictRerankFailureReturnsRerankFailed(t *testing.T) {
	service, _ := newTestService(config.Config{
		RerankEnabled:     true,
		RerankFailureMode: "strict",
		VectorTopN:        3,
		RerankTopK:        2,
	}, []repository.SearchResult{
		searchResult(uuid.New(), 0.91),
	}, nil, errors.New("provider unavailable"))

	_, err := service.Search(context.Background(), uuid.New(), uuid.New(), dto.SearchRequest{Query: "policy"})
	if err == nil {
		t.Fatal("expected error")
	}
	appErr, ok := err.(*apperror.Error)
	if !ok {
		t.Fatalf("expected apperror.Error, got %T", err)
	}
	if appErr.Code != "RERANK_FAILED" {
		t.Fatalf("expected RERANK_FAILED, got %s", appErr.Code)
	}
}

func TestSearchFallbackRerankFailureKeepsVectorOrderWithoutRerankScores(t *testing.T) {
	chunkA, chunkB, chunkC := uuid.New(), uuid.New(), uuid.New()
	service, _ := newTestService(config.Config{
		RerankEnabled:     true,
		RerankFailureMode: "fallback",
		VectorTopN:        3,
		RerankTopK:        2,
	}, []repository.SearchResult{
		searchResult(chunkA, 0.91),
		searchResult(chunkB, 0.88),
		searchResult(chunkC, 0.80),
	}, nil, errors.New("provider unavailable"))

	res, err := service.Search(context.Background(), uuid.New(), uuid.New(), dto.SearchRequest{Query: "policy"})
	if err != nil {
		t.Fatalf("Search returned error: %v", err)
	}

	if len(res.Items) != 2 {
		t.Fatalf("expected 2 items, got %d", len(res.Items))
	}
	if res.Items[0].ChunkID != chunkA.String() || res.Items[1].ChunkID != chunkB.String() {
		t.Fatalf("expected vector order [A B], got [%s %s]", res.Items[0].ChunkID, res.Items[1].ChunkID)
	}
	for _, item := range res.Items {
		if item.RerankScore != nil {
			t.Fatalf("expected nil rerankScore during fallback, got %#v", item.RerankScore)
		}
	}
	if res.RerankFallback == nil || !res.RerankFallback.Used {
		t.Fatalf("expected fallback metadata, got %#v", res.RerankFallback)
	}
	if res.RerankFallback.Reason == "" {
		t.Fatal("expected fallback reason")
	}
}

func TestSearchDebugIncludesVectorRerankAndFinalStages(t *testing.T) {
	chunkA, chunkB, chunkC := uuid.New(), uuid.New(), uuid.New()
	service, _ := newTestService(config.Config{
		RerankEnabled:     true,
		RerankFailureMode: "strict",
		VectorTopN:        3,
		RerankTopK:        2,
	}, []repository.SearchResult{
		searchResult(chunkA, 0.91),
		searchResult(chunkB, 0.88),
		searchResult(chunkC, 0.80),
	}, []rerank.Result{
		{ID: chunkC.String(), Score: 0.99},
		{ID: chunkA.String(), Score: 0.72},
		{ID: chunkB.String(), Score: 0.13},
	}, nil)

	res, err := service.Search(context.Background(), uuid.New(), uuid.New(), dto.SearchRequest{
		Query: "policy",
		Debug: true,
	})
	if err != nil {
		t.Fatalf("Search returned error: %v", err)
	}

	if res.Debug == nil {
		t.Fatal("expected debug payload")
	}
	if res.Debug.Query != "policy" {
		t.Fatalf("expected debug query to be preserved, got %q", res.Debug.Query)
	}
	if len(res.Debug.VectorStage.Items) != 3 {
		t.Fatalf("expected all vector candidates in debug payload, got %#v", res.Debug.VectorStage.Items)
	}
	if res.Debug.VectorStage.Items[0].ChunkID != chunkA.String() || res.Debug.VectorStage.Items[0].Rank != 1 {
		t.Fatalf("expected vector stage to keep raw vector order and rank, got %#v", res.Debug.VectorStage.Items[0])
	}
	if res.Debug.RerankStage.Status != "completed" {
		t.Fatalf("expected completed rerank stage, got %#v", res.Debug.RerankStage)
	}
	if len(res.Debug.RerankStage.Input) != 3 || len(res.Debug.RerankStage.Output) != 3 {
		t.Fatalf("expected rerank input and output mappings, got %#v", res.Debug.RerankStage)
	}
	if res.Debug.RerankStage.Output[0].ChunkID != chunkC.String() || res.Debug.RerankStage.Output[0].Rank != 1 {
		t.Fatalf("expected rerank output sorted by rerank score, got %#v", res.Debug.RerankStage.Output)
	}
	if len(res.Debug.FinalStage.Items) != 2 || res.Debug.FinalStage.Items[0].ChunkID != chunkC.String() {
		t.Fatalf("expected final stage to match response topK, got %#v", res.Debug.FinalStage.Items)
	}
}

func TestSearchDebugMarksDisabledAndFallbackRerankStages(t *testing.T) {
	chunkA, chunkB := uuid.New(), uuid.New()
	disabledService, _ := newTestService(config.Config{
		RerankEnabled: false,
		VectorTopN:    2,
		RerankTopK:    1,
	}, []repository.SearchResult{
		searchResult(chunkA, 0.91),
		searchResult(chunkB, 0.88),
	}, nil, nil)

	disabled, err := disabledService.Search(context.Background(), uuid.New(), uuid.New(), dto.SearchRequest{
		Query: "policy",
		Debug: true,
	})
	if err != nil {
		t.Fatalf("Search returned error with rerank disabled: %v", err)
	}
	if disabled.Debug == nil || disabled.Debug.RerankStage.Status != "disabled" {
		t.Fatalf("expected disabled rerank stage, got %#v", disabled.Debug)
	}

	fallbackService, _ := newTestService(config.Config{
		RerankEnabled:     true,
		RerankFailureMode: "fallback",
		VectorTopN:        2,
		RerankTopK:        1,
	}, []repository.SearchResult{
		searchResult(chunkA, 0.91),
		searchResult(chunkB, 0.88),
	}, nil, errors.New("provider unavailable"))

	fallback, err := fallbackService.Search(context.Background(), uuid.New(), uuid.New(), dto.SearchRequest{
		Query: "policy",
		Debug: true,
	})
	if err != nil {
		t.Fatalf("Search returned error during fallback: %v", err)
	}
	if fallback.Debug == nil || fallback.Debug.RerankStage.Status != "fallback" {
		t.Fatalf("expected fallback rerank stage, got %#v", fallback.Debug)
	}
	if fallback.Debug.RerankFallback == nil || !fallback.Debug.RerankFallback.Used {
		t.Fatalf("expected fallback metadata in debug payload, got %#v", fallback.Debug.RerankFallback)
	}
	if len(fallback.Debug.FinalStage.Items) != 1 || fallback.Debug.FinalStage.Items[0].RerankScore != nil {
		t.Fatalf("expected fallback final stage to keep nil rerankScore, got %#v", fallback.Debug.FinalStage.Items)
	}
}

func TestSearchDisabledRerankKeepsVectorTopKAndDoesNotCallProvider(t *testing.T) {
	chunkA, chunkB, chunkC := uuid.New(), uuid.New(), uuid.New()
	service, reranker := newTestService(config.Config{
		RerankEnabled: false,
		VectorTopN:    3,
		RerankTopK:    2,
	}, []repository.SearchResult{
		searchResult(chunkA, 0.91),
		searchResult(chunkB, 0.88),
		searchResult(chunkC, 0.80),
	}, nil, nil)

	res, err := service.Search(context.Background(), uuid.New(), uuid.New(), dto.SearchRequest{Query: "policy"})
	if err != nil {
		t.Fatalf("Search returned error: %v", err)
	}

	if reranker.called {
		t.Fatal("expected reranker not to be called")
	}
	if len(res.Items) != 2 {
		t.Fatalf("expected 2 items, got %d", len(res.Items))
	}
	if res.Items[0].ChunkID != chunkA.String() || res.Items[1].ChunkID != chunkB.String() {
		t.Fatalf("expected vector order [A B], got [%s %s]", res.Items[0].ChunkID, res.Items[1].ChunkID)
	}
	if res.RerankFallback != nil {
		t.Fatalf("expected no fallback metadata, got %#v", res.RerankFallback)
	}
}

func newTestService(cfg config.Config, candidates []repository.SearchResult, rerankResults []rerank.Result, rerankErr error) (*Service, *fakeReranker) {
	kb := &model.KnowledgeBase{ID: uuid.New(), OwnerID: uuid.New()}
	chunks := &fakeChunkStore{candidates: candidates}
	kbs := &fakeKnowledgeBaseStore{kb: kb}
	reranker := &fakeReranker{results: rerankResults, err: rerankErr}
	return NewService(cfg, chunks, kbs, fakeEmbedder{}, reranker), reranker
}

func searchResult(chunkID uuid.UUID, vectorScore float64) repository.SearchResult {
	return repository.SearchResult{
		ChunkID:     chunkID,
		DocumentID:  uuid.New(),
		Filename:    "manual.md",
		Content:     "content",
		VectorScore: vectorScore,
	}
}
