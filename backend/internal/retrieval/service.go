package retrieval

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"go.opentelemetry.io/otel/attribute"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"gorm.io/datatypes"

	"kbchat/backend/internal/access"
	"kbchat/backend/internal/apperror"
	"kbchat/backend/internal/authz"
	"kbchat/backend/internal/cache"
	"kbchat/backend/internal/config"
	"kbchat/backend/internal/document/parser"
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
	return s.SearchMany(ctx, ownerID, []uuid.UUID{kbID}, req)
}

func (s *Service) SearchMany(ctx context.Context, ownerID uuid.UUID, kbIDs []uuid.UUID, req dto.SearchRequest) (*dto.SearchResponse, error) {
	return s.searchBases(ctx, ownerID, kbIDs, req, false)
}

// SearchAutomatic is an internal chat entry point. The service supplies all
// currently accessible bases; each is authorized again here before model work.
func (s *Service) SearchAutomatic(ctx context.Context, ownerID uuid.UUID, kbIDs []uuid.UUID, req dto.SearchRequest) (*dto.SearchResponse, error) {
	return s.searchBases(ctx, ownerID, kbIDs, req, true)
}

func (s *Service) searchBases(ctx context.Context, ownerID uuid.UUID, kbIDs []uuid.UUID, req dto.SearchRequest, automatic bool) (response *dto.SearchResponse, retErr error) {
	ctx, span := observability.Start(ctx, "rag.retrieval", attribute.Int("rag.knowledge_base_count", len(kbIDs)))
	defer func() { observability.Finish(span, retErr) }()
	if req.ScoreThreshold != nil && (*req.ScoreThreshold < 0 || *req.ScoreThreshold > 1) {
		return nil, apperror.Validation(map[string]any{"scoreThreshold": "must be between 0 and 1"})
	}
	if len(kbIDs) == 0 || (!automatic && len(kbIDs) > dto.MaxChatKnowledgeBases) {
		return nil, apperror.Validation(map[string]any{"knowledgeBaseIds": "provide 1 to 5 knowledge bases"})
	}
	bases := make([]*model.KnowledgeBase, 0, len(kbIDs))
	seen := map[uuid.UUID]bool{}
	for _, kbID := range kbIDs {
		if kbID == uuid.Nil || seen[kbID] {
			return nil, apperror.Validation(map[string]any{"knowledgeBaseIds": "IDs must be valid and unique"})
		}
		seen[kbID] = true
		decision, err := authz.KnowledgeBase(ctx, s.knowledgeBases, ownerID, kbID, access.CapKnowledgeBaseSearch)
		if err != nil {
			return nil, err
		}
		bases = append(bases, decision.KnowledgeBase)
	}
	documentIDs, err := dto.ParseDocumentIDs(req.DocumentIDs)
	if err != nil {
		return nil, err
	}
	if len(documentIDs) > 0 {
		finder, ok := s.chunks.(interface {
			FindScopeDocuments(context.Context, []uuid.UUID, []uuid.UUID) ([]model.Document, error)
		})
		if !ok {
			return nil, apperror.Internal(fmt.Errorf("document scope lookup is unavailable"))
		}
		docs, err := finder.FindScopeDocuments(ctx, documentIDs, kbIDs)
		if err != nil {
			return nil, apperror.Internal(err)
		}
		if len(docs) != len(documentIDs) {
			// 409, not 404: the session still exists and must stay readable. The
			// frontend clears a conversation on any 404, so returning one here
			// made a deleted scope document look like a lost session. The chat
			// path returns the same code and status (chat_document_scope.go).
			return nil, apperror.New(409, "DOCUMENT_SCOPE_UNAVAILABLE", "所选文档已删除、移动或不可访问，请重新选择提问范围")
		}
		ctx = repository.WithDocumentSearchScope(ctx, documentIDs)
	}
	// Canonical order keeps quotas and ties independent of request order.
	sort.Slice(bases, func(i, j int) bool { return bases[i].ID.String() < bases[j].ID.String() })
	policy := bases[0]
	if automatic || len(bases) > 1 {
		policy = &model.KnowledgeBase{}
	}
	options := s.resolveSearchOptions(policy, req)
	if !automatic && options.vectorTopN < len(bases) {
		options.vectorTopN = len(bases)
	}

	// Timed from here rather than from function entry: the authorization lookup
	// above is not retrieval work, and including it would make the metric partly a
	// measure of how often callers pass bad IDs.
	retrievalStart := time.Now()
	defer s.metrics.ObserveSince(ctx, observability.MetricRetrieval, retrievalStart)

	queryVector, err := s.queryEmbedding(ctx, req.Query)
	if err != nil {
		return nil, apperror.Wrap(500, "EMBEDDING_FAILED", "知识检索暂时不可用，请稍后重试", err)
	}

	recalled, err := s.recallBases(ctx, bases, queryVector, options, req, automatic)
	if err != nil {
		return nil, err
	}
	rerankInput := recalled.rerankInput
	span.SetAttributes(attribute.String("rag.keyword_stage", recalled.keywordStageStatus))
	thresholdScore := scoreVector
	if recalled.fusionStageStatus == "completed" {
		thresholdScore = scoreFusion
	}

	candidates := rerankInput
	rerankCandidates := []repository.SearchResult{}
	rerankStageStatus := "disabled"
	var rerankFallback *dto.RerankFallbackResponse
	if options.enableRerank {
		rerankStart := time.Now()
		rerankCandidates, err = s.rerank(ctx, req.Query, rerankInput, 0)
		if len(rerankInput) > 0 {
			s.metrics.RecordProviderResult(ctx, observability.ProviderRerank, err)
			s.metrics.ObserveSince(ctx, observability.MetricRerank, rerankStart)
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
			TextSource:        chunkTextSource(item.Metadata),
			Table:             chunkTableSource(item.Metadata),
			KnowledgeBaseID:   item.KnowledgeBaseID.String(),
			KnowledgeBaseName: item.KnowledgeBaseName,
			ChunkID:           item.ChunkID.String(),
			DocumentID:        item.DocumentID.String(),
			Filename:          item.Filename,
			Content:           item.Content,
			PageNumber:        item.PageNumber,
			VectorScore:       item.VectorScore,
			KeywordScore:      item.KeywordScore,
			RerankScore:       item.RerankScore,
			StartOffset:       start,
			EndOffset:         end,
		})
	}

	span.SetAttributes(attribute.Int("rag.candidate_count", len(rerankInput)), attribute.Int("rag.context_chunk_count", len(items)), attribute.Bool("rag.rerank_fallback", rerankFallback != nil))
	res := &dto.SearchResponse{Items: items, RerankFallback: rerankFallback}
	if req.Debug {
		recalled.query = req.Query
		recalled.rerankCandidates, recalled.rerankStageStatus = rerankCandidates, rerankStageStatus
		recalled.finalCandidates, recalled.rerankFallback = candidates, rerankFallback
		res.Debug = buildSearchDebugResponse(recalled)
	}
	return res, nil
}

func (s *Service) queryEmbedding(ctx context.Context, query string) (result []float32, retErr error) {
	ctx, span := observability.Start(ctx, "rag.query_embedding")
	defer func() { observability.Finish(span, retErr) }()
	normalizedQuery := cache.NormalizeEmbeddingQuery(query)
	cacheModel := s.embeddingCacheModelKey()
	if s.embeddingCache != nil {
		vector, hit, err := s.embeddingCache.Get(ctx, cacheModel, normalizedQuery)
		switch {
		case err != nil:
			span.SetAttributes(attribute.String("cache.result", "error"))
			s.metrics.RecordEmbeddingCacheResult(observability.EmbeddingCacheResultError)
		case hit:
			span.SetAttributes(attribute.String("cache.result", "hit"))
			s.metrics.RecordEmbeddingCacheResult(observability.EmbeddingCacheResultHit)
			return vector, nil
		default:
			span.SetAttributes(attribute.String("cache.result", "miss"))
			s.metrics.RecordEmbeddingCacheResult(observability.EmbeddingCacheResultMiss)
		}
	}

	embeddingStart := time.Now()
	embeddings, err := s.embedder.EmbedTexts(ctx, []string{normalizedQuery})
	s.metrics.RecordProviderResult(ctx, observability.ProviderEmbedding, err)
	s.metrics.ObserveSince(ctx, observability.MetricEmbedding, embeddingStart)
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

func chunkTableSource(metadata datatypes.JSON) *dto.TableSource {
	var source struct {
		FileType string           `json:"fileType"`
		Table    *dto.TableSource `json:"table"`
	}
	if json.Unmarshal(metadata, &source) != nil || source.Table == nil || (source.FileType != "csv" && source.FileType != "xlsx") {
		return nil
	}
	table := source.Table
	if table.HeaderRow < 1 || table.RowStart <= table.HeaderRow || table.RowEnd < table.RowStart || table.RowEnd > parser.MaxTableSourceRow {
		return nil
	}
	if (source.FileType == "csv" && table.SheetName != "") || (source.FileType == "xlsx" && (table.SheetName == "" || table.RowStart != table.RowEnd)) {
		return nil
	}
	return table
}

func chunkTextSource(metadata datatypes.JSON) string {
	var source struct {
		FileType   string `json:"fileType"`
		TextSource string `json:"textSource"`
	}
	if json.Unmarshal(metadata, &source) == nil && source.FileType == "pdf" && (source.TextSource == "ocr" || source.TextSource == "ocr_corrected") {
		return source.TextSource
	}
	return ""
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
