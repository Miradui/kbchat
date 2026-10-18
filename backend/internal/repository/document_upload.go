package repository

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"kbchat/backend/internal/model"
)

var ErrDocumentUploadReplayed = errors.New("document upload request already committed")
var ErrPDFCorrectionConflict = errors.New("published PDF snapshot changed")

type PDFCorrectionWrite struct {
	Content        []byte
	SourceRevision string
}

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
func (r *DocumentRepository) CommitUpload(ctx context.Context, document *model.Document, job *model.DocumentJob, actorID uuid.UUID, receipt *model.DocumentUploadReceipt, replaces *uuid.UUID, corrections ...PDFCorrectionWrite) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(document).Error; err != nil {
			return err
		}
		if len(corrections) > 0 && len(corrections[0].Content) > 0 {
			if err := tx.Create(&model.DocumentPDFCorrection{DocumentID: document.ID, Content: corrections[0].Content}).Error; err != nil {
				return err
			}
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
			if len(corrections) > 0 && len(corrections[0].Content) > 0 {
				// Publication locks this same document before replacing its snapshot.
				var source model.Document
				if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&source, "id = ?", *replaces).Error; err != nil {
					return err
				}
				var snapshot model.DocumentPDFSnapshot
				if err := tx.First(&snapshot, "document_id = ?", *replaces).Error; err != nil {
					return err
				}
				sum := sha256.Sum256(snapshot.Content)
				if hex.EncodeToString(sum[:]) != corrections[0].SourceRevision {
					return ErrPDFCorrectionConflict
				}
			}
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
