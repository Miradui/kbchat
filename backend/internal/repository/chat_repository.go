package repository

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"gorm.io/datatypes"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"kbchat/backend/internal/dto"
	"kbchat/backend/internal/model"
)

type ChatRepository struct {
	db *gorm.DB
}

// ErrChatSessionNotDeleted means a restore or permanent delete lost a race and
// the session is no longer present in the recycle bin.
var ErrChatSessionNotDeleted = errors.New("chat session is not in the recycle bin")

// ErrChatMessageNotFound means an owner-scoped message disappeared between the
// read and the field-level feedback update.
var ErrChatMessageNotFound = errors.New("chat message not found")

// ErrChatMessageChanged means another write changed the target or its tail
// after the service loaded the conversation.
var ErrChatMessageChanged = errors.New("chat message changed concurrently")

func NewChatRepository(db *gorm.DB) *ChatRepository {
	return &ChatRepository{db: db}
}

func (r *ChatRepository) CreateSession(ctx context.Context, session *model.ChatSession) error {
	return r.db.WithContext(ctx).Create(session).Error
}

type ChatSessionListItem struct {
	ID                 uuid.UUID
	KnowledgeBaseID    uuid.UUID
	KnowledgeBaseName  string
	Title              string
	CreatedAt          time.Time
	UpdatedAt          time.Time
	ArchivedAt         *time.Time
	MessageCount       int64
	LastMessagePreview string
}

// ListSessions returns one page of the caller's sessions. Ownership is enforced
// twice on purpose: the session must belong to the user and the knowledge base
// behind it must still be owned by the same user and not deleted.
// ListSessions lists the caller's own sessions in knowledge bases they can still
// reach. memberRoles are the roles holding the chat capability, from the matrix.
//
// A session is not shown once its knowledge base is out of reach, even though the
// session row is the caller's: the transcript quotes content they no longer have
// access to.
func (r *ChatRepository) ListSessions(ctx context.Context, userID uuid.UUID, memberRoles []string, query dto.ChatSessionListQuery, offset, limit int) ([]ChatSessionListItem, int64, error) {
	base := func() *gorm.DB {
		db := r.db.WithContext(ctx).
			Model(&model.ChatSession{}).
			Joins("JOIN knowledge_bases ON knowledge_bases.id = chat_sessions.knowledge_base_id").
			Where("chat_sessions.user_id = ?", userID).
			Where(reachableKnowledgeBaseCondition(r.db, userID, memberRoles)).
			Where("knowledge_bases.deleted_at IS NULL").
			Where("chat_sessions.deleted_at IS NULL")
		if query.Archived {
			db = db.Where("chat_sessions.archived_at IS NOT NULL")
		} else {
			db = db.Where("chat_sessions.archived_at IS NULL")
		}
		if query.KnowledgeBaseID != nil {
			db = db.Where("chat_sessions.knowledge_base_id = ?", *query.KnowledgeBaseID)
		}
		if query.Q != "" {
			db = db.Where("LOWER(chat_sessions.title) LIKE ?", "%"+strings.ToLower(query.Q)+"%")
		}
		return db
	}

	var total int64
	if err := base().Count(&total).Error; err != nil {
		return nil, 0, err
	}

	// Correlated subqueries instead of GROUP BY: the message aggregates stay
	// independent of the knowledge base join and work the same on SQLite.
	var items []ChatSessionListItem
	err := base().
		Select(`
			chat_sessions.id AS id,
			chat_sessions.knowledge_base_id AS knowledge_base_id,
			knowledge_bases.name AS knowledge_base_name,
			chat_sessions.title AS title,
			chat_sessions.created_at AS created_at,
			chat_sessions.updated_at AS updated_at,
			chat_sessions.archived_at AS archived_at,
			(
				SELECT COUNT(*) FROM chat_messages
				WHERE chat_messages.session_id = chat_sessions.id
			) AS message_count,
			(
				SELECT chat_messages.content FROM chat_messages
				WHERE chat_messages.session_id = chat_sessions.id
				ORDER BY chat_messages.created_at DESC, chat_messages.id DESC
				LIMIT 1
			) AS last_message_preview
		`).
		Order("chat_sessions.updated_at desc").
		Limit(limit).
		Offset(offset).
		Scan(&items).Error
	return items, total, err
}

func (r *ChatRepository) FindSessionByIDAndUser(ctx context.Context, sessionID, userID uuid.UUID) (*model.ChatSession, error) {
	var session model.ChatSession
	err := r.db.WithContext(ctx).
		Where("id = ? AND user_id = ?", sessionID, userID).
		Where("deleted_at IS NULL").
		First(&session).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return &session, err
}

func (r *ChatRepository) UpdateSessionTitle(ctx context.Context, sessionID uuid.UUID, title string) error {
	return r.db.WithContext(ctx).
		Model(&model.ChatSession{}).
		Where("id = ?", sessionID).
		Updates(map[string]any{
			"title":      title,
			"updated_at": time.Now(),
		}).Error
}

func (r *ChatRepository) ArchiveSession(ctx context.Context, sessionID uuid.UUID, archivedAt time.Time) error {
	return r.db.WithContext(ctx).
		Model(&model.ChatSession{}).
		Where("id = ? AND archived_at IS NULL", sessionID).
		Updates(map[string]any{
			"archived_at": archivedAt,
			"updated_at":  archivedAt,
		}).Error
}

func (r *ChatRepository) UnarchiveSession(ctx context.Context, sessionID uuid.UUID, updatedAt time.Time) error {
	return r.db.WithContext(ctx).
		Model(&model.ChatSession{}).
		Where("id = ? AND archived_at IS NOT NULL", sessionID).
		Updates(map[string]any{
			"archived_at": nil,
			"updated_at":  updatedAt,
		}).Error
}

// DeleteSession soft deletes. Messages are deliberately kept: the session can be
// restored from the recycle bin, and a restored session with no history would be
// indistinguishable from a new one. Permanent deletion is what clears them.
func (r *ChatRepository) DeleteSession(ctx context.Context, sessionID uuid.UUID) error {
	return r.db.WithContext(ctx).
		Where("id = ?", sessionID).
		Delete(&model.ChatSession{}).Error
}

func (r *ChatRepository) FindDeletedSessionByIDAndUser(ctx context.Context, sessionID, userID uuid.UUID) (*model.ChatSession, error) {
	var session model.ChatSession
	err := r.db.WithContext(ctx).
		Unscoped().
		Where("id = ? AND user_id = ?", sessionID, userID).
		Where("deleted_at IS NOT NULL").
		First(&session).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return &session, err
}

func (r *ChatRepository) RestoreSession(ctx context.Context, sessionID uuid.UUID) error {
	result := r.db.WithContext(ctx).
		Unscoped().
		Model(&model.ChatSession{}).
		Where("id = ? AND deleted_at IS NOT NULL", sessionID).
		Update("deleted_at", nil)
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return ErrChatSessionNotDeleted
	}
	return nil
}

type RecycleChatSessionItem struct {
	ID                uuid.UUID
	KnowledgeBaseID   uuid.UUID
	KnowledgeBaseName string
	Title             string
	DeletedAt         time.Time
}

// ListDeletedSessions mirrors the knowledge base and document recycle bins: the
// owning knowledge base must still exist and belong to the caller, so a session
// whose knowledge base was itself deleted is not offered for restore here.
func (r *ChatRepository) ListDeletedSessions(ctx context.Context, userID uuid.UUID, memberRoles []string, offset, limit int) ([]RecycleChatSessionItem, int64, error) {
	base := func() *gorm.DB {
		return deletedChatSessionsScope(r.db.WithContext(ctx), userID, memberRoles)
	}

	var total int64
	if err := base().Count(&total).Error; err != nil {
		return nil, 0, err
	}

	var items []RecycleChatSessionItem
	err := base().
		Select(`
			chat_sessions.id AS id,
			chat_sessions.knowledge_base_id AS knowledge_base_id,
			knowledge_bases.name AS knowledge_base_name,
			chat_sessions.title AS title,
			chat_sessions.deleted_at AS deleted_at
		`).
		Order("chat_sessions.deleted_at desc, chat_sessions.id asc").
		Limit(limit).
		Offset(offset).
		Scan(&items).Error
	return items, total, err
}

// PermanentDeleteSession drops the session and its messages for good.
func (r *ChatRepository) PermanentDeleteSession(ctx context.Context, sessionID uuid.UUID) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := lockDeletedChatSession(tx, sessionID); err != nil {
			return err
		}
		return permanentDeleteChatSessions(tx, []uuid.UUID{sessionID})
	})
}

// EmptyDeletedSessions clears the caller's chat recycle bin in one transaction,
// keeping the all-or-nothing semantics of the other empty endpoints.
func (r *ChatRepository) EmptyDeletedSessions(ctx context.Context, userID uuid.UUID, memberRoles []string) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var ids []uuid.UUID
		if err := deletedChatSessionsScope(tx, userID, memberRoles).
			Clauses(clause.Locking{
				Strength: "UPDATE",
				Table:    clause.Table{Name: "chat_sessions"},
			}).
			Pluck("chat_sessions.id", &ids).Error; err != nil {
			return err
		}
		return permanentDeleteChatSessions(tx, ids)
	})
}

func lockDeletedChatSession(tx *gorm.DB, sessionID uuid.UUID) error {
	var session model.ChatSession
	if err := tx.
		Unscoped().
		Select("id").
		Clauses(clause.Locking{Strength: "UPDATE"}).
		Where("id = ? AND deleted_at IS NOT NULL", sessionID).
		First(&session).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return ErrChatSessionNotDeleted
		}
		return err
	}
	return nil
}

// deletedChatSessionsScope is the definition of the chat recycle bin. Listing
// and destructive bulk operations must share it exactly: sessions under a
// deleted or no-longer-reachable knowledge base are intentionally hidden until
// that knowledge base becomes reachable again.
func deletedChatSessionsScope(db *gorm.DB, userID uuid.UUID, memberRoles []string) *gorm.DB {
	return db.
		Unscoped().
		Model(&model.ChatSession{}).
		Joins("JOIN knowledge_bases ON knowledge_bases.id = chat_sessions.knowledge_base_id").
		Where("chat_sessions.user_id = ?", userID).
		Where(reachableKnowledgeBaseCondition(db, userID, memberRoles)).
		Where("knowledge_bases.deleted_at IS NULL").
		Where("chat_sessions.deleted_at IS NOT NULL")
}

func permanentDeleteChatSessions(tx *gorm.DB, sessionIDs []uuid.UUID) error {
	if len(sessionIDs) == 0 {
		return nil
	}
	if err := tx.Where("session_id IN ?", sessionIDs).Delete(&model.ChatMessage{}).Error; err != nil {
		return err
	}
	return tx.Unscoped().Where("id IN ?", sessionIDs).Delete(&model.ChatSession{}).Error
}

func (r *ChatRepository) ListMessages(ctx context.Context, sessionID uuid.UUID) ([]model.ChatMessage, error) {
	var messages []model.ChatMessage
	err := r.db.WithContext(ctx).
		Where("session_id = ?", sessionID).
		Order("created_at asc, id asc").
		Find(&messages).Error
	return messages, err
}

// FindMessageByIDAndOwner applies the same visibility rule as the chat page:
// the session and its knowledge base must both still be visible to their owner.
// FindMessageByIDAndOwner loads a message from one of the caller's own sessions,
// provided its knowledge base is still reachable with the given member roles.
func (r *ChatRepository) FindMessageByIDAndOwner(ctx context.Context, messageID, ownerID uuid.UUID, memberRoles []string) (*model.ChatMessage, error) {
	var message model.ChatMessage
	err := r.db.WithContext(ctx).
		Model(&model.ChatMessage{}).
		Select("chat_messages.*").
		Joins("JOIN chat_sessions ON chat_sessions.id = chat_messages.session_id").
		Joins("JOIN knowledge_bases ON knowledge_bases.id = chat_sessions.knowledge_base_id").
		Where("chat_messages.id = ?", messageID).
		Where("chat_sessions.user_id = ?", ownerID).
		Where("chat_sessions.deleted_at IS NULL").
		Where(reachableKnowledgeBaseCondition(r.db, ownerID, memberRoles)).
		Where("knowledge_bases.deleted_at IS NULL").
		First(&message).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return &message, err
}

// UpdateMessageFeedback is deliberately field-level so it cannot overwrite
// message content, citations or a concurrently persisted rerank fallback.
func (r *ChatRepository) UpdateMessageFeedback(
	ctx context.Context,
	messageID uuid.UUID,
	rating string,
	updatedAt time.Time,
) error {
	result := r.db.WithContext(ctx).
		Model(&model.ChatMessage{}).
		Where("id = ? AND role = ?", messageID, "assistant").
		Updates(map[string]any{
			"feedback_rating":     rating,
			"feedback_updated_at": updatedAt,
		})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return ErrChatMessageNotFound
	}
	return nil
}

// chatEmptyCitationsSQL is the single definition of "this answer cited nothing".
//
// The cast covers all three ways an empty citation set has been stored across the
// column's history: SQL NULL, the JSON literal `null`, and an empty array. Shared
// by the overview, the negative-feedback list and the gap list so a change to the
// storage shape cannot leave one of them disagreeing with the others.
const chatEmptyCitationsSQL = `COALESCE(CAST(chat_messages.citations AS TEXT), '[]') IN ('', 'null', '[]')`

type ChatQualityOverview struct {
	AnswerCount             int64
	FeedbackCount           int64
	PositiveFeedbackCount   int64
	NegativeFeedbackCount   int64
	KnowledgeAnswerCount    int64
	WithoutCitationsCount   int64
	UnclassifiedAnswerCount int64
}

type ChatQualityFeedbackItem struct {
	MessageID         uuid.UUID
	SessionID         uuid.UUID
	SessionTitle      string
	KnowledgeBaseID   uuid.UUID
	KnowledgeBaseName string
	Question          string
	Answer            string
	Citations         datatypes.JSON
	RerankFallback    datatypes.JSON
	CreatedAt         time.Time
	FeedbackUpdatedAt time.Time
}

func (r *ChatRepository) GetQualityOverview(
	ctx context.Context,
	ownerID uuid.UUID,
	knowledgeBaseID *uuid.UUID,
	startAt, endAt time.Time,
) (ChatQualityOverview, error) {
	var overview ChatQualityOverview
	err := chatQualityScope(r.db.WithContext(ctx), ownerID, knowledgeBaseID, startAt, endAt).
		Select(`
			COUNT(*) AS answer_count,
			COALESCE(SUM(CASE WHEN chat_messages.feedback_rating IS NOT NULL THEN 1 ELSE 0 END), 0) AS feedback_count,
			COALESCE(SUM(CASE WHEN chat_messages.feedback_rating = 'positive' THEN 1 ELSE 0 END), 0) AS positive_feedback_count,
			COALESCE(SUM(CASE WHEN chat_messages.feedback_rating = 'negative' THEN 1 ELSE 0 END), 0) AS negative_feedback_count,
			COALESCE(SUM(CASE WHEN chat_messages.intent = 'knowledge_base' THEN 1 ELSE 0 END), 0) AS knowledge_answer_count,
			COALESCE(SUM(CASE WHEN chat_messages.intent = 'knowledge_base' AND ` + chatEmptyCitationsSQL + ` THEN 1 ELSE 0 END), 0) AS without_citations_count,
			COALESCE(SUM(CASE WHEN chat_messages.intent IS NULL THEN 1 ELSE 0 END), 0) AS unclassified_answer_count
		`).
		Scan(&overview).Error
	return overview, err
}

// Gap categories.
//
// `no_citations` is one row per knowledge answer that retrieved nothing, and
// `repeated_rewrite` is one row per cluster of rephrasings of the same question
// inside one session. `retrieval_failed` and `model_refused` split out the two
// cases that used to be counted as no_citations: all three produce an empty
// citation set, but only no_citations is a statement about the knowledge base.
//
// The split is driven by chat_messages.answer_status, so it only applies to rows
// written after migration 019. Older rows have a NULL status and stay in
// no_citations, which is where they were before -- see noCitationGapScope.
const (
	ChatKnowledgeGapNoCitations     = "no_citations"
	ChatKnowledgeGapRepeatedRewrite = "repeated_rewrite"
	ChatKnowledgeGapRetrievalFailed = "retrieval_failed"
	ChatKnowledgeGapModelRefused    = "model_refused"
)

// chatRepeatedRewriteMinOccurrences is the cluster threshold: a single ask is not
// evidence of anything, two phrasings of one question is the weakest signal worth
// showing an operator.
const chatRepeatedRewriteMinOccurrences = 2

type ChatKnowledgeGapItem struct {
	Category string
	// MessageID identifies the single answer behind a no_citations row. It is nil
	// for a repeated_rewrite cluster, which spans several answers by definition.
	MessageID         *uuid.UUID
	SessionID         uuid.UUID
	SessionTitle      string
	KnowledgeBaseID   uuid.UUID
	KnowledgeBaseName string
	Question          string
	RetrievalQuery    string
	OccurrenceCount   int64
	UngroundedCount   int64
	FirstSeenAt       time.Time
	LastSeenAt        time.Time
}

// chatQuestionForAnswerSQL resolves the user question an assistant answer replied
// to, preferring the idempotency pairing and falling back to the nearest earlier
// user message for answers written before that pairing existed.
const chatQuestionForAnswerSQL = `COALESCE(
	(SELECT paired.content FROM chat_messages AS paired
	 WHERE paired.session_id = chat_messages.session_id
	   AND paired.role = 'user'
	   AND paired.client_request_id = chat_messages.client_request_id
	 ORDER BY paired.created_at DESC, paired.id DESC LIMIT 1),
	(SELECT previous.content FROM chat_messages AS previous
	 WHERE previous.session_id = chat_messages.session_id
	   AND previous.role = 'user'
	   AND (previous.created_at < chat_messages.created_at
	        OR (previous.created_at = chat_messages.created_at AND previous.id < chat_messages.id))
	 ORDER BY previous.created_at DESC, previous.id DESC LIMIT 1),
	''
)`

// noCitationGapScope is knowledge-intent answers where the knowledge base itself
// had nothing to offer.
//
// Restricted to intent = 'knowledge_base' so conversation answers, which are
// given an empty citation array on purpose, are not reported as knowledge gaps.
// Rows with NULL intent predate intent tracking and are excluded rather than
// assumed.
//
// A retrieval failure or a model refusal also has no citations but is not this
// condition, so both are excluded. NULL answer_status is kept: those rows predate
// migration 019 and an empty citation set is the only evidence available for them,
// which is exactly what this category meant before the status existed.
func noCitationGapScope(
	db *gorm.DB,
	ownerID uuid.UUID,
	knowledgeBaseID *uuid.UUID,
	startAt, endAt time.Time,
) *gorm.DB {
	return chatQualityScope(db, ownerID, knowledgeBaseID, startAt, endAt).
		Where("chat_messages.intent = ?", "knowledge_base").
		Where(chatEmptyCitationsSQL).
		Where(
			"(chat_messages.answer_status IS NULL OR chat_messages.answer_status NOT IN ?)",
			[]string{ChatKnowledgeGapRetrievalFailed, ChatKnowledgeGapModelRefused},
		)
}

// answerStatusGapScope is answers carrying one specific answer_status.
//
// Unlike noCitationGapScope this does not filter on citations: a model refusal has
// content in hand and may well have citations attached, and that is precisely what
// makes it a different problem from an empty knowledge base.
func answerStatusGapScope(
	db *gorm.DB,
	ownerID uuid.UUID,
	knowledgeBaseID *uuid.UUID,
	startAt, endAt time.Time,
	answerStatus string,
) *gorm.DB {
	return chatQualityScope(db, ownerID, knowledgeBaseID, startAt, endAt).
		Where("chat_messages.intent = ?", "knowledge_base").
		Where("chat_messages.answer_status = ?", answerStatus)
}

// repeatedRewriteGapScope is the pre-grouping row set for rewrite clusters.
//
// client_request_id IS NOT NULL excludes regenerations: only the send paths set
// it, so a nil value means the answer came from someone asking for another
// attempt at the same question rather than from a user rephrasing it. Counting
// regenerations here would turn "I want a better answer" into "the knowledge base
// cannot answer this", which are different problems.
func repeatedRewriteGapScope(
	db *gorm.DB,
	ownerID uuid.UUID,
	knowledgeBaseID *uuid.UUID,
	startAt, endAt time.Time,
) *gorm.DB {
	return chatQualityScope(db, ownerID, knowledgeBaseID, startAt, endAt).
		Where("chat_messages.intent = ?", "knowledge_base").
		Where("chat_messages.retrieval_query_norm IS NOT NULL").
		Where("chat_messages.client_request_id IS NOT NULL")
}

func (r *ChatRepository) CountNoCitationGaps(
	ctx context.Context,
	ownerID uuid.UUID,
	knowledgeBaseID *uuid.UUID,
	startAt, endAt time.Time,
) (int64, error) {
	var total int64
	err := noCitationGapScope(r.db.WithContext(ctx), ownerID, knowledgeBaseID, startAt, endAt).
		Count(&total).Error
	return total, err
}

// CountRetrievalFailedGaps counts turns where retrieval itself broke, so an
// operator can tell "the knowledge base is missing content" apart from "the system
// was failing during this period".
func (r *ChatRepository) CountRetrievalFailedGaps(
	ctx context.Context,
	ownerID uuid.UUID,
	knowledgeBaseID *uuid.UUID,
	startAt, endAt time.Time,
) (int64, error) {
	var total int64
	err := answerStatusGapScope(
		r.db.WithContext(ctx), ownerID, knowledgeBaseID, startAt, endAt,
		ChatKnowledgeGapRetrievalFailed,
	).Count(&total).Error
	return total, err
}

// CountModelRefusedGaps counts turns the provider declined. Uploading documents
// will not fix these, which is why they are counted separately.
func (r *ChatRepository) CountModelRefusedGaps(
	ctx context.Context,
	ownerID uuid.UUID,
	knowledgeBaseID *uuid.UUID,
	startAt, endAt time.Time,
) (int64, error) {
	var total int64
	err := answerStatusGapScope(
		r.db.WithContext(ctx), ownerID, knowledgeBaseID, startAt, endAt,
		ChatKnowledgeGapModelRefused,
	).Count(&total).Error
	return total, err
}

func (r *ChatRepository) ListRetrievalFailedGaps(
	ctx context.Context,
	ownerID uuid.UUID,
	knowledgeBaseID *uuid.UUID,
	startAt, endAt time.Time,
	offset, limit int,
) ([]ChatKnowledgeGapItem, error) {
	return r.listSingleAnswerGaps(
		ctx,
		answerStatusGapScope(
			r.db.WithContext(ctx), ownerID, knowledgeBaseID, startAt, endAt,
			ChatKnowledgeGapRetrievalFailed,
		),
		ChatKnowledgeGapRetrievalFailed,
		offset, limit,
	)
}

func (r *ChatRepository) ListModelRefusedGaps(
	ctx context.Context,
	ownerID uuid.UUID,
	knowledgeBaseID *uuid.UUID,
	startAt, endAt time.Time,
	offset, limit int,
) ([]ChatKnowledgeGapItem, error) {
	return r.listSingleAnswerGaps(
		ctx,
		answerStatusGapScope(
			r.db.WithContext(ctx), ownerID, knowledgeBaseID, startAt, endAt,
			ChatKnowledgeGapModelRefused,
		),
		ChatKnowledgeGapModelRefused,
		offset, limit,
	)
}

func (r *ChatRepository) ListNoCitationGaps(
	ctx context.Context,
	ownerID uuid.UUID,
	knowledgeBaseID *uuid.UUID,
	startAt, endAt time.Time,
	offset, limit int,
) ([]ChatKnowledgeGapItem, error) {
	return r.listSingleAnswerGaps(
		ctx,
		noCitationGapScope(r.db.WithContext(ctx), ownerID, knowledgeBaseID, startAt, endAt),
		ChatKnowledgeGapNoCitations,
		offset, limit,
	)
}

// listSingleAnswerGaps pages one-row-per-answer categories. Shared by all three so
// the projection, ordering and tie-break cannot drift between them.
func (r *ChatRepository) listSingleAnswerGaps(
	_ context.Context,
	scope *gorm.DB,
	category string,
	offset, limit int,
) ([]ChatKnowledgeGapItem, error) {
	type row struct {
		MessageID         uuid.UUID
		SessionID         uuid.UUID
		SessionTitle      string
		KnowledgeBaseID   uuid.UUID
		KnowledgeBaseName string
		Question          string
		RetrievalQuery    string
		CreatedAt         time.Time
	}
	var rows []row
	err := scope.
		Select(`
			chat_messages.id AS message_id,
			chat_messages.session_id AS session_id,
			chat_sessions.title AS session_title,
			chat_sessions.knowledge_base_id AS knowledge_base_id,
			knowledge_bases.name AS knowledge_base_name,
			` + chatQuestionForAnswerSQL + ` AS question,
			COALESCE(chat_messages.retrieval_query, '') AS retrieval_query,
			chat_messages.created_at AS created_at
		`).
		// id breaks ties on created_at so repeated requests for one page cannot
		// return a different slice.
		Order("chat_messages.created_at DESC, chat_messages.id DESC").
		Limit(limit).
		Offset(offset).
		Scan(&rows).Error
	if err != nil {
		return nil, err
	}
	items := make([]ChatKnowledgeGapItem, 0, len(rows))
	for i := range rows {
		messageID := rows[i].MessageID
		items = append(items, ChatKnowledgeGapItem{
			Category:          category,
			MessageID:         &messageID,
			SessionID:         rows[i].SessionID,
			SessionTitle:      rows[i].SessionTitle,
			KnowledgeBaseID:   rows[i].KnowledgeBaseID,
			KnowledgeBaseName: rows[i].KnowledgeBaseName,
			Question:          rows[i].Question,
			RetrievalQuery:    rows[i].RetrievalQuery,
			OccurrenceCount:   1,
			UngroundedCount:   1,
			FirstSeenAt:       rows[i].CreatedAt,
			LastSeenAt:        rows[i].CreatedAt,
		})
	}
	return items, nil
}

// parseAggregatedTime reads a timestamp that came out of MIN()/MAX().
//
// PostgreSQL keeps the column type through the aggregate and returns a time.Time,
// but SQLite loses the type affinity and returns text, so scanning straight into
// time.Time works in production and fails in the test suite. Scanning as text and
// parsing here works on both, which is the same approach the workspace listing
// takes for MAX(viewed_at).
//
// A value that parses in no known layout yields the zero time rather than an
// error: this feeds a diagnostic list, so losing one cluster's timestamps is
// better than failing the whole page.
func parseAggregatedTime(value string) time.Time {
	value = strings.TrimSpace(value)
	if value == "" {
		return time.Time{}
	}
	formats := []string{
		time.RFC3339Nano,
		"2006-01-02 15:04:05.999999999-07:00",
		"2006-01-02 15:04:05.999999999Z07:00",
		"2006-01-02 15:04:05.999999999",
		"2006-01-02 15:04:05",
	}
	for _, format := range formats {
		if parsed, err := time.Parse(format, value); err == nil {
			return parsed
		}
	}
	return time.Time{}
}

// repeatedRewriteGroups is the grouped query shared by the count and the page so
// the HAVING threshold cannot drift between them.
func repeatedRewriteGroups(
	db *gorm.DB,
	ownerID uuid.UUID,
	knowledgeBaseID *uuid.UUID,
	startAt, endAt time.Time,
) *gorm.DB {
	return repeatedRewriteGapScope(db, ownerID, knowledgeBaseID, startAt, endAt).
		Select(`
			chat_messages.session_id AS session_id,
			chat_messages.retrieval_query_norm AS retrieval_query_norm,
			chat_sessions.title AS session_title,
			chat_sessions.knowledge_base_id AS knowledge_base_id,
			knowledge_bases.name AS knowledge_base_name,
			COUNT(*) AS occurrence_count,
			COALESCE(SUM(CASE WHEN `+chatEmptyCitationsSQL+` THEN 1 ELSE 0 END), 0) AS ungrounded_count,
			MIN(chat_messages.retrieval_query) AS retrieval_query,
			MIN(chat_messages.created_at) AS first_seen_at,
			MAX(chat_messages.created_at) AS last_seen_at
		`).
		Group("chat_messages.session_id, chat_messages.retrieval_query_norm, chat_sessions.title, chat_sessions.knowledge_base_id, knowledge_bases.name").
		Having("COUNT(*) >= ?", chatRepeatedRewriteMinOccurrences)
}

func (r *ChatRepository) CountRepeatedRewriteGaps(
	ctx context.Context,
	ownerID uuid.UUID,
	knowledgeBaseID *uuid.UUID,
	startAt, endAt time.Time,
) (int64, error) {
	// Counting groups needs the grouped query as a subquery: COUNT(*) applied to
	// it directly would count rows inside each group instead of the groups.
	groups := repeatedRewriteGroups(r.db.WithContext(ctx), ownerID, knowledgeBaseID, startAt, endAt)
	var total int64
	err := r.db.WithContext(ctx).Table("(?) AS clusters", groups).Count(&total).Error
	return total, err
}

func (r *ChatRepository) ListRepeatedRewriteGaps(
	ctx context.Context,
	ownerID uuid.UUID,
	knowledgeBaseID *uuid.UUID,
	startAt, endAt time.Time,
	offset, limit int,
) ([]ChatKnowledgeGapItem, error) {
	type row struct {
		SessionID          uuid.UUID
		RetrievalQueryNorm string
		SessionTitle       string
		KnowledgeBaseID    uuid.UUID
		KnowledgeBaseName  string
		OccurrenceCount    int64
		UngroundedCount    int64
		RetrievalQuery     string
		FirstSeenAt        string
		LastSeenAt         string
	}
	var rows []row
	err := repeatedRewriteGroups(r.db.WithContext(ctx), ownerID, knowledgeBaseID, startAt, endAt).
		// session_id and the normalized query are the group key, so ordering by
		// them after last_seen_at makes the sequence total and pagination stable.
		Order("last_seen_at DESC, session_id DESC, retrieval_query_norm ASC").
		Limit(limit).
		Offset(offset).
		Scan(&rows).Error
	if err != nil {
		return nil, err
	}
	items := make([]ChatKnowledgeGapItem, 0, len(rows))
	for i := range rows {
		items = append(items, ChatKnowledgeGapItem{
			Category:          ChatKnowledgeGapRepeatedRewrite,
			SessionID:         rows[i].SessionID,
			SessionTitle:      rows[i].SessionTitle,
			KnowledgeBaseID:   rows[i].KnowledgeBaseID,
			KnowledgeBaseName: rows[i].KnowledgeBaseName,
			// The cluster's members normalize to one key, so they differ only in
			// case, punctuation and spacing. Any member is a fair label; MIN keeps
			// the choice deterministic.
			Question:        rows[i].RetrievalQuery,
			RetrievalQuery:  rows[i].RetrievalQuery,
			OccurrenceCount: rows[i].OccurrenceCount,
			UngroundedCount: rows[i].UngroundedCount,
			FirstSeenAt:     parseAggregatedTime(rows[i].FirstSeenAt),
			LastSeenAt:      parseAggregatedTime(rows[i].LastSeenAt),
		})
	}
	return items, nil
}

func (r *ChatRepository) ListNegativeFeedback(
	ctx context.Context,
	ownerID uuid.UUID,
	knowledgeBaseID *uuid.UUID,
	hasCitations *bool,
	startAt, endAt time.Time,
	offset, limit int,
) ([]ChatQualityFeedbackItem, int64, error) {
	base := func() *gorm.DB {
		db := chatQualityScope(r.db.WithContext(ctx), ownerID, knowledgeBaseID, startAt, endAt).
			Where("chat_messages.feedback_rating = ?", "negative")
		if hasCitations != nil {
			predicate := "NOT (" + chatEmptyCitationsSQL + ")"
			if !*hasCitations {
				predicate = chatEmptyCitationsSQL
			}
			db = db.Where(predicate)
		}
		return db
	}

	var total int64
	if err := base().Count(&total).Error; err != nil {
		return nil, 0, err
	}

	var items []ChatQualityFeedbackItem
	err := base().
		Select(`
			chat_messages.id AS message_id,
			chat_messages.session_id AS session_id,
			chat_sessions.title AS session_title,
			chat_sessions.knowledge_base_id AS knowledge_base_id,
			knowledge_bases.name AS knowledge_base_name,
			COALESCE(
				(SELECT paired.content FROM chat_messages AS paired
				 WHERE paired.session_id = chat_messages.session_id
				   AND paired.role = 'user'
				   AND paired.client_request_id = chat_messages.client_request_id
				 ORDER BY paired.created_at DESC, paired.id DESC LIMIT 1),
				(SELECT previous.content FROM chat_messages AS previous
				 WHERE previous.session_id = chat_messages.session_id
				   AND previous.role = 'user'
				   AND (previous.created_at < chat_messages.created_at
				        OR (previous.created_at = chat_messages.created_at AND previous.id < chat_messages.id))
				 ORDER BY previous.created_at DESC, previous.id DESC LIMIT 1),
				''
			) AS question,
			chat_messages.content AS answer,
			chat_messages.citations AS citations,
			chat_messages.rerank_fallback AS rerank_fallback,
			chat_messages.created_at AS created_at,
			chat_messages.feedback_updated_at AS feedback_updated_at
		`).
		Order("chat_messages.feedback_updated_at DESC, chat_messages.id DESC").
		Limit(limit).
		Offset(offset).
		Scan(&items).Error
	return items, total, err
}

func chatQualityScope(
	db *gorm.DB,
	ownerID uuid.UUID,
	knowledgeBaseID *uuid.UUID,
	startAt, endAt time.Time,
) *gorm.DB {
	db = db.Model(&model.ChatMessage{}).
		Joins("JOIN chat_sessions ON chat_sessions.id = chat_messages.session_id").
		Joins("JOIN knowledge_bases ON knowledge_bases.id = chat_sessions.knowledge_base_id").
		Where("chat_messages.role = ?", "assistant").
		Where("chat_sessions.user_id = ?", ownerID).
		Where("chat_sessions.deleted_at IS NULL").
		Where("knowledge_bases.owner_id = ?", ownerID).
		Where("knowledge_bases.deleted_at IS NULL").
		Where("chat_messages.created_at >= ? AND chat_messages.created_at < ?", startAt, endAt)
	if knowledgeBaseID != nil {
		db = db.Where("chat_sessions.knowledge_base_id = ?", *knowledgeBaseID)
	}
	return db
}

func (r *ChatRepository) FindMessagesByClientRequestID(ctx context.Context, sessionID, clientRequestID uuid.UUID) ([]model.ChatMessage, error) {
	var messages []model.ChatMessage
	err := r.db.WithContext(ctx).
		Where("session_id = ? AND client_request_id = ?", sessionID, clientRequestID).
		Order("created_at asc, id asc").
		Find(&messages).Error
	return messages, err
}

func (r *ChatRepository) CreateMessage(ctx context.Context, message *model.ChatMessage) error {
	return r.db.WithContext(ctx).Create(message).Error
}

func (r *ChatRepository) CreateMessages(ctx context.Context, messages ...*model.ChatMessage) error {
	return r.createMessages(ctx, nil, false, messages...)
}

func (r *ChatRepository) CreateMessagesIfUnchanged(
	ctx context.Context,
	expectedMessageIDs []uuid.UUID,
	messages ...*model.ChatMessage,
) error {
	return r.createMessages(ctx, expectedMessageIDs, true, messages...)
}

func (r *ChatRepository) createMessages(
	ctx context.Context,
	expectedMessageIDs []uuid.UUID,
	checkSnapshot bool,
	messages ...*model.ChatMessage,
) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if len(messages) > 0 {
			var session model.ChatSession
			if err := tx.Select("id").Clauses(clause.Locking{Strength: "UPDATE"}).
				Where("id = ?", messages[0].SessionID).First(&session).Error; err != nil {
				return err
			}
			if checkSnapshot {
				var current []model.ChatMessage
				if err := tx.Select("id").Where("session_id = ?", messages[0].SessionID).
					Order("created_at asc, id asc").Find(&current).Error; err != nil {
					return err
				}
				if !sameUUIDs(messageIDs(current), expectedMessageIDs) {
					return ErrChatMessageChanged
				}
			}
			if err := assignStrictMessageTimes(tx, messages[0].SessionID, messages); err != nil {
				return err
			}
		}
		for _, message := range messages {
			if err := tx.Create(message).Error; err != nil {
				return err
			}
		}
		if len(messages) > 0 {
			return tx.Model(&model.ChatSession{}).
				Where("id = ?", messages[0].SessionID).
				Update("updated_at", time.Now()).Error
		}
		return nil
	})
}

func assignStrictMessageTimes(tx *gorm.DB, sessionID uuid.UUID, messages []*model.ChatMessage) error {
	var latest model.ChatMessage
	err := tx.Select("created_at").Where("session_id = ?", sessionID).
		Order("created_at desc, id desc").First(&latest).Error
	if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
		return err
	}
	cursor := latest.CreatedAt
	now := time.Now().UTC()
	for _, message := range messages {
		createdAt := message.CreatedAt
		if createdAt.IsZero() {
			createdAt = now
		}
		if !cursor.IsZero() && !createdAt.After(cursor) {
			createdAt = cursor.Add(time.Microsecond)
		}
		message.CreatedAt = createdAt
		cursor = createdAt
	}
	return nil
}

// ReplaceMessageTail updates an existing user turn and atomically removes the
// messages that followed it before creating the regenerated assistant turn.
// IDs are supplied by the service from its ordered snapshot so this operation
// never guesses ordering from timestamps or UUID values.
func (r *ChatRepository) ReplaceMessageTail(
	ctx context.Context,
	sessionID, targetMessageID uuid.UUID,
	expectedClientRequestID *uuid.UUID,
	expectedTailIDs []uuid.UUID,
	userMessage *model.ChatMessage,
	assistantMessage *model.ChatMessage,
) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var session model.ChatSession
		if err := tx.Select("id").Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("id = ?", sessionID).First(&session).Error; err != nil {
			return err
		}
		var current []model.ChatMessage
		if err := tx.Where("session_id = ?", sessionID).
			Order("created_at asc, id asc").Find(&current).Error; err != nil {
			return err
		}
		targetIndex := -1
		for i := range current {
			if current[i].ID == targetMessageID {
				targetIndex = i
				break
			}
		}
		if targetIndex < 0 || current[targetIndex].Role != "user" {
			return ErrChatMessageNotFound
		}
		if !sameOptionalUUID(current[targetIndex].ClientRequestID, expectedClientRequestID) ||
			!sameUUIDs(messageIDs(current[targetIndex+1:]), expectedTailIDs) {
			return ErrChatMessageChanged
		}
		target := current[targetIndex]

		if len(expectedTailIDs) > 0 {
			if err := tx.Where("session_id = ? AND id IN ?", sessionID, expectedTailIDs).
				Delete(&model.ChatMessage{}).Error; err != nil {
				return err
			}
		}

		if err := tx.Model(&target).Updates(map[string]any{
			"client_request_id":   userMessage.ClientRequestID,
			"content":             userMessage.Content,
			"citations":           userMessage.Citations,
			"rerank_fallback":     userMessage.RerankFallback,
			"feedback_rating":     nil,
			"feedback_updated_at": nil,
		}).Error; err != nil {
			return err
		}

		if err := tx.Create(assistantMessage).Error; err != nil {
			return err
		}
		return tx.Model(&model.ChatSession{}).
			Where("id = ?", sessionID).
			Update("updated_at", time.Now()).Error
	})
}

func messageIDs(messages []model.ChatMessage) []uuid.UUID {
	ids := make([]uuid.UUID, 0, len(messages))
	for i := range messages {
		ids = append(ids, messages[i].ID)
	}
	return ids
}

func sameUUIDs(left, right []uuid.UUID) bool {
	if len(left) != len(right) {
		return false
	}
	for i := range left {
		if left[i] != right[i] {
			return false
		}
	}
	return true
}

func sameOptionalUUID(left, right *uuid.UUID) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}
