package retrieval

import (
	"context"
	"fmt"
	"testing"

	"github.com/google/uuid"
	"gorm.io/datatypes"
	"kbchat/backend/internal/config"
	"kbchat/backend/internal/dto"
	"kbchat/backend/internal/model"
	"kbchat/backend/internal/repository"
	"kbchat/backend/internal/rerank"
)

func TestAutomaticRecallUsesGlobalBudgetAndCanChangeLibraries(t *testing.T) {
	owner := uuid.New()
	bases := multiBases{}
	chunks := multiChunks{}
	ids := []uuid.UUID{}
	for i := 1; i <= 7; i++ {
		id := uuid.MustParse(fmt.Sprintf("00000000-0000-0000-0000-%012d", i))
		ids = append(ids, id)
		bases[id] = &model.KnowledgeBase{ID: id, OwnerID: owner, Name: fmt.Sprintf("库%d", i), RetrievalConfig: datatypes.JSON(`{"vectorTopN":1,"rerankTopK":1,"scoreThreshold":1}`)}
		chunks[id] = &fakeChunkStore{candidates: []repository.SearchResult{searchResult(uuid.New(), float64(i)/10)}}
	}
	embed := &countingEmbedding{}
	rank := &countingRerank{fakeReranker: fakeReranker{results: []rerank.Result{{ID: chunks[ids[6]].candidates[0].ChunkID.String(), Score: .95}}}}
	s := NewService(config.Config{RerankEnabled: true, VectorTopN: 2, RerankTopK: 1}, chunks, bases, embed, rank)
	first, err := s.SearchAutomatic(context.Background(), owner, ids, dto.SearchRequest{Query: "产品问题", Debug: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(rank.docs) != 2 || len(first.Items) != 1 || first.Items[0].KnowledgeBaseID != ids[6].String() {
		t.Fatalf("later library omitted or unbounded rerank: %+v %+v", rank.docs, first.Items)
	}
	if embed.calls != 1 || rank.calls != 1 {
		t.Fatalf("expected one embedding/rerank: %d/%d", embed.calls, rank.calls)
	}
	chunks[ids[0]].candidates[0].VectorScore = .99
	rank.results = []rerank.Result{{ID: chunks[ids[0]].candidates[0].ChunkID.String(), Score: .97}}
	second, err := s.SearchAutomatic(context.Background(), owner, ids, dto.SearchRequest{Query: "制度问题"})
	if err != nil || len(second.Items) != 1 || second.Items[0].KnowledgeBaseID != ids[0].String() {
		t.Fatalf("did not change library: %+v %v", second, err)
	}
	if _, err = s.SearchMany(context.Background(), owner, ids, dto.SearchRequest{Query: "manual"}); err == nil {
		t.Fatal("manual cap changed")
	}
	bases[ids[0]].OwnerID = uuid.New()
	if _, err = s.SearchAutomatic(context.Background(), owner, ids, dto.SearchRequest{Query: "unauthorized"}); err == nil || embed.calls != 2 {
		t.Fatal("unauthorized automatic scope reached a model")
	}
}

func TestAutomaticSingleLibraryUsesSystemDefaults(t *testing.T) {
	owner, id := uuid.New(), uuid.New()
	bases := multiBases{id: {ID: id, OwnerID: owner, RetrievalConfig: datatypes.JSON(`{"vectorTopN":1,"rerankTopK":1,"scoreThreshold":1}`)}}
	chunks := multiChunks{id: {candidates: []repository.SearchResult{searchResult(uuid.New(), .8), searchResult(uuid.New(), .7)}}}
	s := NewService(config.Config{VectorTopN: 2, RerankTopK: 2, ScoreThreshold: .1}, chunks, bases, &countingEmbedding{}, nil)
	res, err := s.SearchAutomatic(context.Background(), owner, []uuid.UUID{id}, dto.SearchRequest{Query: "q"})
	if err != nil || len(res.Items) != 2 {
		t.Fatalf("inherited per-library settings: %+v %v", res, err)
	}
}
