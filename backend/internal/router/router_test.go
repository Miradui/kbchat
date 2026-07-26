package router

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"
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

func TestDocumentChunksRejectInvalidChunkID(t *testing.T) {
	cfg := config.Config{AppEnv: "test", ServerPort: "0", JWTSecret: "router-test-secret", JWTExpiresIn: "1h"}
	token, err := auth.GenerateToken(cfg, uuid.New())
	if err != nil {
		t.Fatalf("generate chunk query token: %v", err)
	}
	for _, rawChunkID := range []string{"not-a-uuid", ""} {
		t.Run("chunkId="+rawChunkID, func(t *testing.T) {
			r := New(cfg, testDB(t), logger.New(cfg))
			req := httptest.NewRequest(
				http.MethodGet,
				"/api/v1/documents/"+uuid.NewString()+"/chunks?chunkId="+rawChunkID,
				nil,
			)
			req.Header.Set("Authorization", "Bearer "+token)
			rec := httptest.NewRecorder()

			r.ServeHTTP(rec, req)

			if rec.Code != http.StatusBadRequest {
				t.Fatalf("expected invalid chunk ID status %d, got %d: %s", http.StatusBadRequest, rec.Code, rec.Body.String())
			}
			var response struct {
				Code    string         `json:"code"`
				Details map[string]any `json:"details"`
			}
			if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
				t.Fatalf("decode validation response: %v", err)
			}
			if response.Code != "VALIDATION_ERROR" || response.Details["chunkId"] == nil {
				t.Fatalf("unexpected validation response: %#v", response)
			}
		})
	}
}

func TestGlobalSearchRejectsInvalidContractParameters(t *testing.T) {
	cfg := config.Config{AppEnv: "test", ServerPort: "0", JWTSecret: "router-test-secret", JWTExpiresIn: "1h"}
	token, err := auth.GenerateToken(cfg, uuid.New())
	if err != nil {
		t.Fatalf("generate search token: %v", err)
	}
	r := New(cfg, testDB(t), logger.New(cfg))

	for _, path := range []string{
		"/api/v1/search?q=%20%20%20",
		"/api/v1/search?q=policy&type=invalid",
		"/api/v1/search?q=policy&page=abc",
		"/api/v1/search?q=policy&pageSize=abc",
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

func TestSendChatMessageRequiresUUIDClientRequestID(t *testing.T) {
	cfg := config.Config{AppEnv: "test", ServerPort: "0", JWTSecret: "router-test-secret", JWTExpiresIn: "1h"}
	token, err := auth.GenerateToken(cfg, uuid.New())
	if err != nil {
		t.Fatalf("generate chat token: %v", err)
	}
	r := New(cfg, testDB(t), logger.New(cfg))
	sessionID := uuid.NewString()

	for name, body := range map[string]string{
		"missing": `{"content":"question"}`,
		"invalid": `{"content":"question","clientRequestId":"not-a-uuid"}`,
	} {
		t.Run(name, func(t *testing.T) {
			req := httptest.NewRequest(
				http.MethodPost,
				"/api/v1/chat/sessions/"+sessionID+"/messages",
				strings.NewReader(body),
			)
			req.Header.Set("Authorization", "Bearer "+token)
			req.Header.Set("Content-Type", "application/json")
			rec := httptest.NewRecorder()

			r.ServeHTTP(rec, req)

			if rec.Code != http.StatusBadRequest {
				t.Fatalf("expected validation status %d, got %d: %s", http.StatusBadRequest, rec.Code, rec.Body.String())
			}
		})
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
