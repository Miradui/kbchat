package repository

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"gorm.io/datatypes"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"kbchat/backend/internal/model"
)

var ErrEvaluationLimit = errors.New("evaluation limit reached")
var ErrEvaluationMissing = errors.New("evaluation resource not found")

type EvaluationRepository struct{ db *gorm.DB }

func NewEvaluationRepository(db *gorm.DB) *EvaluationRepository { return &EvaluationRepository{db: db} }

func (r *EvaluationRepository) ListCases(ctx context.Context, kbID uuid.UUID, actors ...uuid.UUID) ([]model.EvaluationCase, error) {
	items := []model.EvaluationCase{}
	query := r.db.WithContext(ctx).Where("knowledge_base_id = ?", kbID)
	if len(actors) > 0 {
		query = query.Where("CAST(scope AS TEXT) IN ('{}','null') OR scope IS NULL OR created_by = ?", actors[0])
	}
	err := query.Order("created_at DESC, id DESC").Limit(200).Find(&items).Error
	return items, err
}
func (r *EvaluationRepository) GetCase(ctx context.Context, kbID, id uuid.UUID) (*model.EvaluationCase, error) {
	var item model.EvaluationCase
	err := r.db.WithContext(ctx).Where("id = ? AND knowledge_base_id = ?", id, kbID).First(&item).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, ErrEvaluationMissing
	}
	return &item, err
}

func lockEvaluationBase(tx *gorm.DB, kbID uuid.UUID) error {
	return tx.Select("id").Clauses(clause.Locking{Strength: "UPDATE"}).First(&model.KnowledgeBase{}, "id = ?", kbID).Error
}

func (r *EvaluationRepository) CreateCase(ctx context.Context, item *model.EvaluationCase) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := lockEvaluationBase(tx, item.KnowledgeBaseID); err != nil {
			return err
		}
		var count int64
		if err := tx.Model(&model.EvaluationCase{}).Where("knowledge_base_id = ?", item.KnowledgeBaseID).Count(&count).Error; err != nil {
			return err
		}
		if count >= 200 {
			return ErrEvaluationLimit
		}
		return tx.Create(item).Error
	})
}

func (r *EvaluationRepository) UpdateCase(ctx context.Context, item *model.EvaluationCase) error {
	res := r.db.WithContext(ctx).Model(&model.EvaluationCase{}).Where("id = ? AND knowledge_base_id = ?", item.ID, item.KnowledgeBaseID).
		Updates(map[string]any{"scope": item.Scope, "question": item.Question, "expected_answer": item.ExpectedAnswer, "required_keywords": item.RequiredKeywords, "require_citation": item.RequireCitation})
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected != 1 {
		return ErrEvaluationMissing
	}
	return r.db.WithContext(ctx).First(item, "id = ? AND knowledge_base_id = ?", item.ID, item.KnowledgeBaseID).Error
}

func (r *EvaluationRepository) DeleteCase(ctx context.Context, kbID, id uuid.UUID) error {
	res := r.db.WithContext(ctx).Where("id = ? AND knowledge_base_id = ?", id, kbID).Delete(&model.EvaluationCase{})
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected != 1 {
		return ErrEvaluationMissing
	}
	return nil
}

func (r *EvaluationRepository) FindRunRequest(ctx context.Context, kbID, actor, request uuid.UUID) (*model.EvaluationRun, error) {
	var run model.EvaluationRun
	err := r.db.WithContext(ctx).Where("knowledge_base_id = ? AND created_by = ? AND client_request_id = ?", kbID, actor, request).First(&run).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return &run, err
}

func (r *EvaluationRepository) CreateRun(ctx context.Context, run *model.EvaluationRun) (*model.EvaluationRun, error) {
	var stored model.EvaluationRun
	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := lockEvaluationBase(tx, run.KnowledgeBaseID); err != nil {
			return err
		}
		err := tx.Where("knowledge_base_id = ? AND created_by = ? AND client_request_id = ?", run.KnowledgeBaseID, run.CreatedBy, run.ClientRequestID).First(&stored).Error
		if err == nil {
			return nil
		}
		if !errors.Is(err, gorm.ErrRecordNotFound) {
			return err
		}
		var count int64
		if err := tx.Model(&model.EvaluationRun{}).Where("knowledge_base_id = ? AND status IN ?", run.KnowledgeBaseID, []string{"queued", "running"}).Count(&count).Error; err != nil {
			return err
		}
		if count >= 3 {
			return ErrEvaluationLimit
		}
		if err := tx.Create(run).Error; err != nil {
			return err
		}
		stored = *run
		return nil
	})
	return &stored, err
}

func (r *EvaluationRepository) ListRuns(ctx context.Context, kbID uuid.UUID, actors ...uuid.UUID) ([]model.EvaluationRun, error) {
	items := []model.EvaluationRun{}
	query := r.db.WithContext(ctx).Where("knowledge_base_id = ?", kbID)
	if len(actors) > 0 {
		query = query.Where("is_private = ? OR created_by = ?", false, actors[0])
	}
	err := query.Order("created_at DESC, id DESC").Limit(50).Find(&items).Error
	return items, err
}

func (r *EvaluationRepository) GetRun(ctx context.Context, kbID, id uuid.UUID) (*model.EvaluationRun, error) {
	var run model.EvaluationRun
	err := r.db.WithContext(ctx).Where("id = ? AND knowledge_base_id = ?", id, kbID).First(&run).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, ErrEvaluationMissing
	}
	return &run, err
}

func (r *EvaluationRepository) CancelRun(ctx context.Context, kbID, id uuid.UUID) error {
	return r.db.WithContext(ctx).Model(&model.EvaluationRun{}).Where("id = ? AND knowledge_base_id = ? AND status IN ?", id, kbID, []string{"queued", "running"}).
		Updates(map[string]any{"status": "cancelled", "finished_at": time.Now().UTC(), "lease_token": nil}).Error
}

// Abandoned work is never replayed automatically: the external model may have
// completed a request before the process disappeared.
func (r *EvaluationRepository) ClaimNext(ctx context.Context) (*model.EvaluationRun, error) {
	now := time.Now().UTC()
	if err := r.db.WithContext(ctx).Model(&model.EvaluationRun{}).Where("status = ? AND updated_at < ?", "running", now.Add(-2*time.Minute)).
		Updates(map[string]any{"status": "failed", "error_message": "评测运行已中断，请重新发起评测。", "finished_at": now, "lease_token": nil}).Error; err != nil {
		return nil, err
	}
	var run model.EvaluationRun
	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE", Options: "SKIP LOCKED"}).
			Where("status = ? AND knowledge_base_id IN (?)", "queued", tx.Model(&model.KnowledgeBase{}).Select("id")).
			Order("created_at ASC, id ASC").Limit(1).Find(&run).Error; err != nil {
			return err
		}
		if run.ID == uuid.Nil {
			return gorm.ErrRecordNotFound
		}
		lease := uuid.New()
		res := tx.Model(&run).Where("status = ?", "queued").Updates(map[string]any{"status": "running", "started_at": now, "lease_token": lease, "updated_at": now})
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected != 1 {
			return gorm.ErrRecordNotFound
		}
		run.LeaseToken = &lease
		return nil
	})
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return &run, err
}

func (r *EvaluationRepository) Heartbeat(ctx context.Context, run *model.EvaluationRun) (bool, error) {
	res := r.db.WithContext(ctx).Model(&model.EvaluationRun{}).
		Where("id = ? AND lease_token = ? AND status = ?", run.ID, run.LeaseToken, "running").
		Where("knowledge_base_id IN (?)", r.db.Model(&model.KnowledgeBase{}).Select("id")).Update("updated_at", time.Now().UTC())
	return res.RowsAffected == 1, res.Error
}

func (r *EvaluationRepository) Checkpoint(ctx context.Context, run *model.EvaluationRun, results, runtime datatypes.JSON, status, message string) (bool, error) {
	values := map[string]any{"results": results, "runtime": runtime, "status": status, "error_message": message}
	if status != "running" {
		values["finished_at"] = time.Now().UTC()
		values["lease_token"] = nil
	}
	res := r.db.WithContext(ctx).Model(&model.EvaluationRun{}).Where("id = ? AND lease_token = ? AND status = ?", run.ID, run.LeaseToken, "running").Updates(values)
	return res.RowsAffected == 1, res.Error
}
