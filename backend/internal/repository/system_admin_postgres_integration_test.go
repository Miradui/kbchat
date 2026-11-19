package repository

import (
	"context"
	"errors"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"gorm.io/gorm"

	"kbchat/backend/internal/model"
)

// Uses the existing isolated-schema PostgreSQL harness. Never writes application
// users; each schema is removed after both independent pools have closed.
func TestPostgresSystemAdminBootstrapSerializesFirstAdmin(t *testing.T) {
	for _, create := range []bool{false, true} {
		name := "promote"
		if create {
			name = "create"
		}
		t.Run(name, func(t *testing.T) {
			db1, db2 := newPostgresConcurrencyTestDBs(t)
			// Mirror the pre-P4 SQL schema and apply the actual migration so model
			// column naming mistakes cannot be hidden by GORM AutoMigrate.
			if err := db1.Exec(`ALTER TABLE users ADD COLUMN display_name TEXT, ADD COLUMN avatar_url TEXT, ADD COLUMN role TEXT DEFAULT 'user', ADD COLUMN created_at TIMESTAMPTZ, ADD COLUMN updated_at TIMESTAMPTZ`).Error; err != nil {
				t.Fatal(err)
			}
			migration, err := os.ReadFile("../../migrations/025_user_status_and_admin.sql")
			if err != nil {
				t.Fatal(err)
			}
			if err := db1.Exec(string(migration)).Error; err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			users := []model.User{
				{Username: "first", PasswordHash: "fixture-hash-1", Role: model.SystemRoleUser},
				{Username: "second", PasswordHash: "fixture-hash-2", Role: model.SystemRoleUser},
			}
			if !create {
				for i := range users {
					if err := db1.Create(&users[i]).Error; err != nil {
						t.Fatal(err)
					}
				}
			}
			counted := make(chan struct{})
			release := make(chan struct{})
			var once sync.Once
			unblock := func() { once.Do(func() { close(release) }) }
			t.Cleanup(unblock)
			var paused atomic.Bool
			const callback = "test:pause-first-admin-count"
			if err := db1.Callback().Query().After("gorm:query").Register(callback, func(tx *gorm.DB) {
				if _, ok := tx.Statement.Dest.(*int64); ok && tx.Statement.Table == "users" && paused.CompareAndSwap(false, true) {
					close(counted)
					<-release
				}
			}); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = db1.Callback().Query().Remove(callback) })
			run := func(db *gorm.DB, index int) error {
				var newUser *model.User
				if create {
					newUser = &users[index]
				}
				_, err := NewUserRepository(db).BootstrapSystemAdmin(ctx, users[index].Username, newUser)
				return err
			}
			firstDone := make(chan error, 1)
			go func() { firstDone <- run(db1, 0) }()
			select {
			case <-counted:
			case <-ctx.Done():
				t.Fatal("first bootstrap did not reach the protected empty-admin check")
			}
			secondDone := make(chan error, 1)
			go func() { secondDone <- run(db2, 1) }()
			select {
			case err := <-secondDone:
				t.Fatalf("competing bootstrap did not wait for the first transaction: %v", err)
			case <-time.After(150 * time.Millisecond):
			}
			unblock()
			if err := <-firstDone; err != nil {
				t.Fatal(err)
			}
			if err := <-secondDone; !errors.Is(err, ErrSystemAdminAlreadyInitialized) {
				t.Fatalf("expected competing first-admin request to fail, got %v", err)
			}
			var admins int64
			if err := db1.Model(&model.User{}).Where("role = ?", model.SystemRoleAdmin).Count(&admins).Error; err != nil {
				t.Fatal(err)
			}
			if admins != 1 {
				t.Fatalf("expected exactly one administrator, got %d", admins)
			}
		})
	}
}

// Two administrators disabling each other used to lock different rows, both
// count the other as still active, and both commit -- leaving zero enabled
// administrators and every operator endpoint returning 403. The advisory lock
// serializes the decision, so the second transaction must wait and then refuse.
func TestPostgresConcurrentAdminDemotionsKeepOneActiveAdministrator(t *testing.T) {
	db1, db2 := newPostgresConcurrencyTestDBs(t)
	if err := db1.AutoMigrate(&model.User{}); err != nil {
		t.Fatal(err)
	}
	first := model.User{Username: "race-admin-1", PasswordHash: "fixture", Role: model.SystemRoleAdmin, Status: "active"}
	second := model.User{Username: "race-admin-2", PasswordHash: "fixture", Role: model.SystemRoleAdmin, Status: "active"}
	for _, user := range []*model.User{&first, &second} {
		if err := db1.Create(user).Error; err != nil {
			t.Fatal(err)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	counted := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	unblock := func() { once.Do(func() { close(release) }) }
	t.Cleanup(unblock)
	var paused atomic.Bool
	const callback = "test:pause-last-admin-count"
	if err := db1.Callback().Query().After("gorm:query").Register(callback, func(tx *gorm.DB) {
		if _, ok := tx.Statement.Dest.(*int64); ok && tx.Statement.Table == "users" && paused.CompareAndSwap(false, true) {
			close(counted)
			<-release
		}
	}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db1.Callback().Query().Remove(callback) })

	firstDone := make(chan error, 1)
	go func() {
		_, err := NewUserRepository(db1).UpdateAdminProfile(ctx, first.ID, "first", "disabled")
		firstDone <- err
	}()
	select {
	case <-counted:
	case <-ctx.Done():
		t.Fatal("first demotion did not reach the last-admin count")
	}

	secondDone := make(chan error, 1)
	go func() {
		_, err := NewUserRepository(db2).UpdateAdminProfile(ctx, second.ID, "second", "disabled")
		secondDone <- err
	}()
	select {
	case err := <-secondDone:
		t.Fatalf("competing demotion did not wait for the first transaction: %v", err)
	case <-time.After(150 * time.Millisecond):
	}

	unblock()
	if err := <-firstDone; err != nil {
		t.Fatalf("first demotion: %v", err)
	}
	if err := <-secondDone; !errors.Is(err, ErrAdminLastAdmin) {
		t.Fatalf("expected the second demotion to be refused, got %v", err)
	}

	var activeAdmins int64
	if err := db1.Model(&model.User{}).
		Where("role = ? AND (status = ? OR status = '' OR status IS NULL)", model.SystemRoleAdmin, "active").
		Count(&activeAdmins).Error; err != nil {
		t.Fatal(err)
	}
	if activeAdmins < 1 {
		t.Fatalf("expected at least one active administrator to remain, got %d", activeAdmins)
	}
}

func TestPostgresLastActiveAdministratorIsProtected(t *testing.T) {
	db, _ := newPostgresConcurrencyTestDBs(t)
	if err := db.AutoMigrate(&model.User{}); err != nil {
		t.Fatal(err)
	}
	active := model.User{Username: "active-admin", PasswordHash: "fixture", Role: model.SystemRoleAdmin, Status: "active"}
	disabled := model.User{Username: "disabled-admin", PasswordHash: "fixture", Role: model.SystemRoleAdmin, Status: "disabled"}
	for _, user := range []*model.User{&active, &disabled} {
		if err := db.Create(user).Error; err != nil {
			t.Fatal(err)
		}
	}
	repo := NewUserRepository(db)
	if _, err := repo.UpdateAdminProfile(context.Background(), active.ID, "admin", "disabled"); !errors.Is(err, ErrAdminLastAdmin) {
		t.Fatalf("disable: %v", err)
	}
	if _, err := repo.UpdateAdminRole(context.Background(), disabled.ID, active.ID, model.SystemRoleUser); !errors.Is(err, ErrAdminLastAdmin) {
		t.Fatalf("demote: %v", err)
	}
}
