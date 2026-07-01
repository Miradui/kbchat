package service

import (
	"context"
	"strings"

	"rag/backend/internal/apperror"
	"rag/backend/internal/dto"
	"rag/backend/internal/repository"
)

type UserService struct {
	users *repository.UserRepository
}

func NewUserService(users *repository.UserRepository) *UserService {
	return &UserService{users: users}
}

func (s *UserService) Search(ctx context.Context, query string, limit int) (*dto.UserSearchResponse, error) {
	items, err := s.users.Search(ctx, strings.TrimSpace(query), limit)
	if err != nil {
		return nil, apperror.Internal(err)
	}
	res := &dto.UserSearchResponse{Items: make([]dto.UserSummary, 0, len(items))}
	for i := range items {
		res.Items = append(res.Items, dto.UserSummary{
			ID:          items[i].ID.String(),
			Username:    items[i].Username,
			DisplayName: items[i].DisplayName,
			AvatarURL:   items[i].AvatarURL,
		})
	}
	return res, nil
}
