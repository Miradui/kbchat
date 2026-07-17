package auth

import (
	"testing"

	"github.com/google/uuid"

	"rag/backend/internal/config"
)

func TestGenerateTokenRejectsUnsafeJWTSecret(t *testing.T) {
	_, err := GenerateToken(config.Config{
		JWTSecret:    "replace-with-local-secret",
		JWTExpiresIn: "1h",
	}, uuid.New())
	if err == nil {
		t.Fatal("expected token generation to reject the legacy fallback secret")
	}
}

func TestParseTokenRejectsUnsafeJWTSecret(t *testing.T) {
	token, err := GenerateToken(config.Config{
		JWTSecret:    "this-is-a-long-random-test-secret-123456",
		JWTExpiresIn: "1h",
	}, uuid.New())
	if err != nil {
		t.Fatalf("generate token: %v", err)
	}

	if _, err := ParseToken(config.Config{JWTSecret: "replace-with-local-secret"}, token); err == nil {
		t.Fatal("expected token parsing to reject the legacy fallback secret")
	}
}
