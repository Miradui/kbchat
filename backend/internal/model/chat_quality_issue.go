package model

import (
	"github.com/google/uuid"
	"gorm.io/datatypes"
	"time"
)

type ChatQualityIssue struct {
	UserID           uuid.UUID      `gorm:"type:uuid;primaryKey"`
	SessionID        uuid.UUID      `gorm:"type:uuid;primaryKey"`
	QuestionKey      string         `gorm:"size:64;primaryKey"`
	Question         string         `gorm:"not null"`
	Status           string         `gorm:"size:16;not null;default:open"`
	Note             string         `gorm:"not null;default:''"`
	EvaluationCaseID *uuid.UUID     `gorm:"type:uuid"`
	EvaluationRunID  *uuid.UUID     `gorm:"type:uuid"`
	DocumentIDs      datatypes.JSON `gorm:"type:jsonb;not null;default:'[]'"`
	UpdatedAt        time.Time
	User             User            `gorm:"foreignKey:UserID;constraint:OnDelete:CASCADE"`
	Session          ChatSession     `gorm:"foreignKey:SessionID;constraint:OnDelete:CASCADE"`
	EvaluationCase   *EvaluationCase `gorm:"foreignKey:EvaluationCaseID;constraint:OnDelete:SET NULL"`
	EvaluationRun    *EvaluationRun  `gorm:"foreignKey:EvaluationRunID;constraint:OnDelete:SET NULL"`
}
