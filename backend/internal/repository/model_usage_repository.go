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

// AttachMessage links usage rows written during generation to the assistant
// message that was persisted afterwards.
func (r *ModelUsageRepository) AttachMessage(ctx context.Context, recordIDs []uuid.UUID, messageID uuid.UUID) error {
	if len(recordIDs) == 0 || messageID == uuid.Nil {
		return nil
	}
	return r.db.WithContext(ctx).Model(&model.ModelUsageRecord{}).Where("id IN ?", recordIDs).Update("message_id", messageID).Error
}

// UsageScope is who is asking and what they may see. It mirrors
// ChatQualityFilter: usage is quality data, so the same reachability rule
// applies, with one addition for system administrators who see every
// knowledge base.
type UsageScope struct {
	ActorID uuid.UUID
	// MemberRoles comes from access.MemberRolesWith(access.CapQualityRead).
	MemberRoles []string
	// KnowledgeBaseID narrows to one knowledge base the service already
	// authorized.
	KnowledgeBaseID *uuid.UUID
	// AllKnowledgeBases skips the reachability predicate (system admins).
	AllKnowledgeBases bool
}

type UsageAggregate struct {
	GroupKey string `json:"groupKey"`
	// GroupLabel is the human-readable name behind GroupKey (knowledge base
	// name, user display name). Empty for day and model grouping.
	GroupLabel       string `json:"groupLabel"`
	PromptTokens     int64  `json:"promptTokens"`
	CompletionTokens int64  `json:"completionTokens"`
	TotalTokens      int64  `json:"totalTokens"`
	Calls            int64  `json:"calls"`
}

// ModelTotals is token usage per model over the same scope and range, used to
// price an aggregate regardless of how it was grouped.
type ModelTotals struct {
	Model            string
	PromptTokens     int64
	CompletionTokens int64
}

func (r *ModelUsageRepository) Aggregate(ctx context.Context, scope UsageScope, from, to time.Time, groupBy string) ([]UsageAggregate, error) {
	group, label := r.groupExpressions(groupBy)
	query := r.scoped(ctx, scope, from, to).
		Select(group + " AS group_key, " + label + " AS group_label, COALESCE(SUM(model_usage_records.prompt_tokens),0) AS prompt_tokens, COALESCE(SUM(model_usage_records.completion_tokens),0) AS completion_tokens, COALESCE(SUM(model_usage_records.total_tokens),0) AS total_tokens, COUNT(*) AS calls")
	var rows []UsageAggregate
	query = query.Group(group)
	// PostgreSQL rejects a bare string constant in GROUP BY. A constant label
	// already has the same value throughout every group and needs no grouping.
	if label != "''" {
		query = query.Group(label)
	}
	err := query.Order("group_key asc").Scan(&rows).Error
	return rows, err
}

// AggregateByModel returns per-model totals for cost estimation.
func (r *ModelUsageRepository) AggregateByModel(ctx context.Context, scope UsageScope, from, to time.Time) ([]ModelTotals, error) {
	var rows []ModelTotals
	err := r.scoped(ctx, scope, from, to).
		Select("model_usage_records.model AS model, COALESCE(SUM(model_usage_records.prompt_tokens),0) AS prompt_tokens, COALESCE(SUM(model_usage_records.completion_tokens),0) AS completion_tokens").
		Group("model_usage_records.model").
		Scan(&rows).Error
	return rows, err
}

func (r *ModelUsageRepository) scoped(ctx context.Context, scope UsageScope, from, to time.Time) *gorm.DB {
	db := r.db.WithContext(ctx)
	query := db.Model(&model.ModelUsageRecord{}).
		Joins("JOIN knowledge_bases ON knowledge_bases.id = model_usage_records.knowledge_base_id").
		// A deleted knowledge base keeps its usage rows for the audit trail but
		// must not appear in totals or in the knowledgeBase grouping: its name
		// would still be listed and its historical tokens still billed. The
		// quality views filter the same way.
		Where("knowledge_bases.deleted_at IS NULL").
		Where("model_usage_records.created_at >= ? AND model_usage_records.created_at < ?", from, to)
	if !scope.AllKnowledgeBases {
		query = query.Where(reachableKnowledgeBaseCondition(db, scope.ActorID, scope.MemberRoles))
	}
	if scope.KnowledgeBaseID != nil {
		query = query.Where("model_usage_records.knowledge_base_id = ?", *scope.KnowledgeBaseID)
	}
	return query
}

// groupExpressions returns the SQL for the group key and its label. Day keys
// are rendered as YYYY-MM-DD in UTC on every dialect so clients never see a
// driver-specific timestamp rendering.
func (r *ModelUsageRepository) groupExpressions(groupBy string) (string, string) {
	switch groupBy {
	case "day":
		if r.db.Dialector.Name() == "postgres" {
			return "to_char(model_usage_records.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')", "''"
		}
		return "strftime('%Y-%m-%d', model_usage_records.created_at)", "''"
	case "knowledgeBase":
		return "model_usage_records.knowledge_base_id", "COALESCE(knowledge_bases.name, '')"
	case "purpose":
		return "model_usage_records.purpose", "''"
	case "user":
		return "model_usage_records.user_id", "COALESCE((SELECT COALESCE(NULLIF(users.display_name, ''), users.username) FROM users WHERE users.id = model_usage_records.user_id), '')"
	default:
		return "model_usage_records.model", "''"
	}
}
