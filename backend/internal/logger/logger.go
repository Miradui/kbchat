package logger

import (
	"log"

	"go.uber.org/zap"

	"rag/backend/internal/config"
)

func New(cfg config.Config) *zap.Logger {
	var (
		l   *zap.Logger
		err error
	)

	if cfg.AppEnv == "production" {
		l, err = zap.NewProduction()
	} else {
		l, err = zap.NewDevelopment()
	}
	if err != nil {
		log.Fatalf("initialize zap logger: %v", err)
	}

	return l
}
