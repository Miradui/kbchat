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

var ErrTransferTargetInvalid = errors.New("new owner must be an active, different user")
var ErrOwnershipChanged = errors.New("knowledge base ownership changed")

// TransferOwnership moves one live KB, or all KBs (including deleted ones) when
// kbID is nil. Every row is locked and the batch either commits entirely or rolls back.
func (r *KnowledgeBaseRepository) TransferOwnership(ctx context.Context, kbID *uuid.UUID, ownerID, newOwnerID, actorID uuid.UUID, keep bool) ([]model.KnowledgeBase, error) {
	var items []model.KnowledgeBase
	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if ownerID == newOwnerID || newOwnerID == uuid.Nil {
			return ErrTransferTargetInvalid
		}
		// A stable account lock order also serializes against disabling the target.
		var users []model.User
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("id IN ?", []uuid.UUID{ownerID, newOwnerID}).Order("id").Find(&users).Error; err != nil {
			return err
		}
		foundOwner, foundTarget := false, false
		for _, user := range users {
			if user.ID == ownerID {
				foundOwner = true
			}
			if user.ID == newOwnerID && user.Status == "active" {
				foundTarget = true
			}
		}
		if !foundOwner {
			return ErrAdminUserNotFound
		}
		if !foundTarget {
			return ErrTransferTargetInvalid
		}
		query := tx.Unscoped().Where("owner_id = ?", ownerID)
		if kbID != nil {
			query = query.Where("id = ? AND deleted_at IS NULL", *kbID)
		}
		if err := query.Clauses(clause.Locking{Strength: "UPDATE"}).Order("id").Find(&items).Error; err != nil {
			return err
		}
		if kbID != nil && len(items) != 1 {
			return ErrOwnershipChanged
		}
		for i := range items {
			kb := &items[i]
			values := map[string]any{"owner_id": newOwnerID, "updated_by_id": actorID, "updated_at": time.Now()}
			if kb.CategoryID != nil {
				var count int64
				if err := tx.Model(&model.KnowledgeBaseCategory{}).Where("id = ? AND owner_id = ?", *kb.CategoryID, newOwnerID).Count(&count).Error; err != nil {
					return err
				}
				if count == 0 {
					values["category_id"] = nil
				}
			}
			if err := tx.Unscoped().Model(&model.KnowledgeBase{}).Where("id = ? AND owner_id = ?", kb.ID, ownerID).Updates(values).Error; err != nil {
				return err
			}
			if err := tx.Where("knowledge_base_id = ? AND user_id IN ?", kb.ID, []uuid.UUID{ownerID, newOwnerID}).Delete(&model.KnowledgeBaseMember{}).Error; err != nil {
				return err
			}
			if keep {
				member := model.KnowledgeBaseMember{KnowledgeBaseID: kb.ID, UserID: ownerID, Role: "manager"}
				if err := tx.Omit(clause.Associations).Create(&member).Error; err != nil {
					return err
				}
			}
			kb.OwnerID = newOwnerID
		}
		return nil
	})
	return items, err
}

func (r *KnowledgeBaseRepository) CountOwned(ctx context.Context, userIDs []uuid.UUID) (map[uuid.UUID]int64, error) {
	result := map[uuid.UUID]int64{}
	if len(userIDs) == 0 {
		return result, nil
	}
	var rows []struct {
		OwnerID uuid.UUID
		Count   int64
	}
	err := r.db.WithContext(ctx).Unscoped().Model(&model.KnowledgeBase{}).Select("owner_id, COUNT(*) AS count").Where("owner_id IN ?", userIDs).Group("owner_id").Scan(&rows).Error
	for _, row := range rows {
		result[row.OwnerID] = row.Count
	}
	return result, err
}
