package main

import (
	"context"
	"os"
	"time"

	"go.uber.org/zap"

	"kbchat/backend/internal/auth"
	"kbchat/backend/internal/config"
	"kbchat/backend/internal/database"
	"kbchat/backend/internal/logger"
	"kbchat/backend/internal/model"
	"kbchat/backend/internal/repository"
)

func main() {
	cfg := config.Load()
	log := logger.New(cfg)
	defer func() { _ = log.Sync() }()

	db, err := database.Open(cfg)
	if err != nil {
		log.Fatal("database connection failed", zap.Error(err))
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := database.AutoMigrate(ctx, db); err != nil {
		log.Fatal("database migration failed", zap.Error(err))
	}

	username := getEnv("SEED_USERNAME", "admin")
	password := getEnv("SEED_PASSWORD", "123456")
	displayName := getEnv("SEED_DISPLAY_NAME", "Admin")

	users := repository.NewUserRepository(db)
	existing, err := users.FindByUsername(ctx, username)
	if err != nil {
		log.Fatal("find user failed", zap.String("username", username), zap.Error(err))
	}
	if existing != nil {
		log.Info("seed user already exists", zap.String("username", username))
		return
	}

	passwordHash, err := auth.HashPassword(password)
	if err != nil {
		log.Fatal("hash password failed", zap.Error(err))
	}

	if err := users.Create(ctx, &model.User{
		Username:     username,
		PasswordHash: passwordHash,
		DisplayName:  displayName,
		Role:         "user",
	}); err != nil {
		log.Fatal("create user failed", zap.String("username", username), zap.Error(err))
	}

	log.Info("seeded user", zap.String("username", username))
}

func getEnv(key, fallback string) string {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	return value
}
