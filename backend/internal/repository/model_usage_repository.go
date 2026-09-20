package repository

import (
	"context"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"kbchat/backend/internal/model"
)

type ModelUsageRepository struct{ db *gorm.DB }

func NewModelUsageRepository(db *gorm.DB) *ModelUsageRepository { return &ModelUsageRepository{db: db} }

func (r *ModelUsageRepository) Create(ctx context.Context, record *model.ModelUsageRecord) error {
	return r.db.WithContext(ctx).Create(record).Error
}

type UsageAggregate struct {
	GroupKey         string `json:"groupKey"`
	PromptTokens     int64  `json:"promptTokens"`
	CompletionTokens int64  `json:"completionTokens"`
	TotalTokens      int64  `json:"totalTokens"`
	Calls            int64  `json:"calls"`
}

func (r *ModelUsageRepository) Aggregate(ctx context.Context, userID uuid.UUID, knowledgeBaseIDs []uuid.UUID, from, to time.Time, groupBy string) ([]UsageAggregate, error) {
	group := "model"
	switch groupBy {
	case "day":
		group = "DATE(created_at)"
	case "knowledgeBase":
		group = "knowledge_base_id"
	case "user":
		group = "user_id"
	}
	query := r.db.WithContext(ctx).Model(&model.ModelUsageRecord{}).Select(group+" AS group_key, COALESCE(SUM(prompt_tokens),0) AS prompt_tokens, COALESCE(SUM(completion_tokens),0) AS completion_tokens, COALESCE(SUM(total_tokens),0) AS total_tokens, COUNT(*) AS calls").Where("created_at >= ? AND created_at < ?", from, to)
	if len(knowledgeBaseIDs) > 0 {
		query = query.Where("knowledge_base_id IN ?", knowledgeBaseIDs)
	} else {
		query = query.Where("user_id = ?", userID)
	}
	var rows []UsageAggregate
	err := query.Group(group).Order("group_key asc").Scan(&rows).Error
	return rows, err
}
