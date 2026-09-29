package service

import (
	"context"
	"go.uber.org/zap"
	"kbchat/backend/internal/dto"
	"kbchat/backend/internal/repository"
)

type embeddingInventoryReader interface {
	EmbeddingInventory(context.Context) ([]repository.EmbeddingGroup, error)
}
type embeddingDimensionReader interface {
	EmbeddingColumnDimension(context.Context) (int, error)
}

func (s *SystemService) embeddingStatus(ctx context.Context) dto.SystemEmbeddingStatus {
	result := dto.SystemEmbeddingStatus{Status: dto.SystemStatusNotConfigured, Model: s.cfg.EmbeddingModel, ConfiguredDimension: s.cfg.EmbeddingDimension, Groups: []dto.SystemEmbeddingGroup{}}
	inventory, ok := s.diag.Docs.(embeddingInventoryReader)
	if !ok {
		return result
	}
	ctx, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()
	result.Status = dto.SystemStatusOK
	groups, err := inventory.EmbeddingInventory(ctx)
	if err != nil {
		s.logger().Warn("embedding inventory unavailable", zap.Error(err))
		result.Status = dto.SystemStatusDown
		return result
	}
	for _, group := range groups {
		result.Groups = append(result.Groups, dto.SystemEmbeddingGroup{Model: group.Model, Dimension: group.Dimension, Count: group.Count})
		result.TotalDocuments += group.Count
		if group.Model == nil || group.Dimension == nil || *group.Model == "" {
			result.UnknownDocuments += group.Count
		} else if *group.Model != s.cfg.EmbeddingModel || *group.Dimension != s.cfg.EmbeddingDimension {
			result.MismatchedDocuments += group.Count
		}
	}
	if reader, ok := s.diag.Database.(embeddingDimensionReader); ok {
		actual, err := reader.EmbeddingColumnDimension(ctx)
		if err != nil {
			s.logger().Warn("embedding column dimension unavailable", zap.Error(err))
			result.Status = dto.SystemStatusDown
			return result
		}
		if actual > 0 {
			result.ColumnDimension = &actual
		}
	}
	if result.UnknownDocuments > 0 || result.MismatchedDocuments > 0 || result.ColumnDimension != nil && *result.ColumnDimension != result.ConfiguredDimension {
		result.Status = dto.SystemStatusDegraded
	}
	return result
}
