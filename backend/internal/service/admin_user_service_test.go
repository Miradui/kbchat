package service

import (
	"context"
	"testing"

	"kbchat/backend/internal/dto"
	"kbchat/backend/internal/model"
)

func TestAdminUserServiceProtectsSelfAndLastAdministrator(t *testing.T) {
	services := newWorkspaceTestServices(t)
	admin := createWorkspaceUser(t, services.db, "admin-p4")
	other := createWorkspaceUser(t, services.db, "other-p4")
	if err := services.db.Model(&model.User{}).Where("id = ?", admin.ID).Update("role", model.SystemRoleAdmin).Error; err != nil {
		t.Fatal(err)
	}
	svc := NewAdminUserService(services.users.users)
	if _, err := svc.UpdateRole(context.Background(), admin.ID, admin.ID, model.SystemRoleUser); err == nil {
		t.Fatal("expected self-demotion rejection")
	}
	if _, err := svc.UpdateRole(context.Background(), admin.ID, other.ID, model.SystemRoleAdmin); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.UpdateRole(context.Background(), admin.ID, other.ID, model.SystemRoleUser); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.UpdateRole(context.Background(), admin.ID, admin.ID, model.SystemRoleUser); err == nil {
		t.Fatal("expected last-admin/self protection")
	}
}

func TestAdminUserServiceCreatesOneTimePassword(t *testing.T) {
	services := newWorkspaceTestServices(t)
	admin := createWorkspaceUser(t, services.db, "admin-create-p4")
	if err := services.db.Model(&model.User{}).Where("id = ?", admin.ID).Update("role", model.SystemRoleAdmin).Error; err != nil {
		t.Fatal(err)
	}
	svc := NewAdminUserService(services.users.users)
	result, err := svc.Create(context.Background(), admin.ID, dto.AdminUserCreateRequest{Username: "created-p4"})
	if err != nil || result.InitialPassword == "" {
		t.Fatalf("expected one-time password, result=%#v err=%v", result, err)
	}
	if len(result.InitialPassword) < MinPasswordLength {
		t.Fatalf("generated password too short: %q", result.InitialPassword)
	}
}
