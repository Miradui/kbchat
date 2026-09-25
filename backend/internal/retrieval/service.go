package retrieval

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"go.uber.org/zap"
	"gorm.io/datatypes"

	"kbchat/backend/internal/access"
	"kbchat/backend/internal/apperror"
	"kbchat/backend/internal/authz"
	"kbchat/backend/internal/cache"
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
	enableKeyword  bool
}

type chunkSearcher interface {
	SearchByVector(ctx context.Context, kbID uuid.UUID, vector []float32, limit int) ([]repository.SearchResult, error)
	SearchByVectorExact(ctx context.Context, kbID uuid.UUID, vector []float32, limit int) ([]repository.SearchResult, error)
	CountVectorSearchable(ctx context.Context, kbID uuid.UUID) (int64, error)
	SearchByKeyword(ctx context.Context, kbID uuid.UUID, query string, limit int) ([]repository.SearchResult, error)
}

// knowledgeBaseFinder is what the authorization decision needs. It matches
// authz.KnowledgeBaseFinder; the interface is redeclared here so this package keeps
// stating its own dependency rather than inheriting one.
type knowledgeBaseFinder interface {
	FindByID(ctx context.Context, id uuid.UUID) (*model.KnowledgeBase, error)
	FindMemberRole(ctx context.Context, kbID, userID uuid.UUID) (string, error)
}

type queryEmbeddingCache interface {
	Get(ctx context.Context, model, query string) ([]float32, bool, error)
	Set(ctx context.Context, model, query string, vector []float32, ttl time.Duration) error
}

type Service struct {
	cfg            config.Config
	chunks         chunkSearcher
	knowledgeBases knowledgeBaseFinder
	embedder       embedding.Provider
	reranker       rerank.Provider
	metrics        *observability.Recorder
	embeddingCache queryEmbeddingCache
}

// SetRecorder wires retrieval timings and provider outcomes into the diagnostics
// endpoint. Optional, following the SetActivityRecorder precedent, so the
// constructor signature and its existing callers stay unchanged. The recorder is
// nil-safe, so an unset one simply records nothing.
func (s *Service) SetRecorder(recorder *observability.Recorder) {
	s.metrics = recorder
}

// SetEmbeddingCache wires the optional Redis-backed query cache. Retrieval
// remains usable when it is absent or unavailable; failures are recorded and
// the provider remains the source of truth.
func (s *Service) SetEmbeddingCache(embeddingCache queryEmbeddingCache) {
	s.embeddingCache = embeddingCache
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

	queryVector, err := s.queryEmbedding(ctx, req.Query)
	if err != nil {
		return nil, apperror.Wrap(500, "EMBEDDING_FAILED", "知识检索暂时不可用，请稍后重试", err)
	}

	vectorCandidates, err := s.chunks.SearchByVector(ctx, kbID, queryVector, options.vectorTopN)
	if err != nil {
		return nil, apperror.Internal(err)
	}
	vectorCandidates = limitSearchResults(vectorCandidates, options.vectorTopN)
	vectorCandidates, exactFallback, err := s.completeVectorRecall(ctx, kbID, queryVector, options.vectorTopN, vectorCandidates)
	if err != nil {
		return nil, apperror.Internal(err)
	}

	// Keyword recall runs after the vector stage rather than concurrently: the
	// two queries share the same pool and the keyword one is cheap, so the
	// simpler sequential code is not worth trading for a goroutine here.
	keywordCandidates := []repository.SearchResult{}
	keywordStageStatus := "disabled"
	fusionStageStatus := "skipped"
	var fused []fusedCandidate
	keywordFailed := false
	if options.enableKeyword {
		keywordStart := time.Now()
		keywordCandidates, err = s.chunks.SearchByKeyword(ctx, kbID, req.Query, options.vectorTopN)
		s.metrics.RecordProviderResult(observability.ProviderKeyword, err)
		if err != nil {
			// Keyword recall is an addition to vector recall, not a prerequisite:
			// a broken GIN index or a missing search_vector column must not take
			// down retrieval that worked before hybrid search existed. The stage
			// is reported as failed in debug output and the vector list is used
			// alone, with vector-score thresholds as before.
			if log := s.metrics.Logger(); log != nil {
				log.Warn("keyword recall failed; falling back to vector recall", zap.String("knowledgeBaseId", kbID.String()), zap.Error(err))
			}
			keywordFailed = true
			keywordCandidates = nil
			keywordStageStatus = "failed"
			fusionStageStatus = "skipped"
			fused = fuseByReciprocalRank(vectorCandidates, nil, options.vectorTopN)
			for i := range fused {
				fused[i].FusionScore = nil
			}
		} else {
			s.metrics.ObserveSince(observability.MetricKeyword, keywordStart)
			keywordCandidates = limitSearchResults(keywordCandidates, options.vectorTopN)
			keywordStageStatus = "completed"
			fusionStageStatus = "completed"
			fused = fuseByReciprocalRank(vectorCandidates, keywordCandidates, options.vectorTopN)
		}
	} else {
		fused = fuseByReciprocalRank(vectorCandidates, nil, options.vectorTopN)
		for i := range fused {
			fused[i].FusionScore = nil
		}
	}
	rerankInput := searchResultsOf(fused)

	// Without a successful Rerank the threshold has to be applied to whatever
	// score ordered the list. That is the vector score when keyword recall is
	// off (unchanged behavior) and the normalized fusion score when it is on,
	// because a keyword-only chunk has no vector score to compare.
	thresholdScore := scoreVector
	if options.enableKeyword && !keywordFailed {
		thresholdScore = scoreFusion
	}

	candidates := rerankInput
	rerankCandidates := []repository.SearchResult{}
	rerankStageStatus := "disabled"
	var rerankFallback *dto.RerankFallbackResponse
	if options.enableRerank {
		rerankStart := time.Now()
		rerankCandidates, err = s.rerank(ctx, req.Query, rerankInput, 0)
		s.metrics.RecordProviderResult(observability.ProviderRerank, err)
		if err == nil {
			s.metrics.ObserveSince(observability.MetricRerank, rerankStart)
		}
		if err != nil {
			if s.cfg.RerankFailureMode == rerankFailureModeFallback {
				candidates = filterSearchResults(rerankInput, options.scoreThreshold, thresholdScore)
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
			candidates = filterSearchResults(rerankCandidates, options.scoreThreshold, scoreRerank)
			candidates = limitSearchResults(candidates, options.rerankTopK)
		}
	} else {
		candidates = filterSearchResults(rerankInput, options.scoreThreshold, thresholdScore)
		candidates = limitSearchResults(candidates, options.rerankTopK)
	}

	items := make([]dto.SearchResultResponse, 0, len(candidates))
	for _, item := range candidates {
		start, end := chunkSourceOffsets(item.Metadata)
		items = append(items, dto.SearchResultResponse{
			ChunkID:      item.ChunkID.String(),
			DocumentID:   item.DocumentID.String(),
			Filename:     item.Filename,
			Content:      item.Content,
			PageNumber:   item.PageNumber,
			VectorScore:  item.VectorScore,
			KeywordScore: item.KeywordScore,
			RerankScore:  item.RerankScore,
			StartOffset:  start,
			EndOffset:    end,
		})
	}

	s.metrics.ObserveSince(observability.MetricRetrieval, retrievalStart)

	res := &dto.SearchResponse{Items: items, RerankFallback: rerankFallback}
	if req.Debug {
		res.Debug = buildSearchDebugResponse(searchDebugInput{
			query:              req.Query,
			vectorCandidates:   vectorCandidates,
			exactFallback:      exactFallback,
			keywordCandidates:  keywordCandidates,
			keywordStageStatus: keywordStageStatus,
			fused:              fused,
			fusionStageStatus:  fusionStageStatus,
			rerankInput:        rerankInput,
			rerankCandidates:   rerankCandidates,
			rerankStageStatus:  rerankStageStatus,
			finalCandidates:    candidates,
			rerankFallback:     rerankFallback,
		})
	}
	return res, nil
}

func (s *Service) queryEmbedding(ctx context.Context, query string) ([]float32, error) {
	normalizedQuery := cache.NormalizeEmbeddingQuery(query)
	cacheModel := s.embeddingCacheModelKey()
	if s.embeddingCache != nil {
		vector, hit, err := s.embeddingCache.Get(ctx, cacheModel, normalizedQuery)
		switch {
		case err != nil:
			s.metrics.RecordEmbeddingCacheResult(observability.EmbeddingCacheResultError)
		case hit:
			s.metrics.RecordEmbeddingCacheResult(observability.EmbeddingCacheResultHit)
			return vector, nil
		default:
			s.metrics.RecordEmbeddingCacheResult(observability.EmbeddingCacheResultMiss)
		}
	}

	embeddingStart := time.Now()
	embeddings, err := s.embedder.EmbedTexts(ctx, []string{normalizedQuery})
	s.metrics.RecordProviderResult(observability.ProviderEmbedding, err)
	if err == nil {
		s.metrics.ObserveSince(observability.MetricEmbedding, embeddingStart)
	}
	if err != nil {
		return nil, err
	}
	if len(embeddings) != 1 || len(embeddings[0]) == 0 {
		return nil, fmt.Errorf("embedding provider returned %d vectors", len(embeddings))
	}

	vector := embeddings[0]
	if s.embeddingCache != nil {
		if err := s.embeddingCache.Set(ctx, cacheModel, normalizedQuery, vector, s.cfg.EmbeddingCacheTTL); err != nil {
			s.metrics.RecordEmbeddingCacheResult(observability.EmbeddingCacheResultError)
		}
	}
	return vector, nil
}

// embeddingCacheModelKey namespaces cached vectors by everything that changes
// their meaning: the model name, the configured dimension and the endpoint.
// Switching any of them must miss the cache instead of serving vectors from
// the previous configuration for the rest of the TTL.
func (s *Service) embeddingCacheModelKey() string {
	endpoint := sha256.Sum256([]byte(strings.TrimSpace(s.cfg.EmbeddingBaseURL)))
	return fmt.Sprintf("%s:%d:%s", s.cfg.EmbeddingModel, s.cfg.EmbeddingDimension, hex.EncodeToString(endpoint[:6]))
}

func (s *Service) resolveSearchOptions(kb *model.KnowledgeBase, req dto.SearchRequest) searchOptions {
	kbConfig := dto.RetrievalConfig{
		VectorTopN:     positiveOrDefault(s.cfg.VectorTopN, defaultVectorTopN),
		RerankTopK:     positiveOrDefault(s.cfg.RerankTopK, defaultRerankTopK),
		ScoreThreshold: normalizedScoreThreshold(s.cfg.ScoreThreshold),
		EnableRerank:   s.cfg.RerankEnabled,
		EnableKeyword:  s.cfg.KeywordSearchEnabled,
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
	enableKeyword := kbConfig.EnableKeyword
	if req.EnableKeyword != nil {
		enableKeyword = *req.EnableKeyword
	}
	if !s.cfg.KeywordSearchEnabled {
		enableKeyword = false
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
		enableKeyword:  enableKeyword,
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

// thresholdScoreKind selects which score scoreThreshold is compared against.
type thresholdScoreKind int

const (
	scoreVector thresholdScoreKind = iota
	scoreFusion
	scoreRerank
)

// filterSearchResults keeps the candidates whose selected score reaches the
// threshold. A candidate lacking the selected score is dropped: it cannot be
// shown to have met the bar, and passing it through would let an unscored
// chunk into the prompt.
func filterSearchResults(candidates []repository.SearchResult, threshold float64, kind thresholdScoreKind) []repository.SearchResult {
	filtered := make([]repository.SearchResult, 0, len(candidates))
	for _, candidate := range candidates {
		var score float64
		switch kind {
		case scoreRerank:
			if candidate.RerankScore == nil {
				continue
			}
			score = *candidate.RerankScore
		case scoreFusion:
			if candidate.FusionScore == nil {
				continue
			}
			score = *candidate.FusionScore
		default:
			score = candidate.VectorScore
		}
		if score >= threshold {
			filtered = append(filtered, candidate)
		}
	}
	return filtered
}

// chunkSourceOffsets reads startOffset/endOffset from chunk metadata. Missing,
// malformed or inverted offsets yield nil: a citation without a location is
// still a citation, so this never fails the search.
func chunkSourceOffsets(metadata datatypes.JSON) (*int, *int) {
	if len(metadata) == 0 {
		return nil, nil
	}
	var offsets struct {
		StartOffset *int `json:"startOffset"`
		EndOffset   *int `json:"endOffset"`
	}
	if err := json.Unmarshal(metadata, &offsets); err != nil {
		return nil, nil
	}
	if offsets.StartOffset == nil || offsets.EndOffset == nil || *offsets.StartOffset < 0 || *offsets.EndOffset <= *offsets.StartOffset {
		return nil, nil
	}
	return offsets.StartOffset, offsets.EndOffset
}

// completeVectorRecall reruns the vector stage exhaustively when the
// approximate scan came back with fewer than limit rows although the knowledge
// base holds more. An HNSW scan yields at most ef_search neighbours before the
// knowledge-base and soft-delete filters run, so with many chunks from other
// knowledge bases or deleted documents nearby it can return a handful of rows,
// or none, without any error. A short result on a small knowledge base is
// normal and costs one COUNT to confirm.
func (s *Service) completeVectorRecall(ctx context.Context, kbID uuid.UUID, vector []float32, limit int, approximate []repository.SearchResult) ([]repository.SearchResult, bool, error) {
	if len(approximate) >= limit {
		return approximate, false, nil
	}
	searchable, err := s.chunks.CountVectorSearchable(ctx, kbID)
	if err != nil {
		return nil, false, err
	}
	if searchable <= int64(len(approximate)) {
		return approximate, false, nil
	}
	exact, err := s.chunks.SearchByVectorExact(ctx, kbID, vector, limit)
	if err != nil {
		return nil, false, err
	}
	s.metrics.RecordVectorExactFallback()
	return limitSearchResults(exact, limit), true, nil
}

type searchDebugInput struct {
	query              string
	vectorCandidates   []repository.SearchResult
	exactFallback      bool
	keywordCandidates  []repository.SearchResult
	keywordStageStatus string
	fused              []fusedCandidate
	fusionStageStatus  string
	rerankInput        []repository.SearchResult
	rerankCandidates   []repository.SearchResult
	rerankStageStatus  string
	finalCandidates    []repository.SearchResult
	rerankFallback     *dto.RerankFallbackResponse
}

func buildSearchDebugResponse(in searchDebugInput) *dto.SearchDebugResponse {
	return &dto.SearchDebugResponse{
		Query: in.query,
		VectorStage: dto.SearchDebugVectorStage{
			Status:        "completed",
			Items:         toDebugVectorItems(in.vectorCandidates),
			ExactFallback: in.exactFallback,
		},
		KeywordStage: dto.SearchDebugKeywordStage{
			Status: in.keywordStageStatus,
			Items:  toDebugKeywordItems(in.keywordCandidates),
		},
		FusionStage: dto.SearchDebugFusionStage{
			Status: in.fusionStageStatus,
			Items:  toDebugFusionItems(in.fused),
		},
		RerankStage: dto.SearchDebugRerankStage{
			Status: in.rerankStageStatus,
			Input:  toDebugRerankInput(in.rerankInput),
			Output: toDebugRerankOutput(in.rerankCandidates),
		},
		FinalStage: dto.SearchDebugFinalStage{
			Items: toDebugFinalItems(in.finalCandidates),
		},
		RerankFallback: in.rerankFallback,
	}
}

func toDebugKeywordItems(candidates []repository.SearchResult) []dto.SearchDebugKeywordItem {
	items := make([]dto.SearchDebugKeywordItem, 0, len(candidates))
	for i, candidate := range candidates {
		score := 0.0
		if candidate.KeywordScore != nil {
			score = *candidate.KeywordScore
		}
		items = append(items, dto.SearchDebugKeywordItem{
			ChunkID:      candidate.ChunkID.String(),
			DocumentID:   candidate.DocumentID.String(),
			Filename:     candidate.Filename,
			PageNumber:   candidate.PageNumber,
			Content:      candidate.Content,
			KeywordScore: score,
			Rank:         i + 1,
		})
	}
	return items
}

func toDebugFusionItems(candidates []fusedCandidate) []dto.SearchDebugFusionItem {
	items := make([]dto.SearchDebugFusionItem, 0, len(candidates))
	for i, candidate := range candidates {
		score := 0.0
		if candidate.FusionScore != nil {
			score = *candidate.FusionScore
		}
		items = append(items, dto.SearchDebugFusionItem{
			ChunkID:      candidate.ChunkID.String(),
			PageNumber:   candidate.PageNumber,
			VectorRank:   candidate.VectorRank,
			KeywordRank:  candidate.KeywordRank,
			FusionScore:  score,
			VectorScore:  candidate.VectorScore,
			KeywordScore: candidate.KeywordScore,
			Rank:         i + 1,
		})
	}
	return items
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
			ChunkID:      candidate.ChunkID.String(),
			PageNumber:   candidate.PageNumber,
			VectorScore:  candidate.VectorScore,
			KeywordScore: candidate.KeywordScore,
			FusionScore:  candidate.FusionScore,
			RerankScore:  candidate.RerankScore,
			Rank:         i + 1,
		})
	}
	return items
}
