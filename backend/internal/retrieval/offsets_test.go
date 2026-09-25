package retrieval

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"gorm.io/datatypes"

	"kbchat/backend/internal/config"
	"kbchat/backend/internal/dto"
	"kbchat/backend/internal/rerank"
	"kbchat/backend/internal/repository"
)

func withOffsets(result repository.SearchResult, metadata string) repository.SearchResult {
	result.Metadata = datatypes.JSON(metadata)
	return result
}

func TestChunkSourceOffsetsRejectsUnusableMetadata(t *testing.T) {
	cases := map[string]bool{
		`{"startOffset": 12, "endOffset": 40, "headingPath": ["a"]}`: true,
		`{"startOffset": 0, "endOffset": 1}`:                         true,
		`{"startOffset": 12}`:                                        false,
		`{"startOffset": 40, "endOffset": 12}`:                       false,
		`{"startOffset": 12, "endOffset": 12}`:                       false,
		`{"startOffset": -1, "endOffset": 12}`:                       false,
		`{"startOffset": "12", "endOffset": 40}`:                     false,
		`not json`:                                                   false,
		``:                                                           false,
	}
	for metadata, usable := range cases {
		start, end := chunkSourceOffsets(datatypes.JSON(metadata))
		if (start != nil && end != nil) != usable {
			t.Errorf("metadata %q: got start=%v end=%v, usable=%v", metadata, start, end, usable)
		}
	}
}

func assertOffsets(t *testing.T, items []dto.SearchResultResponse, chunkID uuid.UUID, start, end int) {
	t.Helper()
	for _, item := range items {
		if item.ChunkID != chunkID.String() {
			continue
		}
		if item.StartOffset == nil || item.EndOffset == nil || *item.StartOffset != start || *item.EndOffset != end {
			t.Fatalf("chunk %s offsets = %v..%v, want %d..%d", chunkID, item.StartOffset, item.EndOffset, start, end)
		}
		return
	}
	t.Fatalf("chunk %s not in results %#v", chunkID, items)
}

func TestSearchCarriesChunkOffsetsThroughEveryStage(t *testing.T) {
	vectorOnly, both, keywordOnly := uuid.New(), uuid.New(), uuid.New()
	kb := knowledgeBaseWithRetrievalConfig(t, dto.RetrievalConfig{VectorTopN: 5, RerankTopK: 5, EnableKeyword: true})
	service, _, chunks := newTestServiceWithKB(config.Config{VectorTopN: 5, RerankTopK: 5, KeywordSearchEnabled: true}, kb, []repository.SearchResult{
		withOffsets(searchResult(vectorOnly, 0.9), `{"startOffset": 10, "endOffset": 20}`),
		withOffsets(searchResult(both, 0.8), `{"startOffset": 30, "endOffset": 45}`),
	}, nil, nil)
	keyword := withOffsets(searchResult(keywordOnly, 0), `{"startOffset": 50, "endOffset": 60}`)
	chunks.keywordCandidates = []repository.SearchResult{keyword, withOffsets(searchResult(both, 0), `{"startOffset": 30, "endOffset": 45}`)}

	res, err := service.Search(context.Background(), uuid.New(), uuid.New(), dto.SearchRequest{Query: "policy"})
	if err != nil {
		t.Fatalf("search: %v", err)
	}
	assertOffsets(t, res.Items, vectorOnly, 10, 20)
	assertOffsets(t, res.Items, both, 30, 45)
	assertOffsets(t, res.Items, keywordOnly, 50, 60)
}

func TestSearchCarriesChunkOffsetsThroughRerankAndExactFallback(t *testing.T) {
	first, second := uuid.New(), uuid.New()
	kb := knowledgeBaseWithRetrievalConfig(t, dto.RetrievalConfig{VectorTopN: 3, RerankTopK: 2, EnableRerank: true})
	service, _, chunks := newTestServiceWithKB(config.Config{VectorTopN: 3, RerankTopK: 2, RerankEnabled: true, RerankFailureMode: "strict"}, kb,
		nil, []rerank.Result{{ID: second.String(), Score: 0.9}, {ID: first.String(), Score: 0.5}}, nil)
	two := int64(2)
	chunks.searchable = &two
	chunks.exactCandidates = []repository.SearchResult{
		withOffsets(searchResult(first, 0.9), `{"startOffset": 1, "endOffset": 5}`),
		withOffsets(searchResult(second, 0.8), `{"startOffset": 7, "endOffset": 9}`),
	}

	res, err := service.Search(context.Background(), uuid.New(), uuid.New(), dto.SearchRequest{Query: "policy"})
	if err != nil {
		t.Fatalf("search: %v", err)
	}
	if len(res.Items) != 2 || res.Items[0].ChunkID != second.String() {
		t.Fatalf("expected the reranked exact results, got %#v", res.Items)
	}
	assertOffsets(t, res.Items, first, 1, 5)
	assertOffsets(t, res.Items, second, 7, 9)
}
