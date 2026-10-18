package repository

import (
	"context"
	"errors"

	"github.com/google/uuid"
	"gorm.io/gorm"
	"kbchat/backend/internal/model"
)

// Caller must first authorize the document with the requested capability.
func (r *DocumentRepository) PDFSnapshot(ctx context.Context, documentID uuid.UUID) ([]byte, error) {
	var snapshot model.DocumentPDFSnapshot
	err := r.db.WithContext(ctx).Where("document_id = ?", documentID).First(&snapshot).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return snapshot.Content, err
}
func (r *DocumentRepository) PDFCorrection(ctx context.Context, documentID uuid.UUID) ([]byte, error) {
	var correction model.DocumentPDFCorrection
	err := r.db.WithContext(ctx).Where("document_id = ?", documentID).First(&correction).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return correction.Content, err
}
