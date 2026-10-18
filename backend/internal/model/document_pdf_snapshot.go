package model

import (
	"github.com/google/uuid"
	"gorm.io/datatypes"
)

// Kept out of documents so list/status queries never fetch entire PDF text.
type DocumentPDFSnapshot struct {
	DocumentID uuid.UUID      `gorm:"type:uuid;primaryKey"`
	Content    datatypes.JSON `gorm:"type:jsonb;not null"`
	Document   Document       `gorm:"foreignKey:DocumentID;constraint:OnDelete:CASCADE"`
}

// Immutable parsing baseline for a user-corrected revision; separate from its published snapshot.
type DocumentPDFCorrection struct {
	DocumentID uuid.UUID      `gorm:"type:uuid;primaryKey"`
	Content    datatypes.JSON `gorm:"type:jsonb;not null"`
	Document   Document       `gorm:"foreignKey:DocumentID;constraint:OnDelete:CASCADE"`
}
