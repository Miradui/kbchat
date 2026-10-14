package service

import (
	"context"
	"errors"
	"github.com/google/uuid"
	"gorm.io/gorm"
	"kbchat/backend/internal/apperror"
	"kbchat/backend/internal/dto"
	"kbchat/backend/internal/model"
	"strings"
	"unicode"
	"unicode/utf8"
)

func templateVariables(body string) ([]string, error) {
	vars := []string{}
	seen := map[string]bool{}
	invalid := func() ([]string, error) {
		return nil, apperror.Validation(map[string]any{"body": "变量请写作 {{变量名}}；名称仅含中英文、数字、下划线或连字符，最多 40 字、20 个不同变量"})
	}
	for {
		start := strings.Index(body, "{{")
		end := strings.Index(body, "}}")
		if start < 0 {
			if end >= 0 {
				return invalid()
			}
			break
		}
		if end < start {
			return invalid()
		}
		name := strings.TrimSpace(body[start+2 : end])
		if name == "" || utf8.RuneCountInString(name) > 40 {
			return invalid()
		}
		for _, r := range name {
			if !unicode.IsLetter(r) && !unicode.IsNumber(r) && r != '_' && r != '-' {
				return invalid()
			}
		}
		if !seen[name] {
			vars = append(vars, name)
			seen[name] = true
		}
		if len(vars) > 20 {
			return invalid()
		}
		body = body[end+2:]
	}
	return vars, nil
}
func questionTemplateResponse(item model.QuestionTemplate) dto.QuestionTemplateResponse {
	vars, _ := templateVariables(item.Body)
	return dto.QuestionTemplateResponse{ID: item.ID.String(), Title: item.Title, Body: item.Body, Variables: vars, CreatedAt: item.CreatedAt, UpdatedAt: item.UpdatedAt}
}
func templateError(err error) error {
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return apperror.NotFound("RESOURCE_NOT_FOUND", "模板不存在或不属于当前用户")
	}
	return apperror.Internal(err)
}
func (s *ChatService) ListQuestionTemplates(ctx context.Context, userID uuid.UUID, q dto.PersonalListQuery) (*dto.QuestionTemplateListResponse, error) {
	if err := validatePersonalList(&q); err != nil {
		return nil, err
	}
	items, total, err := s.chats.ListQuestionTemplates(ctx, userID, q)
	if err != nil {
		return nil, apperror.Internal(err)
	}
	res := &dto.QuestionTemplateListResponse{Items: []dto.QuestionTemplateResponse{}, Total: total, Page: q.Page, PageSize: q.PageSize}
	for _, item := range items {
		res.Items = append(res.Items, questionTemplateResponse(item))
	}
	return res, nil
}
func (s *ChatService) SaveQuestionTemplate(ctx context.Context, userID uuid.UUID, id *uuid.UUID, req dto.SaveQuestionTemplateRequest) (*dto.QuestionTemplateResponse, error) {
	title, body := strings.TrimSpace(req.Title), strings.TrimSpace(req.Body)
	if title == "" || utf8.RuneCountInString(title) > 100 || body == "" || utf8.RuneCountInString(body) > 12000 {
		return nil, apperror.Validation(map[string]any{"template": "标题为 1–100 字，正文为 1–12000 字"})
	}
	if _, err := templateVariables(body); err != nil {
		return nil, err
	}
	var item *model.QuestionTemplate
	if id == nil {
		item = &model.QuestionTemplate{ID: uuid.New(), UserID: userID, Title: title, Body: body}
		if err := s.chats.CreateQuestionTemplate(ctx, item); err != nil {
			return nil, templateError(err)
		}
	} else {
		var err error
		item, err = s.chats.UpdateQuestionTemplate(ctx, userID, *id, title, body)
		if err != nil {
			return nil, templateError(err)
		}
	}
	res := questionTemplateResponse(*item)
	return &res, nil
}
func (s *ChatService) DeleteQuestionTemplate(ctx context.Context, userID, id uuid.UUID) error {
	if err := s.chats.DeleteQuestionTemplate(ctx, userID, id); err != nil {
		return templateError(err)
	}
	return nil
}
