package retrieval

import (
	"context"
	"github.com/google/uuid"
	"go.opentelemetry.io/otel/attribute"
	"go.uber.org/zap"
	"kbchat/backend/internal/apperror"
	"kbchat/backend/internal/dto"
	"kbchat/backend/internal/model"
	"kbchat/backend/internal/observability"
	"kbchat/backend/internal/repository"
	"sort"
	"time"
)

func (s *Service) recallOne(ctx context.Context, kbID uuid.UUID, queryVector []float32, options searchOptions, req dto.SearchRequest) (searchDebugInput, error) {
	vectorCtx, vectorSpan := observability.Start(ctx, "rag.vector_recall", attribute.String("knowledge_base.id", kbID.String()))
	vectorCandidates, err := s.chunks.SearchByVector(vectorCtx, kbID, queryVector, options.vectorTopN)
	if err != nil {
		observability.Finish(vectorSpan, err)
		return searchDebugInput{}, apperror.Internal(err)
	}
	vectorCandidates = limitSearchResults(vectorCandidates, options.vectorTopN)
	vectorCandidates, exactFallback, err := s.completeVectorRecall(vectorCtx, kbID, queryVector, options.vectorTopN, vectorCandidates)
	vectorSpan.SetAttributes(attribute.Bool("rag.exact_fallback", exactFallback), attribute.Int("rag.candidate_count", len(vectorCandidates)))
	observability.Finish(vectorSpan, err)
	if err != nil {
		return searchDebugInput{}, apperror.Internal(err)
	}

	// Keyword recall runs after the vector stage rather than concurrently: the
	// two queries share the same pool and the keyword one is cheap, so the
	// simpler sequential code is not worth trading for a goroutine here.
	keywordCandidates := []repository.SearchResult{}
	keywordStageStatus := "disabled"
	fusionStageStatus := "skipped"
	var fused []fusedCandidate
	if options.enableKeyword {
		keywordStart := time.Now()
		keywordCtx, keywordSpan := observability.Start(ctx, "rag.keyword_recall")
		keywordCandidates, err = s.chunks.SearchByKeyword(keywordCtx, kbID, req.Query, options.vectorTopN)
		keywordSpan.SetAttributes(attribute.Int("rag.candidate_count", len(keywordCandidates)))
		observability.Finish(keywordSpan, err)
		s.metrics.RecordProviderResult(ctx, observability.ProviderKeyword, err)
		s.metrics.ObserveSince(ctx, observability.MetricKeyword, keywordStart)
		if err != nil {
			// Keyword recall is an addition to vector recall, not a prerequisite:
			// a broken GIN index or a missing search_vector column must not take
			// down retrieval that worked before hybrid search existed. The stage
			// is reported as failed in debug output and the vector list is used
			// alone, with vector-score thresholds as before.
			if log := s.metrics.Logger(ctx); log != nil {
				log.Warn("keyword recall failed; falling back to vector recall", zap.String("knowledgeBaseId", kbID.String()), zap.Error(err))
			}
			keywordCandidates = nil
			keywordStageStatus = "failed"
			fusionStageStatus = "skipped"
			fused = fuseByReciprocalRank(vectorCandidates, nil, options.vectorTopN)
			for i := range fused {
				fused[i].FusionScore = nil
			}
		} else {
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

	return searchDebugInput{vectorCandidates: vectorCandidates, exactFallback: exactFallback,
		keywordCandidates: keywordCandidates, keywordStageStatus: keywordStageStatus,
		fused: fused, fusionStageStatus: fusionStageStatus, rerankInput: rerankInput}, nil
}

// Each base gets a turn before any base gets a second candidate. Empty bases
// consume no quota. Rerank sees at most vectorTopN candidates across all bases.
func (s *Service) recallMany(ctx context.Context, bases []*model.KnowledgeBase, vector []float32, options searchOptions, req dto.SearchRequest) (searchDebugInput, error) {
	return s.recallBases(ctx, bases, vector, options, req, false)
}

func (s *Service) recallBases(ctx context.Context, bases []*model.KnowledgeBase, vector []float32, options searchOptions, req dto.SearchRequest, automatic bool) (searchDebugInput, error) {
	all := searchDebugInput{keywordStageStatus: "disabled", fusionStageStatus: "skipped"}
	groups := make([]searchDebugInput, 0, len(bases))
	failed := false
	for _, kb := range bases {
		group, err := s.recallOne(ctx, kb.ID, vector, options, req)
		if err != nil {
			return all, err
		}
		for i := range group.vectorCandidates {
			group.vectorCandidates[i].KnowledgeBaseID = kb.ID
			group.vectorCandidates[i].KnowledgeBaseName = kb.Name
		}
		for i := range group.keywordCandidates {
			group.keywordCandidates[i].KnowledgeBaseID = kb.ID
			group.keywordCandidates[i].KnowledgeBaseName = kb.Name
		}
		for i := range group.fused {
			group.fused[i].KnowledgeBaseID = kb.ID
			group.fused[i].KnowledgeBaseName = kb.Name
		}
		all.vectorCandidates = append(all.vectorCandidates, group.vectorCandidates...)
		all.keywordCandidates = append(all.keywordCandidates, group.keywordCandidates...)
		all.exactFallback = all.exactFallback || group.exactFallback
		failed = failed || group.keywordStageStatus == "failed"
		groups = append(groups, group)
	}
	if options.enableKeyword {
		all.keywordStageStatus, all.fusionStageStatus = "completed", "completed"
		if failed {
			all.keywordStageStatus, all.fusionStageStatus = "failed", "skipped"
			// Keep one threshold scale on fallback; discard keyword recall for all bases.
			for i := range groups {
				groups[i].fused = fuseByReciprocalRank(groups[i].vectorCandidates, nil, options.vectorTopN)
				for j := range groups[i].fused {
					groups[i].fused[j].FusionScore = nil
				}
			}
		}
	}
	if automatic {
		// Compare documents globally, rather than assigning a slot to every
		// library or silently dropping libraries after the manual five-base cap.
		sort.SliceStable(all.vectorCandidates, func(i, j int) bool { return all.vectorCandidates[i].VectorScore > all.vectorCandidates[j].VectorScore })
		vectors := limitSearchResults(all.vectorCandidates, options.vectorTopN)
		var keywords []repository.SearchResult
		if options.enableKeyword && !failed {
			sort.SliceStable(all.keywordCandidates, func(i, j int) bool {
				a, b := all.keywordCandidates[i].KeywordScore, all.keywordCandidates[j].KeywordScore
				return a != nil && (b == nil || *a > *b)
			})
			keywords = limitSearchResults(all.keywordCandidates, options.vectorTopN)
		}
		all.fused = fuseByReciprocalRank(vectors, keywords, options.vectorTopN)
		if !options.enableKeyword || failed {
			for i := range all.fused {
				all.fused[i].FusionScore = nil
			}
		}
		all.rerankInput = searchResultsOf(all.fused)
		return all, nil
	}
	for rank := 0; len(all.fused) < options.vectorTopN; rank++ {
		added := false
		for _, group := range groups {
			if rank < len(group.fused) && len(all.fused) < options.vectorTopN {
				all.fused = append(all.fused, group.fused[rank])
				added = true
			}
		}
		if !added {
			break
		}
	}
	// Without rerank, compare the shared vector or normalized fusion score.
	// Stable ordering preserves deterministic base order for score ties.
	if len(bases) > 1 {
		sortCandidates(all.fused, options.enableKeyword && !failed)
	}
	all.rerankInput = searchResultsOf(all.fused)
	return all, nil
}

func sortCandidates(items []fusedCandidate, fusion bool) {
	sort.SliceStable(items, func(i, j int) bool {
		if fusion {
			return *items[i].FusionScore > *items[j].FusionScore
		}
		return items[i].VectorScore > items[j].VectorScore
	})
}
