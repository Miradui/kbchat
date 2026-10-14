package repository

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"kbchat/backend/internal/model"
)

var ErrDocumentAlreadySuperseded = errors.New("document is already superseded")

// A deleted or cross-library link stops the chain. UNION also terminates a
// malformed cycle without exposing documents outside this authorized library.
func (r *DocumentRepository) VersionChain(ctx context.Context, kbID, documentID uuid.UUID) ([]model.Document, error) {
	items := []model.Document{}
	err := r.db.WithContext(ctx).Raw(`WITH RECURSIVE versions AS (
 SELECT id, superseded_by_id FROM documents WHERE id = ? AND knowledge_base_id = ? AND deleted_at IS NULL
 UNION
 SELECT d.id, d.superseded_by_id FROM documents d JOIN versions v
 ON d.id = v.superseded_by_id OR d.superseded_by_id = v.id
 WHERE d.knowledge_base_id = ? AND d.deleted_at IS NULL
 ) SELECT d.* FROM documents d JOIN versions v ON d.id = v.id ORDER BY d.created_at ASC, d.id ASC LIMIT 101`, documentID, kbID, kbID).Scan(&items).Error
	return items, err
}

// FindByContentHash returns the oldest live document in a knowledge base whose
// content hash matches.
//
// Oldest rather than newest: when several copies already exist, the original is
// the one a user means by "the existing file". Superseded rows are excluded --
// they have already been replaced, so offering to replace them again would point
// the user at a version that is no longer current.
//
// The knowledge base is assumed already ownership-checked by the caller. This
// takes the knowledge base ID, not an owner, because the duplicate scope is a
// single knowledge base: the same file in two knowledge bases is two deliberate
// pieces of content, not a duplicate.
func (r *DocumentRepository) FindByContentHash(ctx context.Context, kbID uuid.UUID, contentHash string) (*model.Document, error) {
	if contentHash == "" {
		return nil, nil
	}
	var document model.Document
	err := r.db.WithContext(ctx).
		Where("knowledge_base_id = ? AND content_hash = ?", kbID, contentHash).
		Where("deleted_at IS NULL").
		Where("superseded_by_id IS NULL").
		Order("created_at ASC").
		First(&document).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &document, nil
}

// MarkSuperseded records that oldID was replaced by newID.
//
// Guarded on superseded_by_id IS NULL so two concurrent replacements cannot
// chain a document behind an already-recorded successor, which would silently
// lose the first replacement from the version trail.
func (r *DocumentRepository) MarkSuperseded(ctx context.Context, oldID, newID uuid.UUID, at time.Time) error {
	result := r.db.WithContext(ctx).
		Model(&model.Document{}).
		Where("id = ? AND deleted_at IS NULL AND superseded_by_id IS NULL", oldID).
		UpdateColumns(map[string]any{
			"superseded_by_id": newID,
			"superseded_at":    at.UTC(),
			"updated_at":       time.Now().UTC(),
		})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return ErrDocumentAlreadySuperseded
	}
	return nil
}
