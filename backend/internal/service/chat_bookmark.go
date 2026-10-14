package service

import (
	"context"
	"github.com/google/uuid"
	"kbchat/backend/internal/access"
	"kbchat/backend/internal/apperror"
	"kbchat/backend/internal/dto"
	"kbchat/backend/internal/model"
	"strings"
	"unicode/utf8"
)

func validatePersonalList(q *dto.PersonalListQuery) error {
	q.Q = strings.TrimSpace(q.Q)
	if utf8.RuneCountInString(q.Q) > 200 || q.Page < 1 || q.Page > 1000000 || q.PageSize < 1 || q.PageSize > 100 {
		return apperror.Validation(map[string]any{"query": "q must be at most 200 characters; page must be 1-1000000 and pageSize 1-100"})
	}
	return nil
}
func bookmarkResponse(b *model.ChatBookmark) *dto.ChatBookmarkResponse {
	if b == nil {
		return nil
	}
	return &dto.ChatBookmarkResponse{MessageID: b.MessageID.String(), Note: b.Note, CreatedAt: b.CreatedAt, UpdatedAt: b.UpdatedAt}
}
func (s *ChatService) SaveBookmark(ctx context.Context, userID, messageID uuid.UUID, note string) (*dto.ChatBookmarkResponse, error) {
	note = strings.TrimSpace(note)
	if utf8.RuneCountInString(note) > 4000 {
		return nil, apperror.Validation(map[string]any{"note": "note must be at most 4000 characters"})
	}
	m, err := s.chats.FindMessageByIDAndOwner(ctx, messageID, userID, access.MemberRolesWith(access.CapChatUse))
	if err != nil {
		return nil, apperror.Internal(err)
	}
	if m == nil {
		return nil, apperror.NotFound("RESOURCE_NOT_FOUND", "resource not found")
	}
	if m.Role != "assistant" {
		return nil, apperror.Validation(map[string]any{"messageId": "only assistant answers can be bookmarked"})
	}
	b := &model.ChatBookmark{MessageID: messageID, UserID: userID, Note: note}
	if err = s.chats.SaveBookmark(ctx, b); err != nil {
		return nil, apperror.Internal(err)
	}
	return bookmarkResponse(b), nil
}
func (s *ChatService) DeleteBookmark(ctx context.Context, userID, messageID uuid.UUID) error {
	m, err := s.chats.FindMessageByIDAndOwner(ctx, messageID, userID, access.MemberRolesWith(access.CapChatUse))
	if err != nil {
		return apperror.Internal(err)
	}
	if m == nil {
		return apperror.NotFound("RESOURCE_NOT_FOUND", "resource not found")
	}
	if err = s.chats.DeleteBookmark(ctx, userID, messageID); err != nil {
		return apperror.Internal(err)
	}
	return nil
}
func (s *ChatService) ListBookmarks(ctx context.Context, userID uuid.UUID, q dto.PersonalListQuery) (*dto.ChatBookmarkListResponse, error) {
	if err := validatePersonalList(&q); err != nil {
		return nil, err
	}
	items, total, err := s.chats.ListBookmarks(ctx, userID, access.MemberRolesWith(access.CapChatUse), q)
	if err != nil {
		return nil, apperror.Internal(err)
	}
	res := &dto.ChatBookmarkListResponse{Items: []dto.ChatBookmarkItem{}, Total: total, Page: q.Page, PageSize: q.PageSize}
	for _, i := range items {
		res.Items = append(res.Items, dto.ChatBookmarkItem{
			ChatMessageSearchItem: dto.ChatMessageSearchItem{MessageID: i.MessageID.String(), SessionID: i.SessionID.String(), SessionTitle: i.SessionTitle, ArchivedAt: i.ArchivedAt, Role: i.Role, CreatedAt: i.CreatedAt, Excerpt: chatSearchExcerpt(i.Content, q.Q)},
			Bookmark:              dto.ChatBookmarkResponse{MessageID: i.MessageID.String(), Note: i.Note, CreatedAt: i.BookmarkedAt, UpdatedAt: i.BookmarkUpdatedAt},
		})
	}
	return res, nil
}
