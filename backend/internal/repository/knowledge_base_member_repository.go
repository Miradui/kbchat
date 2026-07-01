package repository

import (
	"context"
	"errors"

	"github.com/google/uuid"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"rag/backend/internal/model"
)

type KnowledgeBaseMemberRepository struct {
	db *gorm.DB
}

func NewKnowledgeBaseMemberRepository(db *gorm.DB) *KnowledgeBaseMemberRepository {
	return &KnowledgeBaseMemberRepository{db: db}
}

func (r *KnowledgeBaseMemberRepository) Save(ctx context.Context, member *model.KnowledgeBaseMember) error {
	return r.db.WithContext(ctx).Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "knowledge_base_id"}, {Name: "user_id"}},
		DoUpdates: clause.AssignmentColumns([]string{"role", "updated_at"}),
	}).Create(member).Error
}

func (r *KnowledgeBaseMemberRepository) Find(ctx context.Context, kbID, userID uuid.UUID) (*model.KnowledgeBaseMember, error) {
	var member model.KnowledgeBaseMember
	err := r.db.WithContext(ctx).
		Where("knowledge_base_id = ? AND user_id = ?", kbID, userID).
		First(&member).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return &member, err
}

func (r *KnowledgeBaseMemberRepository) ListByKnowledgeBase(ctx context.Context, kbID uuid.UUID) ([]model.KnowledgeBaseMember, error) {
	var members []model.KnowledgeBaseMember
	err := r.db.WithContext(ctx).
		Preload("User").
		Where("knowledge_base_id = ?", kbID).
		Order("role asc, created_at asc").
		Find(&members).Error
	return members, err
}

func (r *KnowledgeBaseMemberRepository) Delete(ctx context.Context, kbID, userID uuid.UUID) error {
	return r.db.WithContext(ctx).
		Where("knowledge_base_id = ? AND user_id = ?", kbID, userID).
		Delete(&model.KnowledgeBaseMember{}).Error
}
