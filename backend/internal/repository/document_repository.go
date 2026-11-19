package repository

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"gorm.io/datatypes"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"kbchat/backend/internal/model"
)

type GlobalDocumentListItem struct {
	SourcePath        string
	ID                uuid.UUID
	KnowledgeBaseID   uuid.UUID
	KnowledgeBaseName string
	Filename          string
	FileType          string
	FileSize          int64
	Status            string
	ErrorMessage      string
	ErrorCode         *string
	SupersededByID    *uuid.UUID
	SupersededAt      *time.Time
	CreatedAt         time.Time
	UpdatedAt         time.Time
}

type DocumentRepository struct {
	db *gorm.DB
}

var (
	errDocumentJobBlocked    = errors.New("document job blocked by running predecessor")
	errDocumentJobNotRunning = errors.New("document job is not running")

	// ErrDocumentJobActive rejects a cross-knowledge-base move while the document
	// still has a queued or running job.
	ErrDocumentJobActive = errors.New("document has an active processing job")
	// ErrDocumentJobNotCancellable is returned when there is nothing to cancel:
	// the document has no pending or running job.
	ErrDocumentJobNotCancellable = errors.New("document has no cancellable job")
	// ErrDocumentJobCancelled tells an in-flight processor that its job was
	// cancelled and it should stop instead of publishing its result.
	ErrDocumentJobCancelled = errors.New("document job was cancelled")
	// ErrDocumentNotDeleted means restore/permanent-delete lost a race and the
	// document is no longer present in the recycle bin.
	ErrDocumentNotDeleted = errors.New("document is not in the recycle bin")
)

// DocumentJobCancelledMessage is stored on both the job and the document so the
// service layer can tell a cancel apart from a genuine processing failure.
const DocumentJobCancelledMessage = "document job cancelled by user"

// DocumentErrorCodeCancelled duplicates processor.ErrorCodeCancelled rather than
// importing it: the processor already depends on this package, so referencing it
// from here would be an import cycle.
const DocumentErrorCodeCancelled = "cancelled"

func NewDocumentRepository(db *gorm.DB) *DocumentRepository {
	return &DocumentRepository{db: db}
}

func (r *DocumentRepository) CreateWithJob(ctx context.Context, document *model.Document, job *model.DocumentJob, updatedByID uuid.UUID) error {
	return r.createWithJob(ctx, document, job, updatedByID, false)
}

func (r *DocumentRepository) CreateWithJobAndReleaseStorageReservation(ctx context.Context, document *model.Document, job *model.DocumentJob, updatedByID uuid.UUID) error {
	return r.createWithJob(ctx, document, job, updatedByID, true)
}

func (r *DocumentRepository) createWithJob(ctx context.Context, document *model.Document, job *model.DocumentJob, updatedByID uuid.UUID, releaseReservation bool) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(document).Error; err != nil {
			return err
		}
		job.DocumentID = document.ID
		if err := tx.Create(job).Error; err != nil {
			return err
		}
		if err := touchKnowledgeBase(tx, document.KnowledgeBaseID, updatedByID, time.Now()); err != nil {
			return err
		}
		if releaseReservation {
			result := tx.Where("storage_path = ? AND locked_at IS NULL", document.StoragePath).
				Delete(&model.StorageCleanupJob{})
			if result.Error != nil {
				return result.Error
			}
			if result.RowsAffected != 1 {
				return errors.New("storage cleanup reservation was lost before document commit")
			}
		}
		return nil
	})
}

// ListForActor lists documents across every knowledge base the actor can reach.
//
// memberRoles are the stored member roles that hold the capability this list needs,
// supplied by the service from the capability matrix. A cross-knowledge-base list
// cannot authorize row by row without a query per row, so reachability is expressed
// here instead -- but the role set is still derived from the matrix rather than
// spelled out in SQL.
func (r *DocumentRepository) ListForActor(ctx context.Context, actorID uuid.UUID, memberRoles []string, query GlobalDocumentQuery) ([]GlobalDocumentListItem, int64, error) {
	page, pageSize := normalizePage(query.Page, query.PageSize)
	base := r.documentQueryForActor(ctx, actorID, memberRoles, query)

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
			documents.source_path AS source_path,
			documents.file_type AS file_type,
			documents.file_size AS file_size,
			documents.status AS status,
			documents.error_message AS error_message,
			documents.error_code AS error_code,
			documents.superseded_by_id AS superseded_by_id,
			documents.superseded_at AS superseded_at,
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
	ExcludeCancelled bool
	Q                string
	KnowledgeBaseID  uuid.UUID
	Status           string
	FileType         string
	Sort             string
	Page             int
	PageSize         int
}

type DocumentCounts struct {
	Total      int64
	Completed  int64
	Processing int64
	Failed     int64
}

// CountsForActor reads every status bucket in one statement and snapshot.
// Status and pagination belong to the list, not to its status-filter controls.
func (r *DocumentRepository) CountsForActor(ctx context.Context, actorID uuid.UUID, memberRoles []string, query GlobalDocumentQuery) (DocumentCounts, error) {
	query.Status = ""
	var counts DocumentCounts
	err := r.documentQueryForActor(ctx, actorID, memberRoles, query).
		Select(`COUNT(*) AS total,
			COUNT(CASE WHEN documents.status = ? THEN 1 END) AS completed,
			COUNT(CASE WHEN documents.status IN ? THEN 1 END) AS processing,
			COUNT(CASE WHEN documents.status = ? THEN 1 END) AS failed`,
			"completed", []string{"uploaded", "parsing", "chunking", "embedding"}, "failed").
		Scan(&counts).Error
	return counts, err
}

func (r *DocumentRepository) documentQueryForActor(ctx context.Context, actorID uuid.UUID, memberRoles []string, query GlobalDocumentQuery) *gorm.DB {
	base := r.db.WithContext(ctx).
		Model(&model.Document{}).
		Joins("JOIN knowledge_bases ON knowledge_bases.id = documents.knowledge_base_id").
		Where(reachableKnowledgeBaseCondition(r.db, actorID, memberRoles)).
		Where("knowledge_bases.deleted_at IS NULL").
		Where("documents.deleted_at IS NULL")
	if query.Q != "" {
		like := "%" + strings.ToLower(query.Q) + "%"
		base = base.Where("LOWER(documents.filename) LIKE ? OR LOWER(knowledge_bases.name) LIKE ?", like, like)
	}
	if query.KnowledgeBaseID != uuid.Nil {
		base = base.Where("documents.knowledge_base_id = ?", query.KnowledgeBaseID)
	}
	if query.Status == "processing" {
		base = base.Where("documents.status IN ?", []string{"uploaded", "parsing", "chunking", "embedding"})
	} else if query.Status != "" {
		base = base.Where("documents.status = ?", query.Status)
	}
	if query.FileType != "" {
		base = base.Where("documents.file_type = ?", query.FileType)
	}
	if query.ExcludeCancelled {
		// Older cancelled documents can lack error_code. Only the latest job
		// counts, so a later failed retry remains actionable.
		base = base.Where("COALESCE(documents.error_code, '') <> ?", DocumentErrorCodeCancelled).
			Where(`COALESCE((SELECT document_jobs.status FROM document_jobs
				WHERE document_jobs.document_id = documents.id
				ORDER BY document_jobs.created_at DESC, document_jobs.id DESC LIMIT 1), '') <> ?`, "cancelled")
	}
	return base
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
	if document == nil {
		return gorm.ErrRecordNotFound
	}
	return r.softDeleteAndCancelJobs(ctx, []uuid.UUID{document.ID})
}

func (r *DocumentRepository) BatchDelete(ctx context.Context, documentIDs []uuid.UUID) error {
	return r.softDeleteAndCancelJobs(ctx, documentIDs)
}

func (r *DocumentRepository) softDeleteAndCancelJobs(ctx context.Context, documentIDs []uuid.UUID) error {
	orderedIDs := append([]uuid.UUID(nil), documentIDs...)
	sort.Slice(orderedIDs, func(i, j int) bool {
		return orderedIDs[i].String() < orderedIDs[j].String()
	})
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var documents []model.Document
		if err := tx.
			Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("id IN ?", orderedIDs).
			Order("id asc").
			Find(&documents).Error; err != nil {
			return err
		}
		if len(documents) != len(orderedIDs) {
			return gorm.ErrRecordNotFound
		}

		var activeJobs []model.DocumentJob
		if err := tx.
			Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("document_id IN ? AND job_type = ? AND status IN ?", orderedIDs, "process_document", []string{"pending", "running"}).
			Order("document_id asc, created_at asc").
			Find(&activeJobs).Error; err != nil {
			return err
		}
		if len(activeJobs) > 0 {
			now := time.Now()
			jobIDs := make([]uuid.UUID, 0, len(activeJobs))
			activeDocumentIDs := make([]uuid.UUID, 0, len(activeJobs))
			seenDocuments := make(map[uuid.UUID]struct{}, len(activeJobs))
			for i := range activeJobs {
				jobIDs = append(jobIDs, activeJobs[i].ID)
				if _, seen := seenDocuments[activeJobs[i].DocumentID]; !seen {
					seenDocuments[activeJobs[i].DocumentID] = struct{}{}
					activeDocumentIDs = append(activeDocumentIDs, activeJobs[i].DocumentID)
				}
			}
			if err := tx.Model(&model.DocumentJob{}).
				Where("id IN ?", jobIDs).
				Updates(map[string]any{
					"status":        "cancelled",
					"error_message": DocumentJobCancelledMessage,
					"locked_at":     nil,
					"updated_at":    now,
				}).Error; err != nil {
				return err
			}
			if err := tx.Model(&model.Document{}).
				Where("id IN ?", activeDocumentIDs).
				Updates(map[string]any{
					"status":        "failed",
					"error_message": DocumentJobCancelledMessage,
					"error_code":    DocumentErrorCodeCancelled,
					"updated_at":    now,
				}).Error; err != nil {
				return err
			}
		}

		result := tx.Where("id IN ?", orderedIDs).Delete(&model.Document{})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != int64(len(orderedIDs)) {
			return gorm.ErrRecordNotFound
		}
		return nil
	})
}

func (r *DocumentRepository) CreateJob(ctx context.Context, job *model.DocumentJob) error {
	return r.db.WithContext(ctx).Create(job).Error
}

func (r *DocumentRepository) QueueReprocess(ctx context.Context, documentID, updatedByID uuid.UUID) (*model.DocumentJob, bool, error) {
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

		var activeJobs []model.DocumentJob
		if err := tx.
			Where("document_id = ? AND job_type = ? AND status IN ?", documentID, "process_document", []string{"pending", "running"}).
			Order("created_at desc").
			Find(&activeJobs).Error; err != nil {
			return err
		}
		if len(activeJobs) > 0 && !isTerminalDocumentStatus(document.Status) {
			job = activeJobs[0]
			return nil
		}
		for i := range activeJobs {
			if activeJobs[i].Status == "pending" {
				job = activeJobs[i]
				return nil
			}
		}

		now := time.Now()
		if err := tx.Model(&document).Updates(map[string]any{
			"status":           "uploaded",
			"error_message":    "",
			"pdf_text_summary": nil,
			"updated_at":       now,
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
		if err := touchKnowledgeBase(tx, document.KnowledgeBaseID, updatedByID, now); err != nil {
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

func (r *DocumentRepository) QueueBatchReprocess(ctx context.Context, documentIDs []uuid.UUID, updatedByID uuid.UUID) error {
	orderedIDs := append([]uuid.UUID(nil), documentIDs...)
	sort.Slice(orderedIDs, func(i, j int) bool {
		return orderedIDs[i].String() < orderedIDs[j].String()
	})

	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var documents []model.Document
		if err := tx.
			Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("id IN ?", orderedIDs).
			Order("id asc").
			Find(&documents).Error; err != nil {
			return err
		}
		if len(documents) != len(orderedIDs) {
			return gorm.ErrRecordNotFound
		}

		touchedKnowledgeBases := make(map[uuid.UUID]time.Time, len(documents))
		for i := range documents {
			var activeJobs []model.DocumentJob
			if err := tx.
				Where("document_id = ? AND job_type = ? AND status IN ?", documents[i].ID, "process_document", []string{"pending", "running"}).
				Order("created_at desc").
				Find(&activeJobs).Error; err != nil {
				return err
			}
			if len(activeJobs) > 0 && !isTerminalDocumentStatus(documents[i].Status) {
				continue
			}
			hasPendingSuccessor := false
			for j := range activeJobs {
				if activeJobs[j].Status == "pending" {
					hasPendingSuccessor = true
					break
				}
			}
			if hasPendingSuccessor {
				continue
			}

			now := time.Now()
			if err := tx.Model(&documents[i]).Updates(map[string]any{
				"status":           "uploaded",
				"error_message":    "",
				"pdf_text_summary": nil,
				"updated_at":       now,
			}).Error; err != nil {
				return err
			}
			job := model.DocumentJob{
				DocumentID: documents[i].ID,
				JobType:    "process_document",
				Status:     "pending",
			}
			if err := tx.Create(&job).Error; err != nil {
				return err
			}
			touchedKnowledgeBases[documents[i].KnowledgeBaseID] = now
		}
		for knowledgeBaseID, updatedAt := range touchedKnowledgeBases {
			if err := touchKnowledgeBase(tx, knowledgeBaseID, updatedByID, updatedAt); err != nil {
				return err
			}
		}
		return nil
	})
}

func (r *DocumentRepository) LatestJobsByDocumentIDs(ctx context.Context, documentIDs []uuid.UUID) (map[uuid.UUID]model.DocumentJob, error) {
	jobsByDocumentID := make(map[uuid.UUID]model.DocumentJob, len(documentIDs))
	if len(documentIDs) == 0 {
		return jobsByDocumentID, nil
	}

	var jobs []model.DocumentJob
	err := r.db.WithContext(ctx).
		Where("document_id IN ?", documentIDs).
		Order("document_id asc, created_at desc, id desc").
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
		result := tx.Model(&model.DocumentJob{}).
			Select("document_jobs.*").
			Joins("JOIN documents ON documents.id = document_jobs.document_id").
			Where("document_jobs.status = ? AND document_jobs.job_type = ?", "pending", "process_document").
			Where("document_jobs.locked_at IS NULL OR document_jobs.locked_at <= ?", time.Now()).
			Where(`NOT EXISTS (
				SELECT 1
				FROM document_jobs AS running_jobs
				WHERE running_jobs.document_id = document_jobs.document_id
					AND running_jobs.status = ?
					AND running_jobs.job_type = ?
			)`, "running", "process_document").
			Order("document_jobs.created_at asc").
			Clauses(clause.Locking{
				Strength: "UPDATE",
				Table:    clause.Table{Name: "documents"},
				Options:  "SKIP LOCKED",
			}).
			Limit(1).
			Find(&job)
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected == 0 {
			return gorm.ErrRecordNotFound
		}

		var lockedJob model.DocumentJob
		if err := tx.
			Clauses(clause.Locking{Strength: "UPDATE"}).
			Where(
				"id = ? AND document_id = ? AND status = ? AND job_type = ?",
				job.ID, job.DocumentID, "pending", "process_document",
			).
			Where("locked_at IS NULL OR locked_at <= ?", time.Now()).
			First(&lockedJob).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return errDocumentJobBlocked
			}
			return err
		}
		job = lockedJob
		var runningCount int64
		if err := tx.Model(&model.DocumentJob{}).
			Where("document_id = ? AND job_type = ? AND status = ?", job.DocumentID, "process_document", "running").
			Count(&runningCount).Error; err != nil {
			return err
		}
		if runningCount > 0 {
			return errDocumentJobBlocked
		}

		now := time.Now()
		return tx.Model(&job).Updates(map[string]any{
			"status":     "running",
			"locked_at":  &now,
			"updated_at": now,
		}).Error
	})
	if errors.Is(err, gorm.ErrRecordNotFound) || errors.Is(err, errDocumentJobBlocked) {
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
		Where("status = ? AND job_type = ?", "running", "process_document").
		Updates(map[string]any{
			"status":     "pending",
			"progress":   0,
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

// FindDeletedByID loads a soft-deleted document without an ownership predicate.
// Access is decided from its knowledge base by the service layer.
func (r *DocumentRepository) FindDeletedByID(ctx context.Context, id uuid.UUID) (*model.Document, error) {
	var document model.Document
	err := r.db.WithContext(ctx).
		Unscoped().
		Where("id = ?", id).
		Where("deleted_at IS NOT NULL").
		First(&document).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return &document, err
}

func (r *DocumentRepository) Restore(ctx context.Context, id uuid.UUID) error {
	result := r.db.WithContext(ctx).
		Unscoped().
		Model(&model.Document{}).
		Where("id = ? AND deleted_at IS NOT NULL", id).
		Update("deleted_at", nil)
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return ErrDocumentNotDeleted
	}
	return nil
}

func (r *DocumentRepository) BatchRestore(ctx context.Context, documentIDs []uuid.UUID) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		result := tx.
			Unscoped().
			Model(&model.Document{}).
			Where("id IN ? AND deleted_at IS NOT NULL", documentIDs).
			Update("deleted_at", nil)
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != int64(len(documentIDs)) {
			return ErrDocumentNotDeleted
		}
		return nil
	})
}

func (r *DocumentRepository) PermanentDelete(ctx context.Context, documentID uuid.UUID) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		document, err := lockDocumentForPermanentDelete(tx, documentID)
		if err != nil {
			return err
		}
		if err := enqueueStorageCleanup(tx, []string{document.StoragePath}); err != nil {
			return err
		}
		if err := tx.Where("document_id = ?", documentID).Delete(&model.DocumentChunk{}).Error; err != nil {
			return err
		}
		if err := tx.Where("document_id = ?", documentID).Delete(&model.DocumentJob{}).Error; err != nil {
			return err
		}
		return tx.Unscoped().Delete(&model.Document{ID: documentID}).Error
	})
}

// EmptyDeletedForActor purges every deleted document the actor may purge. It is
// deliberately narrower than ListDeletedForActor: an editor sees the bin and can
// restore from it, but emptying it is a purge.
func (r *DocumentRepository) EmptyDeletedForActor(ctx context.Context, actorID uuid.UUID, memberRoles []string) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var documents []struct {
			ID          uuid.UUID
			StoragePath string
		}
		if err := tx.Unscoped().
			Model(&model.Document{}).
			Joins("JOIN knowledge_bases ON knowledge_bases.id = documents.knowledge_base_id").
			Where(reachableKnowledgeBaseCondition(tx, actorID, memberRoles)).
			Where("knowledge_bases.deleted_at IS NULL").
			Where("documents.deleted_at IS NOT NULL").
			Order("documents.id asc").
			Clauses(clause.Locking{Strength: "UPDATE", Table: clause.Table{Name: "documents"}}).
			Select("documents.id, documents.storage_path").
			Find(&documents).Error; err != nil {
			return err
		}
		paths := make([]string, 0, len(documents))
		for _, document := range documents {
			paths = append(paths, document.StoragePath)
		}
		if err := enqueueStorageCleanup(tx, paths); err != nil {
			return err
		}
		for _, document := range documents {
			id := document.ID
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

func lockDocumentForPermanentDelete(tx *gorm.DB, documentID uuid.UUID) (*model.Document, error) {
	var document model.Document
	err := tx.
		Unscoped().
		Select("id, storage_path").
		Clauses(clause.Locking{Strength: "UPDATE"}).
		Where("id = ? AND deleted_at IS NOT NULL", documentID).
		First(&document).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, ErrDocumentNotDeleted
	}
	return &document, err
}

type RecycleDocumentItem struct {
	ID                uuid.UUID
	KnowledgeBaseID   uuid.UUID
	KnowledgeBaseName string
	Filename          string
	DeletedAt         time.Time
}

// ListDeletedForActor lists the recycle bin across every knowledge base where the
// actor holds the capability that can act on a deleted document. A viewer sees an
// empty bin rather than a list of items they could not restore.
func (r *DocumentRepository) ListDeletedForActor(ctx context.Context, actorID uuid.UUID, memberRoles []string, page, pageSize int) ([]RecycleDocumentItem, int64, error) {
	page, pageSize = normalizePage(page, pageSize)
	base := r.db.WithContext(ctx).
		Unscoped().
		Model(&model.Document{}).
		Joins("JOIN knowledge_bases ON knowledge_bases.id = documents.knowledge_base_id").
		Where(reachableKnowledgeBaseCondition(r.db, actorID, memberRoles)).
		Where("knowledge_bases.deleted_at IS NULL").
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
			documents.source_path AS source_path,
			documents.deleted_at AS deleted_at
		`).
		Order("documents.deleted_at desc").
		Limit(pageSize).
		Offset((page - 1) * pageSize).
		Scan(&items).Error
	return items, total, err
}

// UpdateStatus records an in-flight processing stage. It is scoped to the job
// that is doing the work: once that job stops being 'running' — cancelled, or
// already finalized — the write is refused with ErrDocumentJobCancelled so the
// processor aborts instead of overwriting the terminal state and burning more
// embedding calls.
func (r *DocumentRepository) UpdateStatus(ctx context.Context, documentID, jobID uuid.UUID, status string, progress int, errorMessage string) error {
	if progress < 0 || progress > 100 {
		return fmt.Errorf("document job progress must be between 0 and 100")
	}
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := guardRunningDocumentJob(tx, documentID, jobID); err != nil {
			return err
		}
		updates := map[string]any{"status": status, "error_message": errorMessage, "updated_at": time.Now()}
		if status == "parsing" {
			updates["pdf_text_summary"] = nil
		}
		result := tx.Model(&model.Document{}).Where("id = ?", documentID).Updates(updates)
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return gorm.ErrRecordNotFound
		}
		jobResult := tx.Model(&model.DocumentJob{}).
			Where("id = ? AND document_id = ? AND status = ? AND job_type = ?", jobID, documentID, "running", "process_document").
			Updates(map[string]any{
				"progress":   progress,
				"updated_at": time.Now(),
			})
		if jobResult.Error != nil {
			return jobResult.Error
		}
		if jobResult.RowsAffected != 1 {
			return ErrDocumentJobCancelled
		}
		return nil
	})
}

// SavePDFTextSummary preserves successful parsing even if embedding later fails.
// A cancelled or superseded processing job cannot publish its extraction result.
func (r *DocumentRepository) SavePDFTextSummary(ctx context.Context, documentID, jobID uuid.UUID, summary []byte, progress ...int) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := guardRunningDocumentJob(tx, documentID, jobID); err != nil {
			return err
		}
		if len(progress) > 0 {
			if err := tx.Model(&model.DocumentJob{}).Where("id = ?", jobID).
				Updates(map[string]any{"progress": max(10, min(progress[0], 29)), "updated_at": time.Now()}).Error; err != nil {
				return err
			}
		}
		return tx.Model(&model.Document{}).Where("id = ?", documentID).
			Updates(map[string]any{"pdf_text_summary": datatypes.JSON(summary), "updated_at": time.Now()}).Error
	})
}

// EnsureJobRunning is the inexpensive cancellation checkpoint used between
// embedding batches. The final publication has its own transactional guard;
// this method exists to stop spending provider calls as soon as a cancel has
// already committed.
func (r *DocumentRepository) EnsureJobRunning(ctx context.Context, documentID, jobID uuid.UUID) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		return guardRunningDocumentJob(tx, documentID, jobID)
	})
}

// guardRunningDocumentJob uses the document row as the aggregate lock shared
// with CancelActiveJob and chunk publication. A cancel that committed first is
// observed here; a caller that acquired the lock first completes its atomic
// operation before cancellation can take effect.
func guardRunningDocumentJob(tx *gorm.DB, documentID, jobID uuid.UUID) error {
	var document model.Document
	if err := tx.
		Select("id").
		Clauses(clause.Locking{Strength: "UPDATE"}).
		Where("id = ?", documentID).
		First(&document).Error; err != nil {
		return err
	}

	var running int64
	if err := tx.Model(&model.DocumentJob{}).
		Where(
			"id = ? AND document_id = ? AND status = ? AND job_type = ?",
			jobID, documentID, "running", "process_document",
		).
		Count(&running).Error; err != nil {
		return err
	}
	if running != 1 {
		return ErrDocumentJobCancelled
	}
	return nil
}

// UpdateMetadata renames a document and optionally moves it to another knowledge
// base. A move has to carry the chunks with it: the composite foreign key
// (document_id, knowledge_base_id) makes the two rows inseparable, so migration
// 011 marks that constraint DEFERRABLE and this transaction defers it until both
// statements have run. Updating either side alone would violate it.
func (r *DocumentRepository) UpdateMetadata(
	ctx context.Context,
	documentID uuid.UUID,
	filename string,
	targetKnowledgeBaseID *uuid.UUID,
	actorID uuid.UUID,
) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var document model.Document
		if err := tx.
			Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("id = ?", documentID).
			First(&document).Error; err != nil {
			return err
		}

		moving := targetKnowledgeBaseID != nil && *targetKnowledgeBaseID != document.KnowledgeBaseID
		if moving {
			// A claimed processor writes its chunks under the knowledge base it
			// read when it started. Moving underneath it would either break the
			// composite key or publish chunks into the old knowledge base, so
			// wait for the job to finish instead.
			var activeJobs int64
			if err := tx.Model(&model.DocumentJob{}).
				Where("document_id = ? AND job_type = ? AND status IN ?",
					documentID, "process_document", []string{"pending", "running"}).
				Count(&activeJobs).Error; err != nil {
				return err
			}
			if activeJobs > 0 {
				return ErrDocumentJobActive
			}
			if err := deferChunkKnowledgeBaseConstraint(tx); err != nil {
				return err
			}
		}

		now := time.Now()
		updates := map[string]any{"updated_at": now}
		if filename != "" {
			updates["filename"] = filename
		}
		if moving {
			updates["knowledge_base_id"] = *targetKnowledgeBaseID
		}
		result := tx.Model(&model.Document{}).Where("id = ?", documentID).Updates(updates)
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return gorm.ErrRecordNotFound
		}

		if !moving {
			return touchKnowledgeBase(tx, document.KnowledgeBaseID, actorID, now)
		}

		if err := tx.Model(&model.DocumentChunk{}).
			Where("document_id = ?", documentID).
			Update("knowledge_base_id", *targetKnowledgeBaseID).Error; err != nil {
			return err
		}
		// Both knowledge bases changed in the workspace, so both get touched.
		if err := touchKnowledgeBase(tx, document.KnowledgeBaseID, actorID, now); err != nil {
			return err
		}
		return touchKnowledgeBase(tx, *targetKnowledgeBaseID, actorID, now)
	})
}

// CancelActiveJob stops the document's queued or running job. It shares the
// worker's terminal-state guard rather than adding a second path: finalizeJob
// and RetryJob both require status='running', so once this flips the row to
// 'cancelled' a late-finishing worker can no longer write over the result.
func (r *DocumentRepository) CancelActiveJob(ctx context.Context, documentID, actorID uuid.UUID) (*model.DocumentJob, error) {
	var cancelled model.DocumentJob
	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var document model.Document
		if err := tx.
			Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("id = ?", documentID).
			First(&document).Error; err != nil {
			return err
		}

		var jobs []model.DocumentJob
		if err := tx.
			Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("document_id = ? AND job_type = ? AND status IN ?",
				documentID, "process_document", []string{"pending", "running"}).
			Order("created_at desc").
			Find(&jobs).Error; err != nil {
			return err
		}
		if len(jobs) == 0 {
			return ErrDocumentJobNotCancellable
		}

		now := time.Now()
		ids := make([]uuid.UUID, 0, len(jobs))
		for i := range jobs {
			ids = append(ids, jobs[i].ID)
		}
		if err := tx.Model(&model.DocumentJob{}).
			Where("id IN ?", ids).
			Updates(map[string]any{
				"status":        "cancelled",
				"error_message": DocumentJobCancelledMessage,
				"locked_at":     nil,
				"updated_at":    now,
			}).Error; err != nil {
			return err
		}

		// Already-embedded batches are not rolled back, and the processor only
		// swaps chunks in after every batch succeeded, so a cancel never leaves
		// half an index behind. The document lands on failed; jobStatus carries
		// the reason.
		if err := tx.Model(&model.Document{}).
			Where("id = ?", documentID).
			Updates(map[string]any{
				"status":        "failed",
				"error_message": DocumentJobCancelledMessage,
				"error_code":    DocumentErrorCodeCancelled,
				"updated_at":    now,
			}).Error; err != nil {
			return err
		}
		if err := touchKnowledgeBase(tx, document.KnowledgeBaseID, actorID, now); err != nil {
			return err
		}
		cancelled = jobs[0]
		cancelled.Status = "cancelled"
		return nil
	})
	if err != nil {
		return nil, err
	}
	return &cancelled, nil
}

// deferChunkKnowledgeBaseConstraint is a no-op outside PostgreSQL. SQLite, used
// by the service tests, never creates the composite constraint at all.
func deferChunkKnowledgeBaseConstraint(tx *gorm.DB) error {
	if tx.Dialector == nil || tx.Dialector.Name() != "postgres" {
		return nil
	}
	return tx.Exec("SET CONSTRAINTS fk_document_chunks_document_kb DEFERRED").Error
}

func (r *DocumentRepository) CompleteJob(ctx context.Context, jobID uuid.UUID) error {
	err := r.finalizeJob(ctx, jobID, "completed", "", "")
	if !errors.Is(err, errDocumentJobNotRunning) {
		return err
	}

	// Chunk publication now completes the document and job in the same
	// transaction. The worker still calls CompleteJob after Process returns, so
	// treat that already-completed state as an idempotent success while keeping
	// cancelled and failed jobs protected from late writes.
	var completed int64
	if queryErr := r.db.WithContext(ctx).Model(&model.DocumentJob{}).
		Where("id = ? AND job_type = ? AND status = ?", jobID, "process_document", "completed").
		Count(&completed).Error; queryErr != nil {
		return queryErr
	}
	if completed == 1 {
		return nil
	}
	return err
}

func (r *DocumentRepository) FailJob(ctx context.Context, jobID uuid.UUID, message string) error {
	return r.finalizeJob(ctx, jobID, "failed", message, "")
}

// FailJobWithCode is FailJob plus the closed-set classification of why. Separate
// from FailJob so the existing callers and their tests keep working; the code only
// lands on the document, not the job, because the job already carries the raw
// message and a job is an attempt while the code describes the document.
func (r *DocumentRepository) FailJobWithCode(ctx context.Context, jobID uuid.UUID, message, errorCode string) error {
	return r.finalizeJob(ctx, jobID, "failed", message, errorCode)
}

func (r *DocumentRepository) finalizeJob(
	ctx context.Context,
	jobID uuid.UUID,
	status string,
	errorMessage string,
	errorCode string,
) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var job model.DocumentJob
		if err := tx.
			Select("id", "document_id").
			Where("id = ? AND status = ? AND job_type = ?", jobID, "running", "process_document").
			First(&job).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return errDocumentJobNotRunning
			}
			return err
		}

		now := time.Now()
		var document model.Document
		if err := tx.Unscoped().
			Select("id").
			Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("id = ?", job.DocumentID).
			First(&document).Error; err != nil {
			return err
		}

		var lockedJob model.DocumentJob
		if err := tx.
			Select("id", "document_id").
			Clauses(clause.Locking{Strength: "UPDATE"}).
			Where(
				"id = ? AND document_id = ? AND status = ? AND job_type = ?",
				jobID, job.DocumentID, "running", "process_document",
			).
			First(&lockedJob).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return errDocumentJobNotRunning
			}
			return err
		}
		documentResult := tx.Unscoped().Model(&model.Document{}).
			Where("id = ?", job.DocumentID).
			Updates(map[string]any{
				"status":        status,
				"error_message": errorMessage,
				// Always written, so a document that succeeds after a classified
				// failure stops showing the old reason. NULL rather than "" on
				// success: the CHECK constraint admits NULL or a failure code.
				"error_code": nullableErrorCode(errorCode),
				"updated_at": now,
			})
		if documentResult.Error != nil {
			return documentResult.Error
		}
		if documentResult.RowsAffected != 1 {
			return gorm.ErrRecordNotFound
		}

		jobUpdates := map[string]any{
			"status":        status,
			"error_message": errorMessage,
			"locked_at":     nil,
			"updated_at":    now,
		}
		if status == "completed" {
			jobUpdates["progress"] = 100
		}
		jobResult := tx.Model(&model.DocumentJob{}).
			Where("id = ? AND status = ? AND job_type = ?", jobID, "running", "process_document").
			Updates(jobUpdates)
		if jobResult.Error != nil {
			return jobResult.Error
		}
		if jobResult.RowsAffected != 1 {
			return errDocumentJobNotRunning
		}
		return nil
	})
}

// RetryJob reschedules a failed attempt. The status='running' guard is what
// keeps a cancel final: a worker whose processor died after the cancel landed
// updates nothing here, so the job stays cancelled instead of being requeued.
func (r *DocumentRepository) RetryJob(ctx context.Context, jobID uuid.UUID, retryCount int, retryAt time.Time, message string) error {
	return r.db.WithContext(ctx).Model(&model.DocumentJob{}).
		Where("id = ? AND status = ? AND job_type = ?", jobID, "running", "process_document").
		Updates(map[string]any{
			"status":        "pending",
			"retry_count":   retryCount,
			"progress":      0,
			"error_message": message,
			"locked_at":     retryAt,
			"updated_at":    time.Now(),
		}).Error
}

func nullableErrorCode(errorCode string) any {
	if errorCode == "" {
		return nil
	}
	return errorCode
}

func isTerminalDocumentStatus(status string) bool {
	return status == "completed" || status == "failed"
}

func touchKnowledgeBase(tx *gorm.DB, knowledgeBaseID, updatedByID uuid.UUID, updatedAt time.Time) error {
	result := tx.Model(&model.KnowledgeBase{}).
		Where("id = ?", knowledgeBaseID).
		Updates(map[string]any{
			"updated_by_id": updatedByID,
			"updated_at":    updatedAt,
		})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return gorm.ErrRecordNotFound
	}
	return nil
}
