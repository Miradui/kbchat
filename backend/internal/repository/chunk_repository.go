package repository

import (
	"context"
	"fmt"
	"strings"

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
	return r.db.WithContext(ctx).CreateInBatches(chunks, 50).Error
}

func (r *ChunkRepository) ReplaceByDocument(ctx context.Context, documentID uuid.UUID, chunks []model.DocumentChunk) error {
	for index := range chunks {
		if chunks[index].DocumentID != documentID {
			return fmt.Errorf("replacement chunk %d belongs to document %s, expected %s", index, chunks[index].DocumentID, documentID)
		}
	}
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("document_id = ?", documentID).Delete(&model.DocumentChunk{}).Error; err != nil {
			return err
		}
		if len(chunks) == 0 {
			return nil
		}
		return tx.CreateInBatches(chunks, 50).Error
	})
}

func (r *ChunkRepository) ListByDocument(ctx context.Context, documentID uuid.UUID) ([]model.DocumentChunk, error) {
	var chunks []model.DocumentChunk
	err := r.db.WithContext(ctx).
		Where("document_id = ?", documentID).
		Order("chunk_index asc").
		Find(&chunks).Error
	return chunks, err
}

func (r *ChunkRepository) ListByDocumentPaged(ctx context.Context, documentID uuid.UUID, query string, page, pageSize int) ([]model.DocumentChunk, int64, error) {
	page, pageSize = normalizePage(page, pageSize)
	base := r.db.WithContext(ctx).
		Model(&model.DocumentChunk{}).
		Where("document_id = ?", documentID)
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
		Where("documents.deleted_at IS NULL").
		Order(clause.Expr{SQL: "document_chunks.embedding <=> ?", Vars: []any{pgvector.NewVector(vector)}}).
		Limit(limit).
		Scan(&results).Error
	return results, err
}
