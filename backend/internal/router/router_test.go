package router

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"

	"rag/backend/internal/auth"
	"rag/backend/internal/config"
	"rag/backend/internal/dto"
	"rag/backend/internal/logger"
	"rag/backend/internal/model"
	rerankprovider "rag/backend/internal/provider/rerank"
	corererank "rag/backend/internal/rerank"
)

func TestHealthz(t *testing.T) {
	cfg := config.Config{AppEnv: "test", ServerPort: "0"}
	r := New(cfg, testDB(t), logger.New(cfg))

	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	rec := httptest.NewRecorder()

	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d", http.StatusOK, rec.Code)
	}
}

func TestAPIHealthz(t *testing.T) {
	cfg := config.Config{AppEnv: "test", ServerPort: "0"}
	r := New(cfg, testDB(t), logger.New(cfg))

	req := httptest.NewRequest(http.MethodGet, "/api/v1/healthz", nil)
	rec := httptest.NewRecorder()

	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d", http.StatusOK, rec.Code)
	}
}

func TestNewRerankProviderUsesOpenAICompatibleProviderWhenEnabled(t *testing.T) {
	provider := newRerankProvider(config.Config{
		RerankEnabled: true,
		RerankBaseURL: "https://example.test/v1",
		RerankAPIKey:  "test-key",
		RerankModel:   "test-rerank",
	})

	if _, ok := provider.(*rerankprovider.OpenAICompatibleProvider); !ok {
		t.Fatalf("expected OpenAI-compatible provider, got %T", provider)
	}
}

func TestNewRerankProviderUsesDisabledProviderWhenDisabled(t *testing.T) {
	provider := newRerankProvider(config.Config{RerankEnabled: false})

	if _, ok := provider.(*corererank.DisabledProvider); !ok {
		t.Fatalf("expected disabled provider, got %T", provider)
	}
}

func TestArchiveChatSessionReturnsArchivedSession(t *testing.T) {
	cfg := config.Config{AppEnv: "test", ServerPort: "0", JWTSecret: "router-test-secret", JWTExpiresIn: "1h"}
	db := testDB(t)
	if err := db.AutoMigrate(&model.User{}, &model.KnowledgeBase{}, &model.ChatSession{}); err != nil {
		t.Fatalf("migrate archive test tables: %v", err)
	}
	user := model.User{Username: "archive-owner", PasswordHash: "hash"}
	if err := db.Create(&user).Error; err != nil {
		t.Fatalf("create archive test user: %v", err)
	}
	kb := model.KnowledgeBase{Name: "archive-kb", OwnerID: user.ID, Visibility: "private"}
	if err := db.Create(&kb).Error; err != nil {
		t.Fatalf("create archive test knowledge base: %v", err)
	}
	session := model.ChatSession{UserID: user.ID, KnowledgeBaseID: kb.ID, Title: "archive me"}
	if err := db.Create(&session).Error; err != nil {
		t.Fatalf("create archive test session: %v", err)
	}
	token, err := auth.GenerateToken(cfg, user.ID)
	if err != nil {
		t.Fatalf("generate archive test token: %v", err)
	}
	r := New(cfg, db, logger.New(cfg))

	first := archiveSessionRequest(t, r, token, session.ID.String())
	second := archiveSessionRequest(t, r, token, session.ID.String())
	if first.ArchivedAt == nil || second.ArchivedAt == nil {
		t.Fatalf("expected archivedAt in both responses, first=%#v second=%#v", first, second)
	}
	if first.ID != session.ID.String() || !first.ArchivedAt.Equal(*second.ArchivedAt) {
		t.Fatalf("expected stable archived session response, first=%#v second=%#v", first, second)
	}
}

func archiveSessionRequest(t *testing.T, handler http.Handler, token, sessionID string) dto.ChatSessionResponse {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/chat/sessions/"+sessionID+"/archive", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected archive status %d, got %d: %s", http.StatusOK, rec.Code, rec.Body.String())
	}
	var response dto.ChatSessionResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode archive response: %v", err)
	}
	return response
}

func testDB(t *testing.T) *gorm.DB {
	t.Helper()

	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatalf("open test db: %v", err)
	}
	return db
}
