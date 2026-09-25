package service

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"kbchat/backend/internal/apperror"
	"kbchat/backend/internal/auth"
	"kbchat/backend/internal/config"
	"kbchat/backend/internal/dto"
	"kbchat/backend/internal/model"
	"kbchat/backend/internal/repository"
)

func setUserRole(t *testing.T, db *gorm.DB, id uuid.UUID, role string) {
	t.Helper()
	if err := db.Model(&model.User{}).Where("id = ?", id).Update("role", role).Error; err != nil {
		t.Fatal(err)
	}
}

func setUserStatus(t *testing.T, db *gorm.DB, id uuid.UUID, status string) {
	t.Helper()
	if err := db.Model(&model.User{}).Where("id = ?", id).Update("status", status).Error; err != nil {
		t.Fatal(err)
	}
}

func assertAdminError(t *testing.T, err error, status int, code string) *apperror.Error {
	t.Helper()
	if err == nil {
		t.Fatalf("expected %d %s, got success", status, code)
	}
	var appErr *apperror.Error
	if !errors.As(err, &appErr) {
		t.Fatalf("expected apperror, got %T: %v", err, err)
	}
	if appErr.Status != status || appErr.Code != code {
		t.Fatalf("expected %d %s, got %d %s (%v)", status, code, appErr.Status, appErr.Code, appErr.Details)
	}
	return appErr
}

func loadUser(t *testing.T, db *gorm.DB, id uuid.UUID) model.User {
	t.Helper()
	var user model.User
	if err := db.First(&user, "id = ?", id).Error; err != nil {
		t.Fatal(err)
	}
	return user
}

func mustErr(_ any, err error) error { return err }

// The protection must be decided by who would remain, not by counting the
// target itself: with two active admins one can be demoted; once only one is
// left, neither a demotion nor a disable may remove it. A disabled admin does not
// count as a remaining administrator.
func TestAdminUserServiceLastAdminProtection(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	first := createWorkspaceUser(t, services.db, "admin-first")
	second := createWorkspaceUser(t, services.db, "admin-second")
	setUserRole(t, services.db, first.ID, model.SystemRoleAdmin)
	setUserRole(t, services.db, second.ID, model.SystemRoleAdmin)
	svc := NewAdminUserService(services.users.users)

	// Two active admins: demoting one of them is allowed.
	if _, err := svc.UpdateRole(ctx, first.ID, second.ID, model.SystemRoleUser); err != nil {
		t.Fatalf("demote with another active admin present: %v", err)
	}
	if got := loadUser(t, services.db, second.ID).Role; got != model.SystemRoleUser {
		t.Fatalf("second role = %q, want user", got)
	}

	// Promote back and disable the second admin: the first is now the only
	// active admin even though two admin rows exist.
	if _, err := svc.UpdateRole(ctx, first.ID, second.ID, model.SystemRoleAdmin); err != nil {
		t.Fatal(err)
	}
	setUserStatus(t, services.db, second.ID, "disabled")

	// A disabled admin cannot demote the last active one.
	assertAdminError(t, mustErr(svc.UpdateRole(ctx, second.ID, first.ID, model.SystemRoleUser)), 409, "LAST_ADMIN_REQUIRED")
	if got := loadUser(t, services.db, first.ID).Role; got != model.SystemRoleAdmin {
		t.Fatalf("first role changed to %q despite refusal", got)
	}

	// Disabling the last active admin is refused for the same reason.
	_, err := svc.Update(ctx, second.ID, first.ID, dto.AdminUserUpdateRequest{DisplayName: "first", Status: "disabled"})
	assertAdminError(t, err, 409, "LAST_ADMIN_REQUIRED")
	if got := loadUser(t, services.db, first.ID).Status; got != "active" {
		t.Fatalf("first status changed to %q despite refusal", got)
	}

	// Demoting the *disabled* admin is fine: it does not reduce the active set.
	if _, err := svc.UpdateRole(ctx, first.ID, second.ID, model.SystemRoleUser); err != nil {
		t.Fatalf("demote disabled admin: %v", err)
	}

	// Once a second active admin exists again, disabling the first is allowed.
	setUserRole(t, services.db, second.ID, model.SystemRoleAdmin)
	setUserStatus(t, services.db, second.ID, "active")
	if _, err := svc.Update(ctx, second.ID, first.ID, dto.AdminUserUpdateRequest{DisplayName: "first", Status: "disabled"}); err != nil {
		t.Fatalf("disable admin with another active admin present: %v", err)
	}
}

func TestAdminUserServiceRefusesSelfMutation(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	admin := createWorkspaceUser(t, services.db, "admin-self")
	other := createWorkspaceUser(t, services.db, "admin-other")
	setUserRole(t, services.db, admin.ID, model.SystemRoleAdmin)
	setUserRole(t, services.db, other.ID, model.SystemRoleAdmin)
	svc := NewAdminUserService(services.users.users)

	_, err := svc.Update(ctx, admin.ID, admin.ID, dto.AdminUserUpdateRequest{DisplayName: "me", Status: "disabled"})
	assertAdminError(t, err, 400, "ADMIN_SELF_MUTATION")
	assertAdminError(t, mustErr(svc.UpdateRole(ctx, admin.ID, admin.ID, model.SystemRoleUser)), 400, "ADMIN_SELF_MUTATION")
	assertAdminError(t, mustErr(svc.ResetPassword(ctx, admin.ID, admin.ID)), 400, "ADMIN_SELF_MUTATION")

	before := loadUser(t, services.db, admin.ID)
	if before.Role != model.SystemRoleAdmin || before.Status != "active" {
		t.Fatalf("self mutation changed the account: %+v", before)
	}
	// Renaming oneself while staying active is still allowed.
	if _, err := svc.Update(ctx, admin.ID, admin.ID, dto.AdminUserUpdateRequest{DisplayName: "renamed", Status: "active"}); err != nil {
		t.Fatalf("self rename: %v", err)
	}
	// Resetting someone else works, and rotates the hash.
	result, err := svc.ResetPassword(ctx, admin.ID, other.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !auth.CheckPassword(loadUser(t, services.db, other.ID).PasswordHash, result.Password) {
		t.Fatal("reset password does not match stored hash")
	}
}

func TestAdminUserServiceCreatesOneTimePassword(t *testing.T) {
	services := newWorkspaceTestServices(t)
	admin := createWorkspaceUser(t, services.db, "admin-create-p4")
	setUserRole(t, services.db, admin.ID, model.SystemRoleAdmin)
	svc := NewAdminUserService(services.users.users)
	result, err := svc.Create(context.Background(), admin.ID, dto.AdminUserCreateRequest{Username: "created-p4"})
	if err != nil || result.InitialPassword == "" {
		t.Fatalf("expected one-time password, result=%#v err=%v", result, err)
	}
	if len(result.InitialPassword) < MinPasswordLength {
		t.Fatalf("generated password too short: %q", result.InitialPassword)
	}
	created := loadUser(t, services.db, uuid.MustParse(result.User.ID))
	if created.CreatedByID == nil || *created.CreatedByID != admin.ID {
		t.Fatalf("createdBy = %v, want %s", created.CreatedByID, admin.ID)
	}
	if created.Role != model.SystemRoleUser || created.Status != "active" {
		t.Fatalf("new user defaults = role %q status %q", created.Role, created.Status)
	}
}

// The admin create body calls the field "password"; the shared validator was
// written for the change-password body and used to report "newPassword".
func TestAdminUserServiceRejectsShortPasswordUnderThePasswordKey(t *testing.T) {
	services := newWorkspaceTestServices(t)
	admin := createWorkspaceUser(t, services.db, "admin-short-pw")
	svc := NewAdminUserService(services.users.users)
	_, err := svc.Create(context.Background(), admin.ID, dto.AdminUserCreateRequest{Username: "short-pw", Password: "1234567"})
	appErr := assertAdminError(t, err, 400, "VALIDATION_ERROR")
	if _, ok := appErr.Details["password"]; !ok {
		t.Fatalf("details must use the request field name, got %v", appErr.Details)
	}
	if _, ok := appErr.Details["newPassword"]; ok {
		t.Fatalf("details leaked the change-password field name: %v", appErr.Details)
	}
	// The change-password flow keeps its own key.
	authSvc := NewAuthService(config.Config{JWTSecret: "admin-user-service-test-secret-32-bytes!", JWTExpiresIn: "1h"}, services.users.users)
	hash, _ := auth.HashPassword("current-password")
	if err := services.db.Model(&model.User{}).Where("id = ?", admin.ID).Update("password_hash", hash).Error; err != nil {
		t.Fatal(err)
	}
	err = authSvc.ChangePassword(context.Background(), admin.ID, dto.ChangePasswordRequest{CurrentPassword: "current-password", NewPassword: "short"})
	appErr = assertAdminError(t, err, 400, "VALIDATION_ERROR")
	if _, ok := appErr.Details["newPassword"]; !ok {
		t.Fatalf("change-password details = %v, want newPassword", appErr.Details)
	}
	// An admin-specified password that satisfies the rule is stored verbatim.
	result, err := svc.Create(context.Background(), admin.ID, dto.AdminUserCreateRequest{Username: "ok-pw", Password: "long-enough-1"})
	if err != nil {
		t.Fatal(err)
	}
	if result.InitialPassword != "long-enough-1" {
		t.Fatalf("specified password was replaced: %q", result.InitialPassword)
	}
}

func TestAdminUserServiceValidatesUsername(t *testing.T) {
	services := newWorkspaceTestServices(t)
	admin := createWorkspaceUser(t, services.db, "admin-username")
	svc := NewAdminUserService(services.users.users)
	invalid := []string{"", "ab", "has space", "tab\tname", "中文名", "semi;colon", "slash/name", strings.Repeat("a", 65)}
	for _, username := range invalid {
		_, err := svc.Create(context.Background(), admin.ID, dto.AdminUserCreateRequest{Username: username})
		appErr := assertAdminError(t, err, 400, "VALIDATION_ERROR")
		if _, ok := appErr.Details["username"]; !ok {
			t.Fatalf("%q: details = %v, want username", username, appErr.Details)
		}
	}
	for _, username := range []string{"abc", "user.name", "user_name", "user-name", "user@example.com", "MixedCase01", strings.Repeat("b", 64)} {
		result, err := svc.Create(context.Background(), admin.ID, dto.AdminUserCreateRequest{Username: username})
		if err != nil {
			t.Fatalf("%q should be accepted: %v", username, err)
		}
		// Case is stored exactly as typed.
		if result.User.Username != username {
			t.Fatalf("stored username %q, want %q", result.User.Username, username)
		}
	}
	// Surrounding whitespace is trimmed rather than rejected.
	result, err := svc.Create(context.Background(), admin.ID, dto.AdminUserCreateRequest{Username: "  padded  "})
	if err != nil || result.User.Username != "padded" {
		t.Fatalf("trimmed username: %v %v", result, err)
	}
}

func TestAdminUserServiceUsernameUniquenessIgnoresCase(t *testing.T) {
	services := newWorkspaceTestServices(t)
	admin := createWorkspaceUser(t, services.db, "admin-unique")
	createWorkspaceUser(t, services.db, "Alice")
	svc := NewAdminUserService(services.users.users)
	for _, username := range []string{"Alice", "alice", "ALICE", "admin-unique", "Admin-Unique"} {
		assertAdminError(t, mustErr(svc.Create(context.Background(), admin.ID, dto.AdminUserCreateRequest{Username: username})), 409, "USERNAME_EXISTS")
	}
	var count int64
	if err := services.db.Model(&model.User{}).Where("LOWER(username) = ?", "alice").Count(&count).Error; err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("expected exactly one alice, got %d", count)
	}
}

func TestAdminUserServiceRecordsActivities(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	if err := services.db.AutoMigrate(&model.Activity{}); err != nil {
		t.Fatal(err)
	}
	admin := createWorkspaceUser(t, services.db, "admin-activity")
	other := createWorkspaceUser(t, services.db, "other-activity")
	setUserRole(t, services.db, admin.ID, model.SystemRoleAdmin)
	svc := NewAdminUserService(services.users.users)
	svc.SetActivityRecorder(NewActivityRecorder(repository.NewActivityRepository(services.db)))

	created, err := svc.Create(ctx, admin.ID, dto.AdminUserCreateRequest{Username: "activity-target"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Update(ctx, admin.ID, other.ID, dto.AdminUserUpdateRequest{DisplayName: "Other", Status: "disabled"}); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.ResetPassword(ctx, admin.ID, other.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.UpdateRole(ctx, admin.ID, other.ID, model.SystemRoleAdmin); err != nil {
		t.Fatal(err)
	}
	var activities []model.Activity
	if err := services.db.Where("user_id = ?", admin.ID).Order("created_at asc").Find(&activities).Error; err != nil {
		t.Fatal(err)
	}
	want := []string{ActivityAdminUserCreated, ActivityAdminUserUpdated, ActivityAdminUserPasswordReset, ActivityAdminUserRoleChanged}
	if len(activities) != len(want) {
		t.Fatalf("recorded %d activities, want %d", len(activities), len(want))
	}
	seen := map[string]bool{}
	for _, activity := range activities {
		seen[activity.Action] = true
		if !strings.HasPrefix(activity.Action, "admin.user.") {
			t.Fatalf("action %q lacks the admin.user. prefix", activity.Action)
		}
		if activity.ResourceType != "user" {
			t.Fatalf("%s resourceType = %q, want user", activity.Action, activity.ResourceType)
		}
		if activity.Action == ActivityAdminUserCreated && activity.ResourceID.String() != created.User.ID {
			t.Fatalf("created activity points at %s, want %s", activity.ResourceID, created.User.ID)
		}
	}
	for _, action := range want {
		if !seen[action] {
			t.Fatalf("missing activity %s", action)
		}
	}
}

// A disabled account is refused at login with the same message as a wrong
// password, and its existing token is refused by the middleware's status check.
func TestDisabledUserCannotLoginOrKeepUsingTokens(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	hash, err := auth.HashPassword("password-1")
	if err != nil {
		t.Fatal(err)
	}
	user := model.User{Username: "disabled-login", PasswordHash: hash, DisplayName: "Disabled", Status: "disabled"}
	if err := services.db.Create(&user).Error; err != nil {
		t.Fatal(err)
	}
	authSvc := NewAuthService(config.Config{JWTSecret: "admin-user-service-test-secret-32-bytes!", JWTExpiresIn: "1h"}, services.users.users)
	_, err = authSvc.Login(ctx, dto.LoginRequest{Username: "disabled-login", Password: "password-1"})
	assertAdminError(t, err, 401, "UNAUTHORIZED")

	active, err := services.users.users.IsActive(ctx, user.ID)
	if err != nil || active {
		t.Fatalf("disabled IsActive = %v, %v; want false, nil", active, err)
	}
	active, err = services.users.users.IsActive(ctx, uuid.New())
	if err != nil || active {
		t.Fatalf("missing IsActive = %v, %v; want false, nil", active, err)
	}
	setUserStatus(t, services.db, user.ID, "active")
	active, err = services.users.users.IsActive(ctx, user.ID)
	if err != nil || !active {
		t.Fatalf("re-enabled IsActive = %v, %v; want true, nil", active, err)
	}
	if _, err := authSvc.Login(ctx, dto.LoginRequest{Username: "disabled-login", Password: "password-1"}); err != nil {
		t.Fatalf("re-enabled login: %v", err)
	}
}

func TestUserSearchExcludesDisabledUsers(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	createWorkspaceUser(t, services.db, "search-active")
	disabled := createWorkspaceUser(t, services.db, "search-disabled")
	setUserStatus(t, services.db, disabled.ID, "disabled")

	result, err := services.users.Search(ctx, "search-", 20)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Items) != 1 || result.Items[0].Username != "search-active" {
		t.Fatalf("search returned %+v, want only search-active", result.Items)
	}
}
