package router

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"

	"kbchat/backend/internal/auth"
	"kbchat/backend/internal/config"
	"kbchat/backend/internal/logger"
)

func TestKnowledgeGapsRejectsInvalidContractParameters(t *testing.T) {
	cfg := config.Config{AppEnv: "test", ServerPort: "0", JWTSecret: "this-is-a-long-router-test-secret-1234", JWTExpiresIn: "1h"}
	token, err := auth.GenerateToken(cfg, uuid.New())
	if err != nil {
		t.Fatalf("generate quality token: %v", err)
	}
	r := New(cfg, testDB(t), logger.New(cfg))

	for _, path := range []string{
		"/api/v1/chat/quality/knowledge-gaps?period=week",
		"/api/v1/chat/quality/knowledge-gaps?category=everything",
		"/api/v1/chat/quality/knowledge-gaps?knowledgeBaseId=not-a-uuid",
	} {
		t.Run(path, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, path, nil)
			req.Header.Set("Authorization", "Bearer "+token)
			rec := httptest.NewRecorder()

			r.ServeHTTP(rec, req)

			if rec.Code != http.StatusBadRequest {
				t.Fatalf("expected validation status %d, got %d: %s", http.StatusBadRequest, rec.Code, rec.Body.String())
			}
			var response struct {
				Code string `json:"code"`
			}
			if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
				t.Fatalf("decode validation response: %v", err)
			}
			if response.Code != "VALIDATION_ERROR" {
				t.Fatalf("expected VALIDATION_ERROR, got %#v", response)
			}
		})
	}
}

func TestKnowledgeGapsRequiresAuthentication(t *testing.T) {
	cfg := config.Config{AppEnv: "test", ServerPort: "0", JWTSecret: "this-is-a-long-router-test-secret-1234", JWTExpiresIn: "1h"}
	r := New(cfg, testDB(t), logger.New(cfg))

	req := httptest.NewRequest(http.MethodGet, "/api/v1/chat/quality/knowledge-gaps", nil)
	rec := httptest.NewRecorder()

	r.ServeHTTP(rec, req)

	// The list exposes question text from a user's own sessions, so an anonymous
	// caller must not reach the handler at all.
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected status %d, got %d: %s", http.StatusUnauthorized, rec.Code, rec.Body.String())
	}
}
