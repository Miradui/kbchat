package service

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"kbchat/backend/internal/dto"
	"kbchat/backend/internal/model"
	"kbchat/backend/internal/repository"
)

func TestAdminActivitiesScopePaginationAndActions(t *testing.T) {
	ctx := context.Background()
	f := newWorkspaceTestServices(t)
	if err := f.db.AutoMigrate(&model.Activity{}); err != nil {
		t.Fatal(err)
	}
	a := createWorkspaceUser(t, f.db, "log-admin-a")
	b := createWorkspaceUser(t, f.db, "log-admin-b")
	target := createWorkspaceUser(t, f.db, "log-target")
	repo := repository.NewActivityRepository(f.db)
	svc := NewAdminUserService(f.users.users)
	svc.SetActivityLog(repo)
	svc.SetActivityRecorder(NewActivityRecorder(repo))
	for i, actor := range []model.User{a, b} {
		if err := repo.Create(ctx, &model.Activity{UserID: actor.ID, Action: ActivityAdminUserCreated, ResourceType: "user", ResourceID: target.ID, ResourceName: target.Username, CreatedAt: time.Date(2026, 9, 1, 0, i, 0, 0, time.UTC)}); err != nil {
			t.Fatal(err)
		}
	}
	if err := repo.Create(ctx, &model.Activity{UserID: a.ID, Action: "document.uploaded", ResourceType: "document", ResourceID: uuid.New()}); err != nil {
		t.Fatal(err)
	}
	first, err := svc.ListActivities(ctx, 1, 1)
	if err != nil {
		t.Fatal(err)
	}
	if first.Total != 2 || len(first.Items) != 1 || first.Items[0].Actor.Username != b.Username {
		t.Fatalf("first: %+v", first)
	}
	second, err := svc.ListActivities(ctx, 2, 1)
	if err != nil || len(second.Items) != 1 || second.Items[0].Actor.ID != a.ID.String() {
		t.Fatalf("second: %+v %v", second, err)
	}
	capped, err := svc.ListActivities(ctx, -1, 999)
	if err != nil || capped.Page != 1 || capped.PageSize != 100 {
		t.Fatalf("capped: %+v %v", capped, err)
	}
	for _, status := range []string{"disabled", "disabled", "active", "active"} {
		if _, err := svc.Update(ctx, a.ID, target.ID, dto.AdminUserUpdateRequest{DisplayName: target.DisplayName, Status: status}); err != nil {
			t.Fatal(err)
		}
	}
	all, err := svc.ListActivities(ctx, 1, 100)
	if err != nil {
		t.Fatal(err)
	}
	counts := map[string]int{}
	for _, item := range all.Items {
		counts[item.Action]++
	}
	if all.Total != 4 || counts[ActivityAdminUserDisabled] != 1 || counts[ActivityAdminUserEnabled] != 1 || counts[ActivityAdminUserUpdated] != 0 {
		t.Fatalf("actions: %v total %d", counts, all.Total)
	}
}
