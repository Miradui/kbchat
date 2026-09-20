package service

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"

	"kbchat/backend/internal/apperror"
	"kbchat/backend/internal/auth"
	"kbchat/backend/internal/model"
	"kbchat/backend/internal/repository"
)

type SystemAdminService struct {
	users *repository.UserRepository
}

func NewSystemAdminService(users *repository.UserRepository) *SystemAdminService {
	return &SystemAdminService{users: users}
}

// The database is authoritative. JWT role snapshots may predate a promotion or
// revocation, and old tokens may have no role claim at all.
func (s *SystemAdminService) Authorize(ctx context.Context, userID uuid.UUID) error {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	user, err := s.users.FindByID(ctx, userID)
	if err != nil {
		return apperror.Internal(err)
	}
	if user == nil {
		return apperror.Unauthorized()
	}
	if user.Role != model.SystemRoleAdmin {
		return apperror.New(http.StatusForbidden, "SYSTEM_ADMIN_REQUIRED", "此操作需要系统管理员权限")
	}
	return nil
}

type SystemAdminBootstrapRequest struct {
	Username    string
	Create      bool
	Password    string
	DisplayName string
}

// Bootstrap is only exposed by the operator CLI, never by a public HTTP route.
func (s *SystemAdminService) Bootstrap(ctx context.Context, req SystemAdminBootstrapRequest) (*repository.SystemAdminBootstrapResult, error) {
	username := strings.TrimSpace(req.Username)
	if username == "" || utf8.RuneCountInString(username) > 64 {
		return nil, fmt.Errorf("username must contain 1 to 64 characters")
	}
	var create *model.User
	if req.Create {
		if err := validateNewPassword(req.Password); err != nil {
			return nil, fmt.Errorf("BOOTSTRAP_ADMIN_PASSWORD must contain at least %d characters and at most %d UTF-8 bytes", MinPasswordLength, auth.MaxPasswordBytes)
		}
		displayName := strings.TrimSpace(req.DisplayName)
		if displayName == "" {
			displayName = username
		}
		if utf8.RuneCountInString(displayName) > MaxDisplayNameLength {
			return nil, fmt.Errorf("display name must contain at most %d characters", MaxDisplayNameLength)
		}
		hash, err := auth.HashPassword(req.Password)
		if err != nil {
			return nil, err
		}
		create = &model.User{Username: username, PasswordHash: hash, DisplayName: displayName, Role: model.SystemRoleAdmin}
	}
	return s.users.BootstrapSystemAdmin(ctx, username, create)
}
