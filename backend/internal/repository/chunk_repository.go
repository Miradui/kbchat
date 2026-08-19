package repository

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/pgvector/pgvector-go"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"rag/backend/internal/model"
)

type SearchResult struct {
	ChunkID     uuid.UUID
	DocumentID  uuid.UUID
	Filename    string
	Content     string
	PageNumber  *int
	VectorScore float64
	RerankScore *float64
}

type ChunkRepository struct {
	db *gorm.DB
}

func NewChunkRepository(db *gorm.DB) *ChunkRepository {
	return &ChunkRepository{db: db}
}

func (r *ChunkRepository) DeleteByDocument(ctx context.Context, documentID uuid.UUID) error {
	return r.db.WithContext(ctx).Where("document_id = ?", documentID).Delete(&model.DocumentChunk{}).Error
}

func (r *ChunkRepository) CreateBatch(ctx context.Context, chunks []model.DocumentChunk) error {
	if len(chunks) == 0 {
		return nil
	}
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := validateChunkOwnership(tx, chunks); err != nil {
			return err
		}
		return tx.CreateInBatches(chunks, 50).Error
	})
}

func (r *ChunkRepository) ReplaceByDocument(ctx context.Context, documentID uuid.UUID, chunks []model.DocumentChunk) error {
	if err := validateReplacementChunks(documentID, chunks); err != nil {
		return err
	}
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := validateChunkOwnership(tx, chunks); err != nil {
			return err
		}
		return replaceDocumentChunks(tx, documentID, chunks)
	})
}

// PublishByDocument atomically publishes a complete replacement index and the
// successful terminal state of the exact job that produced it. It linearizes
// against CancelActiveJob on the document row: cancellation that committed
// first prevents all chunk writes, while a publication that commits first makes
// a later cancel non-cancellable because the job is already completed.
func (r *ChunkRepository) PublishByDocument(
	ctx context.Context,
	documentID uuid.UUID,
	jobID uuid.UUID,
	chunks []model.DocumentChunk,
) error {
	if err := validateReplacementChunks(documentID, chunks); err != nil {
		return err
	}
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := guardRunningDocumentJob(tx, documentID, jobID); err != nil {
			return err
		}
		if err := validateChunkOwnership(tx, chunks); err != nil {
			return err
		}
		if err := replaceDocumentChunks(tx, documentID, chunks); err != nil {
			return err
		}

		now := time.Now()
		documentResult := tx.Model(&model.Document{}).
			Where("id = ?", documentID).
			Updates(map[string]any{
				"status":        "completed",
				"error_message": "",
				"updated_at":    now,
			})
		if documentResult.Error != nil {
			return documentResult.Error
		}
		if documentResult.RowsAffected != 1 {
			return gorm.ErrRecordNotFound
		}

		jobResult := tx.Model(&model.DocumentJob{}).
			Where(
				"id = ? AND document_id = ? AND status = ? AND job_type = ?",
				jobID, documentID, "running", "process_document",
			).
			Updates(map[string]any{
				"status":        "completed",
				"progress":      100,
				"error_message": "",
				"locked_at":     nil,
				"updated_at":    now,
			})
		if jobResult.Error != nil {
			return jobResult.Error
		}
		if jobResult.RowsAffected != 1 {
			return ErrDocumentJobCancelled
		}
		return nil
	})
}

func validateReplacementChunks(documentID uuid.UUID, chunks []model.DocumentChunk) error {
	for index := range chunks {
		if chunks[index].DocumentID != documentID {
			return fmt.Errorf("replacement chunk %d belongs to document %s, expected %s", index, chunks[index].DocumentID, documentID)
		}
	}
	return nil
}

func replaceDocumentChunks(tx *gorm.DB, documentID uuid.UUID, chunks []model.DocumentChunk) error {
	if err := tx.Where("document_id = ?", documentID).Delete(&model.DocumentChunk{}).Error; err != nil {
		return err
	}
	if len(chunks) == 0 {
		return nil
	}
	return tx.CreateInBatches(chunks, 50).Error
}

func validateChunkOwnership(tx *gorm.DB, chunks []model.DocumentChunk) error {
	if len(chunks) == 0 {
		return nil
	}

	documentIDs := make([]uuid.UUID, 0, len(chunks))
	seen := make(map[uuid.UUID]struct{}, len(chunks))
	for _, chunk := range chunks {
		if _, ok := seen[chunk.DocumentID]; ok {
			continue
		}
		seen[chunk.DocumentID] = struct{}{}
		documentIDs = append(documentIDs, chunk.DocumentID)
	}

	type documentOwnership struct {
		ID              uuid.UUID
		KnowledgeBaseID uuid.UUID
	}
	var documents []documentOwnership
	if err := tx.Model(&model.Document{}).
		Select("id", "knowledge_base_id").
		Where("id IN ?", documentIDs).
		Find(&documents).Error; err != nil {
		return err
	}
	owners := make(map[uuid.UUID]uuid.UUID, len(documents))
	for _, document := range documents {
		owners[document.ID] = document.KnowledgeBaseID
	}
	for index, chunk := range chunks {
		knowledgeBaseID, ok := owners[chunk.DocumentID]
		if !ok {
			return fmt.Errorf("chunk %d references missing document %s", index, chunk.DocumentID)
		}
		if chunk.KnowledgeBaseID != knowledgeBaseID {
			return fmt.Errorf("chunk %d knowledge base %s does not match document %s knowledge base %s", index, chunk.KnowledgeBaseID, chunk.DocumentID, knowledgeBaseID)
		}
	}
	return nil
}

func (r *ChunkRepository) ListByDocument(ctx context.Context, documentID uuid.UUID) ([]model.DocumentChunk, error) {
	var chunks []model.DocumentChunk
	err := r.db.WithContext(ctx).
		Where("document_id = ?", documentID).
		Order("chunk_index asc").
		Find(&chunks).Error
	return chunks, err
}

func (r *ChunkRepository) ListByDocumentPaged(ctx context.Context, documentID uuid.UUID, chunkID *uuid.UUID, query string, page, pageSize int) ([]model.DocumentChunk, int64, error) {
	page, pageSize = normalizePage(page, pageSize)
	base := r.db.WithContext(ctx).
		Model(&model.DocumentChunk{}).
		Where("document_id = ?", documentID)
	if chunkID != nil {
		base = base.Where("id = ?", *chunkID)
	}
	if strings.TrimSpace(query) != "" {
		like := "%" + strings.ToLower(strings.TrimSpace(query)) + "%"
		base = base.Where("LOWER(content) LIKE ?", like)
	}

	var total int64
	if err := base.Count(&total).Error; err != nil {
		return nil, 0, err
	}

	var chunks []model.DocumentChunk
	err := base.
		Select("id, document_id, knowledge_base_id, chunk_index, content, token_count, page_number, metadata, created_at").
		Order("chunk_index asc").
		Limit(pageSize).
		Offset((page - 1) * pageSize).
		Find(&chunks).Error
	return chunks, total, err
}

func (r *ChunkRepository) SearchByVector(ctx context.Context, kbID uuid.UUID, vector []float32, limit int) ([]SearchResult, error) {
	if limit <= 0 {
		limit = 30
	}

	var results []SearchResult
	err := r.db.WithContext(ctx).
		Table("document_chunks").
		Select(`
			document_chunks.id AS chunk_id,
			document_chunks.document_id AS document_id,
			documents.filename AS filename,
			document_chunks.content AS content,
			document_chunks.page_number AS page_number,
			1 - (document_chunks.embedding <=> ?) AS vector_score
		`, pgvector.NewVector(vector)).
		Joins("JOIN documents ON documents.id = document_chunks.document_id").
		Where("document_chunks.knowledge_base_id = ?", kbID).
		Where("documents.knowledge_base_id = ?", kbID).
		Where("documents.deleted_at IS NULL").
		Order(clause.Expr{SQL: "document_chunks.embedding <=> ?", Vars: []any{pgvector.NewVector(vector)}}).
		Limit(limit).
		Scan(&results).Error
	return results, err
}
