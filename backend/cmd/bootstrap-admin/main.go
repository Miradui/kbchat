package main

import (
	"context"
	"errors"
	"flag"
	"os"
	"time"

	"go.uber.org/zap"

	"kbchat/backend/internal/config"
	"kbchat/backend/internal/database"
	"kbchat/backend/internal/logger"
	"kbchat/backend/internal/repository"
	"kbchat/backend/internal/service"
)

func main() {
	username := flag.String("username", "", "explicit account to promote or create as the first system administrator")
	create := flag.Bool("create", false, "create a new account using BOOTSTRAP_ADMIN_PASSWORD; otherwise promote an existing account")
	flag.Parse()
	cfg := config.Load()
	log := logger.New(cfg)
	defer func() { _ = log.Sync() }()
	if *username == "" || flag.NArg() != 0 {
		log.Fatal("specify -username; use -create only for a new account")
	}
	db, err := database.Open(cfg)
	if err != nil {
		log.Fatal("database connection failed", zap.Error(err))
	}
	sqlDB, err := db.DB()
	if err != nil {
		log.Fatal("database pool unavailable", zap.Error(err))
	}
	defer sqlDB.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	request := service.SystemAdminBootstrapRequest{Username: *username, Create: *create}
	if *create {
		request.Password = os.Getenv("BOOTSTRAP_ADMIN_PASSWORD")
		request.DisplayName = os.Getenv("BOOTSTRAP_ADMIN_DISPLAY_NAME")
	}
	result, err := service.NewSystemAdminService(repository.NewUserRepository(db)).Bootstrap(ctx, request)
	if err != nil {
		switch {
		case errors.Is(err, repository.ErrSystemAdminAlreadyInitialized):
			log.Fatal("a system administrator already exists; bootstrap cannot grant another account")
		case errors.Is(err, repository.ErrBootstrapUserNotFound):
			log.Fatal("target account does not exist; use -create and BOOTSTRAP_ADMIN_PASSWORD for a new account")
		case errors.Is(err, repository.ErrBootstrapUserExists):
			log.Fatal("target account already exists; omit -create to promote it without changing its password")
		default:
			log.Fatal("bootstrap system administrator failed", zap.Error(err))
		}
	}
	log.Info("system administrator bootstrap completed", zap.String("username", result.User.Username), zap.String("action", result.Action))
}
