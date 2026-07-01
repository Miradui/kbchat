package service

import (
	"context"
	"net/http"

	"github.com/google/uuid"

	"rag/backend/internal/apperror"
	"rag/backend/internal/auth"
	"rag/backend/internal/config"
	"rag/backend/internal/dto"
	"rag/backend/internal/model"
	"rag/backend/internal/repository"
)

type AuthService struct {
	cfg   config.Config
	users *repository.UserRepository
}

func NewAuthService(cfg config.Config, users *repository.UserRepository) *AuthService {
	return &AuthService{cfg: cfg, users: users}
}

func (s *AuthService) Login(ctx context.Context, req dto.LoginRequest) (*dto.LoginResponse, error) {
	user, err := s.users.FindByUsername(ctx, req.Username)
	if err != nil {
		return nil, apperror.Internal(err)
	}
	if user == nil || !auth.CheckPassword(user.PasswordHash, req.Password) {
		return nil, apperror.New(http.StatusUnauthorized, "UNAUTHORIZED", "用户名或密码错误")
	}

	token, err := auth.GenerateToken(s.cfg, user.ID)
	if err != nil {
		return nil, apperror.Internal(err)
	}

	return &dto.LoginResponse{
		Token: token,
		User:  toUserResponse(user),
	}, nil
}

func (s *AuthService) Me(ctx context.Context, userID uuid.UUID) (*dto.UserResponse, error) {
	user, err := s.users.FindByID(ctx, userID)
	if err != nil {
		return nil, apperror.Internal(err)
	}
	if user == nil {
		return nil, apperror.Unauthorized()
	}

	res := toUserResponse(user)
	return &res, nil
}

func toUserResponse(user *model.User) dto.UserResponse {
	return dto.UserResponse{
		ID:          user.ID.String(),
		Username:    user.Username,
		DisplayName: user.DisplayName,
		AvatarURL:   user.AvatarURL,
		Role:        user.Role,
	}
}
