package repository

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"kbchat/backend/internal/model"
)

var ErrDocumentUploadReplayed = errors.New("document upload request already committed")

func (r *DocumentRepository) UploadReceipt(ctx context.Context, actorID, kbID, requestID uuid.UUID) (*model.DocumentUploadReceipt, error) {
	var receipt model.DocumentUploadReceipt
	err := r.db.WithContext(ctx).Where("user_id = ? AND knowledge_base_id = ? AND request_id = ?", actorID, kbID, requestID).First(&receipt).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return &receipt, err
}

// CommitUpload publishes the file, task, optional replacement link and receipt
// together. A concurrent replay loses at the receipt key and rolls back its new
// document; a different replacement loses at the guarded version-link update.
func (r *DocumentRepository) CommitUpload(ctx context.Context, document *model.Document, job *model.DocumentJob, actorID uuid.UUID, receipt *model.DocumentUploadReceipt, replaces *uuid.UUID) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(document).Error; err != nil {
			return err
		}
		if receipt != nil {
			receipt.DocumentID = &document.ID
			result := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(receipt)
			if result.Error != nil {
				return result.Error
			}
			if result.RowsAffected == 0 {
				return ErrDocumentUploadReplayed
			}
		}
		if replaces != nil {
			result := tx.Model(&model.Document{}).
				Where("id = ? AND knowledge_base_id = ? AND deleted_at IS NULL AND superseded_by_id IS NULL", *replaces, document.KnowledgeBaseID).
				UpdateColumns(map[string]any{"superseded_by_id": document.ID, "superseded_at": time.Now().UTC(), "updated_at": time.Now().UTC()})
			if result.Error != nil {
				return result.Error
			}
			if result.RowsAffected != 1 {
				return ErrDocumentAlreadySuperseded
			}
		}
		job.DocumentID = document.ID
		if err := tx.Create(job).Error; err != nil {
			return err
		}
		if err := touchKnowledgeBase(tx, document.KnowledgeBaseID, actorID, time.Now()); err != nil {
			return err
		}
		result := tx.Where("storage_path = ? AND locked_at IS NULL", document.StoragePath).Delete(&model.StorageCleanupJob{})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return errors.New("storage cleanup reservation was lost before document commit")
		}
		return nil
	})
}
