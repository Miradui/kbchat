package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"go.opentelemetry.io/otel/attribute"
	"net/http"
	"reflect"
	"sort"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
	"go.uber.org/zap"
	"gorm.io/datatypes"

	"kbchat/backend/internal/access"
	"kbchat/backend/internal/apperror"
	chatcore "kbchat/backend/internal/chat"
	"kbchat/backend/internal/config"
	"kbchat/backend/internal/dto"
	"kbchat/backend/internal/model"
	"kbchat/backend/internal/observability"
	"kbchat/backend/internal/repository"
)

type chatRetrievalService interface {
	Search(ctx context.Context, ownerID, kbID uuid.UUID, req dto.SearchRequest) (*dto.SearchResponse, error)
}

type ChatService struct {
	evaluations    *EvaluationService
	cfg            config.Config
	chats          *repository.ChatRepository
	knowledgeBases *repository.KnowledgeBaseRepository
	retrieval      chatRetrievalService
	chatProvider   chatcore.Provider
	activities     *ActivityRecorder
	metrics        *observability.Recorder
	usage          *repository.ModelUsageRepository
	users          systemRoleLookup
}

// SetActivityRecorder wires the workspace timeline. Optional; see the
// KnowledgeBaseService counterpart.
func (s *ChatService) SetActivityRecorder(recorder *ActivityRecorder) {
	s.activities = recorder
}

// SetRecorder wires generation timings into the diagnostics endpoint. Optional
// and nil-safe, for the same reason as SetActivityRecorder.
func (s *ChatService) SetRecorder(recorder *observability.Recorder) {
	s.metrics = recorder
}

func (s *ChatService) SetUsageRepository(repo *repository.ModelUsageRepository) { s.usage = repo }

const (
	chatIntentConversation  = "conversation"
	chatIntentGeneral       = "general"
	chatIntentKnowledgeBase = "knowledge_base"
	defaultChatSessionTitle = "新会话"
)

type chatIntentDecision struct {
	Intent          string `json:"intent"`
	StandaloneQuery string `json:"standaloneQuery"`
	Reason          string `json:"reason"`
}

func NewChatService(
	cfg config.Config,
	chats *repository.ChatRepository,
	knowledgeBases *repository.KnowledgeBaseRepository,
	retrieval chatRetrievalService,
	chatProvider chatcore.Provider,
) *ChatService {
	return &ChatService{
		cfg:            cfg,
		chats:          chats,
		knowledgeBases: knowledgeBases,
		retrieval:      retrieval,
		chatProvider:   chatProvider,
	}
}

func (s *ChatService) CreateSession(ctx context.Context, userID uuid.UUID, req dto.CreateChatSessionRequest) (*dto.ChatSessionResponse, error) {
	mode := req.ScopeMode
	if mode == "" {
		mode = model.ChatScopeManual
		if req.KnowledgeBaseID == "" && len(req.KnowledgeBaseIDs) == 0 {
			mode = model.ChatScopeAuto
		}
	}
	if mode != model.ChatScopeAuto && mode != model.ChatScopeManual {
		return nil, apperror.Validation(map[string]any{"scopeMode": "must be auto or manual"})
	}
	if mode == model.ChatScopeAuto {
		if req.KnowledgeBaseID != "" || len(req.KnowledgeBaseIDs) > 0 || req.DocumentIDs != nil {
			return nil, apperror.Validation(map[string]any{"scopeMode": "automatic scope cannot include explicit knowledge base IDs"})
		}
		available, err := s.knowledgeBases.ListChatKnowledgeBases(ctx, userID)
		if err != nil {
			return nil, apperror.Internal(err)
		}
		if len(available) == 0 {
			return nil, apperror.Validation(map[string]any{"knowledgeBaseIds": "没有可提问的知识库，请先创建或加入知识库"})
		}
		// Retain the existing primary foreign key for accounting and lifecycle.
		// It does not restrict the search performed on subsequent turns.
		req.KnowledgeBaseIDs = []string{available[0].ID.String()}
	}
	ids, err := dto.ParseKnowledgeBaseIDs(req.KnowledgeBaseID, req.KnowledgeBaseIDs)
	if err != nil {
		return nil, err
	}
	bases := make([]model.KnowledgeBase, 0, len(ids))
	for _, id := range ids {
		decision, err := s.authorizeKnowledgeBase(ctx, userID, id, access.CapChatUse)
		if err != nil {
			return nil, err
		}
		bases = append(bases, *decision.knowledgeBase)
	}

	documentScope, err := s.buildDocumentScope(ctx, req.DocumentIDs, ids)
	if err != nil {
		return nil, err
	}
	title := strings.TrimSpace(req.Title)
	if title == "" {
		title = defaultChatSessionTitle
	}
	session := &model.ChatSession{
		DocumentScope:   documentScope,
		ScopeMode:       mode,
		UserID:          userID,
		KnowledgeBaseID: ids[0],
		KnowledgeBase:   bases[0],
		Title:           title,
	}
	for i, id := range ids[1:] {
		session.KnowledgeBaseLinks = append(session.KnowledgeBaseLinks, model.ChatSessionKnowledgeBase{KnowledgeBaseID: id, KnowledgeBase: bases[i+1]})
	}
	sort.Slice(session.KnowledgeBaseLinks, func(i, j int) bool {
		return session.KnowledgeBaseLinks[i].KnowledgeBaseID.String() < session.KnowledgeBaseLinks[j].KnowledgeBaseID.String()
	})
	if err := s.chats.CreateSession(ctx, session); err != nil {
		return nil, apperror.Internal(err)
	}

	res := toChatSessionResponse(session)
	return &res, nil
}

// chatSessionPreviewRunes bounds the preview shipped with each list item so a
// long answer cannot dominate the rail payload.
const chatSessionPreviewRunes = 120

func (s *ChatService) ListSessions(ctx context.Context, userID uuid.UUID, query dto.ChatSessionListQuery) (*dto.ChatSessionListResponse, error) {
	page := query.Page
	if page <= 0 {
		page = 1
	}
	pageSize := query.PageSize
	if pageSize <= 0 {
		pageSize = 20
	}
	if pageSize > 100 {
		pageSize = 100
	}
	query.Q = strings.TrimSpace(query.Q)

	items, total, err := s.chats.ListSessions(ctx, userID, access.MemberRolesWith(access.CapChatUse), query, (page-1)*pageSize, pageSize)
	if err != nil {
		return nil, apperror.Internal(err)
	}

	res := dto.ChatSessionListResponse{
		Items:    make([]dto.ChatSessionResponse, 0, len(items)),
		Total:    total,
		Page:     page,
		PageSize: pageSize,
	}
	for i := range items {
		scope := toChatSessionResponse(&model.ChatSession{DocumentScope: items[i].DocumentScope, KnowledgeBaseID: items[i].KnowledgeBaseID, KnowledgeBase: model.KnowledgeBase{Name: items[i].KnowledgeBaseName}, KnowledgeBaseLinks: items[i].KnowledgeBaseLinks})
		messageCount := items[i].MessageCount
		res.Items = append(res.Items, dto.ChatSessionResponse{
			Documents:          scope.Documents,
			ScopeMode:          items[i].ScopeMode,
			ID:                 items[i].ID.String(),
			KnowledgeBaseID:    items[i].KnowledgeBaseID.String(),
			KnowledgeBaseIDs:   scope.KnowledgeBaseIDs,
			KnowledgeBases:     scope.KnowledgeBases,
			Title:              items[i].Title,
			CreatedAt:          items[i].CreatedAt,
			UpdatedAt:          items[i].UpdatedAt,
			ArchivedAt:         items[i].ArchivedAt,
			KnowledgeBaseName:  items[i].KnowledgeBaseName,
			MessageCount:       &messageCount,
			LastMessagePreview: truncateRunes(items[i].LastMessagePreview, chatSessionPreviewRunes),
		})
	}
	return &res, nil
}

func truncateRunes(value string, limit int) string {
	value = strings.TrimSpace(value)
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return string(runes[:limit]) + "…"
}

func (s *ChatService) GetSession(ctx context.Context, userID, sessionID uuid.UUID) (*dto.ChatSessionResponse, error) {
	session, err := s.authorizeSession(ctx, userID, sessionID, access.CapChatUse)
	if err != nil {
		return nil, err
	}
	res := toChatSessionResponse(session)
	return &res, nil
}

func (s *ChatService) UpdateSession(ctx context.Context, userID, sessionID uuid.UUID, req dto.UpdateChatSessionRequest) (*dto.ChatSessionResponse, error) {
	session, err := s.authorizeSession(ctx, userID, sessionID, access.CapChatUse)
	if err != nil {
		return nil, err
	}
	title := strings.TrimSpace(req.Title)
	if title == "" {
		return nil, apperror.Validation(map[string]any{"title": "title is required"})
	}
	if err := s.chats.UpdateSessionTitle(ctx, session.ID, title); err != nil {
		return nil, apperror.Internal(err)
	}
	session.Title = title
	updated, err := s.authorizeSession(ctx, userID, sessionID, access.CapChatUse)
	if err != nil {
		return nil, err
	}
	res := toChatSessionResponse(updated)
	return &res, nil
}

// DeleteSession soft deletes and keeps the messages, matching the knowledge base
// and document recycle bins. See docs/04-api-design.md (DELETE /chat/sessions/:id).
func (s *ChatService) DeleteSession(ctx context.Context, userID, sessionID uuid.UUID) error {
	session, err := s.authorizeSession(ctx, userID, sessionID, access.CapChatUse)
	if err != nil {
		return err
	}
	if err := s.chats.DeleteSession(ctx, session.ID); err != nil {
		return apperror.Internal(err)
	}
	s.recordSessionActivity(ctx, userID, ActivityChatSessionDeleted, session)
	return nil
}

func (s *ChatService) ListRecycleBin(ctx context.Context, userID uuid.UUID, page, pageSize int) (*dto.RecycleBinListResponse, error) {
	page, pageSize = normalizedRecyclePage(page, pageSize)
	items, total, err := s.chats.ListDeletedSessions(ctx, userID, access.MemberRolesWith(access.CapChatUse), (page-1)*pageSize, pageSize)
	if err != nil {
		return nil, apperror.Internal(err)
	}
	res := &dto.RecycleBinListResponse{
		Items:    make([]dto.RecycleBinItemResponse, 0, len(items)),
		Total:    total,
		Page:     page,
		PageSize: pageSize,
	}
	for i := range items {
		res.Items = append(res.Items, dto.RecycleBinItemResponse{
			ResourceType:      "chatSession",
			ID:                items[i].ID.String(),
			Name:              items[i].Title,
			KnowledgeBaseID:   items[i].KnowledgeBaseID.String(),
			KnowledgeBaseName: items[i].KnowledgeBaseName,
			DeletedAt:         items[i].DeletedAt,
		})
	}
	return res, nil
}

func (s *ChatService) RestoreSession(ctx context.Context, userID, sessionID uuid.UUID) (*dto.ChatSessionResponse, error) {
	if _, err := s.authorizeDeletedSession(ctx, userID, sessionID, access.CapChatUse); err != nil {
		return nil, err
	}
	if err := s.chats.RestoreSession(ctx, sessionID); err != nil {
		if errors.Is(err, repository.ErrChatSessionNotDeleted) {
			return nil, apperror.NotFound("RESOURCE_NOT_FOUND", "resource not found")
		}
		return nil, apperror.Internal(err)
	}
	restored, err := s.authorizeSession(ctx, userID, sessionID, access.CapChatUse)
	if err != nil {
		return nil, err
	}
	s.recordSessionActivity(ctx, userID, ActivityChatSessionRestored, restored)
	res := toChatSessionResponse(restored)
	return &res, nil
}

func (s *ChatService) recordSessionActivity(ctx context.Context, userID uuid.UUID, action string, session *model.ChatSession) {
	if s.activities == nil {
		return
	}
	knowledgeBaseName := ""
	if kb, err := s.knowledgeBases.FindByID(ctx, session.KnowledgeBaseID); err == nil && kb != nil {
		knowledgeBaseName = kb.Name
	}
	knowledgeBaseID := session.KnowledgeBaseID
	resourceName := session.Title
	if session.IsAutomatic() || len(session.KnowledgeBaseLinks) > 0 {
		resourceName = "跨库会话"
	}
	s.activities.Record(ctx, userID, ActivityEntry{
		Action:            action,
		ResourceType:      "chatSession",
		ResourceID:        session.ID,
		ResourceName:      resourceName,
		KnowledgeBaseID:   &knowledgeBaseID,
		KnowledgeBaseName: knowledgeBaseName,
	})
}

func (s *ChatService) PermanentDeleteSession(ctx context.Context, userID, sessionID uuid.UUID) error {
	if _, err := s.authorizeDeletedSession(ctx, userID, sessionID, access.CapChatUse); err != nil {
		return err
	}
	if err := s.chats.PermanentDeleteSession(ctx, sessionID); err != nil {
		if errors.Is(err, repository.ErrChatSessionNotDeleted) {
			return apperror.NotFound("RESOURCE_NOT_FOUND", "resource not found")
		}
		return apperror.Internal(err)
	}
	return nil
}

func (s *ChatService) EmptyRecycleBin(ctx context.Context, userID uuid.UUID) error {
	if err := s.chats.EmptyDeletedSessions(ctx, userID, access.MemberRolesWith(access.CapChatUse)); err != nil {
		return apperror.Internal(err)
	}
	return nil
}

func (s *ChatService) ArchiveSession(ctx context.Context, userID, sessionID uuid.UUID) (*dto.ChatSessionResponse, error) {
	session, err := s.authorizeSession(ctx, userID, sessionID, access.CapChatUse)
	if err != nil {
		return nil, err
	}
	if session.ArchivedAt != nil {
		res := toChatSessionResponse(session)
		return &res, nil
	}
	if err := s.chats.ArchiveSession(ctx, session.ID, time.Now()); err != nil {
		return nil, apperror.Internal(err)
	}
	archived, err := s.authorizeSession(ctx, userID, sessionID, access.CapChatUse)
	if err != nil {
		return nil, err
	}
	res := toChatSessionResponse(archived)
	return &res, nil
}

func (s *ChatService) UnarchiveSession(ctx context.Context, userID, sessionID uuid.UUID) (*dto.ChatSessionResponse, error) {
	session, err := s.authorizeSession(ctx, userID, sessionID, access.CapChatUse)
	if err != nil {
		return nil, err
	}
	if session.ArchivedAt == nil {
		res := toChatSessionResponse(session)
		return &res, nil
	}
	if err := s.chats.UnarchiveSession(ctx, session.ID, time.Now()); err != nil {
		return nil, apperror.Internal(err)
	}
	restored, err := s.authorizeSession(ctx, userID, sessionID, access.CapChatUse)
	if err != nil {
		return nil, err
	}
	res := toChatSessionResponse(restored)
	return &res, nil
}

func (s *ChatService) ListMessages(ctx context.Context, userID, sessionID uuid.UUID) (*dto.ChatMessageListResponse, error) {
	session, err := s.authorizeSession(ctx, userID, sessionID, access.CapChatUse)
	if err != nil {
		return nil, err
	}

	messages, err := s.chats.ListMessages(ctx, session.ID)
	if err != nil {
		return nil, apperror.Internal(err)
	}

	res := dto.ChatMessageListResponse{Items: make([]dto.ChatMessageResponse, 0, len(messages))}
	if err := s.chats.LoadBookmarks(ctx, userID, messages); err != nil {
		return nil, apperror.Internal(err)
	}
	for i := range messages {
		res.Items = append(res.Items, toChatMessageResponse(&messages[i]))
	}
	return &res, nil
}

func (s *ChatService) SetMessageFeedback(
	ctx context.Context,
	userID, messageID uuid.UUID,
	rating string,
	details ...dto.ChatFeedbackDetails,
) (*dto.ChatMessageFeedbackResponse, error) {
	rating = strings.TrimSpace(rating)
	if rating != "positive" && rating != "negative" {
		return nil, apperror.Validation(map[string]any{"rating": "rating must be positive or negative"})
	}
	var feedbackDetails dto.ChatFeedbackDetails
	if len(details) > 0 && rating == "negative" {
		feedbackDetails = dto.ChatFeedbackDetails{Reason: strings.TrimSpace(details[0].Reason), Comment: strings.TrimSpace(details[0].Comment)}
		switch feedbackDetails.Reason {
		case "", "inaccurate", "missing_evidence", "irrelevant", "incomplete", "other":
		default:
			return nil, apperror.Validation(map[string]any{"reason": "unknown feedback reason"})
		}
		if utf8.RuneCountInString(feedbackDetails.Comment) > 1000 {
			return nil, apperror.Validation(map[string]any{"comment": "comment must be at most 1000 characters"})
		}
	}
	message, err := s.chats.FindMessageByIDAndOwner(ctx, messageID, userID, access.MemberRolesWith(access.CapFeedbackWrite))
	if err != nil {
		return nil, apperror.Internal(err)
	}
	if message == nil {
		return nil, apperror.NotFound("RESOURCE_NOT_FOUND", "resource not found")
	}
	if message.Role != "assistant" {
		return nil, apperror.Validation(map[string]any{"messageId": "only assistant messages accept feedback"})
	}
	updatedAt := time.Now().UTC()
	if err := s.chats.UpdateMessageFeedback(ctx, message.ID, rating, updatedAt, feedbackDetails.Reason, feedbackDetails.Comment); err != nil {
		if errors.Is(err, repository.ErrChatMessageNotFound) {
			return nil, apperror.NotFound("RESOURCE_NOT_FOUND", "resource not found")
		}
		return nil, apperror.Internal(err)
	}
	return &dto.ChatMessageFeedbackResponse{
		ChatFeedbackDetails: feedbackDetails,
		MessageID:           message.ID.String(),
		Rating:              rating,
		UpdatedAt:           updatedAt,
	}, nil
}

// qualityFilter is the scope for every quality and knowledge-gap read.
//
// The role set is quality.read, which is manager and above. That is what widens
// these views beyond the caller's own sessions: an operator sees the questions asked
// in the knowledge bases they run, which is the only reading under which "answers
// without citations" is an operational figure rather than a diary.
func qualityFilter(actorID uuid.UUID, knowledgeBaseID *uuid.UUID, startAt, endAt time.Time, scopes ...string) repository.ChatQualityFilter {
	scope := ""
	roles := access.MemberRolesWith(access.CapQualityRead)
	if len(scopes) > 0 {
		scope = scopes[0]
	}
	if scope != "" {
		roles = access.MemberRolesWith(access.CapChatUse)
	}
	return repository.ChatQualityFilter{
		Scope:           scope,
		ActorID:         actorID,
		MemberRoles:     roles,
		KnowledgeBaseID: knowledgeBaseID,
		StartAt:         startAt,
		EndAt:           endAt,
	}
}

func (s *ChatService) GetQualityOverview(
	ctx context.Context,
	userID uuid.UUID,
	query dto.ChatQualityOverviewQuery,
) (*dto.ChatQualityOverviewResponse, error) {
	period := normalizePeriod(query.Period)
	if err := s.validateQualityKnowledgeBase(ctx, userID, query.KnowledgeBaseID, query.Scope); err != nil {
		return nil, err
	}
	endAt := time.Now().UTC()
	startAt := periodStart(endAt, period)
	overview, err := s.chats.GetQualityOverview(ctx, qualityFilter(userID, query.KnowledgeBaseID, startAt, endAt, query.Scope))
	if err != nil {
		return nil, apperror.Internal(err)
	}
	feedbackCoverage := float64(0)
	if overview.AnswerCount > 0 {
		feedbackCoverage = float64(overview.FeedbackCount) / float64(overview.AnswerCount)
	}
	positiveRate := float64(0)
	if overview.FeedbackCount > 0 {
		positiveRate = float64(overview.PositiveFeedbackCount) / float64(overview.FeedbackCount)
	}
	// Denominator is knowledge answers, not all answers: dividing by AnswerCount
	// would let a burst of small talk make the knowledge gap look like it shrank.
	withoutCitationsRate := float64(0)
	if overview.KnowledgeAnswerCount > 0 {
		withoutCitationsRate = float64(overview.WithoutCitationsCount) / float64(overview.KnowledgeAnswerCount)
	}
	return &dto.ChatQualityOverviewResponse{
		Period:                  period,
		StartAt:                 startAt,
		EndAt:                   endAt,
		AnswerCount:             overview.AnswerCount,
		FeedbackCount:           overview.FeedbackCount,
		PositiveFeedbackCount:   overview.PositiveFeedbackCount,
		NegativeFeedbackCount:   overview.NegativeFeedbackCount,
		KnowledgeAnswerCount:    overview.KnowledgeAnswerCount,
		WithoutCitationsCount:   overview.WithoutCitationsCount,
		UnclassifiedAnswerCount: overview.UnclassifiedAnswerCount,
		FeedbackCoverage:        feedbackCoverage,
		PositiveRate:            positiveRate,
		WithoutCitationsRate:    withoutCitationsRate,
	}, nil
}

// systemRoleLookup answers "is this user a system administrator". Optional:
// without it usage is scoped to the caller's reachable knowledge bases only.
type systemRoleLookup interface {
	FindByID(ctx context.Context, id uuid.UUID) (*model.User, error)
}

// SetUserRepository enables the administrator-wide usage view.
func (s *ChatService) SetUserRepository(users systemRoleLookup) { s.users = users }

func (s *ChatService) isSystemAdmin(ctx context.Context, userID uuid.UUID) (bool, error) {
	if s.users == nil {
		return false, nil
	}
	user, err := s.users.FindByID(ctx, userID)
	if err != nil {
		return false, err
	}
	return user != nil && user.Role == model.SystemRoleAdmin, nil
}

func (s *ChatService) GetChatUsage(ctx context.Context, userID uuid.UUID, query dto.ChatUsageQuery) (*dto.ChatUsageResponse, error) {
	if s.usage == nil {
		return nil, apperror.New(http.StatusNotImplemented, "USAGE_NOT_CONFIGURED", "用量统计尚未配置")
	}
	if query.GroupBy == "" {
		query.GroupBy = "day"
	}
	switch query.GroupBy {
	case "day", "knowledgeBase", "user", "model", "purpose":
	default:
		return nil, apperror.Validation(map[string]any{"groupBy": "groupBy 必须是 day、knowledgeBase、user、model 或 purpose"})
	}
	if query.To.IsZero() {
		query.To = time.Now().UTC()
	}
	if query.From.IsZero() {
		query.From = query.To.Add(-7 * 24 * time.Hour)
	}
	if query.From.After(query.To) {
		return nil, apperror.Validation(map[string]any{"from": "起始时间不能晚于结束时间"})
	}
	if query.KnowledgeBaseID != nil {
		if err := s.validateQualityKnowledgeBase(ctx, userID, query.KnowledgeBaseID); err != nil {
			return nil, err
		}
	}
	// Same rule as the rest of the quality page: every knowledge base the
	// caller can read quality data for, or everything for a system admin.
	admin, err := s.isSystemAdmin(ctx, userID)
	if err != nil {
		return nil, apperror.Internal(err)
	}
	scope := repository.UsageScope{
		ActorID:           userID,
		MemberRoles:       access.MemberRolesWith(access.CapQualityRead),
		KnowledgeBaseID:   query.KnowledgeBaseID,
		AllKnowledgeBases: admin,
	}
	rows, err := s.usage.Aggregate(ctx, scope, query.From, query.To, query.GroupBy)
	if err != nil {
		return nil, apperror.Internal(err)
	}
	pricing, _ := config.ParseModelPricing(s.cfg.ModelPricing)
	items := make([]dto.ChatUsageAggregate, 0, len(rows))
	var prompt, completion, total int64
	for _, row := range rows {
		item := dto.ChatUsageAggregate{GroupKey: row.GroupKey, GroupLabel: row.GroupLabel, PromptTokens: row.PromptTokens, CompletionTokens: row.CompletionTokens, TotalTokens: row.TotalTokens, Calls: row.Calls}
		if query.GroupBy == "model" {
			if price, ok := pricing[row.GroupKey]; ok {
				cost := estimateUsageCost(price, row.PromptTokens, row.CompletionTokens)
				item.EstimatedCost = &cost
			}
		}
		items = append(items, item)
		prompt += row.PromptTokens
		completion += row.CompletionTokens
		total += row.TotalTokens
	}
	res := &dto.ChatUsageResponse{From: query.From, To: query.To, GroupBy: query.GroupBy, Items: items, TotalPrompt: prompt, TotalCompletion: completion, TotalTokens: total, PricingConfigured: len(pricing) > 0, UnpricedModels: []string{}}
	if len(pricing) > 0 {
		byModel, err := s.usage.AggregateByModel(ctx, scope, query.From, query.To)
		if err != nil {
			return nil, apperror.Internal(err)
		}
		var cost float64
		for _, totals := range byModel {
			price, ok := pricing[totals.Model]
			if !ok {
				res.UnpricedModels = append(res.UnpricedModels, totals.Model)
				continue
			}
			cost += estimateUsageCost(price, totals.PromptTokens, totals.CompletionTokens)
		}
		res.EstimatedCost = &cost
	}
	return res, nil
}

// estimateUsageCost prices tokens at per-million rates.
func estimateUsageCost(price config.ModelPrice, promptTokens, completionTokens int64) float64 {
	return float64(promptTokens)/1_000_000*price.Prompt + float64(completionTokens)/1_000_000*price.Completion
}

// ChatKnowledgeGapCategoryAll requests both categories in one page.
const ChatKnowledgeGapCategoryAll = "all"

// ListKnowledgeGaps reports questions the knowledge base is failing to answer.
//
// Four categories ship here, and the split matters because the fix differs:
//
//   - `no_citations`: retrieval succeeded and found nothing. Someone should upload
//     the missing content.
//   - `retrieval_failed`: retrieval itself broke, so whether the content exists is
//     unknown. Nothing to upload; the system needs fixing.
//   - `model_refused`: the provider declined despite having content in hand. Not a
//     knowledge base problem at all.
//   - `repeated_rewrite`: a user rephrasing one question inside a session.
//
// The first three all produce an empty citation set, which is why they were one
// bucket before chat_messages.answer_status existed. Answers written before
// migration 019 have a NULL status and stay in no_citations rather than being
// relabelled on a guess.
func (s *ChatService) ListKnowledgeGaps(
	ctx context.Context,
	userID uuid.UUID,
	query dto.ChatKnowledgeGapQuery,
) (*dto.ChatKnowledgeGapListResponse, error) {
	period := normalizePeriod(query.Period)
	category := strings.TrimSpace(query.Category)
	if category == "" {
		category = ChatKnowledgeGapCategoryAll
	}
	switch category {
	case ChatKnowledgeGapCategoryAll,
		repository.ChatKnowledgeGapNoCitations,
		repository.ChatKnowledgeGapRetrievalFailed,
		repository.ChatKnowledgeGapModelRefused,
		repository.ChatKnowledgeGapRepeatedRewrite:
	default:
		// Rejected rather than coerced to "all": silently widening a filter would
		// show an operator a list that is not the one they asked for.
		return nil, apperror.Validation(map[string]any{
			"category": "category must be one of all, no_citations, retrieval_failed, model_refused, repeated_rewrite",
		})
	}
	if err := s.validateQualityKnowledgeBase(ctx, userID, query.KnowledgeBaseID, query.Scope); err != nil {
		return nil, err
	}

	page, pageSize := query.Page, query.PageSize
	if page <= 0 {
		page = 1
	}
	if pageSize <= 0 {
		pageSize = 20
	}
	if pageSize > 100 {
		pageSize = 100
	}
	endAt := time.Now().UTC()
	startAt := periodStart(endAt, period)

	noCitationsTotal, err := s.chats.CountNoCitationGaps(ctx, qualityFilter(userID, query.KnowledgeBaseID, startAt, endAt, query.Scope))
	if err != nil {
		return nil, apperror.Internal(err)
	}
	retrievalFailedTotal, err := s.chats.CountRetrievalFailedGaps(ctx, qualityFilter(userID, query.KnowledgeBaseID, startAt, endAt, query.Scope))
	if err != nil {
		return nil, apperror.Internal(err)
	}
	modelRefusedTotal, err := s.chats.CountModelRefusedGaps(ctx, qualityFilter(userID, query.KnowledgeBaseID, startAt, endAt, query.Scope))
	if err != nil {
		return nil, apperror.Internal(err)
	}
	repeatedRewriteTotal, err := s.chats.CountRepeatedRewriteGaps(ctx, qualityFilter(userID, query.KnowledgeBaseID, startAt, endAt, query.Scope))
	if err != nil {
		return nil, apperror.Internal(err)
	}

	offset := (page - 1) * pageSize
	response := &dto.ChatKnowledgeGapListResponse{
		Items:                make([]dto.ChatKnowledgeGapItemResponse, 0, pageSize),
		Page:                 page,
		PageSize:             pageSize,
		NoCitationsTotal:     noCitationsTotal,
		RetrievalFailedTotal: retrievalFailedTotal,
		ModelRefusedTotal:    modelRefusedTotal,
		RepeatedRewriteTotal: repeatedRewriteTotal,
	}

	var items []repository.ChatKnowledgeGapItem
	switch category {
	case repository.ChatKnowledgeGapNoCitations:
		response.Total = noCitationsTotal
		items, err = s.chats.ListNoCitationGaps(ctx, qualityFilter(userID, query.KnowledgeBaseID, startAt, endAt, query.Scope), offset, pageSize)
	case repository.ChatKnowledgeGapRetrievalFailed:
		response.Total = retrievalFailedTotal
		items, err = s.chats.ListRetrievalFailedGaps(ctx, qualityFilter(userID, query.KnowledgeBaseID, startAt, endAt, query.Scope), offset, pageSize)
	case repository.ChatKnowledgeGapModelRefused:
		response.Total = modelRefusedTotal
		items, err = s.chats.ListModelRefusedGaps(ctx, qualityFilter(userID, query.KnowledgeBaseID, startAt, endAt, query.Scope), offset, pageSize)
	case repository.ChatKnowledgeGapRepeatedRewrite:
		response.Total = repeatedRewriteTotal
		items, err = s.chats.ListRepeatedRewriteGaps(ctx, qualityFilter(userID, query.KnowledgeBaseID, startAt, endAt, query.Scope), offset, pageSize)
	default:
		response.Total = noCitationsTotal + retrievalFailedTotal + modelRefusedTotal + repeatedRewriteTotal
		items, err = s.listCombinedKnowledgeGaps(
			ctx, qualityFilter(userID, query.KnowledgeBaseID, startAt, endAt, query.Scope), offset, pageSize,
			combinedGapTotals{
				noCitations:     noCitationsTotal,
				retrievalFailed: retrievalFailedTotal,
				modelRefused:    modelRefusedTotal,
			},
		)
	}
	if err != nil {
		return nil, apperror.Internal(err)
	}

	for i := range items {
		var messageID *string
		if items[i].MessageID != nil {
			id := items[i].MessageID.String()
			messageID = &id
		}
		response.Items = append(response.Items, dto.ChatKnowledgeGapItemResponse{
			Category:          items[i].Category,
			MessageID:         messageID,
			SessionID:         items[i].SessionID.String(),
			SessionTitle:      items[i].SessionTitle,
			KnowledgeBaseID:   items[i].KnowledgeBaseID.String(),
			KnowledgeBaseName: items[i].KnowledgeBaseName,
			Question:          items[i].Question,
			RetrievalQuery:    items[i].RetrievalQuery,
			OccurrenceCount:   items[i].OccurrenceCount,
			UngroundedCount:   items[i].UngroundedCount,
			FirstSeenAt:       items[i].FirstSeenAt,
			LastSeenAt:        items[i].LastSeenAt,
		})
	}
	return response, nil
}

// combinedGapTotals carries the counts the combined pager needs to know where each
// category's share of a page begins. The last category has no field: once the
// counted ones are exhausted the remainder of the page is entirely its own, so a
// count for it would never be read.
type combinedGapTotals struct {
	noCitations     int64
	retrievalFailed int64
	modelRefused    int64
}

// gapSegment is one category's contribution to the combined listing: how many rows
// it has, and how to fetch a window of them.
type gapSegment struct {
	total int64
	list  func(ctx context.Context, offset, limit int) ([]repository.ChatKnowledgeGapItem, error)
}

// listCombinedKnowledgeGaps pages across every category as one sequence: all
// no_citations rows, then retrieval_failed, then model_refused, then the
// repeated_rewrite clusters.
//
// The categories are concatenated rather than interleaved by recency because they
// are not comparable units — three of them are single answers, the fourth is a
// cluster — so a merged "most recent first" ordering would imply a ranking that
// does not exist. Only the slice each category contributes to the requested page is
// fetched, so no full result set is ever loaded.
func (s *ChatService) listCombinedKnowledgeGaps(
	ctx context.Context,
	filter repository.ChatQualityFilter,
	offset, pageSize int,
	totals combinedGapTotals,
) ([]repository.ChatKnowledgeGapItem, error) {
	segments := []gapSegment{
		{
			total: totals.noCitations,
			list: func(ctx context.Context, offset, limit int) ([]repository.ChatKnowledgeGapItem, error) {
				return s.chats.ListNoCitationGaps(ctx, filter, offset, limit)
			},
		},
		{
			total: totals.retrievalFailed,
			list: func(ctx context.Context, offset, limit int) ([]repository.ChatKnowledgeGapItem, error) {
				return s.chats.ListRetrievalFailedGaps(ctx, filter, offset, limit)
			},
		},
		{
			total: totals.modelRefused,
			list: func(ctx context.Context, offset, limit int) ([]repository.ChatKnowledgeGapItem, error) {
				return s.chats.ListModelRefusedGaps(ctx, filter, offset, limit)
			},
		},
	}

	items := make([]repository.ChatKnowledgeGapItem, 0, pageSize)
	// Consumed as the categories are walked: each one the page starts past shifts
	// the offset down by its own size, so what reaches a category is its local
	// offset rather than the global one.
	remainingOffset := offset
	for _, segment := range segments {
		count := int(segment.total)
		if remainingOffset >= count {
			remainingOffset -= count
			continue
		}
		limit := pageSize - len(items)
		if available := count - remainingOffset; available < limit {
			limit = available
		}
		window, err := segment.list(ctx, remainingOffset, limit)
		if err != nil {
			return nil, err
		}
		items = append(items, window...)
		remainingOffset = 0
		if len(items) >= pageSize {
			return items, nil
		}
	}

	tail, err := s.chats.ListRepeatedRewriteGaps(
		ctx, filter, remainingOffset, pageSize-len(items),
	)
	if err != nil {
		return nil, err
	}
	return append(items, tail...), nil
}

func (s *ChatService) ListNegativeFeedback(
	ctx context.Context,
	userID uuid.UUID,
	query dto.ChatQualityFeedbackQuery,
) (*dto.ChatQualityFeedbackListResponse, error) {
	period := normalizePeriod(query.Period)
	if err := s.validateQualityKnowledgeBase(ctx, userID, query.KnowledgeBaseID, query.Scope); err != nil {
		return nil, err
	}
	page, pageSize := query.Page, query.PageSize
	if page <= 0 {
		page = 1
	}
	if pageSize <= 0 {
		pageSize = 20
	}
	if pageSize > 100 {
		pageSize = 100
	}
	endAt := time.Now().UTC()
	startAt := periodStart(endAt, period)
	items, total, err := s.chats.ListNegativeFeedback(
		ctx, qualityFilter(userID, query.KnowledgeBaseID, startAt, endAt, query.Scope), query.HasCitations, (page-1)*pageSize, pageSize,
	)
	if err != nil {
		return nil, apperror.Internal(err)
	}
	response := &dto.ChatQualityFeedbackListResponse{
		Items:    make([]dto.ChatQualityFeedbackItemResponse, 0, len(items)),
		Total:    total,
		Page:     page,
		PageSize: pageSize,
	}
	for i := range items {
		citations := []dto.CitationResponse{}
		if len(items[i].Citations) > 0 {
			if err := json.Unmarshal(items[i].Citations, &citations); err != nil {
				return nil, apperror.Internal(err)
			}
		}
		var fallback *dto.RerankFallbackResponse
		if len(items[i].RerankFallback) > 0 {
			var stored dto.RerankFallbackResponse
			if err := json.Unmarshal(items[i].RerankFallback, &stored); err != nil {
				return nil, apperror.Internal(err)
			}
			fallback = &stored
		}
		response.Items = append(response.Items, dto.ChatQualityFeedbackItemResponse{
			ChatFeedbackDetails: dto.ChatFeedbackDetails{Reason: items[i].Reason, Comment: items[i].Comment},
			MessageID:           items[i].MessageID.String(),
			SessionID:           items[i].SessionID.String(),
			SessionTitle:        items[i].SessionTitle,
			KnowledgeBaseID:     items[i].KnowledgeBaseID.String(),
			KnowledgeBaseName:   items[i].KnowledgeBaseName,
			Question:            items[i].Question,
			Answer:              items[i].Answer,
			Citations:           citations,
			RerankFallback:      fallback,
			CreatedAt:           items[i].CreatedAt,
			FeedbackUpdatedAt:   items[i].FeedbackUpdatedAt,
		})
	}
	return response, nil
}

// validateQualityKnowledgeBase checks the quality.read capability on the filter.
//
// A nil filter is not a no-op any more than a set one: it means "every knowledge
// base I can see", and the repository scopes those rows to what the caller may read.
// Returning early here only skips the per-knowledge-base check, which has nothing to
// check.
func (s *ChatService) validateQualityKnowledgeBase(ctx context.Context, userID uuid.UUID, knowledgeBaseID *uuid.UUID, scopes ...string) error {
	if len(scopes) > 0 && scopes[0] != "" {
		switch scopes[0] {
		case "personal", "auto", "multi", "documents":
		default:
			return apperror.Validation(map[string]any{"scope": "无效的质量视图范围"})
		}
		if knowledgeBaseID != nil {
			_, err := s.authorizeKnowledgeBase(ctx, userID, *knowledgeBaseID, access.CapChatUse)
			return err
		}
		return nil
	}
	if knowledgeBaseID == nil {
		return nil
	}
	_, err := s.authorizeKnowledgeBase(ctx, userID, *knowledgeBaseID, access.CapQualityRead)
	return err
}

func (s *ChatService) ExportSession(ctx context.Context, userID, sessionID uuid.UUID) (*ExportFile, error) {
	session, err := s.authorizeSession(ctx, userID, sessionID, access.CapChatExport)
	if err != nil {
		return nil, err
	}
	messages, err := s.chats.ListMessages(ctx, session.ID)
	if err != nil {
		return nil, apperror.Internal(err)
	}
	// The knowledge base is re-read for its name only; access was already decided.
	kb, err := s.knowledgeBases.FindByID(ctx, session.KnowledgeBaseID)
	if err != nil {
		return nil, apperror.Internal(err)
	}
	if kb == nil {
		return nil, apperror.NotFound("RESOURCE_NOT_FOUND", "resource not found")
	}

	var builder strings.Builder
	title := strings.TrimSpace(session.Title)
	if title == "" {
		title = "未命名会话"
	}
	builder.WriteString("# " + title + "\n\n")
	names := []string{kb.Name}
	for _, link := range session.KnowledgeBaseLinks {
		names = append(names, link.KnowledgeBase.Name)
	}
	if session.IsAutomatic() {
		builder.WriteString("检索模式：自动（每轮重新检索）\n\n")
	}
	builder.WriteString("知识库：" + strings.Join(names, "、") + "\n\n")
	for i := range messages {
		label := "用户"
		if messages[i].Role == "assistant" {
			label = "助手"
		}
		builder.WriteString("## " + label + "\n\n")
		builder.WriteString(messages[i].Content)
		builder.WriteString("\n\n")
		if messages[i].Role == "assistant" {
			writeExportCitations(&builder, messages[i].Citations)
		}
	}
	return &ExportFile{
		Filename:    "chat-" + session.ID.String() + ".md",
		ContentType: "text/markdown; charset=utf-8",
		Content:     []byte(builder.String()),
	}, nil
}

func writeExportCitations(builder *strings.Builder, raw datatypes.JSON) {
	if len(raw) == 0 {
		return
	}
	var citations []dto.CitationResponse
	if err := json.Unmarshal(raw, &citations); err != nil || len(citations) == 0 {
		return
	}
	builder.WriteString("### 来源\n\n")
	for i := range citations {
		builder.WriteString(fmt.Sprintf("%d. %s", i+1, citations[i].Filename))
		if citations[i].KnowledgeBaseName != "" {
			builder.WriteString("（知识库：" + citations[i].KnowledgeBaseName + "）")
		}
		if citations[i].PageNumber != nil {
			builder.WriteString(fmt.Sprintf("（第 %d 页）", *citations[i].PageNumber))
		}
		if citations[i].TextSource == "ocr_corrected" {
			builder.WriteString("（人工校对 OCR 文本）")
		} else if citations[i].TextSource == "ocr" {
			builder.WriteString("（OCR 识别文本）")
		}
		if table := citations[i].Table; table != nil {
			name := table.SheetName
			if name == "" {
				name = "CSV"
			}
			rows := fmt.Sprint(table.RowStart)
			if table.RowEnd > table.RowStart {
				rows += fmt.Sprintf("–%d", table.RowEnd)
			}
			builder.WriteString(fmt.Sprintf("（%s，第 %s 行）", name, rows))
		}
		builder.WriteString("\n")
		if strings.TrimSpace(citations[i].Content) != "" {
			for _, line := range strings.Split(citations[i].Content, "\n") {
				builder.WriteString("   " + line + "\n")
			}
		}
	}
	builder.WriteString("\n")
}

func (s *ChatService) SendMessage(ctx context.Context, userID, sessionID uuid.UUID, req dto.SendChatMessageRequest) (*dto.SendChatMessageResponse, error) {
	session, err := s.authorizeWritableSession(ctx, userID, sessionID, access.CapChatUse)
	if err != nil {
		return nil, err
	}
	content := strings.TrimSpace(req.Content)
	if content == "" {
		return nil, apperror.Validation(map[string]any{"content": "content is required"})
	}
	clientRequestID, err := uuid.Parse(req.ClientRequestID)
	if err != nil {
		return nil, apperror.Validation(map[string]any{"clientRequestId": "client request id is invalid"})
	}

	existing, err := s.chats.FindMessagesByClientRequestID(ctx, session.ID, clientRequestID)
	if err != nil {
		return nil, apperror.Internal(err)
	}
	if len(existing) > 0 {
		return sendMessageResponseFromPair(clientRequestID, content, existing)
	}

	history, err := s.chats.ListMessages(ctx, session.ID)
	if err != nil {
		return nil, apperror.Internal(err)
	}

	generated, err := s.generateAnswer(ctx, userID, session, content, history)
	if err != nil {
		// The turn is recorded before the error is returned, so a refresh still shows
		// the question. The error is unchanged: the request did fail.
		if isRetrievalInfrastructureFailure(err) {
			if writeErr := s.recordRetrievalFailure(ctx, session, clientRequestID, content, history); writeErr != nil {
				return nil, writeErr
			}
		}
		return nil, err
	}

	userMessage, assistantMessage, err := buildChatMessagePair(session.ID, clientRequestID, content, generated)
	if err != nil {
		return nil, err
	}
	if err := s.chats.CreateMessagesWithTitleIfUnchanged(ctx, chatMessageIDs(history), session, firstQuestionSessionTitle(session, content, history), userMessage, assistantMessage); err != nil {
		existing, lookupErr := s.chats.FindMessagesByClientRequestID(ctx, session.ID, clientRequestID)
		if lookupErr == nil && len(existing) > 0 {
			return sendMessageResponseFromPair(clientRequestID, content, existing)
		}
		if errors.Is(err, repository.ErrChatMessageChanged) {
			return nil, apperror.New(http.StatusConflict, "CHAT_MESSAGE_CHANGED", "conversation changed while the answer was being generated")
		}
		return nil, chatWriteError(err)
	}
	s.attachUsageMessage(ctx, generated.usageRecordIDs, assistantMessage)

	return &dto.SendChatMessageResponse{
		ClientRequestID:  clientRequestID.String(),
		UserMessage:      toChatMessageResponse(userMessage),
		AssistantMessage: toChatMessageResponse(assistantMessage),
		Answer:           generated.answer,
		Citations:        generated.citations,
		RerankFallback:   generated.rerankFallback,
	}, nil
}

// ChatStreamSink receives the events of a streaming send, in order.
//
// Any method returning an error aborts generation. That is the disconnect path:
// the handler's writes fail once the client is gone, so generation stops instead
// of running to completion for nobody.
type ChatStreamSink interface {
	// Citations fires once, after retrieval and before any delta.
	Citations(citations []dto.CitationResponse) error
	Delta(text string) error
	// Done carries exactly the blocking endpoint's response body.
	Done(res *dto.SendChatMessageResponse) error
}

// SendMessageStream is the streaming twin of SendMessage. It reuses the same
// idempotency contract rather than paralleling it:
//
//   - the `(session_id, client_request_id, role)` partial unique index is still
//     the only thing enforcing "one assistant message per key";
//   - a replayed key with identical content replays the stored pair and calls no
//     provider at all;
//   - a replayed key with different content fails with IDEMPOTENCY_KEY_REUSED
//     before anything is emitted, so the handler can still answer 409.
//
// **Nothing is persisted until generation finishes.** An interrupted stream
// therefore leaves no trace, and the client reconciles by looking the
// clientRequestId up in the message list: absent means it is safe to resend with
// the same id. The alternative — storing the partial text — would put a
// truncated answer into the history that every later turn would then read as
// context. See docs/04-api-design.md (POST /chat/sessions/:id/messages/stream).
func (s *ChatService) SendMessageStream(
	ctx context.Context,
	userID, sessionID uuid.UUID,
	req dto.SendChatMessageRequest,
	sink ChatStreamSink,
) error {
	session, err := s.authorizeWritableSession(ctx, userID, sessionID, access.CapChatUse)
	if err != nil {
		return err
	}
	content := strings.TrimSpace(req.Content)
	if content == "" {
		return apperror.Validation(map[string]any{"content": "content is required"})
	}
	clientRequestID, err := uuid.Parse(req.ClientRequestID)
	if err != nil {
		return apperror.Validation(map[string]any{"clientRequestId": "client request id is invalid"})
	}

	// Checked before a single byte is emitted, so a conflict is still an HTTP
	// status rather than an event on an already-committed 200 stream.
	existing, err := s.chats.FindMessagesByClientRequestID(ctx, session.ID, clientRequestID)
	if err != nil {
		return apperror.Internal(err)
	}
	if len(existing) > 0 {
		res, err := sendMessageResponseFromPair(clientRequestID, content, existing)
		if err != nil {
			return err
		}
		if err := sink.Citations(res.Citations); err != nil {
			return err
		}
		return sink.Done(res)
	}

	history, err := s.chats.ListMessages(ctx, session.ID)
	if err != nil {
		return apperror.Internal(err)
	}

	generated, err := s.generateAnswerWithHooks(ctx, userID, session, content, history, answerHooks{
		onCitations: sink.Citations,
		onDelta:     sink.Delta,
	})
	if err != nil {
		// Same reasoning as the non-streaming path, and isRetrievalInfrastructureFailure
		// already excludes client disconnects: nothing is recorded when the reader
		// went away, matching this path's existing rule of persisting nothing on
		// interruption.
		if isRetrievalInfrastructureFailure(err) {
			if writeErr := s.recordRetrievalFailure(ctx, session, clientRequestID, content, history); writeErr != nil {
				return writeErr
			}
		}
		return err
	}
	// The provider may finish at the same moment the client disconnects. Check
	// cancellation once more before entering the persistence transaction so a
	// user-requested stop cannot commit a response that no longer has a reader.
	if err := ctx.Err(); err != nil {
		return err
	}

	userMessage, assistantMessage, err := buildChatMessagePair(session.ID, clientRequestID, content, generated)
	if err != nil {
		return err
	}
	if err := s.chats.CreateMessagesWithTitleIfUnchanged(ctx, chatMessageIDs(history), session, firstQuestionSessionTitle(session, content, history), userMessage, assistantMessage); err != nil {
		// A concurrent stream with the same key may have won the unique index.
		// Adopting its pair is what keeps "no second assistant message" true
		// under concurrency, not just under retry.
		stored, lookupErr := s.chats.FindMessagesByClientRequestID(ctx, session.ID, clientRequestID)
		if lookupErr == nil && len(stored) > 0 {
			res, pairErr := sendMessageResponseFromPair(clientRequestID, content, stored)
			if pairErr != nil {
				return pairErr
			}
			if generated.answer != res.Answer ||
				!reflect.DeepEqual(generated.citations, res.Citations) ||
				!reflect.DeepEqual(generated.rerankFallback, res.RerankFallback) {
				// Deltas are already visible, so finishing with another request's
				// stored answer would make one successful stream contradict itself.
				// Keep the outcome unknown; the client will adopt the stored pair
				// during clientRequestId reconciliation.
				return apperror.New(
					http.StatusInternalServerError,
					"CHAT_RESULT_UNCONFIRMED",
					"回答结果需要重新确认",
				)
			}
			return sink.Done(res)
		}
		if errors.Is(err, repository.ErrChatMessageChanged) {
			return apperror.New(http.StatusConflict, "CHAT_MESSAGE_CHANGED", "conversation changed while the answer was being generated")
		}
		return chatWriteError(err)
	}
	s.attachUsageMessage(ctx, generated.usageRecordIDs, assistantMessage)

	return sink.Done(&dto.SendChatMessageResponse{
		ClientRequestID:  clientRequestID.String(),
		UserMessage:      toChatMessageResponse(userMessage),
		AssistantMessage: toChatMessageResponse(assistantMessage),
		Answer:           generated.answer,
		Citations:        generated.citations,
		RerankFallback:   generated.rerankFallback,
	})
}

// buildChatMessagePair is shared by both send paths so the persisted shape — and
// with it the idempotency key — cannot drift between them.
func buildChatMessagePair(
	sessionID, clientRequestID uuid.UUID,
	content string,
	generated generatedChatAnswer,
) (*model.ChatMessage, *model.ChatMessage, error) {
	userMessage := &model.ChatMessage{
		SessionID:       sessionID,
		ClientRequestID: &clientRequestID,
		Role:            "user",
		Content:         content,
	}
	assistantMessage, err := newAssistantMessage(sessionID, &clientRequestID, generated)
	if err != nil {
		return nil, nil, err
	}
	return userMessage, assistantMessage, nil
}

// newAssistantMessage builds the stored row for a generated answer.
//
// Every path that persists an answer goes through it -- send, edit, regenerate
// and the failure recorder -- so no path can drop a recorded field. Regenerate
// used to build the row by hand and silently omitted rerank_fallback: the
// response said the fallback was used while the stored message and every later
// read of it said null. clientRequestID stays nil for a regeneration, which is
// what keeps regenerations out of repeated-rewrite clustering.
func newAssistantMessage(
	sessionID uuid.UUID,
	clientRequestID *uuid.UUID,
	generated generatedChatAnswer,
) (*model.ChatMessage, error) {
	assistantMessage := &model.ChatMessage{
		SessionID:       sessionID,
		ClientRequestID: clientRequestID,
		Role:            "assistant",
		Content:         generated.answer,
		Citations:       generated.citationJSON,
	}
	if generated.rerankFallback != nil {
		fallbackJSON, err := json.Marshal(generated.rerankFallback)
		if err != nil {
			return nil, apperror.Internal(err)
		}
		assistantMessage.RerankFallback = datatypes.JSON(fallbackJSON)
	}
	applyGeneratedProvenance(assistantMessage, generated)
	return assistantMessage, nil
}

// applyGeneratedProvenance records which intent produced an answer, whether the
// answer succeeded, and for knowledge answers the canonical query retrieval ran.
//
// Shared by the send paths and by regenerate so an answer's intent is recorded
// the same way regardless of how it was produced. Every field stays nil when
// unknown: a NULL intent means "written before this was tracked", and quality
// metrics scope on intent precisely so they can exclude those rows instead of
// silently counting them as something they are not.
func applyGeneratedProvenance(message *model.ChatMessage, generated generatedChatAnswer) {
	if generated.intent != "" {
		intent := generated.intent
		message.Intent = &intent
	}
	if generated.answerStatus != "" {
		answerStatus := generated.answerStatus
		message.AnswerStatus = &answerStatus
	}
	retrievalQuery := strings.TrimSpace(generated.retrievalQuery)
	if retrievalQuery == "" {
		return
	}
	message.RetrievalQuery = &retrievalQuery
	if norm := normalizeRetrievalQuery(retrievalQuery); norm != "" {
		message.RetrievalQueryNorm = &norm
	}
}

func sendMessageResponseFromPair(clientRequestID uuid.UUID, content string, messages []model.ChatMessage) (*dto.SendChatMessageResponse, error) {
	var userMessage *model.ChatMessage
	var assistantMessage *model.ChatMessage
	for i := range messages {
		switch messages[i].Role {
		case "user":
			userMessage = &messages[i]
		case "assistant":
			assistantMessage = &messages[i]
		}
	}
	if userMessage == nil || assistantMessage == nil {
		return nil, apperror.Internal(fmt.Errorf("incomplete chat message pair for client request %s", clientRequestID))
	}
	if userMessage.Content != content {
		return nil, apperror.New(http.StatusConflict, "IDEMPOTENCY_KEY_REUSED", "clientRequestId has already been used with different content")
	}

	assistantResponse := toChatMessageResponse(assistantMessage)
	var fallback *dto.RerankFallbackResponse
	if len(assistantMessage.RerankFallback) > 0 {
		var stored dto.RerankFallbackResponse
		if err := json.Unmarshal(assistantMessage.RerankFallback, &stored); err != nil {
			return nil, apperror.Internal(err)
		}
		fallback = &stored
	}
	return &dto.SendChatMessageResponse{
		ClientRequestID:  clientRequestID.String(),
		UserMessage:      toChatMessageResponse(userMessage),
		AssistantMessage: assistantResponse,
		Answer:           assistantMessage.Content,
		Citations:        assistantResponse.Citations,
		RerankFallback:   fallback,
	}, nil
}

func (s *ChatService) RegenerateMessage(ctx context.Context, userID, sessionID, messageID uuid.UUID) (*dto.RegenerateChatMessageResponse, error) {
	session, err := s.authorizeWritableSession(ctx, userID, sessionID, access.CapChatUse)
	if err != nil {
		return nil, err
	}

	messages, err := s.chats.ListMessages(ctx, session.ID)
	if err != nil {
		return nil, apperror.Internal(err)
	}

	targetIndex := -1
	for i := range messages {
		if messages[i].ID == messageID {
			targetIndex = i
			break
		}
	}
	if targetIndex < 0 {
		return nil, apperror.NotFound("RESOURCE_NOT_FOUND", "resource not found")
	}
	if messages[targetIndex].Role != "assistant" {
		return nil, apperror.Validation(map[string]any{"messageId": "only assistant messages can be regenerated"})
	}
	// Answers are grouped by the preceding user turn. Appending a version of an
	// earlier turn would attach it to a different question. Older versions of
	// the final turn remain valid targets.
	for _, message := range messages[targetIndex+1:] {
		if message.Role == "user" {
			return nil, apperror.New(http.StatusConflict, "CHAT_MESSAGE_CHANGED", "a newer question exists; reload the conversation before regenerating")
		}
	}

	userIndex := -1
	for i := targetIndex - 1; i >= 0; i-- {
		if messages[i].Role == "user" && strings.TrimSpace(messages[i].Content) != "" {
			userIndex = i
			break
		}
	}
	if userIndex < 0 {
		return nil, apperror.Validation(map[string]any{"messageId": "assistant message has no previous user message"})
	}

	question := messages[userIndex].Content
	history := append([]model.ChatMessage(nil), messages[:userIndex]...)
	generated, err := s.generateAnswer(ctx, userID, session, question, history)
	if err != nil {
		return nil, err
	}

	assistantMessage, err := newAssistantMessage(session.ID, nil, generated)
	if err != nil {
		return nil, err
	}
	if err := s.chats.CreateMessagesIfUnchanged(ctx, chatMessageIDs(messages), assistantMessage); err != nil {
		if errors.Is(err, repository.ErrChatMessageChanged) {
			return nil, apperror.New(http.StatusConflict, "CHAT_MESSAGE_CHANGED", "conversation changed while the answer was being regenerated")
		}
		return nil, chatWriteError(err)
	}
	s.attachUsageMessage(ctx, generated.usageRecordIDs, assistantMessage)

	return &dto.RegenerateChatMessageResponse{
		Message:        toChatMessageResponse(assistantMessage),
		RerankFallback: generated.rerankFallback,
	}, nil
}

// EditMessageAndRegenerate replaces a user turn and its descendants in one
// repository transaction. AI generation intentionally happens first so a
// provider failure cannot destroy the existing conversation.
func (s *ChatService) EditMessageAndRegenerate(
	ctx context.Context,
	userID, sessionID, messageID uuid.UUID,
	req dto.EditChatMessageRequest,
) (*dto.SendChatMessageResponse, error) {
	session, err := s.authorizeWritableSession(ctx, userID, sessionID, access.CapChatUse)
	if err != nil {
		return nil, err
	}
	content := strings.TrimSpace(req.Content)
	if content == "" {
		return nil, apperror.Validation(map[string]any{"content": "content is required"})
	}
	clientRequestID, err := uuid.Parse(req.ClientRequestID)
	if err != nil {
		return nil, apperror.Validation(map[string]any{"clientRequestId": "client request id is invalid"})
	}

	// A retry after a lost response must replay the already committed pair and
	// must not run retrieval or mutate the conversation a second time.
	existing, err := s.chats.FindMessagesByClientRequestID(ctx, session.ID, clientRequestID)
	if err != nil {
		return nil, apperror.Internal(err)
	}
	if len(existing) > 0 {
		return sendMessageResponseFromPair(clientRequestID, content, existing)
	}

	messages, err := s.chats.ListMessages(ctx, session.ID)
	if err != nil {
		return nil, apperror.Internal(err)
	}
	targetIndex := -1
	for i := range messages {
		if messages[i].ID == messageID {
			targetIndex = i
			break
		}
	}
	if targetIndex < 0 {
		return nil, apperror.NotFound("RESOURCE_NOT_FOUND", "resource not found")
	}
	if messages[targetIndex].Role != "user" {
		return nil, apperror.Validation(map[string]any{"messageId": "only user messages can be edited"})
	}

	history := append([]model.ChatMessage(nil), messages[:targetIndex]...)
	generated, err := s.generateAnswer(ctx, userID, session, content, history)
	if err != nil {
		return nil, err
	}
	userMessage, assistantMessage, err := buildChatMessagePair(session.ID, clientRequestID, content, generated)
	if err != nil {
		return nil, err
	}
	userMessage.ID = messages[targetIndex].ID
	userMessage.CreatedAt = messages[targetIndex].CreatedAt
	removeIDs := make([]uuid.UUID, 0, len(messages)-targetIndex-1)
	for i := targetIndex + 1; i < len(messages); i++ {
		removeIDs = append(removeIDs, messages[i].ID)
	}
	if err := s.chats.ReplaceMessageTail(ctx, session.ID, messageID, messages[targetIndex].ClientRequestID, removeIDs, userMessage, assistantMessage); err != nil {
		stored, lookupErr := s.chats.FindMessagesByClientRequestID(ctx, session.ID, clientRequestID)
		if lookupErr == nil && len(stored) > 0 {
			return sendMessageResponseFromPair(clientRequestID, content, stored)
		}
		if errors.Is(err, repository.ErrChatMessageNotFound) {
			return nil, apperror.NotFound("RESOURCE_NOT_FOUND", "resource not found")
		}
		if errors.Is(err, repository.ErrChatMessageChanged) {
			return nil, apperror.New(http.StatusConflict, "CHAT_MESSAGE_CHANGED", "conversation changed while the message was being edited")
		}
		return nil, chatWriteError(err)
	}
	s.attachUsageMessage(ctx, generated.usageRecordIDs, assistantMessage)
	return &dto.SendChatMessageResponse{
		ClientRequestID:  clientRequestID.String(),
		UserMessage:      toChatMessageResponse(userMessage),
		AssistantMessage: toChatMessageResponse(assistantMessage),
		Answer:           generated.answer,
		Citations:        generated.citations,
		RerankFallback:   generated.rerankFallback,
	}, nil
}

func chatMessageIDs(messages []model.ChatMessage) []uuid.UUID {
	ids := make([]uuid.UUID, 0, len(messages))
	for i := range messages {
		ids = append(ids, messages[i].ID)
	}
	return ids
}

type generatedChatAnswer struct {
	answer         string
	citations      []dto.CitationResponse
	citationJSON   datatypes.JSON
	rerankFallback *dto.RerankFallbackResponse
	// intent is the classification this turn was routed on. retrievalQuery is the
	// canonical question actually sent to retrieval, set only for
	// knowledge_base intent. Both are persisted so quality metrics can tell a
	// knowledge answer with no sources apart from a conversation answer that
	// correctly has none.
	intent         string
	retrievalQuery string
	// answerStatus tells the three "could not answer" outcomes apart. See
	// chat_answer_status.go: they look identical to the user but need different
	// responses, and only the server knows which one happened.
	answerStatus string
	// usageRecordIDs are the model_usage_records written while generating this
	// answer. They are created before the assistant message exists, so the
	// persistence sites attach the message id afterwards.
	usageRecordIDs []uuid.UUID
}

// answerHooks lets the streaming path observe generation without forking it.
//
// Both hooks are optional; with neither set generateAnswer behaves exactly as
// the blocking path always has. Keeping one implementation matters for the
// citation rule: citations must come only from the chunks that went into this
// turn's prompt, and a second code path is the obvious way for that to drift.
type answerHooks struct {
	// Evaluations supply a snapshot without mutating the knowledge base defaults.
	retrievalConfig *dto.RetrievalConfig
	// answerConfig is the answer configuration snapshot an evaluation run was
	// started with. nil means "read the knowledge base's current config".
	answerConfig *dto.AnswerConfig
	// onCitations fires once retrieval has settled, before any answer text
	// exists, because the citations are an input to the prompt rather than a
	// product of the completion.
	onCitations func([]dto.CitationResponse) error
	onDelta     func(string) error
}

func (s *ChatService) generateAnswer(ctx context.Context, userID uuid.UUID, session *model.ChatSession, question string, history []model.ChatMessage) (generatedChatAnswer, error) {
	return s.generateAnswerWithHooks(ctx, userID, session, question, history, answerHooks{})
}

// complete runs the chat provider, streaming when both the provider supports it
// and the caller wants deltas. The returned answer is authoritative either way.
//
// The returned duration is first-token latency, and is zero unless the provider
// genuinely streamed. A non-streaming provider's single synthetic delta arrives
// only once the whole completion is done, so counting it would record generation
// time under a metric operators read as "time until the user sees something".
func (s *ChatService) complete(ctx context.Context, messages []chatcore.Message, onDelta func(string) error) (string, time.Duration, chatcore.Usage, error) {
	return s.completeWithOptions(ctx, messages, onDelta, chatcore.Options{})
}

func (s *ChatService) completeWithOptions(ctx context.Context, messages []chatcore.Message, onDelta func(string) error, options chatcore.Options) (string, time.Duration, chatcore.Usage, error) {
	start := time.Now()
	if onDelta != nil {
		if reporter, ok := s.chatProvider.(chatcore.StreamingOptionsProvider); ok {
			var firstToken time.Duration
			started := false
			answer, usage, err := reporter.ChatStreamWithOptions(ctx, messages, func(delta string) error {
				if !started {
					started = true
					firstToken = time.Since(start)
					s.metrics.ObserveDuration(ctx, observability.MetricChatFirstToken, firstToken)
				}
				return onDelta(delta)
			}, options)
			s.metrics.RecordProviderResult(ctx, observability.ProviderChat, err)
			return answer, firstToken, usage, err
		}
		if reporter, ok := s.chatProvider.(chatcore.StreamingUsageProvider); ok {
			var firstToken time.Duration
			started := false
			answer, usage, err := reporter.ChatStreamWithUsage(ctx, messages, func(delta string) error {
				if !started {
					started = true
					firstToken = time.Since(start)
					s.metrics.ObserveDuration(ctx, observability.MetricChatFirstToken, firstToken)
				}
				return onDelta(delta)
			})
			s.metrics.RecordProviderResult(ctx, observability.ProviderChat, err)
			return answer, firstToken, usage, err
		}
		if streamer, ok := s.chatProvider.(chatcore.StreamingProvider); ok {
			var firstToken time.Duration
			observedFirstToken := false
			answer, err := streamer.ChatStream(ctx, messages, func(delta string) error {
				// A fast callback can have zero elapsed time on a coarse clock.
				// Duration is a measurement, not a reliable "not observed" flag.
				if !observedFirstToken {
					observedFirstToken = true
					firstToken = time.Since(start)
					s.metrics.ObserveDuration(ctx, observability.MetricChatFirstToken, firstToken)
				}
				return onDelta(delta)
			})
			s.metrics.RecordProviderResult(ctx, observability.ProviderChat, err)
			return answer, firstToken, chatcore.Usage{}, err
		}
	}
	var answer string
	var usage chatcore.Usage
	var err error
	if reporter, ok := s.chatProvider.(chatcore.OptionsProvider); ok {
		answer, usage, err = reporter.ChatWithOptions(ctx, messages, options)
	} else if reporter, ok := s.chatProvider.(chatcore.UsageProvider); ok {
		answer, usage, err = reporter.ChatWithUsage(ctx, messages)
	} else {
		answer, err = s.chatProvider.Chat(ctx, messages)
	}
	s.metrics.RecordProviderResult(ctx, observability.ProviderChat, err)
	if err != nil {
		return "", 0, usage, err
	}
	// A non-streaming provider still has to look like a stream to the client, so
	// the whole answer is delivered as a single delta.
	if onDelta != nil && answer != "" {
		if err := onDelta(answer); err != nil {
			return "", 0, usage, err
		}
	}
	return answer, 0, usage, nil
}

func (s *ChatService) generateAnswerWithHooks(
	ctx context.Context,
	userID uuid.UUID,
	session *model.ChatSession,
	question string,
	history []model.ChatMessage,
	hooks answerHooks,
) (generated generatedChatAnswer, retErr error) {
	ctx, span := observability.Start(ctx, "rag.answer", attribute.String("chat.session_id", session.ID.String()))
	defer func() {
		span.SetAttributes(attribute.String("rag.answer_status", generated.answerStatus), attribute.String("rag.intent", generated.intent), attribute.Int("rag.citation_count", len(generated.citations)))
		observability.Finish(span, retErr)
	}()
	if _, err := s.validateSessionDocuments(ctx, session); err != nil {
		return generatedChatAnswer{}, err
	}
	generationStart := time.Now()
	timing := observability.ChatTiming{}
	// Recorded on every exit path, including failures: how long a broken provider
	// takes to fail is exactly what an operator needs during an incident.
	defer func() {
		timing.Generation = time.Since(generationStart)
		if timing.FirstToken > 0 {
			span.SetAttributes(attribute.Float64("chat.model_first_token_ms", float64(timing.FirstToken)/float64(time.Millisecond)))
		}
		span.SetAttributes(attribute.Bool("rag.rerank_fallback", timing.RerankFallback))
		s.metrics.ObserveDuration(ctx, observability.MetricChatGeneration, timing.Generation)
		s.metrics.RecordChatTiming(ctx, timing)
	}()

	// Classification is itself a chat provider call, and it is the first one to
	// break when the provider is down, so its outcome is recorded too. Without
	// this the diagnostics page would report zero provider failures during an
	// outage that fails every question before generation is even reached.
	intentStart := time.Now()
	intent, intentUsage, err := classifyChatIntentWithUsage(ctx, s.chatProvider, question, history, s.cfg.ChatHistoryLimit)
	s.metrics.RecordProviderResult(ctx, observability.ProviderChat, err)
	var usageRecords []uuid.UUID
	if err != nil {
		return generatedChatAnswer{}, apperror.Wrap(500, "CHAT_COMPLETION_FAILED", "回答生成失败，请稍后重试", err)
	}
	usageRecords = appendUsageRecord(usageRecords, s.recordUsage(ctx, userID, session, "intent", intentUsage, time.Since(intentStart)))
	timing.Intent = intent.Intent

	if intent.Intent == chatIntentConversation || intent.Intent == chatIntentGeneral {
		citations := []dto.CitationResponse{}
		if hooks.onCitations != nil {
			// Announced even when empty: "this answer has no sources" is
			// information the client can act on immediately.
			if err := hooks.onCitations(citations); err != nil {
				return generatedChatAnswer{}, err
			}
		}
		messages := buildConversationAnswerMessages(question, history, s.cfg.ChatHistoryLimit)
		if intent.Intent == chatIntentGeneral {
			messages = buildGeneralAnswerMessages(question, history, s.cfg.ChatHistoryLimit)
		}
		answerStart := time.Now()
		answer, firstToken, usage, err := s.complete(ctx, messages, hooks.onDelta)
		timing.FirstToken = firstToken
		if err != nil {
			s.recordSpentUsage(ctx, userID, session, "answer", usage, time.Since(answerStart))
			return generatedChatAnswer{}, chatCompletionError(err)
		}
		usageRecords = appendUsageRecord(usageRecords, s.recordUsage(ctx, userID, session, "answer", usage, time.Since(answerStart)))
		citationJSON, err := json.Marshal(citations)
		if err != nil {
			return generatedChatAnswer{}, apperror.Internal(err)
		}
		if session.IsAutomatic() || len(session.KnowledgeBaseLinks) > 0 {
			if err := s.authorizeSessionKnowledgeBase(ctx, userID, session, access.CapChatUse); err != nil {
				return generatedChatAnswer{}, err
			}
		}
		return generatedChatAnswer{
			answer:       answer,
			citations:    citations,
			citationJSON: datatypes.JSON(citationJSON),
			intent:       intent.Intent,
			// Answered, not no_basis: a turn that never needs sources correctly has
			// none, and counting greetings or general questions as knowledge gaps
			// would fill the gap list with them.
			answerStatus: AnswerStatusAnswered,
			// No retrievalQuery: these turns never reach retrieval, and an empty
			// one keeps them out of rewrite clustering entirely.
			usageRecordIDs: usageRecords,
		}, nil
	}

	if s.retrieval == nil {
		return generatedChatAnswer{}, apperror.New(500, "INTERNAL_ERROR", "retrieval service is not configured")
	}

	retrievalQuery := strings.TrimSpace(intent.StandaloneQuery)
	if retrievalQuery == "" {
		retrievalQuery = question
	}

	// Retrieval records its own metric internally; this measurement exists so the
	// per-request summary line can attribute the split between retrieval and
	// generation without reading the aggregate.
	retrievalStart := time.Now()
	searchRequest := dto.SearchRequest{Query: retrievalQuery}
	if override := hooks.retrievalConfig; override != nil {
		searchRequest.VectorTopN, searchRequest.RerankTopK = override.VectorTopN, override.RerankTopK
		searchRequest.EnableRerank, searchRequest.ScoreThreshold = &override.EnableRerank, &override.ScoreThreshold
		searchRequest.EnableKeyword = &override.EnableKeyword
	}
	searchRes, err := s.searchSession(ctx, userID, session, searchRequest)
	timing.Retrieval = time.Since(retrievalStart)
	if err != nil {
		return generatedChatAnswer{}, err
	}
	timing.RerankFallback = searchRes.RerankFallback != nil && searchRes.RerankFallback.Used

	if session.IsAutomatic() || len(session.KnowledgeBaseLinks) > 0 {
		if err := s.authorizeSessionKnowledgeBase(ctx, userID, session, access.CapChatUse); err != nil {
			return generatedChatAnswer{}, err
		}
	}
	citations := citationsFromSearch(searchRes.Items)
	if hooks.onCitations != nil {
		if err := hooks.onCitations(citations); err != nil {
			return generatedChatAnswer{}, err
		}
	}

	answer := "当前知识库中未找到足够依据回答该问题。"
	// no_basis by default: retrieval succeeded and returned nothing usable, which
	// is a real statement about the knowledge base rather than a failure.
	answerStatus := AnswerStatusNoBasis
	answerConfig := s.turnAnswerConfig(ctx, session, searchRes.Items, hooks.answerConfig)
	// A base that allows general knowledge has said it prefers a labelled answer
	// over a bare refusal, so an empty result still reaches the model. Every other
	// turn stops at the refusal and never pays for a generation call.
	answerWithoutEvidence := len(searchRes.Items) == 0 && answerConfig.AllowGeneralKnowledge
	if len(searchRes.Items) > 0 || answerWithoutEvidence {
		var firstToken time.Duration
		// Streamed through the gate so the marker is never shown to the user. The
		// gate holds back at most the marker's own length before deciding.
		gate := newRefusalGate(hooks.onDelta)
		var streamHook func(string) error
		if hooks.onDelta != nil {
			streamHook = gate.write
		}
		var usage chatcore.Usage
		answerStart := time.Now()
		_, promptSpan := observability.Start(ctx, "rag.prompt", attribute.Int("rag.context_chunk_count", len(searchRes.Items)))
		messages := buildAnswerMessagesWithConfig(question, searchRes.Items, history, s.cfg.ChatHistoryLimit, answerConfig)
		promptSpan.End()
		answer, firstToken, usage, err = s.completeWithOptions(ctx, messages, streamHook, chatcore.Options{Model: answerConfig.Model, Temperature: answerConfig.Temperature})
		timing.FirstToken = firstToken
		if err != nil {
			s.recordSpentUsage(ctx, userID, session, "answer", usage, time.Since(answerStart))
			return generatedChatAnswer{}, chatCompletionError(err)
		}
		usageRecords = appendUsageRecord(usageRecords, s.recordUsage(ctx, userID, session, "answer", usage, time.Since(answerStart)))
		if hooks.onDelta != nil {
			if err := gate.flush(); err != nil {
				return generatedChatAnswer{}, err
			}
		}
		// The marker is stripped from the stored answer too, so history and a
		// re-read of the session show the same text the user saw streamed.
		var refused bool
		answer, refused = stripRefusalMarker(answer)
		if refused {
			answerStatus = AnswerStatusModelRefused
		} else {
			answerStatus = AnswerStatusAnswered
		}
	} else if hooks.onDelta != nil {
		// The refusal below never reaches the provider, so no first-token latency is
		// recorded for it. Averaging a locally generated string into that metric
		// would make it look best exactly when retrieval is failing.
		// The refusal never reaches the provider, so stream it explicitly rather
		// than letting the client sit on an empty answer until `done`.
		if err := hooks.onDelta(answer); err != nil {
			return generatedChatAnswer{}, err
		}
	}

	citationJSON, err := json.Marshal(citations)
	if err != nil {
		return generatedChatAnswer{}, apperror.Internal(err)
	}

	if session.IsAutomatic() || len(session.KnowledgeBaseLinks) > 0 {
		if err := s.authorizeSessionKnowledgeBase(ctx, userID, session, access.CapChatUse); err != nil {
			return generatedChatAnswer{}, err
		}
	}
	if _, err := s.validateSessionDocuments(ctx, session); err != nil {
		return generatedChatAnswer{}, err
	}
	return generatedChatAnswer{
		answer:         answer,
		citations:      citations,
		citationJSON:   datatypes.JSON(citationJSON),
		rerankFallback: searchRes.RerankFallback,
		intent:         chatIntentKnowledgeBase,
		retrievalQuery: retrievalQuery,
		answerStatus:   answerStatus,
		usageRecordIDs: usageRecords,
	}, nil
}

// chatCompletionError keeps a sink or context failure distinguishable from a
// genuine provider failure: the former means the client went away, and dressing
// it up as CHAT_COMPLETION_FAILED would tell the user their question failed when
// it was their connection that did.
func chatCompletionError(err error) error {
	var appErr *apperror.Error
	if errors.As(err, &appErr) {
		return err
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return err
	}
	return apperror.Wrap(500, "CHAT_COMPLETION_FAILED", "回答生成失败，请稍后重试", err)
}

func firstQuestionSessionTitle(session *model.ChatSession, question string, history []model.ChatMessage) string {
	if !shouldGenerateSessionTitle(session.Title) {
		return ""
	}
	for _, message := range history {
		if message.Role == "user" {
			return ""
		}
	}
	// Name the accepted first question directly, without another model call.
	return truncateRunes(strings.Join(strings.Fields(question), " "), 29)
}

func shouldGenerateSessionTitle(title string) bool {
	title = strings.TrimSpace(title)
	return title == "" || title == defaultChatSessionTitle
}

func toChatSessionResponse(session *model.ChatSession) dto.ChatSessionResponse {
	documents, _ := sessionDocuments(session)
	var sourceSession, sourceMessage *string
	if session.BranchFromSessionID != nil {
		value := session.BranchFromSessionID.String()
		sourceSession = &value
	}
	if session.BranchFromMessageID != nil {
		value := session.BranchFromMessageID.String()
		sourceMessage = &value
	}
	ids := make([]string, 0, 1+len(session.KnowledgeBaseLinks))
	for _, id := range session.KnowledgeBaseIDs() {
		ids = append(ids, id.String())
	}
	bases := []dto.ChatKnowledgeBaseResponse{{ID: session.KnowledgeBaseID.String(), Name: session.KnowledgeBase.Name}}
	for _, link := range session.KnowledgeBaseLinks {
		bases = append(bases, dto.ChatKnowledgeBaseResponse{ID: link.KnowledgeBaseID.String(), Name: link.KnowledgeBase.Name})
	}
	return dto.ChatSessionResponse{
		Documents:           documents,
		BranchFromSessionID: sourceSession, BranchFromMessageID: sourceMessage,
		ScopeMode:        chatScopeMode(session),
		KnowledgeBaseIDs: ids, KnowledgeBases: bases,
		ID:              session.ID.String(),
		KnowledgeBaseID: session.KnowledgeBaseID.String(),
		Title:           session.Title,
		CreatedAt:       session.CreatedAt,
		UpdatedAt:       session.UpdatedAt,
		ArchivedAt:      session.ArchivedAt,
	}
}

func toChatMessageResponse(message *model.ChatMessage) dto.ChatMessageResponse {
	citations := []dto.CitationResponse{}
	if len(message.Citations) > 0 {
		_ = json.Unmarshal(message.Citations, &citations)
	}
	var clientRequestID *string
	if message.ClientRequestID != nil {
		value := message.ClientRequestID.String()
		clientRequestID = &value
	}
	var feedback *dto.ChatMessageFeedbackResponse
	if message.FeedbackRating != nil && message.FeedbackUpdatedAt != nil {
		feedback = &dto.ChatMessageFeedbackResponse{
			ChatFeedbackDetails: dto.ChatFeedbackDetails{Reason: message.FeedbackReason, Comment: message.FeedbackComment},
			MessageID:           message.ID.String(),
			Rating:              *message.FeedbackRating,
			UpdatedAt:           *message.FeedbackUpdatedAt,
		}
	}
	return dto.ChatMessageResponse{
		ID:              message.ID.String(),
		SessionID:       message.SessionID.String(),
		ClientRequestID: clientRequestID,
		Role:            message.Role,
		Content:         message.Content,
		Citations:       citations,
		Feedback:        feedback,
		Bookmark:        bookmarkResponse(message.Bookmark),
		CreatedAt:       message.CreatedAt,
		AnswerStatus:    message.AnswerStatus,
	}
}

func citationsFromSearch(items []dto.SearchResultResponse) []dto.CitationResponse {
	citations := make([]dto.CitationResponse, 0, len(items))
	for _, item := range items {
		citations = append(citations, dto.CitationResponse{
			TextSource:        item.TextSource,
			Table:             item.Table,
			KnowledgeBaseID:   item.KnowledgeBaseID,
			KnowledgeBaseName: item.KnowledgeBaseName,
			DocumentID:        item.DocumentID,
			ChunkID:           item.ChunkID,
			Filename:          item.Filename,
			PageNumber:        item.PageNumber,
			Content:           item.Content,
			VectorScore:       item.VectorScore,
			RerankScore:       item.RerankScore,
			StartOffset:       item.StartOffset,
			EndOffset:         item.EndOffset,
		})
	}
	return citations
}

func systemPrompt() string {
	return systemPromptForConfig(dto.AnswerConfig{AnswerLanguage: "auto"})
}

func systemPromptForConfig(config dto.AnswerConfig) string {
	rules := []string{
		"你是企业知识库问答助手。",
		"只能基于提供的知识片段回答问题。",
		"可以参考历史对话理解用户当前问题中的代词、省略和上下文。",
		"历史对话不能替代知识片段作为事实依据。",
		"引用来源只能来自本轮提供的知识片段。",
		"如果知识片段不足以回答，请明确说明无法从当前知识库确认。",
		"不要编造事实，不要编造引用来源。",
	}
	if config.AllowGeneralKnowledge {
		rules[1] = "优先基于知识片段回答，片段不足时可补充常识并明确标注。"
	}
	rules = append(rules, groundingPromptRules(config.AllowGeneralKnowledge)...)
	if addition := strings.TrimSpace(config.SystemPromptAddition); addition != "" {
		rules = append(rules, "以下补充要求仅在不违反上述依据、引用和资料不足规则时生效。", "知识库回答补充要求：\n"+addition)
	}
	if config.AnswerLanguage == "zh" {
		rules = append(rules, "请使用中文回答。")
	}
	if config.AnswerLanguage == "en" {
		rules = append(rules, "Please answer in English.")
	}
	return strings.Join(append(rules, refusalPromptRules()...), "\n")
}

func classifyChatIntent(ctx context.Context, provider chatcore.Provider, question string, history []model.ChatMessage, historyLimit int) (chatIntentDecision, error) {
	decision, _, err := classifyChatIntentWithUsage(ctx, provider, question, history, historyLimit)
	return decision, err
}

func classifyChatIntentWithUsage(ctx context.Context, provider chatcore.Provider, question string, history []model.ChatMessage, historyLimit int) (decisionResult chatIntentDecision, spent chatcore.Usage, retErr error) {
	ctx, span := observability.Start(ctx, "rag.intent")
	defer func() { observability.Finish(span, retErr) }()
	var raw string
	var usage chatcore.Usage
	var err error
	messages := buildIntentClassificationMessages(question, history, historyLimit)
	if reporter, ok := provider.(chatcore.UsageProvider); ok {
		raw, usage, err = reporter.ChatWithUsage(ctx, messages)
	} else {
		raw, err = provider.Chat(ctx, messages)
	}
	if err != nil {
		return chatIntentDecision{}, usage, err
	}
	return parseChatIntentOutput(raw, question), usage, nil
}

// usageProviderName is what model_usage_records.provider carries. The
// configured MODEL_PROVIDER is the closest thing to a vendor name the server
// knows; the model column carries the concrete model.
func (s *ChatService) usageProviderName() string {
	if provider := strings.TrimSpace(s.cfg.ModelProvider); provider != "" {
		return provider
	}
	return "openai_compatible"
}

// recordUsage persists one model call. It returns the record id (uuid.Nil when
// nothing was written) so callers can attach the assistant message later.
//
// An evaluation run passes a session with a Nil id: those records carry no
// session, since a zero UUID would violate the foreign key and the row would be
// silently lost.
func (s *ChatService) recordUsage(ctx context.Context, userID uuid.UUID, session *model.ChatSession, purpose string, usage chatcore.Usage, latency time.Duration) uuid.UUID {
	if s.usage == nil || session == nil {
		return uuid.Nil
	}
	if session.ID == uuid.Nil && purpose == "answer" {
		purpose = "evaluation"
	}
	record := &model.ModelUsageRecord{
		ID:               uuid.New(),
		UserID:           userID,
		KnowledgeBaseID:  session.KnowledgeBaseID,
		Purpose:          purpose,
		Provider:         s.usageProviderName(),
		Model:            usage.Model,
		PromptTokens:     usageTokenValue(usage.PromptTokens, usage.Reported),
		CompletionTokens: usageTokenValue(usage.CompletionTokens, usage.Reported),
		TotalTokens:      usageTokenValue(usage.TotalTokens, usage.Reported),
		LatencyMs:        durationMillis(latency),
	}
	if record.Model == "" {
		// A provider that omits the model name still spent tokens; record the
		// configured model rather than dropping the row.
		record.Model = s.cfg.ChatModel
	}
	if session.ID != uuid.Nil {
		sessionID := session.ID
		record.SessionID = &sessionID
	}
	return s.persistUsage(ctx, record)
}

// persistUsage writes with a context detached from the request: a client that
// disconnects the instant the stream finishes must not erase the bill for the
// tokens that were already spent. Failures are logged, not swallowed.
func (s *ChatService) persistUsage(ctx context.Context, record *model.ModelUsageRecord) uuid.UUID {
	writeCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	if err := s.usage.Create(writeCtx, record); err != nil {
		if log := s.metrics.Logger(ctx); log != nil {
			log.Warn("model usage record not written", zap.String("purpose", record.Purpose), zap.Error(err))
		}
		return uuid.Nil
	}
	return record.ID
}

// attachUsageMessage backfills message_id once the assistant message has an id.
func (s *ChatService) attachUsageMessage(ctx context.Context, recordIDs []uuid.UUID, message *model.ChatMessage) {
	if s.usage == nil || message == nil || message.ID == uuid.Nil || len(recordIDs) == 0 {
		return
	}
	writeCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	if err := s.usage.AttachMessage(writeCtx, recordIDs, message.ID); err != nil {
		if log := s.metrics.Logger(ctx); log != nil {
			log.Warn("model usage records not linked to message", zap.Error(err))
		}
	}
}

func appendUsageRecord(ids []uuid.UUID, id uuid.UUID) []uuid.UUID {
	if id == uuid.Nil {
		return ids
	}
	return append(ids, id)
}

// recordSpentUsage bills a failed generation when the provider still reported
// usage.
//
// A stream can fail after the provider already answered: a downgraded blocking
// fallback whose onDelta failed, or a decode error after a partial response.
// Those tokens are spent, and dropping the record because the turn failed would
// erase the bill. Nothing is written when usage was never reported.
func (s *ChatService) recordSpentUsage(ctx context.Context, userID uuid.UUID, session *model.ChatSession, purpose string, usage chatcore.Usage, latency time.Duration) {
	if !usage.Reported {
		return
	}
	s.recordUsage(ctx, userID, session, purpose, usage, latency)
}

// usageTokenValue keeps a reported 0 as a real count and stores NULL when the
// provider never reported usage. An OpenAI-compatible gateway that ignores
// stream_options.include_usage still answers 200, and writing its zeroes as real
// counts would understate cost and pull token and latency statistics toward zero.
func usageTokenValue(value int, reported bool) *int {
	if !reported {
		return nil
	}
	copy := value
	return &copy
}

// resolveAnswerConfig returns the snapshot an evaluation supplied, or the
// knowledge base's current configuration.
func (s *ChatService) resolveAnswerConfig(ctx context.Context, knowledgeBaseID uuid.UUID, snapshot *dto.AnswerConfig) dto.AnswerConfig {
	if snapshot != nil {
		return *snapshot
	}
	answerConfig := dto.AnswerConfig{AnswerLanguage: "auto"}
	kb, err := s.knowledgeBases.FindByID(ctx, knowledgeBaseID)
	if err != nil || kb == nil || len(kb.AnswerConfig) == 0 {
		return answerConfig
	}
	if err := json.Unmarshal(kb.AnswerConfig, &answerConfig); err != nil {
		if log := s.metrics.Logger(ctx); log != nil {
			log.Warn("knowledge base answer_config is not valid JSON; using defaults", zap.String("knowledgeBaseId", knowledgeBaseID.String()), zap.Error(err))
		}
		return dto.AnswerConfig{AnswerLanguage: "auto"}
	}
	return answerConfig
}

// turnAnswerConfig resolves the answer configuration for this turn.
//
// A manual single-base turn uses that base's own configuration, including its
// prompt addition, model and temperature. Automatic and multi-base turns cannot:
// no single prompt, model or temperature represents several bases, so those stay
// at system defaults. The general-knowledge permission is the one setting that
// still carries over -- it decides whether the answer may contain text that no
// chunk supports, not how the answer is phrased.
func (s *ChatService) turnAnswerConfig(ctx context.Context, session *model.ChatSession, items []dto.SearchResultResponse, snapshot *dto.AnswerConfig) dto.AnswerConfig {
	if !session.IsAutomatic() && len(session.KnowledgeBaseLinks) == 0 {
		return s.resolveAnswerConfig(ctx, session.KnowledgeBaseID, snapshot)
	}
	return dto.AnswerConfig{
		AnswerLanguage:        "auto",
		AllowGeneralKnowledge: s.contributorsAllowGeneralKnowledge(ctx, items),
	}
}

// contributorsAllowGeneralKnowledge reports whether every base that contributed a
// chunk to this turn allows un-cited supplements.
//
// A supplement would sit next to all of their content, so one base's permission
// must not loosen another base's grounding: the answer may go un-cited only when
// all of them agree. A turn with no contributors has nobody to agree, so an empty
// automatic or multi-base result keeps the refusal it had before.
func (s *ChatService) contributorsAllowGeneralKnowledge(ctx context.Context, items []dto.SearchResultResponse) bool {
	decided := map[uuid.UUID]bool{}
	for _, item := range items {
		id, err := uuid.Parse(item.KnowledgeBaseID)
		if err != nil {
			return false
		}
		allowed, seen := decided[id]
		if !seen {
			allowed = s.resolveAnswerConfig(ctx, id, nil).AllowGeneralKnowledge
			decided[id] = allowed
		}
		if !allowed {
			return false
		}
	}
	return len(decided) > 0
}

func durationMillis(value time.Duration) *int64 {
	// Zero is a real measurement on a coarse clock; only a negative value means
	// "not measured".
	if value < 0 {
		return nil
	}
	ms := value.Milliseconds()
	return &ms
}

func buildIntentClassificationMessages(question string, history []model.ChatMessage, historyLimit int) []chatcore.Message {
	messages := []chatcore.Message{
		{Role: "system", Content: strings.Join([]string{
			"你是企业知识库问答系统的意图分类器和检索问题改写器。",
			"你必须只输出 JSON，不要输出 Markdown，不要输出解释。",
			"JSON 格式：{\"intent\":\"conversation|general|knowledge_base\",\"standaloneQuery\":\"...\",\"reason\":\"...\"}",
			"intent=conversation：用户只是在问候、询问对话历史、询问上一句话、要求回顾聊天进度，且不需要任何外部事实。",
			"intent=general：用户询问通用概念、原理、行业惯例或公开知识，回答不需要本组织自己的资料、制度、配置、数值或承诺。",
			"intent=knowledge_base：用户询问企业知识库内容、要求基于资料回答，或问题涉及本组织自己的资料、制度、配置、数值、承诺，需要检索文档才能可靠回答。",
			"knowledge_base 时 standaloneQuery 必须是结合历史对话改写后的独立检索问题。",
			"conversation 和 general 时 standaloneQuery 必须为空字符串。",
			"不确定时选择 knowledge_base。",
		}, "\n")},
	}
	messages = append(messages, recentChatHistory(history, historyLimit)...)
	messages = append(messages, chatcore.Message{
		Role:    "user",
		Content: "当前用户问题：\n" + strings.TrimSpace(question),
	})
	return messages
}

// normalizeRetrievalQuery reduces a canonical retrieval query to the form used to
// group repeated rewrites of one question.
//
// It lowercases, drops punctuation and symbols, and removes whitespace entirely
// rather than collapsing it to a single space. Dropping it matters because this
// corpus is Chinese-primary and CJK spacing is inconsistent: "退货 政策" and
// "退货政策" are the same question and must land in the same cluster.
//
// Returns "" when nothing survives, which callers treat as "not groupable" and
// store as NULL rather than as an empty-string group that would collect every
// punctuation-only query together.
func normalizeRetrievalQuery(query string) string {
	var b strings.Builder
	b.Grow(len(query))
	for _, r := range query {
		switch {
		case unicode.IsSpace(r), unicode.IsPunct(r), unicode.IsSymbol(r):
			continue
		default:
			b.WriteRune(unicode.ToLower(r))
		}
	}
	return b.String()
}

func parseChatIntentOutput(raw string, question string) chatIntentDecision {
	decision := chatIntentDecision{}
	content := extractJSONObject(raw)
	if content != "" {
		_ = json.Unmarshal([]byte(content), &decision)
	}

	decision.Intent = strings.ToLower(strings.TrimSpace(decision.Intent))
	switch decision.Intent {
	case chatIntentConversation, chatIntentGeneral:
		// Neither turn retrieves, so a rewritten query would only be dead weight.
		decision.StandaloneQuery = ""
	case chatIntentKnowledgeBase:
		decision.StandaloneQuery = strings.TrimSpace(decision.StandaloneQuery)
	default:
		decision.Intent = chatIntentKnowledgeBase
		decision.StandaloneQuery = ""
	}

	if decision.Intent == chatIntentKnowledgeBase && decision.StandaloneQuery == "" {
		decision.StandaloneQuery = strings.TrimSpace(question)
	}
	decision.Reason = strings.TrimSpace(decision.Reason)
	return decision
}

func extractJSONObject(raw string) string {
	content := strings.TrimSpace(raw)
	start := strings.Index(content, "{")
	end := strings.LastIndex(content, "}")
	if start < 0 || end < start {
		return ""
	}
	return content[start : end+1]
}

func buildAnswerMessages(question string, items []dto.SearchResultResponse, history []model.ChatMessage, historyLimit int) []chatcore.Message {
	return buildAnswerMessagesWithConfig(question, items, history, historyLimit, dto.AnswerConfig{AnswerLanguage: "auto"})
}

func buildAnswerMessagesWithConfig(question string, items []dto.SearchResultResponse, history []model.ChatMessage, historyLimit int, config dto.AnswerConfig) []chatcore.Message {
	messages := []chatcore.Message{
		{Role: "system", Content: systemPromptForConfig(config)},
	}
	messages = append(messages, recentChatHistory(history, historyLimit)...)
	messages = append(messages, chatcore.Message{
		Role:    "user",
		Content: buildRAGPrompt(question, items),
	})
	return messages
}

func buildConversationAnswerMessages(question string, history []model.ChatMessage, historyLimit int) []chatcore.Message {
	messages := []chatcore.Message{
		{Role: "system", Content: strings.Join([]string{
			"你是企业知识库问答系统中的聊天助手。",
			"当前问题只涉及对话本身、问候或上下文回顾时，可以直接基于历史对话回答。",
			"不要引用知识库片段，不要编造不存在的历史消息。",
			"如果历史对话不足以回答，请明确说明没有足够的对话历史。",
		}, "\n")},
	}
	messages = append(messages, recentChatHistory(history, historyLimit)...)
	messages = append(messages, chatcore.Message{
		Role:    "user",
		Content: strings.TrimSpace(question),
	})
	return messages
}

// buildGeneralAnswerMessages answers a question the classifier placed outside the
// knowledge base: a concept, a convention or public knowledge.
//
// The prompt states that no chunk exists rather than omitting the section, because
// an empty 知识片段 block reads to the model like a retrieval result it failed to
// use. It also keeps the boundary of the turn visible: this answer carries no
// sources, so it must not look like one that does.
func buildGeneralAnswerMessages(question string, history []model.ChatMessage, historyLimit int) []chatcore.Message {
	messages := []chatcore.Message{
		{Role: "system", Content: strings.Join([]string{
			"你是企业知识库问答系统中的通用知识助手。",
			"当前问题属于通用知识，本轮不检索知识库，也没有知识片段。",
			"直接给出准确、简洁的回答；把握不准的具体数值、版本、规定或机构内部情况要说明不确定，不要编造。",
			"本回答不来自知识库：不要标注 [source: N] 引用，也不要声称依据了知识库资料。",
			"可以参考历史对话理解代词和省略，但历史对话不是本轮事实依据。",
		}, "\n")},
	}
	messages = append(messages, recentChatHistory(history, historyLimit)...)
	messages = append(messages, chatcore.Message{
		Role:    "user",
		Content: strings.TrimSpace(question),
	})
	return messages
}

func recentChatHistory(history []model.ChatMessage, limit int) []chatcore.Message {
	if limit <= 0 {
		return nil
	}

	valid := make([]chatcore.Message, 0, len(history))
	for _, message := range history {
		role := strings.TrimSpace(message.Role)
		content := strings.TrimSpace(message.Content)
		if content == "" || (role != "user" && role != "assistant") {
			continue
		}
		valid = append(valid, chatcore.Message{
			Role:    role,
			Content: content,
		})
	}

	if len(valid) <= limit {
		return valid
	}
	return valid[len(valid)-limit:]
}

func buildRAGPrompt(question string, items []dto.SearchResultResponse) string {
	var builder strings.Builder
	builder.WriteString("用户问题：\n")
	builder.WriteString(question)
	builder.WriteString("\n\n")
	if len(items) == 0 {
		// Only reachable when the knowledge base allows general knowledge. Saying
		// so is the honest form of the evidence: an empty 知识片段 block would read
		// like a retrieval result the model has to explain away.
		builder.WriteString("本轮未检索到知识片段。\n\n请按系统提示回答用户问题；没有资料支持的内容必须单独标明。")
		return builder.String()
	}
	builder.WriteString("知识片段：\n")
	for i, item := range items {
		builder.WriteString(fmt.Sprintf("[source: %d]\n", i+1))
		if item.KnowledgeBaseID != "" {
			builder.WriteString("knowledgeBaseId: " + item.KnowledgeBaseID + "\n")
			builder.WriteString("knowledgeBaseName: " + item.KnowledgeBaseName + "\n")
		}
		builder.WriteString("documentId: " + item.DocumentID + "\n")
		builder.WriteString("chunkId: " + item.ChunkID + "\n")
		builder.WriteString("filename: " + item.Filename + "\n")
		if item.PageNumber != nil {
			builder.WriteString(fmt.Sprintf("pageNumber: %d\n", *item.PageNumber))
		}
		if table := item.Table; table != nil {
			builder.WriteString(fmt.Sprintf("sheetName: %s\nrowStart: %d\nrowEnd: %d\n", table.SheetName, table.RowStart, table.RowEnd))
		}
		builder.WriteString("content: " + item.Content + "\n\n")
	}
	builder.WriteString("请基于以上知识片段回答用户问题。")
	return builder.String()
}
