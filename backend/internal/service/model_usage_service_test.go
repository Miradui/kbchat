package service

import (
	"context"
	"errors"
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

// usageProvider reports token usage and records the options it was called
// with, so tests can check both the usage rows and the model override.
type usageProvider struct {
	answer  string
	model   string
	options []chatcore.Options
}

func (p *usageProvider) Chat(ctx context.Context, messages []chatcore.Message) (string, error) {
	answer, _, err := p.ChatWithOptions(ctx, messages, chatcore.Options{})
	return answer, err
}

func (p *usageProvider) ChatWithUsage(ctx context.Context, messages []chatcore.Message) (string, chatcore.Usage, error) {
	return p.ChatWithOptions(ctx, messages, chatcore.Options{})
}

func (p *usageProvider) ChatWithOptions(_ context.Context, messages []chatcore.Message, options chatcore.Options) (string, chatcore.Usage, error) {
	p.options = append(p.options, options)
	model := p.model
	if options.Model != "" {
		model = options.Model
	}
	if strings.Contains(messages[0].Content, "意图分类器") {
		return `{"intent":"knowledge_base","standaloneQuery":"退货"}`, chatcore.Usage{PromptTokens: 11, CompletionTokens: 3, TotalTokens: 14, Model: model}, nil
	}
	return p.answer, chatcore.Usage{PromptTokens: 120, CompletionTokens: 40, TotalTokens: 160, Model: model}, nil
}

func usageTestServices(t *testing.T) (workspaceTestServices, *usageProvider, *repository.ModelUsageRepository) {
	t.Helper()
	w := newWorkspaceTestServices(t)
	if err := w.db.AutoMigrate(&model.ModelUsageRecord{}, &model.EvaluationCase{}, &model.EvaluationRun{}); err != nil {
		t.Fatal(err)
	}
	usage := repository.NewModelUsageRepository(w.db)
	provider := &usageProvider{answer: "签收后 7 天内退货。[source:1]", model: "default-model"}
	w.chats.chatProvider = provider
	w.chats.retrieval = &evaluationRetrieval{}
	w.chats.cfg.ChatModel = "default-model"
	w.chats.cfg.ModelProvider = "openai_compatible"
	w.chats.SetUsageRepository(usage)
	w.chats.SetUserRepository(repository.NewUserRepository(w.db))
	return w, provider, usage
}

func listUsageRecords(t *testing.T, w workspaceTestServices) []model.ModelUsageRecord {
	t.Helper()
	var records []model.ModelUsageRecord
	if err := w.db.Order("created_at asc").Find(&records).Error; err != nil {
		t.Fatal(err)
	}
	return records
}

func TestChatUsageRecordsIntentAndAnswerLinkedToTheMessage(t *testing.T) {
	w, _, _ := usageTestServices(t)
	ctx := context.Background()
	owner := createWorkspaceUser(t, w.db, "owner")
	kb := createWorkspaceKB(t, w.db, owner.ID, uuid.Nil, "库", "private", time.Now())
	session := model.ChatSession{UserID: owner.ID, KnowledgeBaseID: kb.ID, Title: "新会话"}
	if err := w.db.Create(&session).Error; err != nil {
		t.Fatal(err)
	}

	res, err := w.chats.SendMessage(ctx, owner.ID, session.ID, dto.SendChatMessageRequest{Content: "退货规则", ClientRequestID: uuid.NewString()})
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	records := listUsageRecords(t, w)
	if len(records) != 2 {
		t.Fatalf("expected intent and answer records, got %d: %#v", len(records), records)
	}
	purposes := map[string]model.ModelUsageRecord{}
	for _, record := range records {
		purposes[record.Purpose] = record
	}
	answer, ok := purposes["answer"]
	if !ok || purposes["intent"].ID == uuid.Nil {
		t.Fatalf("expected intent and answer purposes, got %#v", purposes)
	}
	if answer.MessageID == nil || answer.MessageID.String() != res.AssistantMessage.ID {
		t.Fatalf("expected answer usage linked to assistant message %s, got %#v", res.AssistantMessage.ID, answer.MessageID)
	}
	if answer.SessionID == nil || *answer.SessionID != session.ID || answer.KnowledgeBaseID != kb.ID || answer.Provider != "openai_compatible" || answer.Model != "default-model" {
		t.Fatalf("unexpected answer record %#v", answer)
	}
	if answer.PromptTokens == nil || *answer.PromptTokens != 120 || answer.CompletionTokens == nil || *answer.CompletionTokens != 40 || answer.TotalTokens == nil || *answer.TotalTokens != 160 {
		t.Fatalf("unexpected token counts %#v", answer)
	}
	if answer.LatencyMs == nil {
		t.Fatalf("expected per-call latency to be recorded")
	}
}

func TestEvaluationUsageIsRecordedWithoutASessionAndUsesTheAnswerConfigSnapshot(t *testing.T) {
	w, provider, _ := usageTestServices(t)
	ctx := context.Background()
	owner := createWorkspaceUser(t, w.db, "owner")
	kb := createWorkspaceKB(t, w.db, owner.ID, uuid.Nil, "库", "private", time.Now())
	if err := w.db.Model(&model.KnowledgeBase{}).Where("id = ?", kb.ID).Update("answer_config", `{"answerLanguage":"en","allowGeneralKnowledge":false,"model":"kb-model","systemPromptAddition":"用要点作答"}`).Error; err != nil {
		t.Fatal(err)
	}
	evaluations := NewEvaluationService(repository.NewEvaluationRepository(w.db), repository.NewKnowledgeBaseRepository(w.db), w.chats)
	item := saveEvaluationCase(t, evaluations, owner.ID, kb.ID, "退货规则", []string{"7"}, true)
	run, err := evaluations.CreateRun(ctx, owner.ID, kb.ID, evaluationRequest(item.ID))
	if err != nil {
		t.Fatal(err)
	}
	if run.AnswerConfig.Model != "kb-model" || run.AnswerConfig.SystemPromptAddition != "用要点作答" {
		t.Fatalf("expected run to snapshot the answer config, got %#v", run.AnswerConfig)
	}
	// Change the knowledge base after the run was created: the run must keep
	// answering with the snapshot.
	if err := w.db.Model(&model.KnowledgeBase{}).Where("id = ?", kb.ID).Update("answer_config", `{"answerLanguage":"auto","allowGeneralKnowledge":false,"model":""}`).Error; err != nil {
		t.Fatal(err)
	}
	if worked, err := evaluations.ProcessNext(ctx); err != nil || !worked {
		t.Fatalf("process: worked=%v err=%v", worked, err)
	}
	finished, err := evaluations.GetRun(ctx, owner.ID, kb.ID, uuid.MustParse(run.ID))
	if err != nil {
		t.Fatal(err)
	}
	if finished.Runtime.ChatModel != "kb-model" {
		t.Fatalf("expected runtime to report the overriding model, got %q", finished.Runtime.ChatModel)
	}
	var sawOverride bool
	for _, options := range provider.options {
		if options.Model == "kb-model" {
			sawOverride = true
		}
	}
	if !sawOverride {
		t.Fatalf("expected the answer call to use the snapshot model, got %#v", provider.options)
	}

	records := listUsageRecords(t, w)
	if len(records) != 2 {
		t.Fatalf("expected intent and evaluation records, got %#v", records)
	}
	for _, record := range records {
		if record.SessionID != nil {
			t.Fatalf("evaluation usage must not carry a session id, got %#v", record)
		}
		if record.KnowledgeBaseID != kb.ID {
			t.Fatalf("evaluation usage must be attributed to the knowledge base, got %#v", record)
		}
		if record.Purpose == "answer" {
			t.Fatalf("evaluation answers must be recorded as evaluation, got %#v", record)
		}
		if record.Purpose == "evaluation" && record.Model != "kb-model" {
			t.Fatalf("expected evaluation record to name the overriding model, got %#v", record)
		}
	}
}

func TestGetChatUsageScopesToReachableKnowledgeBasesAndPricesModels(t *testing.T) {
	w, _, usage := usageTestServices(t)
	ctx := context.Background()
	owner := createWorkspaceUser(t, w.db, "owner")
	other := createWorkspaceUser(t, w.db, "other")
	admin := createWorkspaceUser(t, w.db, "admin")
	if err := w.db.Model(&model.User{}).Where("id = ?", admin.ID).Update("role", model.SystemRoleAdmin).Error; err != nil {
		t.Fatal(err)
	}
	mine := createWorkspaceKB(t, w.db, owner.ID, uuid.Nil, "我的", "private", time.Now())
	theirs := createWorkspaceKB(t, w.db, other.ID, uuid.Nil, "别人的", "private", time.Now())
	// One minute in the past keeps the rows inside the query window even when
	// the test and the query land in the same millisecond.
	now := time.Now().UTC().Add(-time.Minute)
	one, two := 1000, 500
	for _, record := range []model.ModelUsageRecord{
		{UserID: owner.ID, KnowledgeBaseID: mine.ID, Purpose: "answer", Provider: "openai_compatible", Model: "priced", PromptTokens: &one, CompletionTokens: &two, TotalTokens: &one, CreatedAt: now},
		{UserID: other.ID, KnowledgeBaseID: mine.ID, Purpose: "answer", Provider: "openai_compatible", Model: "unpriced", PromptTokens: &one, CompletionTokens: &two, TotalTokens: &one, CreatedAt: now},
		{UserID: other.ID, KnowledgeBaseID: theirs.ID, Purpose: "answer", Provider: "openai_compatible", Model: "priced", PromptTokens: &one, CompletionTokens: &two, TotalTokens: &one, CreatedAt: now},
	} {
		if err := usage.Create(ctx, &record); err != nil {
			t.Fatal(err)
		}
	}
	w.chats.cfg.ModelPricing = `{"priced":{"prompt":2,"completion":4}}`

	// The owner sees every record on their knowledge base, including a
	// colleague's, but nothing from a knowledge base they cannot reach.
	res, err := w.chats.GetChatUsage(ctx, owner.ID, dto.ChatUsageQuery{GroupBy: "knowledgeBase"})
	if err != nil {
		t.Fatalf("usage: %v", err)
	}
	if len(res.Items) != 1 || res.Items[0].GroupKey != mine.ID.String() || res.Items[0].GroupLabel != "我的" || res.Items[0].Calls != 2 {
		t.Fatalf("expected owner scope to cover only their knowledge base, got %#v", res.Items)
	}
	if !res.PricingConfigured || res.EstimatedCost == nil || *res.EstimatedCost != 1000.0/1e6*2+500.0/1e6*4 || len(res.UnpricedModels) != 1 || res.UnpricedModels[0] != "unpriced" {
		t.Fatalf("unexpected pricing result %#v", res)
	}

	byModel, err := w.chats.GetChatUsage(ctx, owner.ID, dto.ChatUsageQuery{GroupBy: "model"})
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range byModel.Items {
		if item.GroupKey == "priced" && item.EstimatedCost == nil {
			t.Fatalf("expected priced model row to carry a cost, got %#v", item)
		}
		if item.GroupKey == "unpriced" && item.EstimatedCost != nil {
			t.Fatalf("expected unpriced model row without cost, got %#v", item)
		}
	}

	byDay, err := w.chats.GetChatUsage(ctx, owner.ID, dto.ChatUsageQuery{GroupBy: "day"})
	if err != nil {
		t.Fatal(err)
	}
	if len(byDay.Items) != 1 || byDay.Items[0].GroupKey != now.Format("2006-01-02") {
		t.Fatalf("expected a YYYY-MM-DD day key, got %#v", byDay.Items)
	}

	// A system administrator sees every knowledge base.
	all, err := w.chats.GetChatUsage(ctx, admin.ID, dto.ChatUsageQuery{GroupBy: "knowledgeBase"})
	if err != nil {
		t.Fatal(err)
	}
	if len(all.Items) != 2 {
		t.Fatalf("expected admin to see both knowledge bases, got %#v", all.Items)
	}

	// A user with no standing on the requested knowledge base is refused.
	_, err = w.chats.GetChatUsage(ctx, owner.ID, dto.ChatUsageQuery{KnowledgeBaseID: &theirs.ID})
	var app *apperror.Error
	if err == nil || !errors.As(err, &app) {
		t.Fatalf("expected an access error, got %v", err)
	}

	// Pricing off: no cost fields.
	w.chats.cfg.ModelPricing = ""
	plain, err := w.chats.GetChatUsage(ctx, owner.ID, dto.ChatUsageQuery{})
	if err != nil {
		t.Fatal(err)
	}
	if plain.PricingConfigured || plain.EstimatedCost != nil {
		t.Fatalf("expected no cost without pricing, got %#v", plain)
	}
}

func TestSystemPromptForConfigKeepsBaseRulesAndAppliesOverrides(t *testing.T) {
	base := systemPromptForConfig(dto.AnswerConfig{AnswerLanguage: "auto"})
	for _, rule := range []string{"只能基于提供的知识片段回答问题。", "引用来源只能来自本轮提供的知识片段。", "不要编造事实，不要编造引用来源。", refusalMarker} {
		if !strings.Contains(base, rule) {
			t.Fatalf("base prompt lost rule %q", rule)
		}
	}
	custom := systemPromptForConfig(dto.AnswerConfig{AnswerLanguage: "en", AllowGeneralKnowledge: true, SystemPromptAddition: "  用要点作答  "})
	if strings.Contains(custom, "只能基于提供的知识片段回答问题。") || !strings.Contains(custom, "优先基于知识片段回答，片段不足时可补充常识并明确标注。") {
		t.Fatalf("allowGeneralKnowledge must swap only the grounding rule: %s", custom)
	}
	addition := strings.Index(custom, "知识库回答补充要求：\n用要点作答")
	refusal := strings.Index(custom, refusalMarker)
	baseRule := strings.Index(custom, "不要编造事实，不要编造引用来源。")
	if addition < 0 || baseRule < 0 || addition < baseRule || refusal < addition {
		t.Fatalf("addition must follow the base rules and precede the refusal rules: %s", custom)
	}
	if !strings.Contains(custom, "Please answer in English.") {
		t.Fatalf("expected English instruction: %s", custom)
	}
	zh := systemPromptForConfig(dto.AnswerConfig{AnswerLanguage: "zh"})
	if !strings.Contains(zh, "请使用中文回答。") || strings.Contains(zh, "Please answer in English.") {
		t.Fatalf("expected Chinese instruction only: %s", zh)
	}
	if strings.Contains(base, "请使用中文回答。") || strings.Contains(base, "Please answer in English.") {
		t.Fatalf("auto must not add a language instruction: %s", base)
	}
}

func TestKnowledgeBaseUpdatePreservesOmittedConfigBlocksAndValidatesAnswerConfig(t *testing.T) {
	w := newWorkspaceTestServices(t)
	ctx := context.Background()
	owner := createWorkspaceUser(t, w.db, "owner")
	w.kbs.SetChatAllowedModels([]string{"allowed-model"})
	temperature := 0.3
	created, err := w.kbs.Create(ctx, owner.ID, dto.KnowledgeBaseRequest{
		Name:            "库",
		Visibility:      "private",
		RetrievalConfig: &dto.RetrievalConfig{VectorTopN: 12, RerankTopK: 3, ScoreThreshold: 0.4, EnableRerank: true, EnableKeyword: false},
		AnswerConfig:    &dto.AnswerConfig{SystemPromptAddition: "用要点作答", AnswerLanguage: "zh", AllowGeneralKnowledge: true, Model: "allowed-model", Temperature: &temperature},
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	kbID := uuid.MustParse(created.ID)

	// Saving the retrieval form alone must not touch the answer block.
	updated, err := w.kbs.Update(ctx, owner.ID, kbID, dto.KnowledgeBaseRequest{
		Name: "库", Visibility: "private",
		RetrievalConfig: &dto.RetrievalConfig{VectorTopN: 20, RerankTopK: 5, ScoreThreshold: 0.2, EnableRerank: false, EnableKeyword: true},
	})
	if err != nil {
		t.Fatalf("update retrieval: %v", err)
	}
	if updated.AnswerConfig.SystemPromptAddition != "用要点作答" || updated.AnswerConfig.Model != "allowed-model" || updated.AnswerConfig.Temperature == nil || *updated.AnswerConfig.Temperature != 0.3 || !updated.AnswerConfig.AllowGeneralKnowledge {
		t.Fatalf("answer config was reset by a retrieval-only update: %#v", updated.AnswerConfig)
	}
	if updated.RetrievalConfig.VectorTopN != 20 {
		t.Fatalf("retrieval config not applied: %#v", updated.RetrievalConfig)
	}

	// A rename that sends neither block keeps both.
	renamed, err := w.kbs.Update(ctx, owner.ID, kbID, dto.KnowledgeBaseRequest{Name: "改名", Visibility: "private"})
	if err != nil {
		t.Fatalf("rename: %v", err)
	}
	if renamed.RetrievalConfig.VectorTopN != 20 || renamed.AnswerConfig.Model != "allowed-model" {
		t.Fatalf("rename reset configuration: retrieval=%#v answer=%#v", renamed.RetrievalConfig, renamed.AnswerConfig)
	}

	// Validation: whitelist, length, language, temperature.
	long := strings.Repeat("字", 2001)
	bad := 1.5
	for name, cfg := range map[string]dto.AnswerConfig{
		"model outside whitelist":  {Model: "other-model"},
		"addition too long":        {SystemPromptAddition: long},
		"unknown language":         {AnswerLanguage: "fr"},
		"temperature out of range": {Temperature: &bad},
	} {
		config := cfg
		_, err := w.kbs.Update(ctx, owner.ID, kbID, dto.KnowledgeBaseRequest{Name: "改名", Visibility: "private", AnswerConfig: &config})
		var app *apperror.Error
		if err == nil || !errors.As(err, &app) || app.Code != "VALIDATION_ERROR" {
			t.Fatalf("%s: expected validation error, got %v", name, err)
		}
	}

	// An empty whitelist rejects any explicit override instead of forwarding it.
	w.kbs.SetChatAllowedModels(nil)
	_, err = w.kbs.Update(ctx, owner.ID, kbID, dto.KnowledgeBaseRequest{Name: "改名", Visibility: "private", AnswerConfig: &dto.AnswerConfig{Model: "anything"}})
	var app *apperror.Error
	if err == nil || !errors.As(err, &app) || app.Code != "VALIDATION_ERROR" {
		t.Fatalf("expected empty whitelist to reject overrides, got %v", err)
	}
	if _, err := w.kbs.Update(ctx, owner.ID, kbID, dto.KnowledgeBaseRequest{Name: "改名", Visibility: "private", AnswerConfig: &dto.AnswerConfig{Model: ""}}); err != nil {
		t.Fatalf("empty model must stay allowed: %v", err)
	}
}
