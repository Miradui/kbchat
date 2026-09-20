package retrieval

import (
	"cmp"
	"slices"

	"github.com/google/uuid"

	"kbchat/backend/internal/repository"
)

// rrfK is the reciprocal-rank-fusion constant. 60 is the value from the
// original RRF paper and the common default; it flattens the difference
// between neighbouring ranks so that appearing in both lists matters more
// than being first in one of them.
const rrfK = 60

// fusedCandidate is a chunk after reciprocal rank fusion. The ranks are
// 1-based positions in the source lists and nil when the stage did not return
// the chunk.
type fusedCandidate struct {
	repository.SearchResult
	VectorRank  *int
	KeywordRank *int
}

// fuseByReciprocalRank merges the vector and keyword recall lists with RRF and
// returns at most limit candidates, best first. The fusion score is
// normalized so that a chunk ranked first in both lists scores exactly 1 and a
// chunk ranked first in one list only scores 0.5; this keeps it on the same
// [0, 1] scale as the other scores so scoreThreshold can be applied to it when
// Rerank does not run.
//
// The vector-side SearchResult is kept as the base record when a chunk appears
// in both lists, and its KeywordScore is copied over from the keyword side.
// Ties are broken by vector rank, then keyword rank, then chunk ID so the order
// is deterministic.
func fuseByReciprocalRank(vector, keyword []repository.SearchResult, limit int) []fusedCandidate {
	merged := make(map[uuid.UUID]*fusedCandidate, len(vector)+len(keyword))
	order := make([]uuid.UUID, 0, len(vector)+len(keyword))

	for i, result := range vector {
		rank := i + 1
		candidate := &fusedCandidate{SearchResult: result, VectorRank: &rank}
		merged[result.ChunkID] = candidate
		order = append(order, result.ChunkID)
	}
	for i, result := range keyword {
		rank := i + 1
		if existing, ok := merged[result.ChunkID]; ok {
			existing.KeywordRank = &rank
			existing.KeywordScore = result.KeywordScore
			continue
		}
		candidate := &fusedCandidate{SearchResult: result, KeywordRank: &rank}
		merged[result.ChunkID] = candidate
		order = append(order, result.ChunkID)
	}

	// A single first place contributes 1/(k+1); two of them are the ceiling.
	ceiling := 2.0 / float64(rrfK+1)
	fused := make([]fusedCandidate, 0, len(order))
	for _, id := range order {
		candidate := merged[id]
		score := 0.0
		if candidate.VectorRank != nil {
			score += 1.0 / float64(rrfK+*candidate.VectorRank)
		}
		if candidate.KeywordRank != nil {
			score += 1.0 / float64(rrfK+*candidate.KeywordRank)
		}
		normalized := score / ceiling
		candidate.FusionScore = &normalized
		fused = append(fused, *candidate)
	}

	slices.SortStableFunc(fused, func(a, b fusedCandidate) int {
		if c := cmp.Compare(*b.FusionScore, *a.FusionScore); c != 0 {
			return c
		}
		if c := compareRank(a.VectorRank, b.VectorRank); c != 0 {
			return c
		}
		if c := compareRank(a.KeywordRank, b.KeywordRank); c != 0 {
			return c
		}
		return cmp.Compare(a.ChunkID.String(), b.ChunkID.String())
	})
	if limit > 0 && len(fused) > limit {
		fused = fused[:limit]
	}
	return fused
}

// compareRank orders present ranks ascending and puts absent ranks last.
func compareRank(a, b *int) int {
	switch {
	case a == nil && b == nil:
		return 0
	case a == nil:
		return 1
	case b == nil:
		return -1
	default:
		return cmp.Compare(*a, *b)
	}
}

func searchResultsOf(candidates []fusedCandidate) []repository.SearchResult {
	results := make([]repository.SearchResult, 0, len(candidates))
	for _, candidate := range candidates {
		results = append(results, candidate.SearchResult)
	}
	return results
}
