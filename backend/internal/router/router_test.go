package router

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"

	"rag/backend/internal/config"
	"rag/backend/internal/logger"
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

func testDB(t *testing.T) *gorm.DB {
	t.Helper()

	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatalf("open test db: %v", err)
	}
	return db
}
