package service

import (
	"context"
	"fmt"
	"github.com/google/uuid"
	"kbchat/backend/internal/repository"
	"strings"
)

type ReembedOptions struct {
	KnowledgeBaseID *uuid.UUID
	Identity        repository.EmbeddingIdentity
	OnlyMismatched  bool
	DryRun          bool
	Batch           int
}
type ReembedResult struct {
	Selected int
	Queued   int
}

// Reembed queues the normal processing pipeline; it does not call a model itself.
// Keyset pagination visits each document at most once while workers run.
func Reembed(ctx context.Context, repo *repository.DocumentRepository, options ReembedOptions) (ReembedResult, error) {
	result := ReembedResult{}
	if strings.TrimSpace(options.Identity.Model) == "" || options.Identity.Dimension <= 0 {
		return result, fmt.Errorf("embedding model and positive dimension are required")
	}
	if options.Batch < 1 || options.Batch > 1000 {
		return result, fmt.Errorf("batch must be between 1 and 1000")
	}
	cursor := uuid.Nil
	for {
		items, err := repo.ReembedCandidates(ctx, options.KnowledgeBaseID, options.Identity, options.OnlyMismatched, cursor, options.Batch)
		if err != nil {
			return result, err
		}
		if len(items) == 0 {
			return result, nil
		}
		result.Selected += len(items)
		for _, item := range items {
			if err := ctx.Err(); err != nil {
				return result, err
			}
			if !options.DryRun {
				queued, err := repo.QueueReembed(ctx, item.ID, options.Identity, options.OnlyMismatched)
				if err != nil {
					return result, err
				}
				if queued {
					result.Queued++
				}
			}
			cursor = item.ID
		}
	}
}
