package service

import (
	"context"
	"errors"
	"github.com/google/uuid"
	"gorm.io/gorm"
	"kbchat/backend/internal/access"
	"kbchat/backend/internal/apperror"
	"kbchat/backend/internal/dto"
	"kbchat/backend/internal/repository"
	"net/http"
	"strings"
	"unicode/utf8"
)

func (s *ChatService) CreateBranch(ctx context.Context, userID, sessionID uuid.UUID, req dto.CreateChatBranchRequest) (*dto.ChatSessionResponse, error) {
	messageID, err := uuid.Parse(req.MessageID)
	if err != nil || messageID == uuid.Nil {
		return nil, apperror.Validation(map[string]any{"messageId": "请选择有效的回答"})
	}
	requestID, err := uuid.Parse(req.ClientRequestID)
	if err != nil || requestID == uuid.Nil {
		return nil, apperror.Validation(map[string]any{"clientRequestId": "请求标识须为 UUID"})
	}
	title := strings.TrimSpace(req.Title)
	if utf8.RuneCountInString(title) > 100 {
		return nil, apperror.Validation(map[string]any{"title": "标题最多 100 字"})
	}
	id, err := s.chats.CreateBranch(ctx, userID, sessionID, messageID, requestID, title, access.MemberRolesWith(access.CapChatUse))
	switch {
	case errors.Is(err, gorm.ErrRecordNotFound):
		return nil, apperror.NotFound("RESOURCE_NOT_FOUND", "resource not found")
	case errors.Is(err, repository.ErrChatBranchTargetInvalid):
		return nil, apperror.Validation(map[string]any{"messageId": "只能从回答创建分支"})
	case errors.Is(err, repository.ErrChatBranchRequestConflict):
		return nil, apperror.New(http.StatusConflict, "CHAT_BRANCH_REQUEST_CONFLICT", "该请求标识已用于其他分支，请重新打开创建窗口")
	case errors.Is(err, repository.ErrChatBranchTooLarge):
		return nil, apperror.New(http.StatusBadRequest, "CHAT_BRANCH_TOO_LARGE", "分支历史最多 10000 条消息、16 MiB 正文与引用")
	case err != nil:
		return nil, apperror.Internal(err)
	}
	return s.GetSession(ctx, userID, id)
}
