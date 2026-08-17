package repository

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"rag/backend/internal/dto"
	"rag/backend/internal/model"
)

type KnowledgeBaseTagRepository struct {
	db *gorm.DB
}

func NewKnowledgeBaseTagRepository(db *gorm.DB) *KnowledgeBaseTagRepository {
	return &KnowledgeBaseTagRepository{db: db}
}

func (r *KnowledgeBaseTagRepository) Create(ctx context.Context, tag *model.KnowledgeBaseTag) error {
	return r.db.WithContext(ctx).Create(tag).Error
}

func (r *KnowledgeBaseTagRepository) ListByOwner(ctx context.Context, ownerID uuid.UUID) ([]model.KnowledgeBaseTag, error) {
	var items []model.KnowledgeBaseTag
	err := r.db.WithContext(ctx).
		Where("owner_id = ?", ownerID).
		Order("name asc, created_at asc").
		Find(&items).Error
	return items, err
}

func (r *KnowledgeBaseTagRepository) FindByIDAndOwner(ctx context.Context, id, ownerID uuid.UUID) (*model.KnowledgeBaseTag, error) {
	var tag model.KnowledgeBaseTag
	err := r.db.WithContext(ctx).Where("id = ? AND owner_id = ?", id, ownerID).First(&tag).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return &tag, err
}

func (r *KnowledgeBaseTagRepository) FindByIDsAndOwner(ctx context.Context, ownerID uuid.UUID, ids []uuid.UUID) ([]model.KnowledgeBaseTag, error) {
	if len(ids) == 0 {
		return []model.KnowledgeBaseTag{}, nil
	}
	var items []model.KnowledgeBaseTag
	err := r.db.WithContext(ctx).
		Where("owner_id = ? AND id IN ?", ownerID, ids).
		Find(&items).Error
	return items, err
}

func (r *KnowledgeBaseTagRepository) Update(ctx context.Context, tag *model.KnowledgeBaseTag) error {
	return r.db.WithContext(ctx).Save(tag).Error
}

func (r *KnowledgeBaseTagRepository) Delete(ctx context.Context, tag *model.KnowledgeBaseTag) error {
	return r.db.WithContext(ctx).Delete(tag).Error
}

// CountBindings and CountBindingsByOwner intentionally share the same scope:
// every knowledge base owned by the tag owner that references the tag, including
// soft-deleted ones still sitting in the recycle bin. The list count therefore
// predicts the TAG_NOT_EMPTY guard exactly.
func (r *KnowledgeBaseTagRepository) CountBindings(ctx context.Context, ownerID, tagID uuid.UUID) (int64, error) {
	var count int64
	err := r.db.WithContext(ctx).
		Model(&model.KnowledgeBaseTagBinding{}).
		Joins("JOIN knowledge_bases ON knowledge_bases.id = knowledge_base_tag_bindings.knowledge_base_id").
		Where("knowledge_base_tag_bindings.tag_id = ?", tagID).
		Where("knowledge_bases.owner_id = ?", ownerID).
		Count(&count).Error
	return count, err
}

func (r *KnowledgeBaseTagRepository) CountBindingsByOwner(ctx context.Context, ownerID uuid.UUID) (map[uuid.UUID]int64, error) {
	type row struct {
		TagID uuid.UUID
		Total int64
	}

	var rows []row
	err := r.db.WithContext(ctx).
		Table("knowledge_base_tag_bindings").
		Select("knowledge_base_tag_bindings.tag_id AS tag_id, COUNT(*) AS total").
		Joins("JOIN knowledge_bases ON knowledge_bases.id = knowledge_base_tag_bindings.knowledge_base_id").
		Joins("JOIN knowledge_base_tags ON knowledge_base_tags.id = knowledge_base_tag_bindings.tag_id").
		Where("knowledge_base_tags.owner_id = ?", ownerID).
		Where("knowledge_bases.owner_id = ?", ownerID).
		Group("knowledge_base_tag_bindings.tag_id").
		Scan(&rows).Error
	if err != nil {
		return nil, err
	}

	counts := make(map[uuid.UUID]int64, len(rows))
	for _, item := range rows {
		counts[item.TagID] = item.Total
	}
	return counts, nil
}

type KnowledgeBaseTagBindingRepository struct {
	db *gorm.DB
}

func NewKnowledgeBaseTagBindingRepository(db *gorm.DB) *KnowledgeBaseTagBindingRepository {
	return &KnowledgeBaseTagBindingRepository{db: db}
}

func (r *KnowledgeBaseTagBindingRepository) ReplaceForKnowledgeBase(ctx context.Context, kbID uuid.UUID, tagIDs []uuid.UUID) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("knowledge_base_id = ?", kbID).Delete(&model.KnowledgeBaseTagBinding{}).Error; err != nil {
			return err
		}
		if len(tagIDs) == 0 {
			return nil
		}
		items := make([]model.KnowledgeBaseTagBinding, 0, len(tagIDs))
		for _, tagID := range tagIDs {
			items = append(items, model.KnowledgeBaseTagBinding{
				KnowledgeBaseID: kbID,
				TagID:           tagID,
			})
		}
		return tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&items).Error
	})
}

// ApplyForKnowledgeBases applies one tag mutation across several knowledge bases
// inside a single transaction, matching the all-or-nothing semantics of the other
// batch endpoints. Ownership of both the knowledge bases and the tags must already
// be verified by the caller. Knowledge base updated_at/updated_by are touched in
// the same transaction so a rollback cannot leave a bare timestamp bump behind.
func (r *KnowledgeBaseTagBindingRepository) ApplyForKnowledgeBases(ctx context.Context, kbIDs, tagIDs []uuid.UUID, mode string, actorID uuid.UUID) error {
	if len(kbIDs) == 0 {
		return nil
	}
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		switch mode {
		case dto.KnowledgeBaseBatchTagModeRemove:
			if len(tagIDs) > 0 {
				if err := tx.Where("knowledge_base_id IN ? AND tag_id IN ?", kbIDs, tagIDs).
					Delete(&model.KnowledgeBaseTagBinding{}).Error; err != nil {
					return err
				}
			}
		case dto.KnowledgeBaseBatchTagModeReplace:
			if err := tx.Where("knowledge_base_id IN ?", kbIDs).
				Delete(&model.KnowledgeBaseTagBinding{}).Error; err != nil {
				return err
			}
			if err := insertTagBindings(tx, kbIDs, tagIDs); err != nil {
				return err
			}
		default:
			if err := insertTagBindings(tx, kbIDs, tagIDs); err != nil {
				return err
			}
		}

		return tx.Model(&model.KnowledgeBase{}).
			Where("id IN ?", kbIDs).
			Updates(map[string]any{
				"updated_by_id": actorID,
				"updated_at":    time.Now(),
			}).Error
	})
}

func insertTagBindings(tx *gorm.DB, kbIDs, tagIDs []uuid.UUID) error {
	if len(tagIDs) == 0 {
		return nil
	}
	items := make([]model.KnowledgeBaseTagBinding, 0, len(kbIDs)*len(tagIDs))
	for _, kbID := range kbIDs {
		for _, tagID := range tagIDs {
			items = append(items, model.KnowledgeBaseTagBinding{
				KnowledgeBaseID: kbID,
				TagID:           tagID,
			})
		}
	}
	return tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&items).Error
}

func (r *KnowledgeBaseTagBindingRepository) ListByKnowledgeBaseIDs(ctx context.Context, kbIDs []uuid.UUID) (map[uuid.UUID][]model.KnowledgeBaseTag, error) {
	result := make(map[uuid.UUID][]model.KnowledgeBaseTag)
	if len(kbIDs) == 0 {
		return result, nil
	}

	type row struct {
		KnowledgeBaseID uuid.UUID
		TagID           uuid.UUID
		OwnerID         uuid.UUID
		Name            string
		CreatedAt       time.Time
		UpdatedAt       time.Time
	}

	var rows []row
	err := r.db.WithContext(ctx).
		Table("knowledge_base_tag_bindings").
		Select(`
			knowledge_base_tag_bindings.knowledge_base_id AS knowledge_base_id,
			knowledge_base_tags.id AS tag_id,
			knowledge_base_tags.owner_id AS owner_id,
			knowledge_base_tags.name AS name,
			knowledge_base_tags.created_at AS created_at,
			knowledge_base_tags.updated_at AS updated_at
		`).
		Joins("JOIN knowledge_base_tags ON knowledge_base_tags.id = knowledge_base_tag_bindings.tag_id").
		Where("knowledge_base_tag_bindings.knowledge_base_id IN ?", kbIDs).
		Order("knowledge_base_tags.name asc").
		Scan(&rows).Error
	if err != nil {
		return nil, err
	}

	for _, item := range rows {
		result[item.KnowledgeBaseID] = append(result[item.KnowledgeBaseID], model.KnowledgeBaseTag{
			ID:        item.TagID,
			OwnerID:   item.OwnerID,
			Name:      item.Name,
			CreatedAt: item.CreatedAt,
			UpdatedAt: item.UpdatedAt,
		})
	}

	return result, nil
}
