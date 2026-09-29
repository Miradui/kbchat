package repository

import (
	"context"
	"errors"
	"github.com/google/uuid"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"kbchat/backend/internal/model"
)

type EmbeddingGroup struct {
	Model     *string
	Dimension *int
	Count     int64
}

// Superseded versions remain searchable until explicitly deleted, so inventory
// and reembedding must include them as well as the current version.
func (r *DocumentRepository) EmbeddingInventory(ctx context.Context) ([]EmbeddingGroup, error) {
	var groups []EmbeddingGroup
	err := r.db.WithContext(ctx).Model(&model.Document{}).
		Joins("JOIN knowledge_bases kb ON kb.id = documents.knowledge_base_id AND kb.deleted_at IS NULL").
		Where("documents.status = ?", "completed").
		Select("documents.embedding_model AS model, documents.embedding_dimension AS dimension, COUNT(*) AS count").
		Group("documents.embedding_model, documents.embedding_dimension").Order("documents.embedding_model, documents.embedding_dimension").Scan(&groups).Error
	return groups, err
}

func (r *DocumentRepository) ReembedCandidates(ctx context.Context, kbID *uuid.UUID, identity EmbeddingIdentity, only bool, after uuid.UUID, limit int) ([]model.Document, error) {
	query := r.db.WithContext(ctx).Model(&model.Document{}).
		Joins("JOIN knowledge_bases kb ON kb.id = documents.knowledge_base_id AND kb.deleted_at IS NULL").
		Where("NOT EXISTS (SELECT 1 FROM document_jobs j WHERE j.document_id = documents.id AND j.job_type = ? AND j.status IN ?)", "process_document", []string{"pending", "running"})
	if kbID != nil {
		query = query.Where("documents.knowledge_base_id = ?", *kbID)
	}
	if only {
		query = query.Where("documents.embedding_model IS NULL OR documents.embedding_dimension IS NULL OR documents.embedding_model <> ? OR documents.embedding_dimension <> ?", identity.Model, identity.Dimension)
	}
	if after != uuid.Nil {
		query = query.Where("documents.id > ?", after)
	}
	var items []model.Document
	err := query.Select("documents.*").Order("documents.id").Limit(limit).Find(&items).Error
	return items, err
}

// Rechecks both the selection and active-job exclusion under the same document
// lock used by QueueReprocess, so a worker or another command cannot race it.
func (r *DocumentRepository) QueueReembed(ctx context.Context, id uuid.UUID, identity EmbeddingIdentity, only bool) (bool, error) {
	queued := false
	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var doc model.Document
		err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&doc, "id = ?", id).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil
		}
		if err != nil {
			return err
		}
		if only && doc.EmbeddingModel != nil && doc.EmbeddingDimension != nil && *doc.EmbeddingModel == identity.Model && *doc.EmbeddingDimension == identity.Dimension {
			return nil
		}
		var kb model.KnowledgeBase
		err = tx.First(&kb, "id = ?", doc.KnowledgeBaseID).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil
		}
		if err != nil {
			return err
		}
		var count int64
		if err := tx.Model(&model.DocumentJob{}).Where("document_id = ? AND job_type = ? AND status IN ?", id, "process_document", []string{"pending", "running"}).Count(&count).Error; err != nil {
			return err
		}
		if count > 0 {
			return nil
		}
		_, created, err := NewDocumentRepository(tx).QueueReprocess(ctx, id, kb.OwnerID)
		queued = created
		return err
	})
	return queued, err
}
