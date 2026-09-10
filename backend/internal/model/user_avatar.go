package model

import (
	"time"

	"github.com/google/uuid"
)

// Only the normalized thumbnail is retained, never the original upload.
type UserAvatar struct {
	UserID    uuid.UUID `gorm:"type:uuid;primaryKey" json:"-"`
	User      User      `gorm:"foreignKey:UserID;constraint:OnDelete:CASCADE" json:"-"`
	Version   uuid.UUID `gorm:"type:uuid;not null" json:"-"`
	Data      []byte    `gorm:"type:bytea;not null" json:"-"`
	UpdatedAt time.Time `json:"-"`
}
