package service

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"go.uber.org/zap"
	"gorm.io/datatypes"
	"kbchat/backend/internal/access"
	"kbchat/backend/internal/apperror"
	"kbchat/backend/internal/authz"
	"kbchat/backend/internal/dto"
	"kbchat/backend/internal/model"
	"kbchat/backend/internal/repository"
	"kbchat/backend/internal/retrieval"
)

type EvaluationService struct {
	repo *repository.EvaluationRepository
	kbs  *repository.KnowledgeBaseRepository
	chat *ChatService
}

func NewEvaluationService(repo *repository.EvaluationRepository, kbs *repository.KnowledgeBaseRepository, chat *ChatService) *EvaluationService {
	return &EvaluationService{repo: repo, kbs: kbs, chat: chat}
}

func (s *EvaluationService) authorize(ctx context.Context, actor, kbID uuid.UUID, run bool) error {
	if _, err := authz.KnowledgeBase(ctx, s.kbs, actor, kbID, access.CapQualityRead); err != nil {
		return err
	}
	if run {
		_, err := authz.KnowledgeBase(ctx, s.kbs, actor, kbID, access.CapChatUse)
		return err
	}
	return nil
}

func evaluationError(err error) error {
	if errors.Is(err, repository.ErrEvaluationMissing) {
		return apperror.NotFound("RESOURCE_NOT_FOUND", "评测记录不存在")
	}
	if errors.Is(err, repository.ErrEvaluationLimit) {
		return apperror.New(409, "EVALUATION_LIMIT", "已达到评测数量上限，请清理测试问题或等待当前运行结束")
	}
	return apperror.Internal(err)
}

func caseResponse(item model.EvaluationCase) dto.EvaluationCaseResponse {
	keywords := []string{}
	_ = json.Unmarshal(item.RequiredKeywords, &keywords)
	return dto.EvaluationCaseResponse{ID: item.ID.String(), KnowledgeBaseID: item.KnowledgeBaseID.String(), CreatedAt: item.CreatedAt, UpdatedAt: item.UpdatedAt,
		EvaluationCaseRequest: dto.EvaluationCaseRequest{Question: item.Question, ExpectedAnswer: item.ExpectedAnswer, RequiredKeywords: keywords, RequireCitation: item.RequireCitation}}
}

func (s *EvaluationService) ListCases(ctx context.Context, actor, kbID uuid.UUID) ([]dto.EvaluationCaseResponse, error) {
	if err := s.authorize(ctx, actor, kbID, false); err != nil {
		return nil, err
	}
	items, err := s.repo.ListCases(ctx, kbID)
	if err != nil {
		return nil, evaluationError(err)
	}
	res := make([]dto.EvaluationCaseResponse, 0, len(items))
	for _, item := range items {
		res = append(res, caseResponse(item))
	}
	return res, nil
}

func (s *EvaluationService) SaveCase(ctx context.Context, actor, kbID, id uuid.UUID, req dto.EvaluationCaseRequest) (*dto.EvaluationCaseResponse, error) {
	if err := s.authorize(ctx, actor, kbID, false); err != nil {
		return nil, err
	}
	req.Question, req.ExpectedAnswer = strings.TrimSpace(req.Question), strings.TrimSpace(req.ExpectedAnswer)
	if req.Question == "" || utf8.RuneCountInString(req.Question) > 4000 || utf8.RuneCountInString(req.ExpectedAnswer) > 8000 || len(req.RequiredKeywords) > 20 {
		return nil, apperror.Validation(map[string]any{"case": "question 1-4000 characters, reference at most 8000 characters, at most 20 keywords"})
	}
	keywords, seen := []string{}, map[string]bool{}
	for _, keyword := range req.RequiredKeywords {
		keyword = strings.TrimSpace(keyword)
		if keyword == "" || utf8.RuneCountInString(keyword) > 100 {
			return nil, apperror.Validation(map[string]any{"requiredKeywords": "keywords must contain 1-100 characters"})
		}
		key := strings.ToLower(keyword)
		if !seen[key] {
			keywords = append(keywords, keyword)
			seen[key] = true
		}
	}
	encoded, _ := json.Marshal(keywords)
	item := model.EvaluationCase{ID: id, KnowledgeBaseID: kbID, CreatedBy: actor, Question: req.Question, ExpectedAnswer: req.ExpectedAnswer, RequiredKeywords: encoded, RequireCitation: req.RequireCitation}
	var err error
	if id == uuid.Nil {
		item.ID = uuid.New()
		err = s.repo.CreateCase(ctx, &item)
	} else {
		err = s.repo.UpdateCase(ctx, &item)
	}
	if err != nil {
		return nil, evaluationError(err)
	}
	res := caseResponse(item)
	return &res, nil
}

func (s *EvaluationService) DeleteCase(ctx context.Context, actor, kbID, id uuid.UUID) error {
	if err := s.authorize(ctx, actor, kbID, false); err != nil {
		return err
	}
	if err := s.repo.DeleteCase(ctx, kbID, id); err != nil {
		return evaluationError(err)
	}
	return nil
}

func runResponse(run *model.EvaluationRun, detail bool) (*dto.EvaluationRunResponse, error) {
	res := &dto.EvaluationRunResponse{ID: run.ID.String(), KnowledgeBaseID: run.KnowledgeBaseID.String(), ClientRequestID: run.ClientRequestID.String(), Name: run.Name, Status: run.Status,
		ErrorMessage: run.ErrorMessage, CreatedAt: run.CreatedAt, StartedAt: run.StartedAt, FinishedAt: run.FinishedAt}
	for _, pair := range []struct {
		data   []byte
		target any
	}{{run.Config, &res.Config}, {run.Cases, &res.Cases}, {run.Results, &res.Results}, {run.Runtime, &res.Runtime}} {
		if err := json.Unmarshal(pair.data, pair.target); err != nil {
			return nil, apperror.Internal(err)
		}
	}
	res.AnswerConfig = defaultAnswerConfig
	if len(run.AnswerConfig) > 0 {
		if err := json.Unmarshal(run.AnswerConfig, &res.AnswerConfig); err != nil {
			return nil, apperror.Internal(err)
		}
	}
	res.Total, res.CompletedCount = len(res.Cases), len(res.Results)
	if !detail {
		res.Cases, res.Results = nil, nil
	}
	return res, nil
}

func (s *EvaluationService) CreateRun(ctx context.Context, actor, kbID uuid.UUID, req dto.EvaluationRunRequest) (*dto.EvaluationRunResponse, error) {
	if err := s.authorize(ctx, actor, kbID, true); err != nil {
		return nil, err
	}
	requestID, err := uuid.Parse(req.ClientRequestID)
	if err != nil || requestID == uuid.Nil {
		return nil, apperror.Validation(map[string]any{"clientRequestId": "a UUID is required"})
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" {
		req.Name = "回归评测"
	}
	cfg := req.Config
	if utf8.RuneCountInString(req.Name) > 80 || len(req.CaseIDs) < 1 || len(req.CaseIDs) > 20 || cfg.VectorTopN < 1 || cfg.VectorTopN > retrieval.MaxVectorTopN || cfg.RerankTopK < 1 || cfg.RerankTopK > retrieval.MaxRerankTopK || cfg.RerankTopK > cfg.VectorTopN || math.IsNaN(cfg.ScoreThreshold) || cfg.ScoreThreshold < 0 || cfg.ScoreThreshold > 1 {
		return nil, apperror.Validation(map[string]any{"run": "invalid name, case count or retrieval configuration"})
	}
	seen := map[string]bool{}
	for i, value := range req.CaseIDs {
		id, err := uuid.Parse(value)
		if err != nil || id == uuid.Nil || seen[id.String()] {
			return nil, apperror.Validation(map[string]any{"caseIds": "unique case UUIDs are required"})
		}
		req.CaseIDs[i] = id.String()
		seen[id.String()] = true
	}
	sort.Strings(req.CaseIDs)
	req.ClientRequestID = requestID.String()
	input, _ := json.Marshal(req)
	sum := sha256.Sum256(input)
	hash := hex.EncodeToString(sum[:])
	existing, err := s.repo.FindRunRequest(ctx, kbID, actor, requestID)
	if err != nil {
		return nil, evaluationError(err)
	}
	if existing != nil {
		return matchingRun(existing, hash)
	}
	items, err := s.repo.ListCases(ctx, kbID)
	if err != nil {
		return nil, evaluationError(err)
	}
	snapshots := []dto.EvaluationCaseResponse{}
	for _, item := range items {
		if seen[item.ID.String()] {
			snapshots = append(snapshots, caseResponse(item))
		}
	}
	if len(snapshots) != len(req.CaseIDs) {
		return nil, apperror.NotFound("RESOURCE_NOT_FOUND", "部分测试问题不存在或不属于当前知识库")
	}
	sort.Slice(snapshots, func(i, j int) bool { return snapshots[i].ID < snapshots[j].ID })
	cases, _ := json.Marshal(snapshots)
	config, _ := json.Marshal(cfg)
	// The answer configuration is frozen with the run: a later edit to the
	// knowledge base must not change what an old run reports it was generated with.
	kb, err := s.kbs.FindByID(ctx, kbID)
	if err != nil {
		return nil, apperror.Internal(err)
	}
	answerConfig, _ := json.Marshal(storedAnswerConfig(kb))
	run, err := s.repo.CreateRun(ctx, &model.EvaluationRun{ID: uuid.New(), KnowledgeBaseID: kbID, CreatedBy: actor, ClientRequestID: requestID, RequestHash: hash, Name: req.Name, Status: "queued", Cases: cases, Config: config, AnswerConfig: answerConfig, Results: datatypes.JSON("[]"), Runtime: datatypes.JSON("{}")})
	if err != nil {
		return nil, evaluationError(err)
	}
	return matchingRun(run, hash)
}

func matchingRun(run *model.EvaluationRun, hash string) (*dto.EvaluationRunResponse, error) {
	if run.RequestHash != hash {
		return nil, apperror.New(409, "EVALUATION_REQUEST_CONFLICT", "同一请求编号不能用于不同评测，请刷新运行记录后重新操作")
	}
	return runResponse(run, true)
}

func (s *EvaluationService) ListRuns(ctx context.Context, actor, kbID uuid.UUID) ([]dto.EvaluationRunResponse, error) {
	if err := s.authorize(ctx, actor, kbID, false); err != nil {
		return nil, err
	}
	items, err := s.repo.ListRuns(ctx, kbID)
	if err != nil {
		return nil, evaluationError(err)
	}
	res := make([]dto.EvaluationRunResponse, 0, len(items))
	for i := range items {
		item, err := runResponse(&items[i], false)
		if err != nil {
			return nil, err
		}
		res = append(res, *item)
	}
	return res, nil
}

func (s *EvaluationService) GetRun(ctx context.Context, actor, kbID, id uuid.UUID) (*dto.EvaluationRunResponse, error) {
	if err := s.authorize(ctx, actor, kbID, false); err != nil {
		return nil, err
	}
	run, err := s.repo.GetRun(ctx, kbID, id)
	if err != nil {
		return nil, evaluationError(err)
	}
	return runResponse(run, true)
}

func (s *EvaluationService) CancelRun(ctx context.Context, actor, kbID, id uuid.UUID) (*dto.EvaluationRunResponse, error) {
	if _, err := s.GetRun(ctx, actor, kbID, id); err != nil {
		return nil, err
	}
	if err := s.repo.CancelRun(ctx, kbID, id); err != nil {
		return nil, evaluationError(err)
	}
	return s.GetRun(ctx, actor, kbID, id)
}

func (s *EvaluationService) RunWorker(ctx context.Context, log *zap.Logger) {
	for ctx.Err() == nil {
		worked, err := s.ProcessNext(ctx)
		if err != nil {
			log.Warn("evaluation worker failed", zap.Error(err))
		}
		if worked && err == nil {
			continue
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(2 * time.Second):
		}
	}
}

func (s *EvaluationService) ProcessNext(ctx context.Context) (bool, error) {
	run, err := s.repo.ClaimNext(ctx)
	if err != nil || run == nil {
		return false, err
	}
	res, err := runResponse(run, true)
	if err != nil {
		return true, err
	}
	chatModel := s.chat.cfg.ChatModel
	if res.AnswerConfig.Model != "" {
		chatModel = res.AnswerConfig.Model
	}
	runtime, _ := json.Marshal(dto.EvaluationRuntime{ChatModel: chatModel, EmbeddingModel: s.chat.cfg.EmbeddingModel, RerankModel: s.chat.cfg.RerankModel, EffectiveRerank: s.chat.cfg.RerankEnabled && res.Config.EnableRerank})
	results := []dto.EvaluationResult{}
	save := func(status, message string) (bool, error) {
		data, _ := json.Marshal(results)
		writeCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		return s.repo.Checkpoint(writeCtx, run, data, runtime, status, message)
	}
	if ok, err := save("running", ""); err != nil || !ok {
		return true, err
	}
	workCtx, stop := context.WithCancel(ctx)
	heartbeatDone := make(chan struct{})
	go func() {
		defer close(heartbeatDone)
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-workCtx.Done():
				return
			case <-ticker.C:
				ok, err := s.repo.Heartbeat(workCtx, run)
				if err != nil || !ok {
					stop()
					return
				}
			}
		}
	}()
	defer func() { stop(); <-heartbeatDone }()
	for _, item := range res.Cases {
		if workCtx.Err() != nil {
			_, err = save("failed", "评测运行已中断，请重新发起评测。")
			return true, err
		}
		if err := s.authorize(workCtx, run.CreatedBy, run.KnowledgeBaseID, true); err != nil {
			_, writeErr := save("failed", "评测知识库不可访问或权限已变更。")
			return true, writeErr
		}
		// Observe cancellation before every external call, including fast test providers.
		if ok, err := s.repo.Heartbeat(workCtx, run); err != nil || !ok {
			return true, err
		}
		result := s.evaluateCase(workCtx, run, item, res.Config, res.AnswerConfig)
		if workCtx.Err() != nil {
			_, err = save("failed", "评测运行已中断，请重新发起评测。")
			return true, err
		}
		results = append(results, result)
		if ok, err := save("running", ""); err != nil || !ok {
			return true, err
		}
	}
	_, err = save("completed", "")
	return true, err
}

func (s *EvaluationService) evaluateCase(ctx context.Context, run *model.EvaluationRun, item dto.EvaluationCaseResponse, cfg dto.RetrievalConfig, answerConfig dto.AnswerConfig) dto.EvaluationResult {
	start := time.Now()
	result := dto.EvaluationResult{CaseID: item.ID, Citations: []dto.CitationResponse{}, MissingKeywords: []string{}}
	callCtx, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()
	generated, err := s.chat.generateAnswerWithHooks(callCtx, run.CreatedBy, &model.ChatSession{KnowledgeBaseID: run.KnowledgeBaseID}, item.Question, nil, answerHooks{retrievalConfig: &cfg, answerConfig: &answerConfig})
	result.DurationMS = time.Since(start).Milliseconds()
	if err != nil {
		result.ErrorCode, result.ErrorMessage = "EVALUATION_FAILED", "评测调用失败，请检查系统状态后重试。"
		var app *apperror.Error
		if errors.As(err, &app) {
			result.ErrorCode, result.ErrorMessage = app.Code, app.Message
		}
		return result
	}
	result.Answer, result.AnswerStatus, result.Citations, result.RerankFallback = generated.answer, &generated.answerStatus, generated.citations, generated.rerankFallback
	for _, keyword := range item.RequiredKeywords {
		if !strings.Contains(strings.ToLower(generated.answer), strings.ToLower(keyword)) {
			result.MissingKeywords = append(result.MissingKeywords, keyword)
		}
	}
	if item.RequireCitation || len(item.RequiredKeywords) > 0 {
		passed := len(result.MissingKeywords) == 0 && (!item.RequireCitation || len(result.Citations) > 0) && generated.answerStatus == AnswerStatusAnswered
		result.RulePassed = &passed
	}
	return result
}
