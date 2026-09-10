package retrieval

import (
	"context"
	"encoding/json"
	"sort"
	"time"

	"github.com/google/uuid"

	"kbchat/backend/internal/access"
	"kbchat/backend/internal/apperror"
	"kbchat/backend/internal/authz"
	"kbchat/backend/internal/config"
	"kbchat/backend/internal/dto"
	"kbchat/backend/internal/embedding"
	"kbchat/backend/internal/model"
	"kbchat/backend/internal/observability"
	"kbchat/backend/internal/repository"
	"kbchat/backend/internal/rerank"
)

const (
	rerankFailureModeFallback   = "fallback"
	rerankFallbackProviderError = "provider_unavailable"
	defaultVectorTopN           = 30
	defaultRerankTopK           = 5
)

// MaxVectorTopN and MaxRerankTopK are the hard ceilings applied to every
// retrieval request. GET /api/v1/system/capabilities publishes them so the
// frontend retrieval form validates against the same numbers.
const (
	MaxVectorTopN = 100
	MaxRerankTopK = 20
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

// knowledgeBaseFinder is what the authorization decision needs. It matches
// authz.KnowledgeBaseFinder; the interface is redeclared here so this package keeps
// stating its own dependency rather than inheriting one.
type knowledgeBaseFinder interface {
	FindByID(ctx context.Context, id uuid.UUID) (*model.KnowledgeBase, error)
	FindMemberRole(ctx context.Context, kbID, userID uuid.UUID) (string, error)
}

type Service struct {
	cfg            config.Config
	chunks         chunkSearcher
	knowledgeBases knowledgeBaseFinder
	embedder       embedding.Provider
	reranker       rerank.Provider
	metrics        *observability.Recorder
}

// SetRecorder wires retrieval timings and provider outcomes into the diagnostics
// endpoint. Optional, following the SetActivityRecorder precedent, so the
// constructor signature and its existing callers stay unchanged. The recorder is
// nil-safe, so an unset one simply records nothing.
func (s *Service) SetRecorder(recorder *observability.Recorder) {
	s.metrics = recorder
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
	if req.ScoreThreshold != nil && (*req.ScoreThreshold < 0 || *req.ScoreThreshold > 1) {
		return nil, apperror.Validation(map[string]any{"scoreThreshold": "must be between 0 and 1"})
	}
	// Search is kb.search, not kb.read: a viewer may retrieve, and this is the same
	// check the chat path makes before answering, so a member cannot reach through
	// retrieval what they could not reach through chat.
	decision, err := authz.KnowledgeBase(ctx, s.knowledgeBases, ownerID, kbID, access.CapKnowledgeBaseSearch)
	if err != nil {
		return nil, err
	}
	kb := decision.KnowledgeBase

	options := s.resolveSearchOptions(kb, req)

	// Timed from here rather than from function entry: the authorization lookup
	// above is not retrieval work, and including it would make the metric partly a
	// measure of how often callers pass bad IDs.
	retrievalStart := time.Now()

	embeddingStart := time.Now()
	embeddings, err := s.embedder.EmbedTexts(ctx, []string{req.Query})
	s.metrics.RecordProviderResult(observability.ProviderEmbedding, err)
	if err == nil {
		s.metrics.ObserveSince(observability.MetricEmbedding, embeddingStart)
	}
	if err != nil {
		return nil, apperror.Wrap(500, "EMBEDDING_FAILED", "知识检索暂时不可用，请稍后重试", err)
	}
	if len(embeddings) != 1 {
		return nil, apperror.New(500, "EMBEDDING_FAILED", "知识检索暂时不可用，请稍后重试")
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
		rerankStart := time.Now()
		rerankCandidates, err = s.rerank(ctx, req.Query, vectorCandidates, 0)
		s.metrics.RecordProviderResult(observability.ProviderRerank, err)
		if err == nil {
			s.metrics.ObserveSince(observability.MetricRerank, rerankStart)
		}
		if err != nil {
			if s.cfg.RerankFailureMode == rerankFailureModeFallback {
				candidates = filterSearchResults(vectorCandidates, options.scoreThreshold, false)
				candidates = fallbackVectorTopK(candidates, options.rerankTopK)
				rerankStageStatus = "fallback"
				rerankFallback = &dto.RerankFallbackResponse{
					Used:   true,
					Reason: rerankFallbackProviderError,
				}
				s.metrics.RecordRerankFallback(rerankFallbackProviderError)
			} else {
				return nil, apperror.Wrap(500, "RERANK_FAILED", "知识检索排序暂时不可用，请稍后重试", err)
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

	s.metrics.ObserveSince(observability.MetricRetrieval, retrievalStart)

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
	vectorTopN = cappedPositive(vectorTopN, positiveOrDefault(s.cfg.VectorTopN, defaultVectorTopN), MaxVectorTopN)

	rerankTopK := kbConfig.RerankTopK
	if req.RerankTopK > 0 {
		rerankTopK = req.RerankTopK
	}
	rerankTopK = cappedPositive(rerankTopK, positiveOrDefault(s.cfg.RerankTopK, defaultRerankTopK), MaxRerankTopK)
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
	threshold := kbConfig.ScoreThreshold
	if req.ScoreThreshold != nil {
		threshold = *req.ScoreThreshold
	}

	return searchOptions{
		vectorTopN:     vectorTopN,
		rerankTopK:     rerankTopK,
		scoreThreshold: normalizedScoreThreshold(threshold),
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
