package retrieval

import (
	"context"
	"errors"
	"github.com/google/uuid"
	"gorm.io/datatypes"
	"kbchat/backend/internal/config"
	"kbchat/backend/internal/dto"
	"kbchat/backend/internal/model"
	"kbchat/backend/internal/repository"
	"kbchat/backend/internal/rerank"
	"testing"
)

type multiBases map[uuid.UUID]*model.KnowledgeBase

func (f multiBases) FindByID(_ context.Context, id uuid.UUID) (*model.KnowledgeBase, error) {
	return f[id], nil
}
func (f multiBases) FindMemberRole(context.Context, uuid.UUID, uuid.UUID) (string, error) {
	return "", nil
}

type multiChunks map[uuid.UUID]*fakeChunkStore

func (f multiChunks) SearchByVector(c context.Context, id uuid.UUID, v []float32, n int) ([]repository.SearchResult, error) {
	return f[id].SearchByVector(c, id, v, n)
}
func (f multiChunks) SearchByVectorExact(c context.Context, id uuid.UUID, v []float32, n int) ([]repository.SearchResult, error) {
	return f[id].SearchByVectorExact(c, id, v, n)
}
func (f multiChunks) CountVectorSearchable(c context.Context, id uuid.UUID) (int64, error) {
	return f[id].CountVectorSearchable(c, id)
}
func (f multiChunks) SearchByKeyword(c context.Context, id uuid.UUID, q string, n int) ([]repository.SearchResult, error) {
	return f[id].SearchByKeyword(c, id, q, n)
}

type countingEmbedding struct{ calls int }

func (f *countingEmbedding) EmbedTexts(context.Context, []string) ([][]float32, error) {
	f.calls++
	return [][]float32{{1, 0}}, nil
}

type countingRerank struct {
	fakeReranker
	calls int
}

func (f *countingRerank) Rerank(c context.Context, q string, docs []rerank.Document) ([]rerank.Result, error) {
	f.calls++
	return f.fakeReranker.Rerank(c, q, docs)
}

func TestMultiRecallOneEmbeddingGlobalRerankAndFairBudget(t *testing.T) {
	ctx := context.Background()
	owner, a, b := uuid.New(), uuid.New(), uuid.New()
	one, two, extra := searchResult(uuid.New(), .99), searchResult(uuid.New(), .1), searchResult(uuid.New(), .98)
	bases := multiBases{a: {ID: a, OwnerID: owner, Name: "制度", RetrievalConfig: datatypes.JSON(`{"vectorTopN":1,"rerankTopK":1,"enableRerank":false}`)}, b: {ID: b, OwnerID: owner, Name: "产品"}}
	chunks := multiChunks{a: {candidates: []repository.SearchResult{one, extra}}, b: {candidates: []repository.SearchResult{two}}}
	embed := &countingEmbedding{}
	rank := &countingRerank{fakeReranker: fakeReranker{results: []rerank.Result{{ID: two.ChunkID.String(), Score: .9}, {ID: one.ChunkID.String(), Score: .8}}}}
	s := NewService(config.Config{RerankEnabled: true, VectorTopN: 2, RerankTopK: 2}, chunks, bases, embed, rank)
	for _, ids := range [][]uuid.UUID{{a, b}, {b, a}} {
		res, err := s.SearchMany(ctx, owner, ids, dto.SearchRequest{Query: "问题", Debug: true})
		if err != nil {
			t.Fatal(err)
		}
		if len(rank.docs) != 2 || len(res.Items) != 2 || res.Items[0].ChunkID != two.ChunkID.String() {
			t.Fatalf("global ranking/quota: %+v %+v", rank.docs, res.Items)
		}
		if res.Items[0].KnowledgeBaseID != b.String() || res.Items[0].KnowledgeBaseName != "产品" || res.Items[1].KnowledgeBaseID != a.String() {
			t.Fatalf("missing provenance: %+v", res.Items)
		}
		if len(res.Debug.RerankStage.Input) != 2 {
			t.Fatal("debug must describe the global candidate list")
		}
	}
	if embed.calls != 2 || rank.calls != 2 {
		t.Fatalf("expected one embedding and rerank per request: %d/%d", embed.calls, rank.calls)
	}
	delete(bases, b)
	if _, err := s.SearchMany(ctx, owner, []uuid.UUID{a, b}, dto.SearchRequest{Query: "secret"}); err == nil {
		t.Fatal("unauthorized base accepted")
	}
	if embed.calls != 2 || rank.calls != 2 {
		t.Fatal("model called before every base was authorized")
	}
}

func TestMultiRecallEmptyBaseAndKeywordFailure(t *testing.T) {
	owner, a, b := uuid.New(), uuid.New(), uuid.New()
	bases := multiBases{a: {ID: a, OwnerID: owner}, b: {ID: b, OwnerID: owner}}
	one, two := searchResult(uuid.New(), .8), searchResult(uuid.New(), .7)
	chunks := multiChunks{a: {candidates: []repository.SearchResult{one, two}}, b: {}}
	s := NewService(config.Config{VectorTopN: 2, RerankTopK: 2, KeywordSearchEnabled: true}, chunks, bases, &countingEmbedding{}, nil)
	chunks[b].keywordErr = errors.New("keyword unavailable")
	res, err := s.SearchMany(context.Background(), owner, []uuid.UUID{a, b}, dto.SearchRequest{Query: "q", Debug: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Items) != 2 || res.Debug.KeywordStage.Status != "failed" || res.Debug.FusionStage.Status != "skipped" {
		t.Fatalf("fallback/empty base: %+v", res)
	}
	for _, ids := range [][]uuid.UUID{nil, {a, a}, {a, uuid.Nil}, {a, b, uuid.New(), uuid.New(), uuid.New(), uuid.New()}} {
		if _, err := s.SearchMany(context.Background(), owner, ids, dto.SearchRequest{Query: "q"}); err == nil {
			t.Fatal("invalid scope accepted")
		}
	}
}
