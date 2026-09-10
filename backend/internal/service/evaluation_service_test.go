package service

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"kbchat/backend/internal/apperror"
	chatcore "kbchat/backend/internal/chat"
	"kbchat/backend/internal/dto"
	"kbchat/backend/internal/model"
	"kbchat/backend/internal/repository"
)

type evaluationProvider struct {
	calls  int
	onCall func()
}

func (p *evaluationProvider) Chat(_ context.Context, messages []chatcore.Message) (string, error) {
	p.calls++
	if p.onCall != nil {
		p.onCall()
	}
	if strings.Contains(messages[0].Content, "意图分类器") {
		return `{"intent":"knowledge_base"}`, nil
	}
	return "签收后 7 天内退货，提供订单号。[source:1]", nil
}

type evaluationRetrieval struct{ requests []dto.SearchRequest }

func (r *evaluationRetrieval) Search(_ context.Context, _, _ uuid.UUID, req dto.SearchRequest) (*dto.SearchResponse, error) {
	r.requests = append(r.requests, req)
	if req.Query == "服务失败" {
		return nil, apperror.New(500, "EMBEDDING_FAILED", "知识检索暂时不可用，请稍后重试")
	}
	return &dto.SearchResponse{Items: []dto.SearchResultResponse{{ChunkID: uuid.NewString(), DocumentID: uuid.NewString(), Filename: "policy.md", Content: "7 天内可退货，需订单号。"}}}, nil
}

func evaluationFixture(t *testing.T) (*EvaluationService, workspaceTestServices, uuid.UUID, uuid.UUID, *evaluationProvider, *evaluationRetrieval) {
	t.Helper()
	w := newWorkspaceTestServices(t)
	if err := w.db.AutoMigrate(&model.EvaluationCase{}, &model.EvaluationRun{}); err != nil {
		t.Fatal(err)
	}
	db, _ := w.db.DB()
	db.SetMaxOpenConns(1)
	actor := createWorkspaceUser(t, w.db, "evaluator")
	kb := createWorkspaceKB(t, w.db, actor.ID, uuid.Nil, "评测库", "private", time.Now())
	provider, search := &evaluationProvider{}, &evaluationRetrieval{}
	w.chats.chatProvider, w.chats.retrieval = provider, search
	w.chats.cfg.ChatModel = "test-model"
	return NewEvaluationService(repository.NewEvaluationRepository(w.db), repository.NewKnowledgeBaseRepository(w.db), w.chats), w, actor.ID, kb.ID, provider, search
}

func saveEvaluationCase(t *testing.T, s *EvaluationService, actor, kb uuid.UUID, question string, keywords []string, citation bool) dto.EvaluationCaseResponse {
	t.Helper()
	item, err := s.SaveCase(context.Background(), actor, kb, uuid.Nil, dto.EvaluationCaseRequest{Question: question, RequiredKeywords: keywords, RequireCitation: citation, ExpectedAnswer: "参考答案"})
	if err != nil {
		t.Fatal(err)
	}
	return *item
}

func evaluationRequest(ids ...string) dto.EvaluationRunRequest {
	return dto.EvaluationRunRequest{ClientRequestID: uuid.NewString(), Name: "对比配置", CaseIDs: ids, Config: dto.RetrievalConfig{VectorTopN: 12, RerankTopK: 3, ScoreThreshold: 0, EnableRerank: true}}
}

func TestEvaluationRunIsIdempotentAndSnapshotsCases(t *testing.T) {
	s, _, actor, kb, provider, _ := evaluationFixture(t)
	ctx := context.Background()
	item := saveEvaluationCase(t, s, actor, kb, "退货规则", []string{"7"}, true)
	req := evaluationRequest(item.ID)
	first, err := s.CreateRun(ctx, actor, kb, req)
	if err != nil {
		t.Fatal(err)
	}
	item.Question = "编辑后的问题"
	if _, err := s.SaveCase(ctx, actor, kb, uuid.MustParse(item.ID), item.EvaluationCaseRequest); err != nil {
		t.Fatal(err)
	}
	repeated, err := s.CreateRun(ctx, actor, kb, req)
	if err != nil {
		t.Fatal(err)
	}
	if first.ID != repeated.ID || repeated.Cases[0].Question != "退货规则" || provider.calls != 0 {
		t.Fatalf("snapshot/idempotency failed: %+v", repeated)
	}
	req.Config.ScoreThreshold = .9
	_, err = s.CreateRun(ctx, actor, kb, req)
	assertAppErrorCode(t, err, "EVALUATION_REQUEST_CONFLICT")
}

func TestEvaluationUsesSharedPipelineAndSeparatesRuleFailureFromProviderFailure(t *testing.T) {
	s, w, actor, kb, _, search := evaluationFixture(t)
	cases := []dto.EvaluationCaseResponse{
		saveEvaluationCase(t, s, actor, kb, "退货规则", []string{"7", "订单号"}, true),
		saveEvaluationCase(t, s, actor, kb, "退货费用", []string{"免费"}, true),
		saveEvaluationCase(t, s, actor, kb, "无自动规则", nil, false),
		saveEvaluationCase(t, s, actor, kb, "服务失败", []string{"7"}, true),
	}
	ids := []string{}
	for _, item := range cases {
		ids = append(ids, item.ID)
	}
	ctx := context.Background()
	run, err := s.CreateRun(ctx, actor, kb, evaluationRequest(ids...))
	if err != nil {
		t.Fatal(err)
	}
	if worked, err := s.ProcessNext(ctx); err != nil || !worked {
		t.Fatalf("process: %v", err)
	}
	finished, err := s.GetRun(ctx, actor, kb, uuid.MustParse(run.ID))
	if err != nil {
		t.Fatal(err)
	}
	if finished.Status != "completed" || finished.CompletedCount != 4 || finished.Runtime.EffectiveRerank || finished.Runtime.ChatModel != "test-model" {
		t.Fatalf("unexpected run: %+v", finished)
	}
	byID := map[string]dto.EvaluationResult{}
	for _, result := range finished.Results {
		byID[result.CaseID] = result
	}
	if got := byID[cases[0].ID]; got.RulePassed == nil || !*got.RulePassed || len(got.Citations) != 1 {
		t.Fatalf("passing rules: %+v", got)
	}
	if got := byID[cases[1].ID]; got.RulePassed == nil || *got.RulePassed || len(got.MissingKeywords) != 1 {
		t.Fatalf("failed rules: %+v", got)
	}
	if got := byID[cases[2].ID]; got.RulePassed != nil || got.ErrorCode != "" {
		t.Fatalf("manual comparison: %+v", got)
	}
	if got := byID[cases[3].ID]; got.RulePassed != nil || got.ErrorCode != "EMBEDDING_FAILED" {
		t.Fatalf("provider error: %+v", got)
	}
	for _, req := range search.requests {
		if req.VectorTopN != 12 || req.RerankTopK != 3 || req.ScoreThreshold == nil || *req.ScoreThreshold != 0 {
			t.Fatalf("lost config override: %+v", req)
		}
	}
	for _, table := range []any{&model.ChatSession{}, &model.ChatMessage{}} {
		var count int64
		w.db.Model(table).Count(&count)
		if count != 0 {
			t.Fatal("evaluation polluted real chat")
		}
	}
	if worked, err := s.ProcessNext(ctx); worked || err != nil {
		t.Fatalf("run replayed: %v", err)
	}
}

func TestEvaluationAccessAndCaseScopeAreCheckedBeforeProviders(t *testing.T) {
	s, w, actor, kb, provider, _ := evaluationFixture(t)
	ctx := context.Background()
	other := createWorkspaceUser(t, w.db, "other-evaluator")
	otherKB := createWorkspaceKB(t, w.db, actor, uuid.Nil, "另一知识库", "private", time.Now())
	item := saveEvaluationCase(t, s, actor, kb, "退货规则", nil, true)
	if _, err := s.ListCases(ctx, other.ID, kb); err == nil {
		t.Fatal("cross-user read allowed")
	}
	if _, err := s.SaveCase(ctx, other.ID, kb, uuid.Nil, item.EvaluationCaseRequest); err == nil {
		t.Fatal("cross-user write allowed")
	}
	if err := s.DeleteCase(ctx, actor, otherKB.ID, uuid.MustParse(item.ID)); err == nil {
		t.Fatal("cross-base delete allowed")
	}
	if _, err := s.CreateRun(ctx, actor, otherKB.ID, evaluationRequest(item.ID)); err == nil {
		t.Fatal("cross-base run allowed")
	}
	run, err := s.CreateRun(ctx, actor, kb, evaluationRequest(item.ID))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.GetRun(ctx, actor, otherKB.ID, uuid.MustParse(run.ID)); err == nil {
		t.Fatal("cross-base result exposed")
	}
	if _, err := s.CancelRun(ctx, other.ID, kb, uuid.MustParse(run.ID)); err == nil {
		t.Fatal("cross-user cancellation allowed")
	}
	if provider.calls != 0 {
		t.Fatal("provider called before access validation")
	}
}

func TestEvaluationCancellationCannotBeOverwrittenAndStopsRemainingCases(t *testing.T) {
	s, _, actor, kb, provider, _ := evaluationFixture(t)
	ctx := context.Background()
	first := saveEvaluationCase(t, s, actor, kb, "第一题", nil, true)
	second := saveEvaluationCase(t, s, actor, kb, "第二题", nil, true)
	run, err := s.CreateRun(ctx, actor, kb, evaluationRequest(first.ID, second.ID))
	if err != nil {
		t.Fatal(err)
	}
	provider.onCall = func() {
		_, err := s.CancelRun(ctx, actor, kb, uuid.MustParse(run.ID))
		if err != nil {
			t.Fatal(err)
		}
		provider.onCall = nil
	}
	if _, err := s.ProcessNext(ctx); err != nil {
		t.Fatal(err)
	}
	result, err := s.GetRun(ctx, actor, kb, uuid.MustParse(run.ID))
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != "cancelled" || result.CompletedCount != 0 || provider.calls > 2 {
		t.Fatalf("cancel overwritten: %+v, calls=%d", result, provider.calls)
	}
}

func TestEvaluationAbandonedLeaseIsReportedWithoutReplay(t *testing.T) {
	s, w, actor, kb, provider, _ := evaluationFixture(t)
	item := saveEvaluationCase(t, s, actor, kb, "退货", nil, true)
	run, err := s.CreateRun(context.Background(), actor, kb, evaluationRequest(item.ID))
	if err != nil {
		t.Fatal(err)
	}
	w.db.Model(&model.EvaluationRun{}).Where("id = ?", run.ID).Updates(map[string]any{"status": "running", "updated_at": time.Now().UTC().Add(-3 * time.Minute), "lease_token": uuid.New()})
	if worked, err := s.ProcessNext(context.Background()); err != nil || worked {
		t.Fatalf("replayed abandoned job: %v", err)
	}
	result, _ := s.GetRun(context.Background(), actor, kb, uuid.MustParse(run.ID))
	if result.Status != "failed" || result.ErrorMessage == "" || provider.calls != 0 {
		t.Fatalf("wrong abandoned result: %+v", result)
	}
}

func TestFeedbackReasonsPersistAndPositiveRatingClearsThem(t *testing.T) {
	w := newWorkspaceTestServices(t)
	actor := createWorkspaceUser(t, w.db, "reason-owner")
	kb := createWorkspaceKB(t, w.db, actor.ID, uuid.Nil, "feedback", "private", time.Now())
	session := createWorkspaceChatSession(t, w.db, actor.ID, kb.ID, "反馈")
	message := model.ChatMessage{SessionID: session.ID, Role: "assistant", Content: "答案", CreatedAt: time.Now().UTC().Add(-time.Minute)}
	if err := w.db.Create(&message).Error; err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	feedback, err := w.chats.SetMessageFeedback(ctx, actor.ID, message.ID, "negative", dto.ChatFeedbackDetails{Reason: "inaccurate", Comment: " 应是 7 天 "})
	if err != nil || feedback.Comment != "应是 7 天" {
		t.Fatalf("reason save: %+v, %v", feedback, err)
	}
	listed, err := w.chats.ListNegativeFeedback(ctx, actor.ID, dto.ChatQualityFeedbackQuery{})
	if err != nil || len(listed.Items) != 1 || listed.Items[0].Reason != "inaccurate" {
		t.Fatalf("quality reason missing: %+v, %v", listed, err)
	}
	_, err = w.chats.SetMessageFeedback(ctx, actor.ID, message.ID, "negative", dto.ChatFeedbackDetails{Reason: "invalid"})
	assertAppErrorCode(t, err, "VALIDATION_ERROR")
	_, err = w.chats.SetMessageFeedback(ctx, actor.ID, message.ID, "negative", dto.ChatFeedbackDetails{Comment: strings.Repeat("字", 1001)})
	assertAppErrorCode(t, err, "VALIDATION_ERROR")
	feedback, err = w.chats.SetMessageFeedback(ctx, actor.ID, message.ID, "positive")
	if err != nil || feedback.Reason != "" || feedback.Comment != "" {
		t.Fatalf("negative fields not cleared: %+v, %v", feedback, err)
	}
}
