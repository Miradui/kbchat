package service

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/google/uuid"

	"kbchat/backend/internal/access"
	"kbchat/backend/internal/apperror"
	"kbchat/backend/internal/dto"
	"kbchat/backend/internal/repository"
)

func (s *ChatService) ListMessagePage(ctx context.Context, userID, sessionID uuid.UUID, query dto.ChatMessagePageQuery) (*dto.ChatMessageListResponse, error) {
	session, err := s.authorizeSession(ctx, userID, sessionID, access.CapChatUse)
	if err != nil {
		return nil, err
	}
	if query.Limit < 1 || query.Limit > 100 || (query.Before != "" && query.Since != "") {
		return nil, apperror.Validation(map[string]any{"pagination": "limit must be 1-100; before and since are mutually exclusive"})
	}
	decode := func(value string) (*repository.ChatHistoryCursor, error) {
		if value == "" {
			return nil, nil
		}
		invalid := apperror.Validation(map[string]any{"cursor": "message cursor is invalid for this session"})
		if len(value) > 512 {
			return nil, invalid
		}
		data, err := base64.RawURLEncoding.DecodeString(value)
		if err != nil {
			return nil, invalid
		}
		var cursor repository.ChatHistoryCursor
		if json.Unmarshal(data, &cursor) != nil || cursor.ID == uuid.Nil || cursor.SessionID != sessionID || cursor.CreatedAt.IsZero() {
			return nil, invalid
		}
		return &cursor, nil
	}
	before, err := decode(query.Before)
	if err != nil {
		return nil, err
	}
	since, err := decode(query.Since)
	if err != nil {
		return nil, err
	}
	if query.Revision != "" {
		if _, err := uuid.Parse(query.Revision); err != nil {
			return nil, apperror.Validation(map[string]any{"revision": "revision is invalid"})
		}
	}
	page, err := s.chats.ListMessagePage(ctx, session.ID, repository.ChatHistoryQuery{Limit: query.Limit, Before: before, Since: since, Revision: query.Revision})
	if errors.Is(err, repository.ErrChatMessageChanged) {
		return nil, apperror.New(http.StatusConflict, "CHAT_MESSAGE_CHANGED", "conversation history changed; reload the latest page")
	}
	if err != nil {
		return nil, apperror.Internal(err)
	}
	res := &dto.ChatMessageListResponse{Items: make([]dto.ChatMessageResponse, 0, len(page.Items)), HasMore: page.HasMore, Revision: page.Revision}
	if page.NextCursor != nil {
		data, _ := json.Marshal(page.NextCursor)
		res.NextCursor = base64.RawURLEncoding.EncodeToString(data)
	}
	for i := range page.Items {
		res.Items = append(res.Items, toChatMessageResponse(&page.Items[i]))
	}
	return res, nil
}
