package retrieval

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"gorm.io/datatypes"

	"kbchat/backend/internal/config"
	"kbchat/backend/internal/dto"
	"kbchat/backend/internal/repository"
	"kbchat/backend/internal/rerank"
)

func TestTableSourcesSurviveRerankAndRejectInvalidMetadata(t *testing.T) {
	for raw, valid := range map[string]bool{
		`{"fileType":"xlsx","table":{"sheetName":"销售","headerRow":2,"rowStart":5,"rowEnd":5}}`: true,
		`{"fileType":"csv","table":{"sheetName":"","headerRow":1,"rowStart":3,"rowEnd":4}}`:    true,
		`{"fileType":"txt","table":{"headerRow":1,"rowStart":3,"rowEnd":4}}`:                   false,
		`{"fileType":"csv","table":{"headerRow":3,"rowStart":2,"rowEnd":4}}`:                   false,
		`{"fileType":"xlsx","table":{"headerRow":1,"rowStart":3,"rowEnd":4}}`:                  false,
		`{"fileType":"csv","table":{"headerRow":1,"rowStart":3,"rowEnd":100001}}`:              false,
	} {
		if got := chunkTableSource(datatypes.JSON(raw)); (got != nil) != valid {
			t.Errorf("unexpected table source for %s: %#v", raw, got)
		}
	}
	first, second := uuid.New(), uuid.New()
	kb := knowledgeBaseWithRetrievalConfig(t, dto.RetrievalConfig{VectorTopN: 3, RerankTopK: 2, EnableRerank: true})
	s, _, chunks := newTestServiceWithKB(config.Config{VectorTopN: 3, RerankTopK: 2, RerankEnabled: true, RerankFailureMode: "strict"}, kb,
		nil, []rerank.Result{{ID: second.String(), Score: 0.9}, {ID: first.String(), Score: 0.5}}, nil)
	n := int64(2)
	chunks.searchable = &n
	chunks.exactCandidates = []repository.SearchResult{
		withOffsets(searchResult(first, 0.9), `{"fileType":"csv","table":{"sheetName":"","headerRow":1,"rowStart":3,"rowEnd":4}}`),
		withOffsets(searchResult(second, 0.8), `{"fileType":"xlsx","table":{"sheetName":"销售","headerRow":2,"rowStart":5,"rowEnd":5}}`),
	}
	res, err := s.Search(context.Background(), uuid.New(), uuid.New(), dto.SearchRequest{Query: "销售"})
	if err != nil || len(res.Items) != 2 {
		t.Fatalf("search: %#v %v", res, err)
	}
	if res.Items[0].ChunkID != second.String() || res.Items[0].Table == nil || res.Items[0].Table.SheetName != "销售" || res.Items[0].Table.RowStart != 5 || res.Items[1].Table == nil || res.Items[1].Table.RowEnd != 4 {
		t.Fatalf("table metadata mixed after ranking: %#v", res.Items)
	}
}
