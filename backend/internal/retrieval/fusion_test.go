package retrieval

import (
	"context"
	"errors"
	"math"
	"testing"

	"github.com/google/uuid"

	"kbchat/backend/internal/apperror"
	"kbchat/backend/internal/config"
	"kbchat/backend/internal/dto"
	"kbchat/backend/internal/model"
	"kbchat/backend/internal/repository"
	"kbchat/backend/internal/rerank"
)

func keywordResult(chunkID uuid.UUID, score float64) repository.SearchResult {
	result := searchResult(chunkID, 0)
	result.KeywordScore = &score
	return result
}

func TestFuseByReciprocalRankPrefersChunksInBothListsAndNormalizes(t *testing.T) {
	both, vectorOnly, keywordOnly := uuid.New(), uuid.New(), uuid.New()
	vector := []repository.SearchResult{searchResult(vectorOnly, 0.95), searchResult(both, 0.90)}
	keyword := []repository.SearchResult{keywordResult(keywordOnly, 0.8), keywordResult(both, 0.6)}

	fused := fuseByReciprocalRank(vector, keyword, 10)
	if len(fused) != 3 {
		t.Fatalf("expected 3 fused candidates, got %d", len(fused))
	}
	if fused[0].ChunkID != both {
		t.Fatalf("expected the chunk present in both lists first, got %s", fused[0].ChunkID)
	}
	// second in both lists: 2/(k+2) over the ceiling 2/(k+1)
	wantBoth := (2.0 / float64(rrfK+2)) / (2.0 / float64(rrfK+1))
	if math.Abs(*fused[0].FusionScore-wantBoth) > 1e-9 {
		t.Fatalf("expected fusion score %.6f, got %.6f", wantBoth, *fused[0].FusionScore)
	}
	if *fused[0].VectorRank != 2 || *fused[0].KeywordRank != 2 {
		t.Fatalf("expected ranks 2/2, got %v/%v", *fused[0].VectorRank, *fused[0].KeywordRank)
	}
	if fused[0].KeywordScore == nil || *fused[0].KeywordScore != 0.6 || fused[0].VectorScore != 0.90 {
		t.Fatalf("expected both scores carried over, got vector=%v keyword=%v", fused[0].VectorScore, fused[0].KeywordScore)
	}

	// Rank 1 in a single list scores exactly 0.5; vector-only wins the tie by rank rule.
	if fused[1].ChunkID != vectorOnly || fused[2].ChunkID != keywordOnly {
		t.Fatalf("expected [both vectorOnly keywordOnly], got [%s %s %s]", fused[0].ChunkID, fused[1].ChunkID, fused[2].ChunkID)
	}
	for _, single := range fused[1:] {
		if math.Abs(*single.FusionScore-0.5) > 1e-9 {
			t.Fatalf("expected single-list first place to score 0.5, got %.6f", *single.FusionScore)
		}
	}
	if fused[1].KeywordRank != nil || fused[2].VectorRank != nil {
		t.Fatalf("expected absent ranks to stay nil, got %#v %#v", fused[1], fused[2])
	}
}

func TestFuseByReciprocalRankTruncatesAndIsDeterministic(t *testing.T) {
	vector := make([]repository.SearchResult, 0, 5)
	for range 5 {
		vector = append(vector, searchResult(uuid.New(), 0.9))
	}
	keyword := []repository.SearchResult{keywordResult(uuid.New(), 0.9)}

	first := fuseByReciprocalRank(vector, keyword, 3)
	second := fuseByReciprocalRank(vector, keyword, 3)
	if len(first) != 3 {
		t.Fatalf("expected truncation to 3, got %d", len(first))
	}
	for i := range first {
		if first[i].ChunkID != second[i].ChunkID {
			t.Fatalf("expected deterministic order, got %s vs %s at %d", first[i].ChunkID, second[i].ChunkID, i)
		}
	}
	if first[0].ChunkID != vector[0].ChunkID || first[1].ChunkID != keyword[0].ChunkID {
		t.Fatalf("expected vector rank 1 then keyword rank 1 (tie broken by vector rank), got %s %s", first[0].ChunkID, first[1].ChunkID)
	}
}

func TestSearchKeywordDisabledDoesNotQueryKeywordStage(t *testing.T) {
	kb := knowledgeBaseWithRetrievalConfig(t, dto.RetrievalConfig{VectorTopN: 2, RerankTopK: 2, EnableRerank: false, EnableKeyword: false})
	service, _, chunks := newTestServiceWithKB(config.Config{KeywordSearchEnabled: true}, kb, []repository.SearchResult{
		searchResult(uuid.New(), 0.9),
	}, nil, nil)
	chunks.keywordCandidates = []repository.SearchResult{keywordResult(uuid.New(), 0.9)}

	res, err := service.Search(context.Background(), kb.OwnerID, kb.ID, dto.SearchRequest{Query: "policy", Debug: true})
	if err != nil {
		t.Fatalf("Search returned error: %v", err)
	}
	if chunks.keywordCalls != 0 {
		t.Fatalf("expected keyword stage to be skipped, got %d calls", chunks.keywordCalls)
	}
	if len(res.Items) != 1 || res.Items[0].KeywordScore != nil {
		t.Fatalf("expected vector-only result without keyword score, got %#v", res.Items)
	}
	if res.Debug.KeywordStage.Status != "disabled" || len(res.Debug.KeywordStage.Items) != 0 {
		t.Fatalf("expected disabled keyword stage, got %#v", res.Debug.KeywordStage)
	}
	if res.Debug.FusionStage.Status != "skipped" || len(res.Debug.FusionStage.Items) != 1 || res.Debug.FusionStage.Items[0].FusionScore != 0 {
		t.Fatalf("expected skipped fusion stage mirroring the vector list, got %#v", res.Debug.FusionStage)
	}
}

func TestSearchGlobalKeywordSwitchOverridesKnowledgeBaseAndRequest(t *testing.T) {
	kb := knowledgeBaseWithRetrievalConfig(t, dto.RetrievalConfig{VectorTopN: 2, RerankTopK: 2, EnableKeyword: true})
	service, _, chunks := newTestServiceWithKB(config.Config{KeywordSearchEnabled: false}, kb, []repository.SearchResult{
		searchResult(uuid.New(), 0.9),
	}, nil, nil)
	enabled := true
	if _, err := service.Search(context.Background(), kb.OwnerID, kb.ID, dto.SearchRequest{Query: "policy", EnableKeyword: &enabled}); err != nil {
		t.Fatalf("Search returned error: %v", err)
	}
	if chunks.keywordCalls != 0 {
		t.Fatal("expected KEYWORD_SEARCH_ENABLED=false to win over knowledge base and request")
	}
}

func TestSearchStoredConfigWithoutEnableKeywordUsesGlobalDefault(t *testing.T) {
	kb := &model.KnowledgeBase{
		ID:              uuid.New(),
		OwnerID:         uuid.New(),
		RetrievalConfig: []byte(`{"vectorTopN":2,"rerankTopK":2,"scoreThreshold":0,"enableRerank":false}`),
	}
	service, _, chunks := newTestServiceWithKB(config.Config{KeywordSearchEnabled: true}, kb, []repository.SearchResult{
		searchResult(uuid.New(), 0.9),
	}, nil, nil)
	if _, err := service.Search(context.Background(), kb.OwnerID, kb.ID, dto.SearchRequest{Query: "policy"}); err != nil {
		t.Fatalf("Search returned error: %v", err)
	}
	if chunks.keywordCalls != 1 {
		t.Fatalf("expected a pre-existing config to inherit the global keyword default, got %d calls", chunks.keywordCalls)
	}
}

func TestSearchRequestCanDisableKeywordForOneCall(t *testing.T) {
	kb := knowledgeBaseWithRetrievalConfig(t, dto.RetrievalConfig{VectorTopN: 2, RerankTopK: 2, EnableKeyword: true})
	service, _, chunks := newTestServiceWithKB(config.Config{KeywordSearchEnabled: true}, kb, []repository.SearchResult{
		searchResult(uuid.New(), 0.9),
	}, nil, nil)
	disabled := false
	if _, err := service.Search(context.Background(), kb.OwnerID, kb.ID, dto.SearchRequest{Query: "policy", EnableKeyword: &disabled}); err != nil {
		t.Fatalf("Search returned error: %v", err)
	}
	if chunks.keywordCalls != 0 {
		t.Fatal("expected request override to disable keyword recall")
	}
}

func TestSearchKeywordEnabledFusesBeforeRerankAndKeepsCitationsFromPrompt(t *testing.T) {
	both, vectorOnly, keywordOnly := uuid.New(), uuid.New(), uuid.New()
	kb := knowledgeBaseWithRetrievalConfig(t, dto.RetrievalConfig{VectorTopN: 3, RerankTopK: 2, ScoreThreshold: 0.3, EnableRerank: true, EnableKeyword: true})
	service, reranker, chunks := newTestServiceWithKB(config.Config{RerankEnabled: true, RerankFailureMode: "strict", KeywordSearchEnabled: true}, kb, []repository.SearchResult{
		searchResult(vectorOnly, 0.95),
		searchResult(both, 0.90),
	}, []rerank.Result{
		{ID: keywordOnly.String(), Score: 0.99},
		{ID: both.String(), Score: 0.80},
		{ID: vectorOnly.String(), Score: 0.10},
	}, nil)
	chunks.keywordCandidates = []repository.SearchResult{keywordResult(keywordOnly, 0.7), keywordResult(both, 0.5)}

	res, err := service.Search(context.Background(), kb.OwnerID, kb.ID, dto.SearchRequest{Query: "E-4021 退款", Debug: true})
	if err != nil {
		t.Fatalf("Search returned error: %v", err)
	}
	if chunks.gotKeywordQuery != "E-4021 退款" || chunks.gotKeywordLimit != 3 {
		t.Fatalf("expected keyword stage to receive the raw query and vectorTopN, got %q limit %d", chunks.gotKeywordQuery, chunks.gotKeywordLimit)
	}
	if len(reranker.docs) != 3 {
		t.Fatalf("expected the fused list of 3 chunks to reach rerank, got %d", len(reranker.docs))
	}
	if reranker.docs[0].ID != both.String() {
		t.Fatalf("expected the chunk in both lists to lead the rerank input, got %s", reranker.docs[0].ID)
	}
	if len(res.Items) != 2 || res.Items[0].ChunkID != keywordOnly.String() || res.Items[1].ChunkID != both.String() {
		t.Fatalf("expected rerank order [keywordOnly both] after threshold, got %#v", res.Items)
	}
	if res.Items[0].VectorScore != 0 || res.Items[0].KeywordScore == nil || *res.Items[0].KeywordScore != 0.7 {
		t.Fatalf("expected keyword-only item to carry keyword score and zero vector score, got %#v", res.Items[0])
	}
	if res.Items[1].KeywordScore == nil || *res.Items[1].KeywordScore != 0.5 || res.Items[1].VectorScore != 0.90 {
		t.Fatalf("expected the shared chunk to carry both scores, got %#v", res.Items[1])
	}

	debug := res.Debug
	if debug.KeywordStage.Status != "completed" || len(debug.KeywordStage.Items) != 2 || debug.KeywordStage.Items[0].ChunkID != keywordOnly.String() || debug.KeywordStage.Items[0].Rank != 1 {
		t.Fatalf("expected keyword stage in raw keyword order, got %#v", debug.KeywordStage)
	}
	if debug.FusionStage.Status != "completed" || len(debug.FusionStage.Items) != 3 {
		t.Fatalf("expected completed fusion stage with 3 items, got %#v", debug.FusionStage)
	}
	lead := debug.FusionStage.Items[0]
	if lead.ChunkID != both.String() || lead.VectorRank == nil || *lead.VectorRank != 2 || lead.KeywordRank == nil || *lead.KeywordRank != 2 || lead.FusionScore <= 0.5 {
		t.Fatalf("expected fusion lead to show both ranks and a score above a single first place, got %#v", lead)
	}
	if len(debug.RerankStage.Input) != 3 || debug.RerankStage.Input[0].ChunkID != both.String() {
		t.Fatalf("expected rerank input to be the fused list, got %#v", debug.RerankStage.Input)
	}
	if len(debug.FinalStage.Items) != 2 || debug.FinalStage.Items[0].FusionScore == nil || debug.FinalStage.Items[0].RerankScore == nil {
		t.Fatalf("expected final stage to expose fusion and rerank scores, got %#v", debug.FinalStage.Items)
	}
}

func TestSearchKeywordEnabledWithoutRerankAppliesThresholdToFusionScore(t *testing.T) {
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
			both, vectorOnly, keywordOnly := uuid.New(), uuid.New(), uuid.New()
			kb := knowledgeBaseWithRetrievalConfig(t, dto.RetrievalConfig{VectorTopN: 3, RerankTopK: 3, ScoreThreshold: 0.6, EnableRerank: tc.enabled, EnableKeyword: true})
			service, _, chunks := newTestServiceWithKB(config.Config{RerankEnabled: tc.enabled, RerankFailureMode: tc.failureMode, KeywordSearchEnabled: true}, kb, []repository.SearchResult{
				searchResult(vectorOnly, 0.99),
				searchResult(both, 0.10),
			}, nil, tc.rerankErr)
			chunks.keywordCandidates = []repository.SearchResult{keywordResult(both, 0.9), keywordResult(keywordOnly, 0.8)}

			res, err := service.Search(context.Background(), kb.OwnerID, kb.ID, dto.SearchRequest{Query: "policy"})
			if err != nil {
				t.Fatalf("Search returned error: %v", err)
			}
			// both: rank 2 vector + rank 1 keyword -> well above 0.6; single-list first places score 0.5.
			if len(res.Items) != 1 || res.Items[0].ChunkID != both.String() {
				t.Fatalf("expected only the chunk found by both stages to pass a 0.6 threshold, got %#v", res.Items)
			}
			if res.Items[0].RerankScore != nil {
				t.Fatalf("expected no rerank score, got %#v", res.Items[0].RerankScore)
			}
			if tc.enabled && (res.RerankFallback == nil || !res.RerankFallback.Used) {
				t.Fatalf("expected fallback metadata to survive fusion, got %#v", res.RerankFallback)
			}
		})
	}
}

func TestSearchKeywordStageErrorIsInternal(t *testing.T) {
	kb := knowledgeBaseWithRetrievalConfig(t, dto.RetrievalConfig{VectorTopN: 2, RerankTopK: 2, EnableKeyword: true})
	service, _, chunks := newTestServiceWithKB(config.Config{KeywordSearchEnabled: true}, kb, []repository.SearchResult{
		searchResult(uuid.New(), 0.9),
	}, nil, nil)
	chunks.keywordErr = errors.New("relation search_vector does not exist")

	_, err := service.Search(context.Background(), kb.OwnerID, kb.ID, dto.SearchRequest{Query: "policy"})
	var app *apperror.Error
	if !errors.As(err, &app) || app.Code != "INTERNAL_ERROR" {
		t.Fatalf("expected internal error from keyword stage failure, got %v", err)
	}
}
