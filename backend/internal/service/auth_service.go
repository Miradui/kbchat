package service

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"

	"kbchat/backend/internal/apperror"
	"kbchat/backend/internal/auth"
	"kbchat/backend/internal/config"
	"kbchat/backend/internal/dto"
	"kbchat/backend/internal/model"
	"kbchat/backend/internal/repository"
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

// UpdateProfile only exposes the two presentation fields. Username and role are
// deliberately not editable here: they are identity, not profile.
func (s *AuthService) UpdateProfile(ctx context.Context, userID uuid.UUID, req dto.UpdateProfileRequest) (*dto.UserResponse, error) {
	user, err := s.users.FindByID(ctx, userID)
	if err != nil {
		return nil, apperror.Internal(err)
	}
	if user == nil {
		return nil, apperror.Unauthorized()
	}

	displayName := strings.TrimSpace(req.DisplayName)
	if displayName == "" {
		return nil, apperror.Validation(map[string]any{"displayName": "显示名称不能为空"})
	}
	if utf8.RuneCountInString(displayName) > MaxDisplayNameLength {
		return nil, apperror.Validation(map[string]any{"displayName": "显示名称过长"})
	}
	avatarURL := strings.TrimSpace(req.AvatarURL)
	if err := validateAvatarURL(avatarURL); err != nil {
		return nil, err
	}

	if err := s.users.UpdateProfile(ctx, user.ID, displayName, avatarURL); err != nil {
		return nil, apperror.Internal(err)
	}
	user.DisplayName = displayName
	user.AvatarURL = avatarURL

	res := toUserResponse(user)
	return &res, nil
}

// ChangePassword requires the current password even though the caller is already
// authenticated: a leaked token should not be enough to lock the owner out.
// Existing tokens stay valid until they expire; there is no server-side session
// store to revoke them against.
func (s *AuthService) ChangePassword(ctx context.Context, userID uuid.UUID, req dto.ChangePasswordRequest) error {
	user, err := s.users.FindByID(ctx, userID)
	if err != nil {
		return apperror.Internal(err)
	}
	if user == nil {
		return apperror.Unauthorized()
	}
	if !auth.CheckPassword(user.PasswordHash, req.CurrentPassword) {
		return apperror.New(http.StatusBadRequest, "INVALID_CURRENT_PASSWORD", "当前密码不正确")
	}
	if err := validateNewPassword(req.NewPassword); err != nil {
		return err
	}
	if req.NewPassword == req.CurrentPassword {
		return apperror.New(http.StatusBadRequest, "PASSWORD_UNCHANGED", "新密码不能与当前密码相同")
	}

	hash, err := auth.HashPassword(req.NewPassword)
	if err != nil {
		return apperror.Internal(err)
	}
	if err := s.users.UpdatePassword(ctx, user.ID, user.PasswordHash, hash); err != nil {
		if errors.Is(err, repository.ErrUserPasswordChanged) {
			return apperror.New(http.StatusBadRequest, "INVALID_CURRENT_PASSWORD", "当前密码不正确")
		}
		return apperror.Internal(err)
	}
	return nil
}

// Account field limits. GET /system/capabilities reports these same constants so
// the frontend validates against the values this path actually enforces.
const (
	MinPasswordLength    = 8
	MaxDisplayNameLength = 128
	MaxAvatarURLLength   = 512
)

func validateNewPassword(password string) error {
	if utf8.RuneCountInString(password) < MinPasswordLength {
		return apperror.Validation(map[string]any{"newPassword": "新密码长度不足"})
	}
	if err := auth.ValidatePasswordBytes(password); err != nil {
		return apperror.Validation(map[string]any{
			"newPassword": "新密码不能超过 72 个 UTF-8 字节",
		})
	}
	return nil
}

// validateAvatarURL keeps the stored value to absolute http(s) URLs or a
// site-relative path. It blocks scheme payloads such as javascript: that would
// become an execution vector wherever the frontend renders the avatar as a link.
func validateAvatarURL(value string) error {
	if value == "" {
		return nil
	}
	if utf8.RuneCountInString(value) > MaxAvatarURLLength {
		return apperror.Validation(map[string]any{"avatarUrl": "头像地址过长"})
	}
	if strings.HasPrefix(value, "/") && !strings.HasPrefix(value, "//") {
		return nil
	}
	parsed, err := url.Parse(value)
	if err != nil {
		return apperror.Validation(map[string]any{"avatarUrl": "头像地址不合法"})
	}
	switch strings.ToLower(parsed.Scheme) {
	case "http", "https":
		if parsed.Host == "" {
			return apperror.Validation(map[string]any{"avatarUrl": "头像地址不合法"})
		}
		return nil
	default:
		return apperror.Validation(map[string]any{"avatarUrl": "头像地址仅支持 http/https 或站内相对路径"})
	}
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
