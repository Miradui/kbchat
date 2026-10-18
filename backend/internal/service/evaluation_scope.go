package service

import (
	"context"
	"encoding/json"
	"github.com/google/uuid"
	"gorm.io/datatypes"
	"kbchat/backend/internal/access"
	"kbchat/backend/internal/apperror"
	"kbchat/backend/internal/dto"
	"kbchat/backend/internal/model"
)

func evaluationScope(content []byte) (*dto.EvaluationScope, error) {
	if len(content) == 0 || string(content) == "{}" || string(content) == "null" {
		return nil, nil
	}
	var scope dto.EvaluationScope
	if err := json.Unmarshal(content, &scope); err != nil {
		return nil, apperror.Internal(err)
	}
	if scope.SourceSessionID == "" {
		return nil, apperror.NotFound("RESOURCE_NOT_FOUND", "测试范围不可访问")
	}
	return &scope, nil
}
func (s *EvaluationService) captureScope(ctx context.Context, actor, kbID uuid.UUID, source string) (datatypes.JSON, error) {
	if source == "" {
		return datatypes.JSON("{}"), nil
	}
	id, err := uuid.Parse(source)
	if err != nil {
		return nil, apperror.Validation(map[string]any{"sourceSessionId": "无效的来源会话"})
	}
	session, err := s.chat.authorizeSession(ctx, actor, id, access.CapChatUse)
	if err != nil {
		return nil, err
	}
	if session.KnowledgeBaseID != kbID {
		return nil, apperror.Validation(map[string]any{"sourceSessionId": "测试问题须保存在来源会话的首选知识库"})
	}
	documents, err := sessionDocuments(session)
	if err != nil {
		return nil, err
	}
	ids := []string{}
	for _, id := range session.KnowledgeBaseIDs() {
		ids = append(ids, id.String())
	}
	return json.Marshal(dto.EvaluationScope{SourceSessionID: source, ScopeMode: chatScopeMode(session), KnowledgeBaseIDs: ids, Documents: documents})
}
func (s *EvaluationService) scopeSession(ctx context.Context, actor, kbID uuid.UUID, scope *dto.EvaluationScope) (*model.ChatSession, error) {
	session := &model.ChatSession{UserID: actor, KnowledgeBaseID: kbID}
	if scope == nil {
		return session, nil
	}
	source, err := uuid.Parse(scope.SourceSessionID)
	if err != nil {
		return nil, apperror.NotFound("RESOURCE_NOT_FOUND", "测试范围不可访问")
	}
	if _, err = s.chat.authorizeSession(ctx, actor, source, access.CapChatUse); err != nil {
		return nil, err
	}
	if scope.ScopeMode != model.ChatScopeAuto && scope.ScopeMode != model.ChatScopeManual {
		return nil, apperror.Validation(map[string]any{"scope": "无效的评测范围"})
	}
	if len(scope.KnowledgeBaseIDs) == 0 {
		return nil, apperror.Validation(map[string]any{"scope": "评测范围为空"})
	}
	session.ScopeMode = scope.ScopeMode
	for i, value := range scope.KnowledgeBaseIDs {
		id, err := uuid.Parse(value)
		if err != nil {
			return nil, apperror.Validation(map[string]any{"scope": "无效的知识库"})
		}
		if _, err = s.chat.authorizeKnowledgeBase(ctx, actor, id, access.CapChatUse); err != nil {
			return nil, err
		}
		if i == 0 {
			if id != kbID {
				return nil, apperror.Validation(map[string]any{"scope": "首选知识库不一致"})
			}
		} else {
			session.KnowledgeBaseLinks = append(session.KnowledgeBaseLinks, model.ChatSessionKnowledgeBase{KnowledgeBaseID: id})
		}
	}
	if len(scope.Documents) > 0 {
		session.DocumentScope, _ = json.Marshal(scope.Documents)
	}
	return session, nil
}
func (s *EvaluationService) authorizeCaseScope(ctx context.Context, actor uuid.UUID, item model.EvaluationCase) error {
	scope, err := evaluationScope(item.Scope)
	if err != nil {
		return err
	}
	if scope == nil {
		return nil
	}
	if item.CreatedBy != actor {
		return apperror.NotFound("RESOURCE_NOT_FOUND", "测试问题不存在或不可访问")
	}
	_, err = s.scopeSession(ctx, actor, item.KnowledgeBaseID, scope)
	return err
}
func (s *EvaluationService) authorizeRunScope(ctx context.Context, actor uuid.UUID, run *model.EvaluationRun) error {
	if !run.IsPrivate {
		return nil
	}
	if actor != run.CreatedBy {
		return apperror.NotFound("RESOURCE_NOT_FOUND", "评测记录不存在或不可访问")
	}
	var cases []dto.EvaluationCaseResponse
	if err := json.Unmarshal(run.Cases, &cases); err != nil {
		return apperror.Internal(err)
	}
	for _, item := range cases {
		if _, err := s.scopeSession(ctx, actor, run.KnowledgeBaseID, item.Scope); err != nil {
			return err
		}
	}
	var results []dto.EvaluationResult
	if err := json.Unmarshal(run.Results, &results); err != nil {
		return apperror.Internal(err)
	}
	seen := map[string]bool{}
	for _, result := range results {
		for _, value := range result.KnowledgeBaseIDs {
			if seen[value] {
				continue
			}
			seen[value] = true
			id, err := uuid.Parse(value)
			if err != nil {
				return apperror.Internal(err)
			}
			if _, err = s.chat.authorizeKnowledgeBase(ctx, actor, id, access.CapChatUse); err != nil {
				return err
			}
		}
	}
	return nil
}
