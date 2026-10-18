package service

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"github.com/google/uuid"
	"kbchat/backend/internal/access"
	"kbchat/backend/internal/apperror"
	"kbchat/backend/internal/dto"
	"kbchat/backend/internal/model"
	"strings"
	"time"
	"unicode/utf8"
)

func (s *ChatService) SetEvaluations(evaluations *EvaluationService) { s.evaluations = evaluations }
func issueKey(question string) string {
	sum := sha256.Sum256([]byte(question))
	return hex.EncodeToString(sum[:])
}
func (s *ChatService) issueSession(ctx context.Context, actor, id uuid.UUID, question string) (*model.ChatSession, error) {
	session, err := s.authorizeSession(ctx, actor, id, access.CapChatUse)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(question) == "" || utf8.RuneCountInString(question) > 4000 {
		return nil, apperror.Validation(map[string]any{"question": "问题须为 1–4000 字"})
	}
	exists, err := s.chats.HasQuestion(ctx, id, question)
	if err != nil {
		return nil, apperror.Internal(err)
	}
	if !exists {
		return nil, apperror.NotFound("RESOURCE_NOT_FOUND", "来源问题不存在或已修改")
	}
	return session, nil
}
func (s *ChatService) GetQualityIssue(ctx context.Context, actor, id uuid.UUID, question string) (*dto.ChatQualityIssueResponse, error) {
	session, err := s.issueSession(ctx, actor, id, question)
	if err != nil {
		return nil, err
	}
	item, err := s.chats.QualityIssue(ctx, actor, id, issueKey(question))
	if err != nil {
		return nil, apperror.Internal(err)
	}
	res := &dto.ChatQualityIssueResponse{ChatQualityIssueRequest: dto.ChatQualityIssueRequest{Question: question, Status: "open", DocumentIDs: []string{}}}
	if item == nil {
		return res, nil
	}
	res.Status, res.Note, res.UpdatedAt = item.Status, item.Note, &item.UpdatedAt
	if item.EvaluationCaseID != nil {
		res.EvaluationCaseID = item.EvaluationCaseID.String()
	}
	if item.EvaluationRunID != nil {
		res.EvaluationRunID = item.EvaluationRunID.String()
	}
	_ = json.Unmarshal(item.DocumentIDs, &res.DocumentIDs)
	// References may outlive a membership or a linked case. Keep the user's own
	// note editable while omitting references that are no longer accessible.
	if len(res.DocumentIDs) > 0 {
		ids, err := dto.ParseDocumentIDs(res.DocumentIDs)
		if err != nil {
			return nil, apperror.Internal(err)
		}
		bases, err := s.knowledgeBases.ListChatKnowledgeBases(ctx, actor)
		if err != nil {
			return nil, apperror.Internal(err)
		}
		baseIDs := []uuid.UUID{}
		for _, base := range bases {
			baseIDs = append(baseIDs, base.ID)
		}
		docs, err := s.chats.FindScopeDocuments(ctx, ids, baseIDs)
		if err != nil {
			return nil, apperror.Internal(err)
		}
		res.DocumentIDs = []string{}
		for _, doc := range docs {
			res.DocumentIDs = append(res.DocumentIDs, doc.ID.String())
		}
	}
	if s.evaluations != nil && res.EvaluationCaseID != "" {
		cases, err := s.evaluations.ListCases(ctx, actor, session.KnowledgeBaseID)
		if err != nil && !isMissingQualityReference(err) {
			return nil, err
		}
		found := false
		for _, test := range cases {
			if test.ID == res.EvaluationCaseID {
				found = true
			}
		}
		if !found {
			res.EvaluationCaseID = ""
		}
	}
	if s.evaluations != nil && res.EvaluationRunID != "" {
		_, err := s.evaluations.GetRun(ctx, actor, session.KnowledgeBaseID, *item.EvaluationRunID)
		if err != nil {
			if !isMissingQualityReference(err) {
				return nil, err
			}
			res.EvaluationRunID = ""
		}
	}
	return res, nil
}

func isMissingQualityReference(err error) bool {
	var app *apperror.Error
	return errors.As(err, &app) && (app.Status == 403 || app.Status == 404)
}
func (s *ChatService) SaveQualityIssue(ctx context.Context, actor, id uuid.UUID, req dto.ChatQualityIssueRequest) (*dto.ChatQualityIssueResponse, error) {
	session, err := s.issueSession(ctx, actor, id, req.Question)
	if err != nil {
		return nil, err
	}
	if req.Status != "open" && req.Status != "retest" && req.Status != "resolved" {
		return nil, apperror.Validation(map[string]any{"status": "无效的处理状态"})
	}
	if utf8.RuneCountInString(req.Note) > 4000 {
		return nil, apperror.Validation(map[string]any{"note": "备注最多 4000 字"})
	}
	item := &model.ChatQualityIssue{UserID: actor, SessionID: id, QuestionKey: issueKey(req.Question), Question: req.Question, Status: req.Status, Note: req.Note, UpdatedAt: time.Now().UTC()}
	if len(req.DocumentIDs) > 0 {
		ids, err := dto.ParseDocumentIDs(req.DocumentIDs)
		if err != nil {
			return nil, err
		}
		bases, err := s.knowledgeBases.ListChatKnowledgeBases(ctx, actor)
		if err != nil {
			return nil, apperror.Internal(err)
		}
		baseIDs := []uuid.UUID{}
		for _, base := range bases {
			baseIDs = append(baseIDs, base.ID)
		}
		docs, err := s.chats.FindScopeDocuments(ctx, ids, baseIDs)
		if err != nil {
			return nil, apperror.Internal(err)
		}
		if len(docs) != len(ids) {
			return nil, apperror.NotFound("RESOURCE_NOT_FOUND", "补充资料不可访问")
		}
	}
	if req.DocumentIDs == nil {
		req.DocumentIDs = []string{}
	}
	item.DocumentIDs, _ = json.Marshal(req.DocumentIDs)
	if req.EvaluationCaseID != "" {
		if s.evaluations == nil {
			return nil, apperror.New(503, "EVALUATION_NOT_CONFIGURED", "评测未配置")
		}
		caseID, err := uuid.Parse(req.EvaluationCaseID)
		if err != nil {
			return nil, apperror.Validation(map[string]any{"evaluationCaseId": "无效的测试问题"})
		}
		cases, err := s.evaluations.ListCases(ctx, actor, session.KnowledgeBaseID)
		if err != nil {
			return nil, err
		}
		found := false
		for _, test := range cases {
			if test.ID == req.EvaluationCaseID && test.Question == req.Question && (test.SourceSessionID == id.String() || (test.Scope == nil && !session.IsAutomatic() && len(session.KnowledgeBaseLinks) == 0 && len(session.DocumentScope) <= 2)) {
				found = true
			}
		}
		if !found {
			return nil, apperror.Validation(map[string]any{"evaluationCaseId": "请选择同一问题和来源范围的测试用例"})
		}
		item.EvaluationCaseID = &caseID
	}
	if req.EvaluationRunID != "" {
		runID, err := uuid.Parse(req.EvaluationRunID)
		if err != nil || item.EvaluationCaseID == nil {
			return nil, apperror.Validation(map[string]any{"evaluationRunId": "请先关联有效测试问题"})
		}
		run, err := s.evaluations.GetRun(ctx, actor, session.KnowledgeBaseID, runID)
		if err != nil {
			return nil, err
		}
		found := false
		for _, test := range run.Cases {
			if test.ID == req.EvaluationCaseID {
				found = true
			}
		}
		if !found {
			return nil, apperror.Validation(map[string]any{"evaluationRunId": "运行记录未包含所选测试问题"})
		}
		item.EvaluationRunID = &runID
	}
	if _, err = s.issueSession(ctx, actor, id, req.Question); err != nil {
		return nil, err
	}
	if err = s.chats.SaveQualityIssue(ctx, item); err != nil {
		return nil, apperror.Internal(err)
	}
	return s.GetQualityIssue(ctx, actor, id, req.Question)
}
