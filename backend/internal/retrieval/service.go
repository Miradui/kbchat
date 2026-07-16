package retrieval

import (
	"context"
	"encoding/json"
	"sort"

	"github.com/google/uuid"

	"rag/backend/internal/apperror"
	"rag/backend/internal/config"
	"rag/backend/internal/dto"
	"rag/backend/internal/embedding"
	"rag/backend/internal/model"
	"rag/backend/internal/repository"
	"rag/backend/internal/rerank"
)

const (
	rerankFailureModeFallback   = "fallback"
	rerankFallbackProviderError = "provider_unavailable"
	defaultVectorTopN           = 30
	defaultRerankTopK           = 5
	maxVectorTopN               = 100
	maxRerankTopK               = 20
)

type searchOptions struct {
	vectorTopN     int
	rerankTopK     int
	scoreThreshold float64
	enableRerank   bool
}

type chunkSearcher interface {
	SearchByVector(ctx context.Context, kbID uuid.UUID, vector []float32, limit int) ([]repository.SearchResult, error)
}

type knowledgeBaseFinder interface {
	FindByIDAndOwner(ctx context.Context, id, ownerID uuid.UUID) (*model.KnowledgeBase, error)
}

type Service struct {
	cfg            config.Config
	chunks         chunkSearcher
	knowledgeBases knowledgeBaseFinder
	embedder       embedding.Provider
	reranker       rerank.Provider
}

func NewService(
	cfg config.Config,
	chunks chunkSearcher,
	knowledgeBases knowledgeBaseFinder,
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

	options := s.resolveSearchOptions(kb, req)

	embeddings, err := s.embedder.EmbedTexts(ctx, []string{req.Query})
	if err != nil {
		return nil, apperror.Wrap(500, "EMBEDDING_FAILED", "embedding failed", err)
	}
	if len(embeddings) != 1 {
		return nil, apperror.New(500, "EMBEDDING_FAILED", "embedding failed")
	}

	candidates, err := s.chunks.SearchByVector(ctx, kbID, embeddings[0], options.vectorTopN)
	if err != nil {
		return nil, apperror.Internal(err)
	}

	vectorCandidates := limitSearchResults(candidates, options.vectorTopN)
	candidates = vectorCandidates
	rerankCandidates := []repository.SearchResult{}
	rerankStageStatus := "disabled"
	var rerankFallback *dto.RerankFallbackResponse
	if options.enableRerank {
		rerankCandidates, err = s.rerank(ctx, req.Query, vectorCandidates, 0)
		if err != nil {
			if s.cfg.RerankFailureMode == rerankFailureModeFallback {
				candidates = filterSearchResults(vectorCandidates, options.scoreThreshold, false)
				candidates = fallbackVectorTopK(candidates, options.rerankTopK)
				rerankStageStatus = "fallback"
				rerankFallback = &dto.RerankFallbackResponse{
					Used:   true,
					Reason: rerankFallbackProviderError,
				}
			} else {
				return nil, apperror.Wrap(500, "RERANK_FAILED", "retrieval rerank failed", err)
			}
		} else {
			rerankStageStatus = "completed"
			candidates = filterSearchResults(rerankCandidates, options.scoreThreshold, true)
			candidates = limitSearchResults(candidates, options.rerankTopK)
		}
	} else {
		candidates = filterSearchResults(vectorCandidates, options.scoreThreshold, false)
		candidates = limitSearchResults(candidates, options.rerankTopK)
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

	res := &dto.SearchResponse{Items: items, RerankFallback: rerankFallback}
	if req.Debug {
		res.Debug = buildSearchDebugResponse(req.Query, vectorCandidates, rerankCandidates, candidates, rerankStageStatus, rerankFallback)
	}
	return res, nil
}

func (s *Service) resolveSearchOptions(kb *model.KnowledgeBase, req dto.SearchRequest) searchOptions {
	kbConfig := dto.RetrievalConfig{
		VectorTopN:     positiveOrDefault(s.cfg.VectorTopN, defaultVectorTopN),
		RerankTopK:     positiveOrDefault(s.cfg.RerankTopK, defaultRerankTopK),
		ScoreThreshold: normalizedScoreThreshold(s.cfg.ScoreThreshold),
		EnableRerank:   s.cfg.RerankEnabled,
	}
	if len(kb.RetrievalConfig) > 0 {
		storedConfig := kbConfig
		if err := json.Unmarshal(kb.RetrievalConfig, &storedConfig); err == nil {
			kbConfig = storedConfig
		}
	}

	vectorTopN := kbConfig.VectorTopN
	if req.VectorTopN > 0 {
		vectorTopN = req.VectorTopN
	}
	vectorTopN = cappedPositive(vectorTopN, positiveOrDefault(s.cfg.VectorTopN, defaultVectorTopN), maxVectorTopN)

	rerankTopK := kbConfig.RerankTopK
	if req.RerankTopK > 0 {
		rerankTopK = req.RerankTopK
	}
	rerankTopK = cappedPositive(rerankTopK, positiveOrDefault(s.cfg.RerankTopK, defaultRerankTopK), maxRerankTopK)
	if rerankTopK > vectorTopN {
		rerankTopK = vectorTopN
	}

	enableRerank := kbConfig.EnableRerank
	if req.EnableRerank != nil {
		enableRerank = *req.EnableRerank
	}
	if !s.cfg.RerankEnabled {
		enableRerank = false
	}

	return searchOptions{
		vectorTopN:     vectorTopN,
		rerankTopK:     rerankTopK,
		scoreThreshold: normalizedScoreThreshold(kbConfig.ScoreThreshold),
		enableRerank:   enableRerank,
	}
}

func positiveOrDefault(value, fallback int) int {
	if value > 0 {
		return value
	}
	return fallback
}

func cappedPositive(value, fallback, maximum int) int {
	value = positiveOrDefault(value, fallback)
	if value > maximum {
		return maximum
	}
	return value
}

func normalizedScoreThreshold(value float64) float64 {
	if value < 0 {
		return 0
	}
	if value > 1 {
		return 1
	}
	return value
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

func fallbackVectorTopK(candidates []repository.SearchResult, topK int) []repository.SearchResult {
	candidates = limitSearchResults(candidates, topK)
	for i := range candidates {
		candidates[i].RerankScore = nil
	}
	return candidates
}

func limitSearchResults(candidates []repository.SearchResult, topK int) []repository.SearchResult {
	if topK > 0 && len(candidates) > topK {
		return candidates[:topK]
	}
	return candidates
}

func filterSearchResults(candidates []repository.SearchResult, threshold float64, useRerankScore bool) []repository.SearchResult {
	filtered := make([]repository.SearchResult, 0, len(candidates))
	for _, candidate := range candidates {
		score := candidate.VectorScore
		if useRerankScore {
			if candidate.RerankScore == nil {
				continue
			}
			score = *candidate.RerankScore
		}
		if score >= threshold {
			filtered = append(filtered, candidate)
		}
	}
	return filtered
}

func buildSearchDebugResponse(
	query string,
	vectorCandidates []repository.SearchResult,
	rerankCandidates []repository.SearchResult,
	finalCandidates []repository.SearchResult,
	rerankStageStatus string,
	rerankFallback *dto.RerankFallbackResponse,
) *dto.SearchDebugResponse {
	return &dto.SearchDebugResponse{
		Query: query,
		VectorStage: dto.SearchDebugVectorStage{
			Status: "completed",
			Items:  toDebugVectorItems(vectorCandidates),
		},
		RerankStage: dto.SearchDebugRerankStage{
			Status: rerankStageStatus,
			Input:  toDebugRerankInput(vectorCandidates),
			Output: toDebugRerankOutput(rerankCandidates),
		},
		FinalStage: dto.SearchDebugFinalStage{
			Items: toDebugFinalItems(finalCandidates),
		},
		RerankFallback: rerankFallback,
	}
}

func toDebugVectorItems(candidates []repository.SearchResult) []dto.SearchDebugVectorItem {
	items := make([]dto.SearchDebugVectorItem, 0, len(candidates))
	for i, candidate := range candidates {
		items = append(items, dto.SearchDebugVectorItem{
			ChunkID:     candidate.ChunkID.String(),
			DocumentID:  candidate.DocumentID.String(),
			Filename:    candidate.Filename,
			PageNumber:  candidate.PageNumber,
			Content:     candidate.Content,
			VectorScore: candidate.VectorScore,
			Rank:        i + 1,
		})
	}
	return items
}

func toDebugRerankInput(candidates []repository.SearchResult) []dto.SearchDebugRerankInput {
	items := make([]dto.SearchDebugRerankInput, 0, len(candidates))
	for i, candidate := range candidates {
		items = append(items, dto.SearchDebugRerankInput{
			ChunkID:    candidate.ChunkID.String(),
			PageNumber: candidate.PageNumber,
			Rank:       i + 1,
		})
	}
	return items
}

func toDebugRerankOutput(candidates []repository.SearchResult) []dto.SearchDebugRerankOutput {
	items := make([]dto.SearchDebugRerankOutput, 0, len(candidates))
	for i, candidate := range candidates {
		items = append(items, dto.SearchDebugRerankOutput{
			ChunkID:     candidate.ChunkID.String(),
			PageNumber:  candidate.PageNumber,
			RerankScore: candidate.RerankScore,
			Rank:        i + 1,
		})
	}
	return items
}

func toDebugFinalItems(candidates []repository.SearchResult) []dto.SearchDebugFinalItem {
	items := make([]dto.SearchDebugFinalItem, 0, len(candidates))
	for i, candidate := range candidates {
		items = append(items, dto.SearchDebugFinalItem{
			ChunkID:     candidate.ChunkID.String(),
			PageNumber:  candidate.PageNumber,
			VectorScore: candidate.VectorScore,
			RerankScore: candidate.RerankScore,
			Rank:        i + 1,
		})
	}
	return items
}
