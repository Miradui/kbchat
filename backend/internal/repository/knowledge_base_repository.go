package repository

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"kbchat/backend/internal/dto"
	"kbchat/backend/internal/model"
)

type KnowledgeBaseRepository struct {
	db *gorm.DB
}

// ErrKnowledgeBaseNotDeleted means restore/permanent-delete lost a race and the
// knowledge base is no longer present in the recycle bin.
var ErrKnowledgeBaseNotDeleted = errors.New("knowledge base is not in the recycle bin")

func NewKnowledgeBaseRepository(db *gorm.DB) *KnowledgeBaseRepository {
	return &KnowledgeBaseRepository{db: db}
}

func (r *KnowledgeBaseRepository) Create(ctx context.Context, kb *model.KnowledgeBase) error {
	return r.db.WithContext(ctx).Create(kb).Error
}

func (r *KnowledgeBaseRepository) ListByOwner(ctx context.Context, ownerID uuid.UUID) ([]model.KnowledgeBase, error) {
	var items []model.KnowledgeBase
	err := r.db.WithContext(ctx).
		Where("owner_id = ?", ownerID).
		Where("deleted_at IS NULL").
		Order("created_at desc").
		Find(&items).Error
	return items, err
}

type KnowledgeBaseListItem struct {
	ID                      uuid.UUID
	Name                    string
	Description             string
	OwnerID                 uuid.UUID
	OwnerUsername           string
	OwnerDisplayName        string
	OwnerAvatarURL          string
	UpdatedByID             *uuid.UUID
	UpdatedByUsername       *string
	UpdatedByDisplayName    *string
	UpdatedByAvatarURL      *string
	CategoryID              *uuid.UUID
	Visibility              string
	RetrievalConfig         []byte
	AnswerConfig            []byte
	CreatedAt               time.Time
	UpdatedAt               time.Time
	DocumentCount           int64
	CompletedDocumentCount  int64
	ProcessingDocumentCount int64
	FailedDocumentCount     int64
	ViewCount               int64
	QuestionCount           int64
	IsFavorite              bool
	LastViewedAt            *string
	// MemberRole is the actor's stored member row, empty when there is none. The
	// service turns it into the effective role; an owner has no member row and so
	// reads as empty here.
	MemberRole string
}

func (r *KnowledgeBaseRepository) ListWorkspace(ctx context.Context, ownerID uuid.UUID, query dto.KnowledgeBaseListQuery) ([]KnowledgeBaseListItem, int64, error) {
	page, pageSize := normalizePage(query.Page, query.PageSize)
	base := r.workspaceBaseQuery(ctx, ownerID, query)

	var total int64
	if err := base.Distinct("knowledge_bases.id").Count(&total).Error; err != nil {
		return nil, 0, err
	}

	var items []KnowledgeBaseListItem
	err := base.
		Select(`
			knowledge_bases.id AS id,
			knowledge_bases.name AS name,
			knowledge_bases.description AS description,
			knowledge_bases.owner_id AS owner_id,
			users.username AS owner_username,
			users.display_name AS owner_display_name,
			users.avatar_url AS owner_avatar_url,
			knowledge_bases.updated_by_id AS updated_by_id,
			updated_users.username AS updated_by_username,
			updated_users.display_name AS updated_by_display_name,
			updated_users.avatar_url AS updated_by_avatar_url,
			knowledge_bases.category_id AS category_id,
			knowledge_bases.visibility AS visibility,
			knowledge_bases.retrieval_config AS retrieval_config,
			knowledge_bases.answer_config AS answer_config,
			knowledge_bases.created_at AS created_at,
			knowledge_bases.updated_at AS updated_at,
			COUNT(DISTINCT documents.id) AS document_count,
			COUNT(DISTINCT CASE WHEN documents.status = 'completed' THEN documents.id END) AS completed_document_count,
			COUNT(DISTINCT CASE WHEN documents.status IN ('uploaded', 'parsing', 'chunking', 'embedding') THEN documents.id END) AS processing_document_count,
			COUNT(DISTINCT CASE WHEN documents.status = 'failed' THEN documents.id END) AS failed_document_count,
			COUNT(DISTINCT knowledge_base_view_events.id) AS view_count,
			COUNT(DISTINCT chat_messages.id) AS question_count,
			CASE WHEN knowledge_base_favorites.user_id IS NULL THEN false ELSE true END AS is_favorite,
			MAX(knowledge_base_view_events.viewed_at) AS last_viewed_at,
			actor_members.role AS member_role
		`).
		Joins("JOIN users ON users.id = knowledge_bases.owner_id").
		Joins("LEFT JOIN users AS updated_users ON updated_users.id = knowledge_bases.updated_by_id").
		Joins("LEFT JOIN documents ON documents.knowledge_base_id = knowledge_bases.id AND documents.deleted_at IS NULL").
		Joins("LEFT JOIN knowledge_base_view_events ON knowledge_base_view_events.knowledge_base_id = knowledge_bases.id AND knowledge_base_view_events.user_id = ?", ownerID).
		Joins("LEFT JOIN chat_sessions ON chat_sessions.knowledge_base_id = knowledge_bases.id AND chat_sessions.user_id = ? AND chat_sessions.deleted_at IS NULL", ownerID).
		Joins("LEFT JOIN chat_messages ON chat_messages.session_id = chat_sessions.id AND chat_messages.role = ?", "user").
		Joins("LEFT JOIN knowledge_base_favorites ON knowledge_base_favorites.knowledge_base_id = knowledge_bases.id AND knowledge_base_favorites.user_id = ?", ownerID).
		Group("knowledge_bases.id, users.id, updated_users.id, knowledge_base_favorites.user_id, actor_members.role").
		Order(workspaceOrder(query.Sort, query.Scope)).
		Limit(pageSize).
		Offset((page - 1) * pageSize).
		Scan(&items).Error
	return items, total, err
}

// workspaceBaseQuery scopes the workspace list to what the actor may reach.
//
// The membership join is a LEFT JOIN on the member table's own primary key, so it
// can add at most one row per knowledge base and cannot inflate the aggregate
// counts this query computes. It is joined unconditionally rather than only for
// the scopes that filter on it, because the select list exposes the actor's role
// and `managed` needs to read it.
func (r *KnowledgeBaseRepository) workspaceBaseQuery(ctx context.Context, actorID uuid.UUID, query dto.KnowledgeBaseListQuery) *gorm.DB {
	db := r.db.WithContext(ctx).Model(&model.KnowledgeBase{}).
		Joins("LEFT JOIN knowledge_base_members AS actor_members ON actor_members.knowledge_base_id = knowledge_bases.id AND actor_members.user_id = ?", actorID).
		Where("knowledge_bases.deleted_at IS NULL")

	switch query.Scope {
	case "created":
		// "created" means authored by me, so membership is irrelevant here.
		db = db.Where("knowledge_bases.owner_id = ?", actorID)
	case "managed":
		// Owners are included: an owner administers their own knowledge base by
		// definition, and a "managed" list that excluded the person who created it
		// would read as a bug rather than as a filter.
		db = db.Where("knowledge_bases.owner_id = ? OR actor_members.role = ?", actorID, "manager")
	default:
		db = db.Where("knowledge_bases.owner_id = ? OR actor_members.user_id IS NOT NULL", actorID)
	}
	if query.Q != "" {
		like := "%" + strings.ToLower(query.Q) + "%"
		db = db.Where("LOWER(knowledge_bases.name) LIKE ? OR LOWER(knowledge_bases.description) LIKE ?", like, like)
	}
	if query.CategoryID != nil {
		db = db.Where("knowledge_bases.category_id = ?", *query.CategoryID)
	}
	if len(query.TagIDs) > 0 {
		db = db.Joins("JOIN knowledge_base_tag_bindings AS filter_tag_bindings ON filter_tag_bindings.knowledge_base_id = knowledge_bases.id").
			Where("filter_tag_bindings.tag_id IN ?", query.TagIDs)
	}
	if query.Visibility == "public" || query.Visibility == "private" {
		db = db.Where("knowledge_bases.visibility = ?", query.Visibility)
	}
	switch query.Scope {
	case "favorite":
		db = db.Joins("JOIN knowledge_base_favorites AS scope_favorites ON scope_favorites.knowledge_base_id = knowledge_bases.id AND scope_favorites.user_id = ?", actorID)
	case "recent":
		db = db.Joins("JOIN knowledge_base_view_events AS scope_views ON scope_views.knowledge_base_id = knowledge_bases.id AND scope_views.user_id = ?", actorID)
	}
	return db
}

func (r *KnowledgeBaseRepository) ListTags(ctx context.Context, kbID uuid.UUID) ([]model.KnowledgeBaseTag, error) {
	var items []model.KnowledgeBaseTag
	err := r.db.WithContext(ctx).
		Model(&model.KnowledgeBaseTag{}).
		Joins("JOIN knowledge_base_tag_bindings ON knowledge_base_tag_bindings.tag_id = knowledge_base_tags.id").
		Where("knowledge_base_tag_bindings.knowledge_base_id = ?", kbID).
		Order("knowledge_base_tags.name asc").
		Find(&items).Error
	return items, err
}

type KnowledgeBaseStats struct {
	KnowledgeBaseCount int64
	DocumentCount      int64
	ViewCount          int64
	QuestionCount      int64
}

func (r *KnowledgeBaseRepository) Stats(ctx context.Context, ownerID uuid.UUID, start, previousStart time.Time) (KnowledgeBaseStats, KnowledgeBaseStats, error) {
	current, err := r.statsForRange(ctx, ownerID, nil, start, time.Time{})
	if err != nil {
		return KnowledgeBaseStats{}, KnowledgeBaseStats{}, err
	}
	previous, err := r.statsForRange(ctx, ownerID, nil, previousStart, start)
	if err != nil {
		return KnowledgeBaseStats{}, KnowledgeBaseStats{}, err
	}
	return current, previous, nil
}

// StatsForKnowledgeBase narrows the same owner-scoped counting rules to a single
// knowledge base. KnowledgeBaseCount is left at zero because it carries no
// meaning for one row; callers expose documents, views and questions only.
func (r *KnowledgeBaseRepository) StatsForKnowledgeBase(ctx context.Context, ownerID, kbID uuid.UUID, start, previousStart time.Time) (KnowledgeBaseStats, KnowledgeBaseStats, error) {
	current, err := r.statsForRange(ctx, ownerID, &kbID, start, time.Time{})
	if err != nil {
		return KnowledgeBaseStats{}, KnowledgeBaseStats{}, err
	}
	previous, err := r.statsForRange(ctx, ownerID, &kbID, previousStart, start)
	if err != nil {
		return KnowledgeBaseStats{}, KnowledgeBaseStats{}, err
	}
	return current, previous, nil
}

func (r *KnowledgeBaseRepository) statsForRange(ctx context.Context, ownerID uuid.UUID, kbID *uuid.UUID, start, end time.Time) (KnowledgeBaseStats, error) {
	var stats KnowledgeBaseStats
	kbQuery := r.db.WithContext(ctx).Model(&model.KnowledgeBase{}).Where("owner_id = ?", ownerID).Where("deleted_at IS NULL")
	docQuery := r.db.WithContext(ctx).Model(&model.Document{}).
		Joins("JOIN knowledge_bases ON knowledge_bases.id = documents.knowledge_base_id").
		Where("knowledge_bases.owner_id = ?", ownerID).
		Where("knowledge_bases.deleted_at IS NULL").
		Where("documents.deleted_at IS NULL")
	viewQuery := r.db.WithContext(ctx).Model(&model.KnowledgeBaseViewEvent{}).
		Joins("JOIN knowledge_bases ON knowledge_bases.id = knowledge_base_view_events.knowledge_base_id").
		Where("knowledge_bases.owner_id = ? AND knowledge_base_view_events.user_id = ?", ownerID, ownerID).
		Where("knowledge_bases.deleted_at IS NULL")
	questionQuery := r.db.WithContext(ctx).Model(&model.ChatMessage{}).
		Joins("JOIN chat_sessions ON chat_sessions.id = chat_messages.session_id").
		Joins("JOIN knowledge_bases ON knowledge_bases.id = chat_sessions.knowledge_base_id").
		Where("knowledge_bases.owner_id = ? AND chat_sessions.user_id = ? AND chat_messages.role = ?", ownerID, ownerID, "user").
		Where("chat_sessions.deleted_at IS NULL").
		Where("knowledge_bases.deleted_at IS NULL")

	if !start.IsZero() {
		kbQuery = kbQuery.Where("knowledge_bases.created_at >= ?", start)
		docQuery = docQuery.Where("documents.created_at >= ?", start)
		viewQuery = viewQuery.Where("knowledge_base_view_events.viewed_at >= ?", start)
		questionQuery = questionQuery.Where("chat_messages.created_at >= ?", start)
	}
	if !end.IsZero() {
		kbQuery = kbQuery.Where("knowledge_bases.created_at < ?", end)
		docQuery = docQuery.Where("documents.created_at < ?", end)
		viewQuery = viewQuery.Where("knowledge_base_view_events.viewed_at < ?", end)
		questionQuery = questionQuery.Where("chat_messages.created_at < ?", end)
	}

	if kbID != nil {
		docQuery = docQuery.Where("knowledge_bases.id = ?", *kbID)
		viewQuery = viewQuery.Where("knowledge_bases.id = ?", *kbID)
		questionQuery = questionQuery.Where("knowledge_bases.id = ?", *kbID)
	} else if err := kbQuery.Count(&stats.KnowledgeBaseCount).Error; err != nil {
		return stats, err
	}
	if err := docQuery.Count(&stats.DocumentCount).Error; err != nil {
		return stats, err
	}
	if err := viewQuery.Count(&stats.ViewCount).Error; err != nil {
		return stats, err
	}
	if err := questionQuery.Count(&stats.QuestionCount).Error; err != nil {
		return stats, err
	}
	return stats, nil
}

func (r *KnowledgeBaseRepository) CountByCategory(ctx context.Context, ownerID, categoryID uuid.UUID) (int64, error) {
	var count int64
	err := r.db.WithContext(ctx).
		Model(&model.KnowledgeBase{}).
		Where("owner_id = ? AND category_id = ?", ownerID, categoryID).
		Where("deleted_at IS NULL").
		Count(&count).Error
	return count, err
}

// CountByCategoryGrouped returns the direct knowledge base count per category for
// one owner. Uncategorized knowledge bases have a NULL category_id and are left
// out; the category tree has no node to hang them on.
func (r *KnowledgeBaseRepository) CountByCategoryGrouped(ctx context.Context, ownerID uuid.UUID) (map[uuid.UUID]int64, error) {
	type row struct {
		CategoryID uuid.UUID
		Total      int64
	}

	var rows []row
	err := r.db.WithContext(ctx).
		Model(&model.KnowledgeBase{}).
		Select("knowledge_bases.category_id AS category_id, COUNT(*) AS total").
		Where("knowledge_bases.owner_id = ?", ownerID).
		Where("knowledge_bases.deleted_at IS NULL").
		Where("knowledge_bases.category_id IS NOT NULL").
		Group("knowledge_bases.category_id").
		Scan(&rows).Error
	if err != nil {
		return nil, err
	}

	counts := make(map[uuid.UUID]int64, len(rows))
	for _, item := range rows {
		counts[item.CategoryID] = item.Total
	}
	return counts, nil
}

func (r *KnowledgeBaseRepository) FindByIDAndOwner(ctx context.Context, id, ownerID uuid.UUID) (*model.KnowledgeBase, error) {
	var kb model.KnowledgeBase
	err := r.db.WithContext(ctx).
		Preload("Owner").
		Preload("UpdatedBy").
		Where("id = ? AND owner_id = ?", id, ownerID).
		First(&kb).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return &kb, err
}

func (r *KnowledgeBaseRepository) FindByID(ctx context.Context, id uuid.UUID) (*model.KnowledgeBase, error) {
	var kb model.KnowledgeBase
	err := r.db.WithContext(ctx).
		Preload("Owner").
		Preload("UpdatedBy").
		Where("id = ?", id).
		Where("deleted_at IS NULL").
		First(&kb).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return &kb, err
}

// FindMemberRole returns the stored role of a user's member row, or "" when there
// is no row.
//
// It lives on this repository rather than on KnowledgeBaseMemberRepository so that
// every service holding a knowledge base repository can resolve access without
// taking a second dependency. Membership is now consulted on nearly every
// knowledge-base request, and threading one more constructor argument through
// three services and twenty test construction sites would buy nothing.
//
// Returns the bare string. Interpreting it -- including deciding that an
// unrecognised value means no access -- belongs to the access package.
func (r *KnowledgeBaseRepository) FindMemberRole(ctx context.Context, kbID, userID uuid.UUID) (string, error) {
	var role string
	err := r.db.WithContext(ctx).
		Model(&model.KnowledgeBaseMember{}).
		Where("knowledge_base_id = ? AND user_id = ?", kbID, userID).
		Limit(1).
		Pluck("role", &role).Error
	if err != nil {
		return "", err
	}
	return role, nil
}

func (r *KnowledgeBaseRepository) FindDeletedByIDAndOwner(ctx context.Context, id, ownerID uuid.UUID) (*model.KnowledgeBase, error) {
	var kb model.KnowledgeBase
	err := r.db.WithContext(ctx).
		Unscoped().
		Where("id = ? AND owner_id = ? AND deleted_at IS NOT NULL", id, ownerID).
		First(&kb).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return &kb, err
}

// Update writes the knowledge base's own columns. Associations are omitted:
// callers load Owner and UpdatedBy for display, and saving them would copy the
// preloaded UpdatedBy.ID back over updated_by_id and upsert the user rows.
func (r *KnowledgeBaseRepository) Update(ctx context.Context, kb *model.KnowledgeBase) error {
	return r.db.WithContext(ctx).Omit(clause.Associations).Save(kb).Error
}

func (r *KnowledgeBaseRepository) TouchUpdatedBy(ctx context.Context, kbID, userID uuid.UUID) error {
	return r.db.WithContext(ctx).
		Model(&model.KnowledgeBase{}).
		Where("id = ?", kbID).
		Updates(map[string]any{
			"updated_by_id": userID,
			"updated_at":    time.Now(),
		}).Error
}

func (r *KnowledgeBaseRepository) Delete(ctx context.Context, kb *model.KnowledgeBase) error {
	return r.db.WithContext(ctx).Delete(kb).Error
}

func (r *KnowledgeBaseRepository) Restore(ctx context.Context, id uuid.UUID) error {
	result := r.db.WithContext(ctx).
		Unscoped().
		Model(&model.KnowledgeBase{}).
		Where("id = ? AND deleted_at IS NOT NULL", id).
		Update("deleted_at", nil)
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return ErrKnowledgeBaseNotDeleted
	}
	return nil
}

func (r *KnowledgeBaseRepository) BatchRestore(ctx context.Context, ids []uuid.UUID) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		result := tx.
			Unscoped().
			Model(&model.KnowledgeBase{}).
			Where("id IN ? AND deleted_at IS NOT NULL", ids).
			Update("deleted_at", nil)
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != int64(len(ids)) {
			return ErrKnowledgeBaseNotDeleted
		}
		return nil
	})
}

func (r *KnowledgeBaseRepository) PermanentDelete(ctx context.Context, kbID uuid.UUID) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := lockDeletedKnowledgeBase(tx, kbID); err != nil {
			return err
		}
		return permanentDeleteKnowledgeBase(tx, kbID)
	})
}

func (r *KnowledgeBaseRepository) EmptyDeletedByOwner(ctx context.Context, ownerID uuid.UUID) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var ids []uuid.UUID
		if err := tx.Unscoped().
			Model(&model.KnowledgeBase{}).
			Where("owner_id = ?", ownerID).
			Where("deleted_at IS NOT NULL").
			Order("id asc").
			Clauses(clause.Locking{Strength: "UPDATE"}).
			Pluck("id", &ids).Error; err != nil {
			return err
		}
		for _, id := range ids {
			if err := permanentDeleteKnowledgeBase(tx, id); err != nil {
				return err
			}
		}
		return nil
	})
}

func lockDeletedKnowledgeBase(tx *gorm.DB, kbID uuid.UUID) error {
	var kb model.KnowledgeBase
	err := tx.
		Unscoped().
		Select("id").
		Clauses(clause.Locking{Strength: "UPDATE"}).
		Where("id = ? AND deleted_at IS NOT NULL", kbID).
		First(&kb).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return ErrKnowledgeBaseNotDeleted
	}
	return err
}

func permanentDeleteKnowledgeBase(tx *gorm.DB, kbID uuid.UUID) error {
	var documents []struct {
		ID          uuid.UUID
		StoragePath string
	}
	if err := tx.Unscoped().
		Model(&model.Document{}).
		Where("knowledge_base_id = ?", kbID).
		Order("documents.id asc").
		Clauses(clause.Locking{Strength: "UPDATE"}).
		Select("documents.id, documents.storage_path").
		Find(&documents).Error; err != nil {
		return err
	}
	paths := make([]string, 0, len(documents))
	documentIDs := make([]uuid.UUID, 0, len(documents))
	for _, document := range documents {
		paths = append(paths, document.StoragePath)
		documentIDs = append(documentIDs, document.ID)
	}
	if err := enqueueStorageCleanup(tx, paths); err != nil {
		return err
	}
	for _, documentID := range documentIDs {
		if err := tx.Where("document_id = ?", documentID).Delete(&model.DocumentChunk{}).Error; err != nil {
			return err
		}
		if err := tx.Where("document_id = ?", documentID).Delete(&model.DocumentJob{}).Error; err != nil {
			return err
		}
	}
	if len(documentIDs) > 0 {
		if err := tx.Unscoped().Where("id IN ?", documentIDs).Delete(&model.Document{}).Error; err != nil {
			return err
		}
	}
	var sessionIDs []uuid.UUID
	if err := chatContainsBase(tx.Unscoped().Model(&model.ChatSession{}), kbID).
		Pluck("id", &sessionIDs).Error; err != nil {
		return err
	}
	if err := permanentDeleteChatSessions(tx, sessionIDs); err != nil {
		return err
	}

	if err := tx.Where("knowledge_base_id = ?", kbID).Delete(&model.KnowledgeBaseMember{}).Error; err != nil {
		return err
	}
	if err := tx.Where("knowledge_base_id = ?", kbID).Delete(&model.KnowledgeBaseFavorite{}).Error; err != nil {
		return err
	}
	if err := tx.Where("knowledge_base_id = ?", kbID).Delete(&model.KnowledgeBaseViewEvent{}).Error; err != nil {
		return err
	}
	if err := tx.Where("knowledge_base_id = ?", kbID).Delete(&model.KnowledgeBaseTagBinding{}).Error; err != nil {
		return err
	}
	return tx.Unscoped().Delete(&model.KnowledgeBase{ID: kbID}).Error
}

type RecycleKnowledgeBaseItem struct {
	ID        uuid.UUID
	Name      string
	DeletedAt time.Time
}

func (r *KnowledgeBaseRepository) ListDeleted(ctx context.Context, ownerID uuid.UUID, page, pageSize int) ([]RecycleKnowledgeBaseItem, int64, error) {
	page, pageSize = normalizePage(page, pageSize)
	base := r.db.WithContext(ctx).
		Unscoped().
		Model(&model.KnowledgeBase{}).
		Where("owner_id = ?", ownerID).
		Where("deleted_at IS NOT NULL")

	var total int64
	if err := base.Count(&total).Error; err != nil {
		return nil, 0, err
	}

	var items []RecycleKnowledgeBaseItem
	err := base.Select("id, name, deleted_at").
		Order("deleted_at desc").
		Limit(pageSize).
		Offset((page - 1) * pageSize).
		Scan(&items).Error
	return items, total, err
}

func normalizePage(page, pageSize int) (int, int) {
	if page <= 0 {
		page = 1
	}
	if pageSize <= 0 {
		pageSize = 20
	}
	if pageSize > 100 {
		pageSize = 100
	}
	return page, pageSize
}

func workspaceOrder(sort string, scope string) string {
	if scope == "recent" {
		return "last_viewed_at desc"
	}
	switch sort {
	case "createdAt_desc":
		return "knowledge_bases.created_at desc"
	case "name_asc":
		return "knowledge_bases.name asc"
	default:
		return "knowledge_bases.updated_at desc"
	}
}
