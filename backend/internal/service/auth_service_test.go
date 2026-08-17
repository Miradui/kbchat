package service

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"

	"rag/backend/internal/auth"
	"rag/backend/internal/config"
	"rag/backend/internal/dto"
	"rag/backend/internal/model"
	"rag/backend/internal/repository"
)

func TestAuthConcurrentPasswordChangesCompareAndSwapCurrentHash(t *testing.T) {
	ctx := context.Background()
	db := newConcurrentAuthTestDB(t)
	currentPassword := "current-secret"
	firstPassword := "first-password"
	secondPassword := "second-password"
	passwordHash, err := auth.HashPassword(currentPassword)
	if err != nil {
		t.Fatalf("hash current password: %v", err)
	}
	user := model.User{
		Username:     "concurrent-owner",
		PasswordHash: passwordHash,
		DisplayName:  "Concurrent Owner",
		Role:         "user",
	}
	if err := db.Create(&user).Error; err != nil {
		t.Fatalf("create concurrent auth user: %v", err)
	}
	service := NewAuthService(config.Config{
		JWTSecret:    "this-is-a-long-concurrent-auth-test-secret",
		JWTExpiresIn: "24h",
	}, repository.NewUserRepository(db))

	firstUpdateBlocked := make(chan struct{})
	releaseFirstUpdate := make(chan struct{})
	var releaseOnce sync.Once
	release := func() { releaseOnce.Do(func() { close(releaseFirstUpdate) }) }
	t.Cleanup(release)
	var blocked atomic.Bool
	callbackName := "test:block_first_concurrent_password_update"
	if err := db.Callback().Update().Before("gorm:update").Register(callbackName, func(tx *gorm.DB) {
		values, ok := tx.Statement.Dest.(map[string]any)
		if !ok {
			return
		}
		if _, changingPassword := values["password_hash"]; !changingPassword {
			return
		}
		if blocked.CompareAndSwap(false, true) {
			close(firstUpdateBlocked)
			<-releaseFirstUpdate
		}
	}); err != nil {
		t.Fatalf("register concurrent password callback: %v", err)
	}
	t.Cleanup(func() { _ = db.Callback().Update().Remove(callbackName) })

	firstDone := make(chan error, 1)
	go func() {
		firstDone <- service.ChangePassword(ctx, user.ID, dto.ChangePasswordRequest{
			CurrentPassword: currentPassword,
			NewPassword:     firstPassword,
		})
	}()

	select {
	case <-firstUpdateBlocked:
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for first password update")
	}

	if err := service.ChangePassword(ctx, user.ID, dto.ChangePasswordRequest{
		CurrentPassword: currentPassword,
		NewPassword:     secondPassword,
	}); err != nil {
		release()
		t.Fatalf("complete second password change: %v", err)
	}
	release()

	select {
	case err := <-firstDone:
		assertAppError(t, err, "INVALID_CURRENT_PASSWORD")
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for first password change")
	}

	if _, err := service.Login(ctx, dto.LoginRequest{
		Username: user.Username,
		Password: secondPassword,
	}); err != nil {
		t.Fatalf("expected winning password to remain valid: %v", err)
	}
	if _, err := service.Login(ctx, dto.LoginRequest{
		Username: user.Username,
		Password: firstPassword,
	}); err == nil {
		t.Fatal("expected losing password to remain invalid")
	}
}

func TestAuthServiceLoginAndMeExposeAvatarURL(t *testing.T) {
	ctx := context.Background()
	db := newAuthTestDB(t)

	passwordHash, err := auth.HashPassword("123456")
	if err != nil {
		t.Fatalf("hash password: %v", err)
	}

	user := &model.User{
		Username:     "admin",
		PasswordHash: passwordHash,
		DisplayName:  "Admin",
		Role:         "user",
	}
	if err := db.Create(user).Error; err != nil {
		t.Fatalf("create user: %v", err)
	}
	if err := db.Exec("UPDATE users SET avatar_url = ? WHERE id = ?", "https://example.com/avatar.png", user.ID).Error; err != nil {
		t.Fatalf("seed avatar url: %v", err)
	}

	service := NewAuthService(config.Config{
		JWTSecret:    "this-is-a-long-auth-service-test-secret",
		JWTExpiresIn: "24h",
	}, repository.NewUserRepository(db))

	loginRes, err := service.Login(ctx, dto.LoginRequest{
		Username: "admin",
		Password: "123456",
	})
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	if got := jsonField(t, loginRes.User, "avatarUrl"); got != "https://example.com/avatar.png" {
		t.Fatalf("expected avatarUrl in login response, got %v", got)
	}

	meRes, err := service.Me(ctx, user.ID)
	if err != nil {
		t.Fatalf("me: %v", err)
	}
	if got := jsonField(t, meRes, "avatarUrl"); got != "https://example.com/avatar.png" {
		t.Fatalf("expected avatarUrl in me response, got %v", got)
	}
}

func newAuthTestDB(t *testing.T) *gorm.DB {
	t.Helper()

	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatalf("open sqlite db: %v", err)
	}
	if err := db.AutoMigrate(&model.User{}); err != nil {
		t.Fatalf("auto migrate: %v", err)
	}
	return db
}

func newConcurrentAuthTestDB(t *testing.T) *gorm.DB {
	t.Helper()
	dsn := fmt.Sprintf("file:%s?mode=memory&cache=shared", uuid.NewString())
	db, err := gorm.Open(sqlite.Open(dsn), &gorm.Config{SkipDefaultTransaction: true})
	if err != nil {
		t.Fatalf("open concurrent sqlite db: %v", err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatalf("get concurrent sqlite database: %v", err)
	}
	sqlDB.SetMaxOpenConns(4)
	t.Cleanup(func() { _ = sqlDB.Close() })
	if err := db.AutoMigrate(&model.User{}); err != nil {
		t.Fatalf("auto migrate concurrent auth fixture: %v", err)
	}
	return db
}

func jsonField(t *testing.T, value any, field string) any {
	t.Helper()

	payload, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal value: %v", err)
	}

	var decoded map[string]any
	if err := json.Unmarshal(payload, &decoded); err != nil {
		t.Fatalf("unmarshal value: %v", err)
	}
	return decoded[field]
}
