package model

import (
	"github.com/google/uuid"
	"time"
)

type ChatBookmark struct {
	MessageID uuid.UUID `gorm:"type:uuid;primaryKey"`
	UserID    uuid.UUID `gorm:"type:uuid;not null;index:idx_chat_bookmarks_user_created,priority:1"`
	Note      string    `gorm:"not null;default:''"`
	CreatedAt time.Time `gorm:"index:idx_chat_bookmarks_user_created,priority:2"`
	UpdatedAt time.Time
}
