package model

import (
	"github.com/google/uuid"
	"time"
)

type QuestionTemplate struct {
	ID        uuid.UUID `gorm:"type:uuid;primaryKey"`
	UserID    uuid.UUID `gorm:"type:uuid;not null;index:idx_question_templates_user_updated,priority:1"`
	Title     string    `gorm:"size:100;not null"`
	Body      string    `gorm:"not null"`
	CreatedAt time.Time
	UpdatedAt time.Time `gorm:"index:idx_question_templates_user_updated,priority:2"`
}
