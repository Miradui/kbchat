package retrieval

import (
	"context"
	"sort"

	"github.com/google/uuid"

	"rag/backend/internal/apperror"
	"rag/backend/internal/config"
	"rag/backend/internal/dto"
	"rag/backend/internal/embedding"
	"rag/backend/internal/repository"
	"rag/backend/internal/rerank"
)

type Service struct {
	cfg            config.Config
	chunks         *repository.ChunkRepository
	knowledgeBases *repository.KnowledgeBaseRepository
	embedder       embedding.Provider
	reranker       rerank.Provider
}

func NewService(
	cfg config.Config,
	chunks *repository.ChunkRepository,
	knowledgeBases *repository.KnowledgeBaseRepository,
	embedder embedding.Provider,
	reranker rerank.Provider,
) *Service {
	return &Service{
		cfg:            cfg,
		chunks:         chunks,
		knowledgeBases: knowledgeBases,
		embedder:       embedder,
		reranker:       reranker,
	}
}

func (s *Service) Search(ctx context.Context, ownerID, kbID uuid.UUID, req dto.SearchRequest) (*dto.SearchResponse, error) {
	kb, err := s.knowledgeBases.FindByIDAndOwner(ctx, kbID, ownerID)
	if err != nil {
		return nil, apperror.Internal(err)
	}
	if kb == nil {
		return nil, apperror.NotFound("KNOWLEDGE_BASE_NOT_FOUND", "knowledge base not found")
	}

	vectorTopN := req.VectorTopN
	if vectorTopN <= 0 {
		vectorTopN = s.cfg.VectorTopN
	}
	rerankTopK := req.RerankTopK
	if rerankTopK <= 0 {
		rerankTopK = s.cfg.RerankTopK
	}
	enableRerank := s.cfg.RerankEnabled
	if req.EnableRerank != nil {
		enableRerank = *req.EnableRerank
	}

	embeddings, err := s.embedder.EmbedTexts(ctx, []string{req.Query})
	if err != nil {
		return nil, apperror.Wrap(500, "EMBEDDING_FAILED", "embedding failed", err)
	}
	if len(embeddings) != 1 {
		return nil, apperror.New(500, "EMBEDDING_FAILED", "embedding failed")
	}

	candidates, err := s.chunks.SearchByVector(ctx, kbID, embeddings[0], vectorTopN)
	if err != nil {
		return nil, apperror.Internal(err)
	}

	if enableRerank {
		candidates, err = s.rerank(ctx, req.Query, candidates, rerankTopK)
		if err != nil {
			return nil, apperror.Wrap(500, "RERANK_FAILED", "retrieval rerank failed", err)
		}
	} else if rerankTopK > 0 && len(candidates) > rerankTopK {
		candidates = candidates[:rerankTopK]
	}

	items := make([]dto.SearchResultResponse, 0, len(candidates))
	for _, item := range candidates {
		items = append(items, dto.SearchResultResponse{
			ChunkID:     item.ChunkID.String(),
			DocumentID:  item.DocumentID.String(),
			Filename:    item.Filename,
			Content:     item.Content,
			PageNumber:  item.PageNumber,
			VectorScore: item.VectorScore,
			RerankScore: item.RerankScore,
		})
	}

	return &dto.SearchResponse{Items: items}, nil
}

func (s *Service) rerank(ctx context.Context, query string, candidates []repository.SearchResult, topK int) ([]repository.SearchResult, error) {
	docs := make([]rerank.Document, 0, len(candidates))
	for _, candidate := range candidates {
		docs = append(docs, rerank.Document{
			ID:      candidate.ChunkID.String(),
			Content: candidate.Content,
		})
	}

	results, err := s.reranker.Rerank(ctx, query, docs)
	if err != nil {
		return nil, err
	}

	scoreByID := make(map[string]float64, len(results))
	for _, result := range results {
		scoreByID[result.ID] = result.Score
	}

	reranked := make([]repository.SearchResult, 0, len(candidates))
	for _, candidate := range candidates {
		score, ok := scoreByID[candidate.ChunkID.String()]
		if !ok {
			continue
		}
		candidate.RerankScore = &score
		reranked = append(reranked, candidate)
	}

	sort.SliceStable(reranked, func(i, j int) bool {
		return *reranked[i].RerankScore > *reranked[j].RerankScore
	})
	if topK > 0 && len(reranked) > topK {
		reranked = reranked[:topK]
	}
	return reranked, nil
}
