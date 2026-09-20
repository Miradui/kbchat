package service

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"

	"kbchat/backend/internal/apperror"
	"kbchat/backend/internal/auth"
	"kbchat/backend/internal/dto"
	"kbchat/backend/internal/model"
	"kbchat/backend/internal/repository"
)

const (
	ActivityAdminUserCreated       = "admin.user.created"
	ActivityAdminUserUpdated       = "admin.user.updated"
	ActivityAdminUserPasswordReset = "admin.user.passwordReset"
	ActivityAdminUserRoleChanged   = "admin.user.roleChanged"
	adminGeneratedPasswordLength   = 14
)

type AdminUserService struct {
	users      *repository.UserRepository
	activities *ActivityRecorder
}

func NewAdminUserService(users *repository.UserRepository) *AdminUserService {
	return &AdminUserService{users: users}
}

func (s *AdminUserService) SetActivityRecorder(recorder *ActivityRecorder) {
	s.activities = recorder
}

func (s *AdminUserService) List(ctx context.Context, query dto.AdminUserListQuery) (*dto.AdminUserListResponse, error) {
	users, total, err := s.users.ListAdmin(ctx, repository.AdminUserQuery{
		Query: query.Q, Status: query.Status, Role: query.Role, Page: query.Page, PageSize: query.PageSize,
	})
	if err != nil {
		return nil, apperror.Internal(err)
	}
	page, pageSize := normalizeAdminPage(query.Page, query.PageSize)
	items := make([]dto.AdminUserResponse, 0, len(users))
	for i := range users {
		items = append(items, adminUserResponse(&users[i]))
	}
	return &dto.AdminUserListResponse{Items: items, Total: total, Page: page, PageSize: pageSize}, nil
}

func (s *AdminUserService) Create(ctx context.Context, actorID uuid.UUID, req dto.AdminUserCreateRequest) (*dto.AdminUserMutationResponse, error) {
	username := strings.TrimSpace(req.Username)
	if username == "" || utf8.RuneCountInString(username) > 64 {
		return nil, apperror.Validation(map[string]any{"username": "用户名不能为空且不能超过 64 个字符"})
	}
	displayName := strings.TrimSpace(req.DisplayName)
	if displayName == "" {
		displayName = username
	}
	if utf8.RuneCountInString(displayName) > MaxDisplayNameLength {
		return nil, apperror.Validation(map[string]any{"displayName": "显示名称过长"})
	}
	password := req.Password
	if password == "" {
		var err error
		password, err = generateAdminPassword()
		if err != nil {
			return nil, apperror.Internal(err)
		}
	}
	if err := validateNewPassword(password); err != nil {
		return nil, err
	}
	hash, err := auth.HashPassword(password)
	if err != nil {
		return nil, apperror.Internal(err)
	}
	user := &model.User{Username: username, DisplayName: displayName, PasswordHash: hash, Role: model.SystemRoleUser, Status: "active", CreatedByID: &actorID}
	if err := s.users.CreateAdminUser(ctx, user); err != nil {
		if isUniqueViolation(err) {
			return nil, apperror.New(http.StatusConflict, "USERNAME_EXISTS", "用户名已存在")
		}
		return nil, apperror.Internal(err)
	}
	s.record(ctx, actorID, ActivityAdminUserCreated, user)
	return &dto.AdminUserMutationResponse{User: adminUserResponse(user), InitialPassword: password}, nil
}

func (s *AdminUserService) Update(ctx context.Context, actorID, targetID uuid.UUID, req dto.AdminUserUpdateRequest) (*dto.AdminUserResponse, error) {
	displayName := strings.TrimSpace(req.DisplayName)
	if displayName == "" || utf8.RuneCountInString(displayName) > MaxDisplayNameLength {
		return nil, apperror.Validation(map[string]any{"displayName": "显示名称不能为空且不能超过 128 个字符"})
	}
	if req.Status != "active" && req.Status != "disabled" {
		return nil, apperror.Validation(map[string]any{"status": "状态必须是 active 或 disabled"})
	}
	if actorID == targetID && req.Status == "disabled" {
		return nil, apperror.New(http.StatusBadRequest, "ADMIN_SELF_MUTATION", "不能禁用自己的管理员账号")
	}
	current, err := s.users.FindByID(ctx, targetID)
	if err != nil {
		return nil, apperror.Internal(err)
	}
	if current == nil {
		return nil, apperror.NotFound("USER_NOT_FOUND", "用户不存在")
	}
	user, err := s.users.UpdateAdminProfile(ctx, targetID, displayName, req.Status)
	if err != nil {
		return nil, mapAdminUserError(err)
	}
	s.record(ctx, actorID, ActivityAdminUserUpdated, user)
	res := adminUserResponse(user)
	return &res, nil
}

func (s *AdminUserService) ResetPassword(ctx context.Context, actorID, targetID uuid.UUID) (*dto.AdminUserResetPasswordResponse, error) {
	password, err := generateAdminPassword()
	if err != nil {
		return nil, apperror.Internal(err)
	}
	hash, err := auth.HashPassword(password)
	if err != nil {
		return nil, apperror.Internal(err)
	}
	user, err := s.users.ResetAdminPassword(ctx, targetID, hash)
	if err != nil {
		return nil, mapAdminUserError(err)
	}
	s.record(ctx, actorID, ActivityAdminUserPasswordReset, user)
	return &dto.AdminUserResetPasswordResponse{User: adminUserResponse(user), Password: password}, nil
}

func (s *AdminUserService) UpdateRole(ctx context.Context, actorID, targetID uuid.UUID, role string) (*dto.AdminUserResponse, error) {
	if role != model.SystemRoleUser && role != model.SystemRoleAdmin {
		return nil, apperror.Validation(map[string]any{"role": "角色必须是 user 或 admin"})
	}
	user, err := s.users.UpdateAdminRole(ctx, actorID, targetID, role)
	if err != nil {
		return nil, mapAdminUserError(err)
	}
	s.record(ctx, actorID, ActivityAdminUserRoleChanged, user)
	res := adminUserResponse(user)
	return &res, nil
}

func adminUserResponse(user *model.User) dto.AdminUserResponse {
	status := user.Status
	if status == "" {
		status = "active"
	}
	return dto.AdminUserResponse{ID: user.ID.String(), Username: user.Username, DisplayName: user.DisplayName, AvatarURL: user.AvatarURL, Role: user.Role, Status: status, LastLoginAt: user.LastLoginAt, CreatedAt: user.CreatedAt}
}

func normalizeAdminPage(page, pageSize int) (int, int) {
	if page < 1 {
		page = 1
	}
	if pageSize < 1 {
		pageSize = 20
	}
	if pageSize > 100 {
		pageSize = 100
	}
	return page, pageSize
}

func generateAdminPassword() (string, error) {
	const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*"
	buf := make([]byte, adminGeneratedPasswordLength)
	random := make([]byte, adminGeneratedPasswordLength)
	if _, err := rand.Read(random); err != nil {
		return "", err
	}
	for i := range buf {
		buf[i] = alphabet[int(random[i])%len(alphabet)]
	}
	return string(buf), nil
}

func isUniqueViolation(err error) bool {
	value := strings.ToLower(err.Error())
	return strings.Contains(value, "unique") || strings.Contains(value, "duplicate")
}

func mapAdminUserError(err error) error {
	switch {
	case errors.Is(err, repository.ErrAdminUserNotFound):
		return apperror.NotFound("USER_NOT_FOUND", "用户不存在")
	case errors.Is(err, repository.ErrAdminSelfMutation):
		return apperror.New(http.StatusBadRequest, "ADMIN_SELF_MUTATION", "不能禁用或降级自己的管理员账号")
	case errors.Is(err, repository.ErrAdminLastAdmin):
		return apperror.New(http.StatusConflict, "LAST_ADMIN_REQUIRED", "不能撤销最后一位系统管理员")
	case errors.Is(err, repository.ErrAdminInvalidRole), errors.Is(err, repository.ErrAdminInvalidStatus):
		return apperror.Validation(map[string]any{"user": "用户状态或角色不合法"})
	default:
		return apperror.Internal(fmt.Errorf("admin user operation: %w", err))
	}
}

func (s *AdminUserService) record(ctx context.Context, actorID uuid.UUID, action string, user *model.User) {
	if s.activities == nil || user == nil {
		return
	}
	s.activities.Record(ctx, actorID, ActivityEntry{Action: action, ResourceType: "user", ResourceID: user.ID, ResourceName: user.Username})
}
