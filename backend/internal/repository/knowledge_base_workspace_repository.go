package repository

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"kbchat/backend/internal/model"
)

type KnowledgeBaseFavoriteRepository struct {
	db *gorm.DB
}

func NewKnowledgeBaseFavoriteRepository(db *gorm.DB) *KnowledgeBaseFavoriteRepository {
	return &KnowledgeBaseFavoriteRepository{db: db}
}

func (r *KnowledgeBaseFavoriteRepository) Set(ctx context.Context, userID, kbID uuid.UUID, favorite bool) error {
	if !favorite {
		return r.db.WithContext(ctx).
			Where("user_id = ? AND knowledge_base_id = ?", userID, kbID).
			Delete(&model.KnowledgeBaseFavorite{}).Error
	}

	item := model.KnowledgeBaseFavorite{
		UserID:          userID,
		KnowledgeBaseID: kbID,
	}
	return r.db.WithContext(ctx).
		Clauses(clause.OnConflict{DoNothing: true}).
		Create(&item).Error
}

func (r *KnowledgeBaseFavoriteRepository) BatchSet(ctx context.Context, userID uuid.UUID, ids []uuid.UUID, favorite bool) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		repo := NewKnowledgeBaseFavoriteRepository(tx)
		for _, id := range ids {
			if err := repo.Set(ctx, userID, id, favorite); err != nil {
				return err
			}
		}
		return nil
	})
}

type KnowledgeBaseViewRepository struct {
	db *gorm.DB
}

func NewKnowledgeBaseViewRepository(db *gorm.DB) *KnowledgeBaseViewRepository {
	return &KnowledgeBaseViewRepository{db: db}
}

func (r *KnowledgeBaseViewRepository) Record(ctx context.Context, userID, kbID uuid.UUID) error {
	event := model.KnowledgeBaseViewEvent{
		UserID:          userID,
		KnowledgeBaseID: kbID,
		ViewedAt:        time.Now(),
	}
	return r.db.WithContext(ctx).Create(&event).Error
}

type KnowledgeBaseWorkspacePreferenceRepository struct {
	db *gorm.DB
}

func NewKnowledgeBaseWorkspacePreferenceRepository(db *gorm.DB) *KnowledgeBaseWorkspacePreferenceRepository {
	return &KnowledgeBaseWorkspacePreferenceRepository{db: db}
}

func (r *KnowledgeBaseWorkspacePreferenceRepository) FindByUserID(ctx context.Context, userID uuid.UUID) (*model.KnowledgeBaseWorkspacePreference, error) {
	var item model.KnowledgeBaseWorkspacePreference
	err := r.db.WithContext(ctx).Where("user_id = ?", userID).First(&item).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return &item, err
}

func (r *KnowledgeBaseWorkspacePreferenceRepository) Save(ctx context.Context, item *model.KnowledgeBaseWorkspacePreference) error {
	return r.db.WithContext(ctx).
		Clauses(clause.OnConflict{
			Columns:   []clause.Column{{Name: "user_id"}},
			DoUpdates: clause.AssignmentColumns([]string{"view_mode", "scope", "sort", "visibility", "expanded_category_ids", "updated_at"}),
		}).
		Create(item).Error
}
