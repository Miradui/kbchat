package model

import (
	"github.com/google/uuid"
	"gorm.io/datatypes"
	"time"
)

type EvaluationCase struct {
	ID               uuid.UUID      `gorm:"type:uuid;primaryKey"`
	KnowledgeBaseID  uuid.UUID      `gorm:"type:uuid;not null;index"`
	KnowledgeBase    KnowledgeBase  `gorm:"constraint:OnDelete:CASCADE"`
	CreatedBy        uuid.UUID      `gorm:"type:uuid;not null"`
	Question         string         `gorm:"not null"`
	ExpectedAnswer   string         `gorm:"not null;default:''"`
	RequiredKeywords datatypes.JSON `gorm:"type:jsonb;not null"`
	RequireCitation  bool           `gorm:"not null"`
	CreatedAt        time.Time
	UpdatedAt        time.Time
}

type EvaluationRun struct {
	ID              uuid.UUID      `gorm:"type:uuid;primaryKey"`
	KnowledgeBaseID uuid.UUID      `gorm:"type:uuid;not null;index;uniqueIndex:idx_evaluation_run_request"`
	KnowledgeBase   KnowledgeBase  `gorm:"constraint:OnDelete:CASCADE"`
	CreatedBy       uuid.UUID      `gorm:"type:uuid;not null;uniqueIndex:idx_evaluation_run_request"`
	ClientRequestID uuid.UUID      `gorm:"type:uuid;not null;uniqueIndex:idx_evaluation_run_request"`
	RequestHash     string         `gorm:"size:64;not null"`
	Name            string         `gorm:"size:80;not null"`
	Status          string         `gorm:"size:20;not null;index"`
	Config          datatypes.JSON `gorm:"type:jsonb;not null"`
	Cases           datatypes.JSON `gorm:"type:jsonb;not null"`
	Results         datatypes.JSON `gorm:"type:jsonb;not null"`
	Runtime         datatypes.JSON `gorm:"type:jsonb;not null"`
	// AnswerConfig is the knowledge base's answer configuration when the run
	// was created, so two runs can be compared on prompt and model changes.
	AnswerConfig datatypes.JSON `gorm:"type:jsonb;not null;default:'{}'"`
	ErrorMessage string         `gorm:"not null;default:''"`
	LeaseToken   *uuid.UUID     `gorm:"type:uuid"`
	CreatedAt    time.Time
	UpdatedAt    time.Time
	StartedAt    *time.Time
	FinishedAt   *time.Time
}
