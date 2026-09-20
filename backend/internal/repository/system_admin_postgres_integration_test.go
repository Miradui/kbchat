package repository

import (
	"context"
	"errors"
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
			if err := db1.AutoMigrate(&model.User{}); err != nil {
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
