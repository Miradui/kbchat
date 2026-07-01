package repository

import (
	"context"
	"errors"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"rag/backend/internal/model"
)

type KnowledgeBaseCategoryRepository struct {
	db *gorm.DB
}

func NewKnowledgeBaseCategoryRepository(db *gorm.DB) *KnowledgeBaseCategoryRepository {
	return &KnowledgeBaseCategoryRepository{db: db}
}

func (r *KnowledgeBaseCategoryRepository) Create(ctx context.Context, category *model.KnowledgeBaseCategory) error {
	return r.db.WithContext(ctx).Create(category).Error
}

func (r *KnowledgeBaseCategoryRepository) ListByOwner(ctx context.Context, ownerID uuid.UUID) ([]model.KnowledgeBaseCategory, error) {
	var items []model.KnowledgeBaseCategory
	err := r.db.WithContext(ctx).
		Where("owner_id = ?", ownerID).
		Order("sort_order asc, created_at asc").
		Find(&items).Error
	return items, err
}

func (r *KnowledgeBaseCategoryRepository) FindByIDAndOwner(ctx context.Context, id, ownerID uuid.UUID) (*model.KnowledgeBaseCategory, error) {
	var category model.KnowledgeBaseCategory
	err := r.db.WithContext(ctx).Where("id = ? AND owner_id = ?", id, ownerID).First(&category).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return &category, err
}

func (r *KnowledgeBaseCategoryRepository) Update(ctx context.Context, category *model.KnowledgeBaseCategory) error {
	return r.db.WithContext(ctx).Save(category).Error
}

func (r *KnowledgeBaseCategoryRepository) Delete(ctx context.Context, category *model.KnowledgeBaseCategory) error {
	return r.db.WithContext(ctx).Delete(category).Error
}

func (r *KnowledgeBaseCategoryRepository) HasChildren(ctx context.Context, id uuid.UUID) (bool, error) {
	var count int64
	err := r.db.WithContext(ctx).
		Model(&model.KnowledgeBaseCategory{}).
		Where("parent_id = ?", id).
		Count(&count).Error
	return count > 0, err
}

func (r *KnowledgeBaseCategoryRepository) ReplaceTree(ctx context.Context, ownerID uuid.UUID, items []model.KnowledgeBaseCategory) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		for i := range items {
			if err := tx.
				Model(&model.KnowledgeBaseCategory{}).
				Where("id = ? AND owner_id = ?", items[i].ID, ownerID).
				Updates(map[string]any{
					"parent_id":  items[i].ParentID,
					"sort_order": items[i].SortOrder,
				}).Error; err != nil {
				return err
			}
		}
		return nil
	})
}
