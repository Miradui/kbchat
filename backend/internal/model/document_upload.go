package model

import (
	"time"

	"github.com/google/uuid"
)

// A receipt outlives its document so retrying an old request cannot recreate a
// deleted file. Only committed writes have receipts; absence is safe to retry
// with the same key even when the original transaction is still in flight.
type DocumentUploadReceipt struct {
	UserID          uuid.UUID  `gorm:"type:uuid;primaryKey"`
	KnowledgeBaseID uuid.UUID  `gorm:"type:uuid;primaryKey"`
	RequestID       uuid.UUID  `gorm:"type:uuid;primaryKey"`
	Fingerprint     string     `gorm:"size:64;not null"`
	DocumentID      *uuid.UUID `gorm:"type:uuid;index"`
	CreatedAt       time.Time
}
