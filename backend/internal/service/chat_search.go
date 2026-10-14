package service

import (
	"context"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"

	"kbchat/backend/internal/access"
	"kbchat/backend/internal/apperror"
	"kbchat/backend/internal/dto"
)

func (s *ChatService) SearchMessages(ctx context.Context, userID uuid.UUID, query dto.ChatMessageSearchQuery) (*dto.ChatMessageSearchResponse, error) {
	query.Q = strings.TrimSpace(query.Q)
	if query.Q == "" || utf8.RuneCountInString(query.Q) > 200 || query.Page < 1 || query.Page > 1000000 || query.PageSize < 1 || query.PageSize > 100 {
		return nil, apperror.Validation(map[string]any{"search": "q must contain 1-200 characters; page must be 1-1000000 and pageSize 1-100"})
	}
	if query.SessionID != nil {
		if _, err := s.authorizeSession(ctx, userID, *query.SessionID, access.CapChatUse); err != nil {
			return nil, err
		}
	}
	items, total, err := s.chats.SearchMessages(ctx, userID, access.MemberRolesWith(access.CapChatUse), query)
	if err != nil {
		return nil, apperror.Internal(err)
	}
	res := &dto.ChatMessageSearchResponse{Items: make([]dto.ChatMessageSearchItem, 0, len(items)), Total: total, Page: query.Page, PageSize: query.PageSize}
	for _, item := range items {
		res.Items = append(res.Items, dto.ChatMessageSearchItem{
			MessageID: item.MessageID.String(), SessionID: item.SessionID.String(), SessionTitle: item.SessionTitle,
			ArchivedAt: item.ArchivedAt, Role: item.Role, CreatedAt: item.CreatedAt, Excerpt: chatSearchExcerpt(item.Content, query.Q),
		})
	}
	return res, nil
}

func chatSearchExcerpt(content, term string) dto.ChatSearchExcerpt {
	lower := strings.ToLower(content)
	byteIndex := strings.Index(lower, strings.ToLower(term))
	if byteIndex < 0 {
		// Database collation may fold characters differently from Go.
		return dto.ChatSearchExcerpt{Before: truncateRunes(content, 120)}
	}
	runes := []rune(content)
	index := utf8.RuneCountInString(lower[:byteIndex])
	end := min(len(runes), index+utf8.RuneCountInString(term))
	start, stop := max(0, index-40), min(len(runes), end+80)
	excerpt := dto.ChatSearchExcerpt{Before: string(runes[start:index]), Match: string(runes[index:end]), After: string(runes[end:stop])}
	if start > 0 {
		excerpt.Before = "…" + excerpt.Before
	}
	if stop < len(runes) {
		excerpt.After += "…"
	}
	return excerpt
}
