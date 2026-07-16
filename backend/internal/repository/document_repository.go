package repository

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"rag/backend/internal/model"
)

type GlobalDocumentListItem struct {
	ID                uuid.UUID
	KnowledgeBaseID   uuid.UUID
	KnowledgeBaseName string
	Filename          string
	FileType          string
	FileSize          int64
	Status            string
	ErrorMessage      string
	CreatedAt         time.Time
	UpdatedAt         time.Time
}

type DocumentRepository struct {
	db *gorm.DB
}

func NewDocumentRepository(db *gorm.DB) *DocumentRepository {
	return &DocumentRepository{db: db}
}

func (r *DocumentRepository) CreateWithJob(ctx context.Context, document *model.Document, job *model.DocumentJob) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(document).Error; err != nil {
			return err
		}
		job.DocumentID = document.ID
		return tx.Create(job).Error
	})
}

func (r *DocumentRepository) ListByKnowledgeBase(ctx context.Context, kbID uuid.UUID) ([]model.Document, error) {
	var items []model.Document
	err := r.db.WithContext(ctx).
		Where("knowledge_base_id = ?", kbID).
		Where("deleted_at IS NULL").
		Order("created_at desc").
		Find(&items).Error
	return items, err
}

func (r *DocumentRepository) ListByOwner(ctx context.Context, ownerID uuid.UUID, query GlobalDocumentQuery) ([]GlobalDocumentListItem, int64, error) {
	page, pageSize := normalizePage(query.Page, query.PageSize)
	base := r.db.WithContext(ctx).
		Model(&model.Document{}).
		Joins("JOIN knowledge_bases ON knowledge_bases.id = documents.knowledge_base_id").
		Where("knowledge_bases.owner_id = ?", ownerID).
		Where("knowledge_bases.deleted_at IS NULL").
		Where("documents.deleted_at IS NULL")
	if query.Q != "" {
		like := "%" + strings.ToLower(query.Q) + "%"
		base = base.Where("LOWER(documents.filename) LIKE ? OR LOWER(knowledge_bases.name) LIKE ?", like, like)
	}
	if query.KnowledgeBaseID != uuid.Nil {
		base = base.Where("documents.knowledge_base_id = ?", query.KnowledgeBaseID)
	}
	if query.Status != "" {
		base = base.Where("documents.status = ?", query.Status)
	}
	if query.FileType != "" {
		base = base.Where("documents.file_type = ?", query.FileType)
	}

	var total int64
	if err := base.Count(&total).Error; err != nil {
		return nil, 0, err
	}

	order := "documents.updated_at desc"
	if query.Sort == "createdAt_desc" {
		order = "documents.created_at desc"
	} else if query.Sort == "filename_asc" {
		order = "documents.filename asc"
	}

	var items []GlobalDocumentListItem
	err := base.
		Select(`
			documents.id AS id,
			documents.knowledge_base_id AS knowledge_base_id,
			knowledge_bases.name AS knowledge_base_name,
			documents.filename AS filename,
			documents.file_type AS file_type,
			documents.file_size AS file_size,
			documents.status AS status,
			documents.error_message AS error_message,
			documents.created_at AS created_at,
			documents.updated_at AS updated_at
		`).
		Order(order).
		Limit(pageSize).
		Offset((page - 1) * pageSize).
		Scan(&items).Error
	return items, total, err
}

type GlobalDocumentQuery struct {
	Q               string
	KnowledgeBaseID uuid.UUID
	Status          string
	FileType        string
	Sort            string
	Page            int
	PageSize        int
}

func (r *DocumentRepository) FindByIDAndOwner(ctx context.Context, id, ownerID uuid.UUID) (*model.Document, error) {
	var document model.Document
	err := r.db.WithContext(ctx).
		Joins("JOIN knowledge_bases ON knowledge_bases.id = documents.knowledge_base_id").
		Where("documents.id = ? AND knowledge_bases.owner_id = ?", id, ownerID).
		Where("knowledge_bases.deleted_at IS NULL").
		Where("documents.deleted_at IS NULL").
		First(&document).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return &document, err
}

func (r *DocumentRepository) FindDeletedByIDAndOwner(ctx context.Context, id, ownerID uuid.UUID) (*model.Document, error) {
	var document model.Document
	err := r.db.WithContext(ctx).
		Unscoped().
		Joins("JOIN knowledge_bases ON knowledge_bases.id = documents.knowledge_base_id").
		Where("documents.id = ? AND knowledge_bases.owner_id = ?", id, ownerID).
		Where("documents.deleted_at IS NOT NULL").
		First(&document).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return &document, err
}

func (r *DocumentRepository) Delete(ctx context.Context, document *model.Document) error {
	return r.db.WithContext(ctx).Delete(document).Error
}

func (r *DocumentRepository) CreateJob(ctx context.Context, job *model.DocumentJob) error {
	return r.db.WithContext(ctx).Create(job).Error
}

func (r *DocumentRepository) QueueReprocess(ctx context.Context, documentID uuid.UUID) (*model.DocumentJob, bool, error) {
	var job model.DocumentJob
	created := false
	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var document model.Document
		if err := tx.
			Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("id = ?", documentID).
			First(&document).Error; err != nil {
			return err
		}

		err := tx.
			Where("document_id = ? AND status IN ?", documentID, []string{"pending", "running"}).
			Order("created_at desc").
			First(&job).Error
		if err == nil {
			return nil
		}
		if !errors.Is(err, gorm.ErrRecordNotFound) {
			return err
		}

		now := time.Now()
		if err := tx.Model(&document).Updates(map[string]any{
			"status":        "uploaded",
			"error_message": "",
			"updated_at":    now,
		}).Error; err != nil {
			return err
		}

		job = model.DocumentJob{
			DocumentID: documentID,
			JobType:    "process_document",
			Status:     "pending",
		}
		if err := tx.Create(&job).Error; err != nil {
			return err
		}
		created = true
		return nil
	})
	if err != nil {
		return nil, false, err
	}
	return &job, created, nil
}

func (r *DocumentRepository) LatestJobsByDocumentIDs(ctx context.Context, documentIDs []uuid.UUID) (map[uuid.UUID]model.DocumentJob, error) {
	jobsByDocumentID := make(map[uuid.UUID]model.DocumentJob, len(documentIDs))
	if len(documentIDs) == 0 {
		return jobsByDocumentID, nil
	}

	var jobs []model.DocumentJob
	err := r.db.WithContext(ctx).
		Where("document_id IN ?", documentIDs).
		Order("document_id asc, created_at desc").
		Find(&jobs).Error
	if err != nil {
		return nil, err
	}

	for _, job := range jobs {
		if _, exists := jobsByDocumentID[job.DocumentID]; exists {
			continue
		}
		jobsByDocumentID[job.DocumentID] = job
	}
	return jobsByDocumentID, nil
}

func (r *DocumentRepository) ClaimPendingJob(ctx context.Context) (*model.DocumentJob, error) {
	var job model.DocumentJob
	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.
			Where("status = ?", "pending").
			Where("locked_at IS NULL OR locked_at <= ?", time.Now()).
			Order("created_at asc").
			Clauses(clauseLockingUpdateSkipLocked()).
			First(&job).Error; err != nil {
			return err
		}

		now := time.Now()
		return tx.Model(&job).Updates(map[string]any{
			"status":     "running",
			"locked_at":  &now,
			"updated_at": now,
		}).Error
	})
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &job, nil
}

func (r *DocumentRepository) RecoverRunningJobs(ctx context.Context) error {
	now := time.Now()
	return r.db.WithContext(ctx).
		Model(&model.DocumentJob{}).
		Where("status = ?", "running").
		Updates(map[string]any{
			"status":     "pending",
			"locked_at":  nil,
			"updated_at": now,
		}).Error
}

func (r *DocumentRepository) FindByID(ctx context.Context, id uuid.UUID) (*model.Document, error) {
	var document model.Document
	err := r.db.WithContext(ctx).Where("id = ?", id).Where("deleted_at IS NULL").First(&document).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return &document, err
}

func (r *DocumentRepository) Restore(ctx context.Context, id uuid.UUID) error {
	return r.db.WithContext(ctx).
		Unscoped().
		Model(&model.Document{}).
		Where("id = ?", id).
		Update("deleted_at", nil).Error
}

func (r *DocumentRepository) PermanentDelete(ctx context.Context, documentID uuid.UUID) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("document_id = ?", documentID).Delete(&model.DocumentChunk{}).Error; err != nil {
			return err
		}
		if err := tx.Where("document_id = ?", documentID).Delete(&model.DocumentJob{}).Error; err != nil {
			return err
		}
		return tx.Unscoped().Delete(&model.Document{ID: documentID}).Error
	})
}

func (r *DocumentRepository) EmptyDeletedByOwner(ctx context.Context, ownerID uuid.UUID) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var ids []uuid.UUID
		if err := tx.Unscoped().
			Model(&model.Document{}).
			Joins("JOIN knowledge_bases ON knowledge_bases.id = documents.knowledge_base_id").
			Where("knowledge_bases.owner_id = ?", ownerID).
			Where("documents.deleted_at IS NOT NULL").
			Pluck("documents.id", &ids).Error; err != nil {
			return err
		}
		for _, id := range ids {
			if err := tx.Where("document_id = ?", id).Delete(&model.DocumentChunk{}).Error; err != nil {
				return err
			}
			if err := tx.Where("document_id = ?", id).Delete(&model.DocumentJob{}).Error; err != nil {
				return err
			}
			if err := tx.Unscoped().Delete(&model.Document{ID: id}).Error; err != nil {
				return err
			}
		}
		return nil
	})
}

type RecycleDocumentItem struct {
	ID                uuid.UUID
	KnowledgeBaseID   uuid.UUID
	KnowledgeBaseName string
	Filename          string
	DeletedAt         time.Time
}

func (r *DocumentRepository) ListDeletedByOwner(ctx context.Context, ownerID uuid.UUID, page, pageSize int) ([]RecycleDocumentItem, int64, error) {
	page, pageSize = normalizePage(page, pageSize)
	base := r.db.WithContext(ctx).
		Unscoped().
		Model(&model.Document{}).
		Joins("JOIN knowledge_bases ON knowledge_bases.id = documents.knowledge_base_id").
		Where("knowledge_bases.owner_id = ?", ownerID).
		Where("documents.deleted_at IS NOT NULL")

	var total int64
	if err := base.Count(&total).Error; err != nil {
		return nil, 0, err
	}

	var items []RecycleDocumentItem
	err := base.Select(`
			documents.id AS id,
			documents.knowledge_base_id AS knowledge_base_id,
			knowledge_bases.name AS knowledge_base_name,
			documents.filename AS filename,
			documents.deleted_at AS deleted_at
		`).
		Order("documents.deleted_at desc").
		Limit(pageSize).
		Offset((page - 1) * pageSize).
		Scan(&items).Error
	return items, total, err
}

func (r *DocumentRepository) UpdateStatus(ctx context.Context, documentID uuid.UUID, status string, errorMessage string) error {
	return r.db.WithContext(ctx).Model(&model.Document{}).
		Where("id = ?", documentID).
		Updates(map[string]any{
			"status":        status,
			"error_message": errorMessage,
			"updated_at":    time.Now(),
		}).Error
}

func (r *DocumentRepository) CompleteJob(ctx context.Context, jobID uuid.UUID) error {
	return r.db.WithContext(ctx).Model(&model.DocumentJob{}).
		Where("id = ?", jobID).
		Updates(map[string]any{
			"status":        "completed",
			"error_message": "",
			"locked_at":     nil,
			"updated_at":    time.Now(),
		}).Error
}

func (r *DocumentRepository) FailJob(ctx context.Context, jobID uuid.UUID, message string) error {
	return r.db.WithContext(ctx).Model(&model.DocumentJob{}).
		Where("id = ?", jobID).
		Updates(map[string]any{
			"status":        "failed",
			"error_message": message,
			"locked_at":     nil,
			"updated_at":    time.Now(),
		}).Error
}

func (r *DocumentRepository) RetryJob(ctx context.Context, jobID uuid.UUID, retryCount int, retryAt time.Time, message string) error {
	return r.db.WithContext(ctx).Model(&model.DocumentJob{}).
		Where("id = ?", jobID).
		Updates(map[string]any{
			"status":        "pending",
			"retry_count":   retryCount,
			"error_message": message,
			"locked_at":     retryAt,
			"updated_at":    time.Now(),
		}).Error
}

func clauseLockingUpdateSkipLocked() clause.Expression {
	return clause.Locking{Strength: "UPDATE", Options: "SKIP LOCKED"}
}
