package router

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"

	"github.com/google/uuid"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"

	"kbchat/backend/internal/auth"
	"kbchat/backend/internal/config"
	"kbchat/backend/internal/dto"
	"kbchat/backend/internal/logger"
	"kbchat/backend/internal/model"
	rerankprovider "kbchat/backend/internal/provider/rerank"
	corererank "kbchat/backend/internal/rerank"
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

func TestCORSAllowsConfiguredPreflightOrigin(t *testing.T) {
	origin := "https://ui.example.test"
	cfg := config.Config{
		AppEnv:             "test",
		ServerPort:         "0",
		CORSAllowedOrigins: []string{origin},
	}
	r := New(cfg, testDB(t), logger.New(cfg))

	req := httptest.NewRequest(http.MethodOptions, "/api/v1/auth/login", nil)
	req.Header.Set("Origin", origin)
	req.Header.Set("Access-Control-Request-Method", http.MethodPost)
	req.Header.Set("Access-Control-Request-Headers", "authorization,content-type")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("expected preflight status %d, got %d", http.StatusNoContent, rec.Code)
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != origin {
		t.Fatalf("expected allowed origin %q, got %q", origin, got)
	}
	if got := rec.Header().Get("Access-Control-Allow-Headers"); got != "Authorization, Content-Type" {
		t.Fatalf("unexpected allowed headers %q", got)
	}
}

func TestCORSRejectsOriginOutsideConfiguredAllowlist(t *testing.T) {
	cfg := config.Config{
		AppEnv:             "test",
		ServerPort:         "0",
		CORSAllowedOrigins: []string{"https://ui.example.test"},
	}
	r := New(cfg, testDB(t), logger.New(cfg))

	req := httptest.NewRequest(http.MethodOptions, "/api/v1/auth/login", nil)
	req.Header.Set("Origin", "http://127.0.0.1:5173")
	req.Header.Set("Access-Control-Request-Method", http.MethodPost)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("expected no allowed origin, got %q", got)
	}
	if got := rec.Header().Values("Vary"); !slices.Contains(got, "Origin") {
		t.Fatalf("expected Vary to include Origin, got %q", got)
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
	cfg := config.Config{AppEnv: "test", ServerPort: "0", JWTSecret: "this-is-a-long-router-test-secret-1234", JWTExpiresIn: "1h"}
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
	cfg := config.Config{AppEnv: "test", ServerPort: "0", JWTSecret: "this-is-a-long-router-test-secret-1234", JWTExpiresIn: "1h"}
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
	cfg := config.Config{AppEnv: "test", ServerPort: "0", JWTSecret: "this-is-a-long-router-test-secret-1234", JWTExpiresIn: "1h"}
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
	cfg := config.Config{AppEnv: "test", ServerPort: "0", JWTSecret: "this-is-a-long-router-test-secret-1234", JWTExpiresIn: "1h"}
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

func TestFeedbackAndExportEndpointsReturnHTTPContracts(t *testing.T) {
	cfg := config.Config{AppEnv: "test", ServerPort: "0", JWTSecret: "this-is-a-long-router-test-secret-1234", JWTExpiresIn: "1h"}
	db := testDB(t)
	if err := db.AutoMigrate(
		&model.User{},
		&model.KnowledgeBase{},
		&model.Document{},
		&model.DocumentChunk{},
		&model.ChatSession{},
		&model.ChatMessage{},
	); err != nil {
		t.Fatalf("migrate gap endpoint test tables: %v", err)
	}
	user := model.User{Username: "gap-contract-owner", PasswordHash: "hash"}
	if err := db.Create(&user).Error; err != nil {
		t.Fatalf("create gap contract user: %v", err)
	}
	kb := model.KnowledgeBase{Name: "contract kb", OwnerID: user.ID, Visibility: "private"}
	if err := db.Create(&kb).Error; err != nil {
		t.Fatalf("create gap contract knowledge base: %v", err)
	}
	document := model.Document{
		KnowledgeBaseID: kb.ID,
		UploaderID:      user.ID,
		Filename:        "contract.pdf",
		StoragePath:     "contract.pdf",
		Status:          "completed",
	}
	if err := db.Create(&document).Error; err != nil {
		t.Fatalf("create gap contract document: %v", err)
	}
	chunk := model.DocumentChunk{
		DocumentID:      document.ID,
		KnowledgeBaseID: kb.ID,
		ChunkIndex:      0,
		Content:         "export-contract content",
	}
	if err := db.Create(&chunk).Error; err != nil {
		t.Fatalf("create gap contract chunk: %v", err)
	}
	session := model.ChatSession{UserID: user.ID, KnowledgeBaseID: kb.ID, Title: "contract chat"}
	if err := db.Create(&session).Error; err != nil {
		t.Fatalf("create gap contract session: %v", err)
	}
	message := model.ChatMessage{SessionID: session.ID, Role: "assistant", Content: "contract answer"}
	if err := db.Create(&message).Error; err != nil {
		t.Fatalf("create gap contract message: %v", err)
	}
	token, err := auth.GenerateToken(cfg, user.ID)
	if err != nil {
		t.Fatalf("generate gap contract token: %v", err)
	}
	r := New(cfg, db, logger.New(cfg))

	t.Run("feedback", func(t *testing.T) {
		req := httptest.NewRequest(
			http.MethodPost,
			"/api/v1/chat/messages/"+message.ID.String()+"/feedback",
			strings.NewReader(`{"rating":"positive"}`),
		)
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("expected feedback status %d, got %d: %s", http.StatusOK, rec.Code, rec.Body.String())
		}
		var response dto.ChatMessageFeedbackResponse
		if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
			t.Fatalf("decode feedback response: %v", err)
		}
		if response.MessageID != message.ID.String() || response.Rating != "positive" || response.UpdatedAt.IsZero() {
			t.Fatalf("unexpected feedback response: %#v", response)
		}
	})

	t.Run("chat markdown export", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/chat/sessions/"+session.ID.String()+"/export", nil)
		req.Header.Set("Authorization", "Bearer "+token)
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("expected chat export status %d, got %d: %s", http.StatusOK, rec.Code, rec.Body.String())
		}
		if got := rec.Header().Get("Content-Type"); got != "text/markdown; charset=utf-8" {
			t.Fatalf("unexpected chat export content type %q", got)
		}
		wantDisposition := `attachment; filename="chat-` + session.ID.String() + `.md"`
		if got := rec.Header().Get("Content-Disposition"); got != wantDisposition {
			t.Fatalf("unexpected chat export disposition %q", got)
		}
	})

	t.Run("search csv export", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/search/export?q=export-contract&type=chunk", nil)
		req.Header.Set("Authorization", "Bearer "+token)
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("expected search export status %d, got %d: %s", http.StatusOK, rec.Code, rec.Body.String())
		}
		if got := rec.Header().Get("Content-Type"); got != "text/csv; charset=utf-8" {
			t.Fatalf("unexpected search export content type %q", got)
		}
		if got := rec.Header().Get("Content-Disposition"); got != `attachment; filename="search-results.csv"` {
			t.Fatalf("unexpected search export disposition %q", got)
		}
	})
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
