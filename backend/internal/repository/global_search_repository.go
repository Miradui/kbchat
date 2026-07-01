package repository

import (
	"context"
	"strings"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"rag/backend/internal/model"
)

type GlobalSearchRepository struct {
	db *gorm.DB
}

func NewGlobalSearchRepository(db *gorm.DB) *GlobalSearchRepository {
	return &GlobalSearchRepository{db: db}
}

type GlobalSearchResult struct {
	Type              string
	ID                uuid.UUID
	KnowledgeBaseID   uuid.UUID
	KnowledgeBaseName string
	DocumentID        *uuid.UUID
	Filename          string
	Title             string
	Snippet           string
}

func (r *GlobalSearchRepository) Search(ctx context.Context, ownerID uuid.UUID, query string, limit int) ([]GlobalSearchResult, error) {
	if limit <= 0 {
		limit = 20
	}
	like := "%" + strings.ToLower(query) + "%"
	results := make([]GlobalSearchResult, 0, limit)

	var kbs []model.KnowledgeBase
	if err := r.db.WithContext(ctx).
		Where("owner_id = ?", ownerID).
		Where("deleted_at IS NULL").
		Where("LOWER(name) LIKE ? OR LOWER(description) LIKE ?", like, like).
		Order("updated_at desc").
		Limit(limit).
		Find(&kbs).Error; err != nil {
		return nil, err
	}
	for _, kb := range kbs {
		results = append(results, GlobalSearchResult{
			Type:              "knowledgeBase",
			ID:                kb.ID,
			KnowledgeBaseID:   kb.ID,
			KnowledgeBaseName: kb.Name,
			Title:             kb.Name,
			Snippet:           kb.Description,
		})
		if len(results) >= limit {
			return results, nil
		}
	}

	var documents []GlobalDocumentListItem
	if err := r.db.WithContext(ctx).
		Table("documents").
		Select(`
			documents.id AS id,
			documents.knowledge_base_id AS knowledge_base_id,
			knowledge_bases.name AS knowledge_base_name,
			documents.filename AS filename,
			documents.file_type AS file_type,
			documents.file_size AS file_size,
			documents.status AS status,
			documents.error_message AS error_message,
			documents.created_at AS created_at,
			documents.updated_at AS updated_at
		`).
		Joins("JOIN knowledge_bases ON knowledge_bases.id = documents.knowledge_base_id").
		Where("knowledge_bases.owner_id = ?", ownerID).
		Where("knowledge_bases.deleted_at IS NULL").
		Where("documents.deleted_at IS NULL").
		Where("LOWER(documents.filename) LIKE ?", like).
		Order("documents.updated_at desc").
		Limit(limit - len(results)).
		Scan(&documents).Error; err != nil {
		return nil, err
	}
	for _, document := range documents {
		documentID := document.ID
		results = append(results, GlobalSearchResult{
			Type:              "document",
			ID:                document.ID,
			KnowledgeBaseID:   document.KnowledgeBaseID,
			KnowledgeBaseName: document.KnowledgeBaseName,
			DocumentID:        &documentID,
			Filename:          document.Filename,
			Title:             document.Filename,
			Snippet:           document.Status,
		})
		if len(results) >= limit {
			return results, nil
		}
	}

	var chunks []struct {
		ID                uuid.UUID
		KnowledgeBaseID   uuid.UUID
		KnowledgeBaseName string
		DocumentID        uuid.UUID
		Filename          string
		Content           string
	}
	if err := r.db.WithContext(ctx).
		Table("document_chunks").
		Select(`
			document_chunks.id AS id,
			document_chunks.knowledge_base_id AS knowledge_base_id,
			knowledge_bases.name AS knowledge_base_name,
			document_chunks.document_id AS document_id,
			documents.filename AS filename,
			document_chunks.content AS content
		`).
		Joins("JOIN knowledge_bases ON knowledge_bases.id = document_chunks.knowledge_base_id").
		Joins("JOIN documents ON documents.id = document_chunks.document_id").
		Where("knowledge_bases.owner_id = ?", ownerID).
		Where("knowledge_bases.deleted_at IS NULL").
		Where("documents.deleted_at IS NULL").
		Where("LOWER(document_chunks.content) LIKE ?", like).
		Order("document_chunks.created_at desc").
		Limit(limit - len(results)).
		Scan(&chunks).Error; err != nil {
		return nil, err
	}
	for _, chunk := range chunks {
		documentID := chunk.DocumentID
		results = append(results, GlobalSearchResult{
			Type:              "chunk",
			ID:                chunk.ID,
			KnowledgeBaseID:   chunk.KnowledgeBaseID,
			KnowledgeBaseName: chunk.KnowledgeBaseName,
			DocumentID:        &documentID,
			Filename:          chunk.Filename,
			Title:             chunk.Filename,
			Snippet:           chunk.Content,
		})
	}

	return results, nil
}
