package service

import (
	"context"
	"github.com/google/uuid"
	"kbchat/backend/internal/dto"
	"kbchat/backend/internal/model"
	"kbchat/backend/internal/repository"
	"testing"
	"time"
)

func TestTransferOwnership(t *testing.T) {
	for _, keep := range []bool{false, true} {
		t.Run(map[bool]string{false: "remove", true: "retain"}[keep], func(t *testing.T) {
			ctx := context.Background()
			f := newWorkspaceTestServices(t)
			old := createWorkspaceUser(t, f.db, "old")
			next := createWorkspaceUser(t, f.db, "next")
			peer := createWorkspaceUser(t, f.db, "peer")
			cat := model.KnowledgeBaseCategory{OwnerID: old.ID, Name: "private"}
			if err := f.db.Create(&cat).Error; err != nil {
				t.Fatal(err)
			}
			kb := createWorkspaceKB(t, f.db, old.ID, cat.ID, "transfer", "private", time.Now())
			for _, u := range []model.User{next, peer} {
				if _, err := f.kbs.AddMember(ctx, old.ID, kb.ID, dto.KnowledgeBaseMemberRequest{UserID: u.ID, Role: "viewer"}); err != nil {
					t.Fatal(err)
				}
			}
			if err := f.db.AutoMigrate(&model.Activity{}); err != nil {
				t.Fatal(err)
			}
			f.kbs.SetActivityRecorder(NewActivityRecorder(repository.NewActivityRepository(f.db)))
			result, err := f.kbs.TransferOwnership(ctx, old.ID, kb.ID, dto.TransferOwnershipRequest{NewOwnerID: next.ID, KeepPreviousOwnerAsManager: keep})
			if err != nil || result.TransferredCount != 1 {
				t.Fatalf("transfer: %v %v", result, err)
			}
			var stored model.KnowledgeBase
			if err := f.db.First(&stored, "id = ?", kb.ID).Error; err != nil {
				t.Fatal(err)
			}
			if stored.OwnerID != next.ID || stored.CategoryID != nil || stored.UpdatedByID == nil || *stored.UpdatedByID != old.ID {
				t.Fatalf("stored: %+v", stored)
			}
			member, err := f.kbs.members.Find(ctx, kb.ID, next.ID)
			if err != nil || member != nil {
				t.Fatalf("new owner member: %v %v", member, err)
			}
			previous, err := f.kbs.members.Find(ctx, kb.ID, old.ID)
			if err != nil {
				t.Fatal(err)
			}
			if keep && (previous == nil || previous.Role != "manager") || !keep && previous != nil {
				t.Fatalf("old owner member: %v", previous)
			}
			if _, err := f.kbs.Get(ctx, peer.ID, kb.ID); err != nil {
				t.Fatalf("peer access: %v", err)
			}
			_, err = f.kbs.Get(ctx, old.ID, kb.ID)
			if !keep {
				assertAdminError(t, err, 404, "KNOWLEDGE_BASE_NOT_FOUND")
			} else if err != nil {
				t.Fatal(err)
			}
			var count int64
			f.db.Model(&model.Activity{}).Where("action = ?", "kb.ownership_transferred").Count(&count)
			if count != 2 {
				t.Fatalf("activity count %d", count)
			}
		})
	}
}

func TestTransferOwnershipInvalidTargetsAndBatchRecycleBin(t *testing.T) {
	ctx := context.Background()
	f := newWorkspaceTestServices(t)
	old := createWorkspaceUser(t, f.db, "old")
	next := createWorkspaceUser(t, f.db, "next")
	admin := createWorkspaceUser(t, f.db, "admin")
	setUserRole(t, f.db, admin.ID, "admin")
	kb := createWorkspaceKB(t, f.db, old.ID, uuid.Nil, "live", "private", time.Now())
	deleted := createWorkspaceKB(t, f.db, old.ID, uuid.Nil, "deleted", "private", time.Now())
	if err := f.kbs.Delete(ctx, old.ID, deleted.ID); err != nil {
		t.Fatal(err)
	}
	for _, id := range []uuid.UUID{old.ID, uuid.New(), uuid.Nil} {
		_, err := f.kbs.TransferOwnership(ctx, old.ID, kb.ID, dto.TransferOwnershipRequest{NewOwnerID: id})
		assertAdminError(t, err, 400, "TRANSFER_TARGET_INVALID")
	}
	setUserStatus(t, f.db, next.ID, "disabled")
	_, err := f.kbs.TransferOwnership(ctx, old.ID, kb.ID, dto.TransferOwnershipRequest{NewOwnerID: next.ID})
	assertAdminError(t, err, 400, "TRANSFER_TARGET_INVALID")
	setUserStatus(t, f.db, next.ID, "active")
	setUserStatus(t, f.db, old.ID, "disabled")
	svc := NewAdminUserService(f.users.users)
	svc.SetOwnershipService(f.kbs)
	_, err = svc.TransferKnowledgeBases(ctx, next.ID, old.ID, dto.TransferOwnershipRequest{NewOwnerID: next.ID})
	assertAdminError(t, err, 403, "SYSTEM_ADMIN_REQUIRED")
	list, err := svc.List(ctx, dto.AdminUserListQuery{})
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range list.Items {
		if item.ID == old.ID.String() && item.OwnedKnowledgeBaseCount != 2 {
			t.Fatalf("count: %+v", item)
		}
	}
	result, err := svc.TransferKnowledgeBases(ctx, admin.ID, old.ID, dto.TransferOwnershipRequest{NewOwnerID: next.ID})
	if err != nil || result.TransferredCount != 2 {
		t.Fatalf("batch: %+v %v", result, err)
	}
	if err := f.kbs.Restore(ctx, next.ID, deleted.ID); err != nil {
		t.Fatalf("new owner restore: %v", err)
	}
	if err := f.kbs.Delete(ctx, next.ID, kb.ID); err != nil {
		t.Fatalf("new owner delete: %v", err)
	}
}
