package retrieval

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/google/uuid"

	"kbchat/backend/internal/apperror"
	"kbchat/backend/internal/config"
	"kbchat/backend/internal/dto"
	"kbchat/backend/internal/model"
	"kbchat/backend/internal/repository"
	"kbchat/backend/internal/rerank"
)

type fakeKnowledgeBaseStore struct {
	kb  *model.KnowledgeBase
	err error
	// memberRole is what the actor's membership resolves to. The retrieval tests
	// use a random actor id, so without a role every one of them would be answered
	// by the authorization check instead of reaching retrieval; "viewer" is the
	// weakest standing that holds kb.search, which is what these tests want to
	// exercise. The tests that are about the check itself set this to "".
	memberRole string
	roleErr    error
}

func (f *fakeKnowledgeBaseStore) FindByID(context.Context, uuid.UUID) (*model.KnowledgeBase, error) {
	return f.kb, f.err
}

func (f *fakeKnowledgeBaseStore) FindMemberRole(context.Context, uuid.UUID, uuid.UUID) (string, error) {
	return f.memberRole, f.roleErr
}

type fakeChunkStore struct {
	candidates []repository.SearchResult
	err        error
	gotLimit   int

	keywordCandidates []repository.SearchResult
	keywordErr        error
	keywordCalls      int
	gotKeywordQuery   string
	gotKeywordLimit   int

	// searchable overrides CountVectorSearchable; nil reports exactly what the
	// approximate search returned, which never triggers the exact fallback.
	searchable      *int64
	countErr        error
	countCalls      int
	exactCandidates []repository.SearchResult
	exactErr        error
	exactCalls      int
	gotExactLimit   int
}

func (f *fakeChunkStore) CountVectorSearchable(context.Context, uuid.UUID) (int64, error) {
	f.countCalls++
	if f.searchable != nil {
		return *f.searchable, f.countErr
	}
	return int64(len(f.candidates)), f.countErr
}

func (f *fakeChunkStore) SearchByVectorExact(_ context.Context, _ uuid.UUID, _ []float32, limit int) ([]repository.SearchResult, error) {
	f.exactCalls++
	f.gotExactLimit = limit
	return append([]repository.SearchResult(nil), f.exactCandidates...), f.exactErr
}

func (f *fakeChunkStore) SearchByVector(_ context.Context, _ uuid.UUID, _ []float32, limit int) ([]repository.SearchResult, error) {
	f.gotLimit = limit
	return append([]repository.SearchResult(nil), f.candidates...), f.err
}

func (f *fakeChunkStore) SearchByKeyword(_ context.Context, _ uuid.UUID, query string, limit int) ([]repository.SearchResult, error) {
	f.keywordCalls++
	f.gotKeywordQuery = query
	f.gotKeywordLimit = limit
	return append([]repository.SearchResult(nil), f.keywordCandidates...), f.keywordErr
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
	docs    []rerank.Document
}

func (f *fakeReranker) Rerank(_ context.Context, _ string, docs []rerank.Document) ([]rerank.Result, error) {
	f.called = true
	f.docs = append([]rerank.Document(nil), docs...)
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
	if appErr.Message != "知识检索排序暂时不可用，请稍后重试" {
		t.Fatalf("expected user-facing rerank message, got %q", appErr.Message)
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
	pageA, pageC := 3, 8
	candidateA := searchResult(chunkA, 0.91)
	candidateA.PageNumber = &pageA
	candidateB := searchResult(chunkB, 0.88)
	candidateC := searchResult(chunkC, 0.80)
	candidateC.PageNumber = &pageC
	service, _ := newTestService(config.Config{
		RerankEnabled:     true,
		RerankFailureMode: "strict",
		VectorTopN:        3,
		RerankTopK:        2,
	}, []repository.SearchResult{
		candidateA,
		candidateB,
		candidateC,
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

	debugJSON, err := json.Marshal(res.Debug)
	if err != nil {
		t.Fatalf("marshal debug payload: %v", err)
	}
	var debugPayload struct {
		VectorStage struct {
			Items []map[string]any `json:"items"`
		} `json:"vectorStage"`
		RerankStage struct {
			Input  []map[string]any `json:"input"`
			Output []map[string]any `json:"output"`
		} `json:"rerankStage"`
		FinalStage struct {
			Items []map[string]any `json:"items"`
		} `json:"finalStage"`
	}
	if err := json.Unmarshal(debugJSON, &debugPayload); err != nil {
		t.Fatalf("unmarshal debug payload: %v", err)
	}
	if debugPayload.VectorStage.Items[0]["pageNumber"] != float64(pageA) ||
		debugPayload.RerankStage.Input[0]["pageNumber"] != float64(pageA) ||
		debugPayload.RerankStage.Output[0]["pageNumber"] != float64(pageC) ||
		debugPayload.FinalStage.Items[0]["pageNumber"] != float64(pageC) {
		t.Fatalf("expected physical page numbers in every debug stage, got %s", debugJSON)
	}
	if pageNumber, exists := debugPayload.RerankStage.Input[1]["pageNumber"]; !exists || pageNumber != nil {
		t.Fatalf("expected a null page number to remain explicit in debug JSON, got %s", debugJSON)
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

func TestSearchUsesKnowledgeBaseRetrievalConfigWhenRequestOmitsOverrides(t *testing.T) {
	kb := knowledgeBaseWithRetrievalConfig(t, dto.RetrievalConfig{
		VectorTopN:     2,
		RerankTopK:     1,
		ScoreThreshold: 0,
		EnableRerank:   false,
	})
	service, reranker, chunks := newTestServiceWithKB(config.Config{
		RerankEnabled: true,
		VectorTopN:    9,
		RerankTopK:    8,
	}, kb, []repository.SearchResult{
		searchResult(uuid.New(), 0.9),
		searchResult(uuid.New(), 0.8),
	}, nil, nil)

	res, err := service.Search(context.Background(), kb.OwnerID, kb.ID, dto.SearchRequest{Query: "policy"})
	if err != nil {
		t.Fatalf("Search returned error: %v", err)
	}
	if chunks.gotLimit != 2 {
		t.Fatalf("expected knowledge-base vectorTopN 2, got %d", chunks.gotLimit)
	}
	if reranker.called {
		t.Fatal("expected knowledge-base config to disable rerank")
	}
	if len(res.Items) != 1 {
		t.Fatalf("expected knowledge-base rerankTopK 1, got %d items", len(res.Items))
	}
}

func TestSearchRerankSuccessFiltersFinalItemsByRerankScoreThreshold(t *testing.T) {
	chunkA, chunkB := uuid.New(), uuid.New()
	kb := knowledgeBaseWithRetrievalConfig(t, dto.RetrievalConfig{
		VectorTopN:     2,
		RerankTopK:     2,
		ScoreThreshold: 0.5,
		EnableRerank:   true,
	})
	service, _, _ := newTestServiceWithKB(config.Config{RerankEnabled: true}, kb, []repository.SearchResult{
		searchResult(chunkA, 0.1),
		searchResult(chunkB, 0.9),
	}, []rerank.Result{
		{ID: chunkA.String(), Score: 0.9},
		{ID: chunkB.String(), Score: 0.2},
	}, nil)

	res, err := service.Search(context.Background(), kb.OwnerID, kb.ID, dto.SearchRequest{Query: "policy", Debug: true})
	if err != nil {
		t.Fatalf("Search returned error: %v", err)
	}
	if len(res.Items) != 1 || res.Items[0].ChunkID != chunkA.String() {
		t.Fatalf("expected only rerank-qualified chunk A, got %#v", res.Items)
	}
	if res.Debug == nil || len(res.Debug.FinalStage.Items) != 1 || res.Debug.FinalStage.Items[0].ChunkID != chunkA.String() {
		t.Fatalf("expected debug final stage to match thresholded response, got %#v", res.Debug)
	}
}

func TestSearchWithoutSuccessfulRerankFiltersByVectorScoreThreshold(t *testing.T) {
	for _, tc := range []struct {
		name        string
		enabled     bool
		failureMode string
		rerankErr   error
	}{
		{name: "disabled"},
		{name: "fallback", enabled: true, failureMode: "fallback", rerankErr: errors.New("provider unavailable")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			chunkA, chunkB := uuid.New(), uuid.New()
			kb := knowledgeBaseWithRetrievalConfig(t, dto.RetrievalConfig{
				VectorTopN:     2,
				RerankTopK:     2,
				ScoreThreshold: 0.5,
				EnableRerank:   tc.enabled,
			})
			service, _, _ := newTestServiceWithKB(config.Config{
				RerankEnabled:     tc.enabled,
				RerankFailureMode: tc.failureMode,
			}, kb, []repository.SearchResult{
				searchResult(chunkA, 0.9),
				searchResult(chunkB, 0.4),
			}, nil, tc.rerankErr)

			res, err := service.Search(context.Background(), kb.OwnerID, kb.ID, dto.SearchRequest{Query: "policy"})
			if err != nil {
				t.Fatalf("Search returned error: %v", err)
			}
			if len(res.Items) != 1 || res.Items[0].ChunkID != chunkA.String() {
				t.Fatalf("expected only vector-qualified chunk A, got %#v", res.Items)
			}
			if res.Items[0].RerankScore != nil {
				t.Fatalf("expected no rerank score, got %#v", res.Items[0].RerankScore)
			}
		})
	}
}

func TestSearchZeroThresholdFiltersNegativeScores(t *testing.T) {
	negativeChunk, zeroChunk := uuid.New(), uuid.New()
	kb := knowledgeBaseWithRetrievalConfig(t, dto.RetrievalConfig{
		VectorTopN:     2,
		RerankTopK:     2,
		ScoreThreshold: 0,
		EnableRerank:   false,
	})
	service, _, _ := newTestServiceWithKB(config.Config{}, kb, []repository.SearchResult{
		searchResult(negativeChunk, -0.1),
		searchResult(zeroChunk, 0),
	}, nil, nil)

	res, err := service.Search(context.Background(), kb.OwnerID, kb.ID, dto.SearchRequest{Query: "policy"})
	if err != nil {
		t.Fatalf("Search returned error: %v", err)
	}
	if len(res.Items) != 1 || res.Items[0].ChunkID != zeroChunk.String() {
		t.Fatalf("expected threshold zero to reject negative score, got %#v", res.Items)
	}
}

func TestSearchRequestThresholdOverridesWithoutChangingKnowledgeBaseDefault(t *testing.T) {
	kb := knowledgeBaseWithRetrievalConfig(t, dto.RetrievalConfig{
		VectorTopN: 2, RerankTopK: 2, ScoreThreshold: 0.8, EnableRerank: false,
	})
	svc, _, _ := newTestServiceWithKB(config.Config{}, kb, []repository.SearchResult{
		searchResult(uuid.New(), 0.9), searchResult(uuid.New(), 0),
	}, nil, nil)
	zero := 0.0
	result, err := svc.Search(context.Background(), kb.OwnerID, kb.ID, dto.SearchRequest{Query: "policy", ScoreThreshold: &zero})
	if err != nil || len(result.Items) != 2 {
		t.Fatalf("explicit zero threshold lost: result=%+v, error=%v", result, err)
	}
	result, err = svc.Search(context.Background(), kb.OwnerID, kb.ID, dto.SearchRequest{Query: "policy"})
	if err != nil || len(result.Items) != 1 {
		t.Fatalf("request changed the saved threshold: result=%+v, error=%v", result, err)
	}
	for _, invalid := range []float64{-0.1, 1.1} {
		_, err = svc.Search(context.Background(), kb.OwnerID, kb.ID, dto.SearchRequest{Query: "policy", ScoreThreshold: &invalid})
		var app *apperror.Error
		if !errors.As(err, &app) || app.Code != "VALIDATION_ERROR" {
			t.Fatalf("invalid threshold %v was accepted: %v", invalid, err)
		}
	}
}

func TestSearchMalformedKnowledgeBaseConfigFallsBackAtomically(t *testing.T) {
	kb := &model.KnowledgeBase{
		ID:              uuid.New(),
		OwnerID:         uuid.New(),
		RetrievalConfig: []byte(`{"vectorTopN":2,"rerankTopK":"invalid"}`),
	}
	service, reranker, chunks := newTestServiceWithKB(config.Config{
		VectorTopN:     7,
		RerankTopK:     3,
		ScoreThreshold: 0.4,
		RerankEnabled:  false,
	}, kb, []repository.SearchResult{
		searchResult(uuid.New(), 0.5),
		searchResult(uuid.New(), 0.3),
	}, nil, nil)

	res, err := service.Search(context.Background(), kb.OwnerID, kb.ID, dto.SearchRequest{Query: "policy"})
	if err != nil {
		t.Fatalf("Search returned error: %v", err)
	}
	if chunks.gotLimit != 7 {
		t.Fatalf("expected malformed config to use global vectorTopN 7, got %d", chunks.gotLimit)
	}
	if reranker.called {
		t.Fatal("expected malformed config to preserve globally disabled rerank")
	}
	if len(res.Items) != 1 || res.Items[0].VectorScore != 0.5 {
		t.Fatalf("expected global threshold fallback to keep only qualified item, got %#v", res.Items)
	}
}

func TestSearchCapsRequestedLimitsAndClampsTopKToTopN(t *testing.T) {
	kb := knowledgeBaseWithRetrievalConfig(t, dto.RetrievalConfig{VectorTopN: 30, RerankTopK: 5, EnableRerank: true})
	candidates := make([]repository.SearchResult, 0, 110)
	results := make([]rerank.Result, 0, 110)
	for i := 0; i < 110; i++ {
		chunkID := uuid.New()
		candidates = append(candidates, searchResult(chunkID, 0.9))
		results = append(results, rerank.Result{ID: chunkID.String(), Score: 0.9})
	}
	service, reranker, chunks := newTestServiceWithKB(config.Config{RerankEnabled: true}, kb, candidates, results, nil)

	res, err := service.Search(context.Background(), kb.OwnerID, kb.ID, dto.SearchRequest{
		Query:      "policy",
		VectorTopN: 1000,
		RerankTopK: 1000,
	})
	if err != nil {
		t.Fatalf("Search returned error: %v", err)
	}
	if chunks.gotLimit != 100 {
		t.Fatalf("expected vectorTopN cap 100, got %d", chunks.gotLimit)
	}
	if len(reranker.docs) != 100 {
		t.Fatalf("expected reranker input capped to 100 documents, got %d", len(reranker.docs))
	}
	if len(res.Items) != 20 {
		t.Fatalf("expected rerankTopK cap 20, got %d items", len(res.Items))
	}

	service, reranker, _ = newTestServiceWithKB(config.Config{RerankEnabled: true}, kb, candidates[:3], results[:3], nil)
	res, err = service.Search(context.Background(), kb.OwnerID, kb.ID, dto.SearchRequest{
		Query:      "policy",
		VectorTopN: 2,
		RerankTopK: 3,
	})
	if err != nil {
		t.Fatalf("Search returned error: %v", err)
	}
	if len(reranker.docs) != 2 || len(res.Items) != 2 {
		t.Fatalf("expected rerankTopK clamped to vectorTopN, docs=%d items=%d", len(reranker.docs), len(res.Items))
	}
}

func TestSearchFallbackReasonIsStableAndDoesNotExposeProviderError(t *testing.T) {
	kb := knowledgeBaseWithRetrievalConfig(t, dto.RetrievalConfig{VectorTopN: 1, RerankTopK: 1, EnableRerank: true})
	reasons := make([]string, 0, 2)
	for _, providerErr := range []error{
		errors.New("api key sk-secret leaked"),
		errors.New("internal provider URL http://10.0.0.5"),
	} {
		service, _, _ := newTestServiceWithKB(config.Config{RerankEnabled: true, RerankFailureMode: "fallback"}, kb, []repository.SearchResult{
			searchResult(uuid.New(), 0.9),
		}, nil, providerErr)
		res, err := service.Search(context.Background(), kb.OwnerID, kb.ID, dto.SearchRequest{Query: "policy"})
		if err != nil {
			t.Fatalf("Search returned error: %v", err)
		}
		if res.RerankFallback == nil {
			t.Fatal("expected fallback metadata")
		}
		reasons = append(reasons, res.RerankFallback.Reason)
		if strings.Contains(res.RerankFallback.Reason, providerErr.Error()) || strings.Contains(res.RerankFallback.Reason, "sk-secret") || strings.Contains(res.RerankFallback.Reason, "10.0.0.5") {
			t.Fatalf("expected sanitized public reason, got %q", res.RerankFallback.Reason)
		}
	}
	if reasons[0] == "" || reasons[0] != reasons[1] {
		t.Fatalf("expected stable public reason, got %#v", reasons)
	}
}

func newTestService(cfg config.Config, candidates []repository.SearchResult, rerankResults []rerank.Result, rerankErr error) (*Service, *fakeReranker) {
	service, reranker, _ := newTestServiceWithKB(cfg, &model.KnowledgeBase{ID: uuid.New(), OwnerID: uuid.New()}, candidates, rerankResults, rerankErr)
	return service, reranker
}

func newTestServiceWithKB(cfg config.Config, kb *model.KnowledgeBase, candidates []repository.SearchResult, rerankResults []rerank.Result, rerankErr error) (*Service, *fakeReranker, *fakeChunkStore) {
	chunks := &fakeChunkStore{candidates: candidates}
	kbs := &fakeKnowledgeBaseStore{memberRole: "viewer", kb: kb}
	reranker := &fakeReranker{results: rerankResults, err: rerankErr}
	return NewService(cfg, chunks, kbs, fakeEmbedder{}, reranker), reranker, chunks
}

func knowledgeBaseWithRetrievalConfig(t *testing.T, cfg dto.RetrievalConfig) *model.KnowledgeBase {
	t.Helper()
	payload, err := json.Marshal(cfg)
	if err != nil {
		t.Fatalf("marshal retrieval config: %v", err)
	}
	return &model.KnowledgeBase{
		ID:              uuid.New(),
		OwnerID:         uuid.New(),
		RetrievalConfig: payload,
	}
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
