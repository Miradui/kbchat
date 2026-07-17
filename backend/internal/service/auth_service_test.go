package service

import (
	"context"
	"encoding/json"
	"testing"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"

	"rag/backend/internal/auth"
	"rag/backend/internal/config"
	"rag/backend/internal/dto"
	"rag/backend/internal/model"
	"rag/backend/internal/repository"
)

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
