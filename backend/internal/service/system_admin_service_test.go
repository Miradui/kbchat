package service

import (
	"context"
	"errors"
	"strings"
	"testing"

	"kbchat/backend/internal/auth"
	"kbchat/backend/internal/model"
	"kbchat/backend/internal/repository"
)

func TestBootstrapPromotesOnlyTheNamedFirstAdminAndPreservesAccount(t *testing.T) {
	ctx := context.Background()
	db := newAuthTestDB(t)
	users := repository.NewUserRepository(db)
	svc := NewSystemAdminService(users)
	original := model.User{Username: "operator", PasswordHash: "existing-hash", DisplayName: "Existing Name", AvatarURL: "/existing.png", Role: model.SystemRoleUser}
	other := model.User{Username: "ordinary", PasswordHash: "other-hash", Role: model.SystemRoleUser}
	for _, user := range []*model.User{&original, &other} {
		if err := users.Create(ctx, user); err != nil {
			t.Fatal(err)
		}
	}
	result, err := svc.Bootstrap(ctx, SystemAdminBootstrapRequest{Username: original.Username})
	if err != nil {
		t.Fatal(err)
	}
	if result.Action != "promoted" || result.User.ID != original.ID || result.User.Role != model.SystemRoleAdmin {
		t.Fatalf("unexpected bootstrap result: action=%s role=%s", result.Action, result.User.Role)
	}
	stored, err := users.FindByID(ctx, original.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.PasswordHash != original.PasswordHash || stored.DisplayName != original.DisplayName || stored.AvatarURL != original.AvatarURL || !stored.CreatedAt.Equal(original.CreatedAt) {
		t.Fatal("promotion changed existing credentials or profile")
	}
	if err := svc.Authorize(ctx, original.ID); err != nil {
		t.Fatal(err)
	}
	again, err := svc.Bootstrap(ctx, SystemAdminBootstrapRequest{Username: original.Username})
	if err != nil || again.Action != "unchanged" || !again.User.UpdatedAt.Equal(stored.UpdatedAt) {
		t.Fatalf("repeat bootstrap must be a no-op: %v", err)
	}
	if _, err := svc.Bootstrap(ctx, SystemAdminBootstrapRequest{Username: other.Username}); !errors.Is(err, repository.ErrSystemAdminAlreadyInitialized) {
		t.Fatalf("must not bootstrap a second administrator: %v", err)
	}
	otherStored, err := users.FindByID(ctx, other.ID)
	if err != nil || otherStored.Role != model.SystemRoleUser {
		t.Fatal("another account was modified")
	}
	if err := db.Model(&model.User{}).Where("id = ?", original.ID).Update("role", model.SystemRoleUser).Error; err != nil {
		t.Fatal(err)
	}
	assertAppError(t, svc.Authorize(ctx, original.ID), "SYSTEM_ADMIN_REQUIRED")
	if err := db.Delete(&model.User{}, original.ID).Error; err != nil {
		t.Fatal(err)
	}
	assertAppError(t, svc.Authorize(ctx, original.ID), "UNAUTHORIZED")
}

// A disabled administrator cannot log in, so counting them as "initialized"
// would leave the only recovery command refusing to run in exactly the state
// that needs it -- including the zero-active-admin state the last-admin race
// used to produce.
func TestBootstrapIgnoresDisabledAdministrators(t *testing.T) {
	ctx := context.Background()
	db := newAuthTestDB(t)
	users := repository.NewUserRepository(db)
	svc := NewSystemAdminService(users)
	disabled := model.User{Username: "disabled-admin", PasswordHash: "fixture-hash", Role: model.SystemRoleAdmin, Status: "disabled"}
	if err := users.Create(ctx, &disabled); err != nil {
		t.Fatal(err)
	}
	result, err := svc.Bootstrap(ctx, SystemAdminBootstrapRequest{Username: "recovery", Create: true, Password: "fixture-admin-password"})
	if err != nil {
		t.Fatalf("bootstrap must recover from a disabled-only administrator set: %v", err)
	}
	if result.Action != "created" || result.User.Role != model.SystemRoleAdmin {
		t.Fatalf("unexpected recovery result: action=%s role=%s", result.Action, result.User.Role)
	}
}

func TestBootstrapCreatesAdminOnlyWhenRequestedWithValidPassword(t *testing.T) {
	ctx := context.Background()
	db := newAuthTestDB(t)
	users := repository.NewUserRepository(db)
	svc := NewSystemAdminService(users)
	if _, err := svc.Bootstrap(ctx, SystemAdminBootstrapRequest{Username: "new-admin"}); !errors.Is(err, repository.ErrBootstrapUserNotFound) {
		t.Fatalf("missing target should not be created implicitly: %v", err)
	}
	for _, password := range []string{"", "123456", strings.Repeat("界", 25)} {
		if _, err := svc.Bootstrap(ctx, SystemAdminBootstrapRequest{Username: "new-admin", Create: true, Password: password}); err == nil {
			t.Fatal("expected invalid bootstrap password to fail")
		}
	}
	const password = "fixture-admin-password"
	result, err := svc.Bootstrap(ctx, SystemAdminBootstrapRequest{Username: "new-admin", Create: true, Password: password, DisplayName: "System Admin"})
	if err != nil {
		t.Fatal(err)
	}
	if result.Action != "created" || result.User.Role != model.SystemRoleAdmin || !auth.CheckPassword(result.User.PasswordHash, password) {
		t.Fatal("new administrator did not receive a hashed password and admin role")
	}
	if _, err := svc.Bootstrap(ctx, SystemAdminBootstrapRequest{Username: "another-admin", Create: true, Password: password}); !errors.Is(err, repository.ErrSystemAdminAlreadyInitialized) {
		t.Fatalf("bootstrap must not create a second administrator: %v", err)
	}
	missing, err := users.FindByUsername(ctx, "another-admin")
	if err != nil || missing != nil {
		t.Fatal("rejected bootstrap created an account")
	}
}

func TestBootstrapDoesNotReplaceAnExistingAccount(t *testing.T) {
	ctx := context.Background()
	db := newAuthTestDB(t)
	users := repository.NewUserRepository(db)
	svc := NewSystemAdminService(users)
	user := model.User{Username: "existing", PasswordHash: "original-hash", Role: model.SystemRoleUser}
	if err := users.Create(ctx, &user); err != nil {
		t.Fatal(err)
	}
	_, err := svc.Bootstrap(ctx, SystemAdminBootstrapRequest{Username: user.Username, Create: true, Password: "different-password"})
	if !errors.Is(err, repository.ErrBootstrapUserExists) {
		t.Fatalf("expected existing-account error, got %v", err)
	}
	stored, err := users.FindByID(ctx, user.ID)
	if err != nil || stored.PasswordHash != user.PasswordHash || stored.Role != model.SystemRoleUser {
		t.Fatal("existing account was replaced")
	}
	if err := db.Model(&user).Update("role", "manager").Error; err != nil {
		t.Fatal(err)
	}
	_, err = svc.Bootstrap(ctx, SystemAdminBootstrapRequest{Username: user.Username})
	if !errors.Is(err, repository.ErrBootstrapUserRole) {
		t.Fatalf("unexpected role must require operator review, got %v", err)
	}
}
