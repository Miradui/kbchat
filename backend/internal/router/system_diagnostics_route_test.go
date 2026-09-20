package router

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"

	"kbchat/backend/internal/auth"
	"kbchat/backend/internal/config"
	"kbchat/backend/internal/dto"
	"kbchat/backend/internal/logger"
	"kbchat/backend/internal/model"
)

func TestDiagnosticsUsesTheCurrentSystemRole(t *testing.T) {
	for _, test := range []struct {
		name, storedRole, tokenRole string
		deleted                     bool
		status                      int
	}{
		{"ordinary user", "user", "user", false, http.StatusForbidden},
		{"stale admin claim", "user", "admin", false, http.StatusForbidden},
		{"knowledge base manager is not system admin", "manager", "admin", false, http.StatusForbidden},
		{"unknown system role", "unknown", "admin", false, http.StatusForbidden},
		{"promoted user with old token", "admin", "user", false, http.StatusOK},
		{"legacy token without role", "admin", "", false, http.StatusOK},
		{"deleted administrator", "admin", "admin", true, http.StatusUnauthorized},
	} {
		t.Run(test.name, func(t *testing.T) {
			cfg := diagnosticsRouteConfig(t)
			db := testDB(t)
			if err := db.AutoMigrate(&model.User{}, &model.DocumentJob{}, &model.StorageCleanupJob{}); err != nil {
				t.Fatal(err)
			}
			user := model.User{Username: "role-" + uuid.NewString(), PasswordHash: "hash", Role: test.storedRole}
			if err := db.Create(&user).Error; err != nil {
				t.Fatal(err)
			}
			token, err := auth.GenerateToken(cfg, user.ID, test.tokenRole)
			if err != nil {
				t.Fatal(err)
			}
			if test.deleted {
				if err := db.Delete(&user).Error; err != nil {
					t.Fatal(err)
				}
			}
			r := New(cfg, db, logger.New(cfg))
			req := httptest.NewRequest(http.MethodGet, "/api/v1/system/diagnostics", nil)
			req.Header.Set("Authorization", "Bearer "+token)
			rec := httptest.NewRecorder()
			r.ServeHTTP(rec, req)
			if rec.Code != test.status {
				t.Fatalf("status %d, want %d: %s", rec.Code, test.status, rec.Body.String())
			}
			if test.status != http.StatusOK && strings.Contains(rec.Body.String(), "dependencies") {
				t.Fatal("denied request leaked diagnostics")
			}
			if test.status == http.StatusForbidden && !strings.Contains(rec.Body.String(), "SYSTEM_ADMIN_REQUIRED") {
				t.Fatal("missing system-admin error code")
			}
			if !test.deleted {
				capabilities := httptest.NewRequest(http.MethodGet, "/api/v1/system/capabilities", nil)
				capabilities.Header.Set("Authorization", "Bearer "+token)
				allowed := httptest.NewRecorder()
				r.ServeHTTP(allowed, capabilities)
				if allowed.Code != http.StatusOK {
					t.Fatal("capabilities must remain accessible to ordinary users")
				}
			}
		})
	}
}

func TestDiagnosticsFailsClosedWhenRoleLookupFails(t *testing.T) {
	cfg := diagnosticsRouteConfig(t)
	r := New(cfg, testDB(t), logger.New(cfg))
	token, err := auth.GenerateToken(cfg, uuid.New(), "admin")
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/system/diagnostics", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("unexpected status: %d", rec.Code)
	}
	for _, forbidden := range []string{"dependencies", "no such table", "SELECT", "routesecret"} {
		if strings.Contains(rec.Body.String(), forbidden) {
			t.Fatalf("authorization failure leaked %s", forbidden)
		}
	}
}

func diagnosticsRouteConfig(t *testing.T) config.Config {
	t.Helper()
	return config.Config{
		AppEnv:     "test",
		ServerPort: "0",
		// A real directory, because the storage probe stats it. An empty upload
		// directory is genuinely unhealthy and should report as such.
		UploadDir:       t.TempDir(),
		JWTSecret:       "diagnostics-route-secret-at-least-32-bytes-long",
		JWTExpiresIn:    "1h",
		ChatAPIKey:      "sk-chat-route-key",
		ChatModel:       "gpt-route",
		EmbeddingAPIKey: "sk-embedding-route-key",
		EmbeddingModel:  "embed-route",
		RerankEnabled:   false,
		DatabaseURL:     "postgres://rag:routesecret@db.internal:5432/rag",
	}
}

func TestDiagnosticsRouteRequiresAuthentication(t *testing.T) {
	cfg := diagnosticsRouteConfig(t)
	r := New(cfg, testDB(t), logger.New(cfg))

	req := httptest.NewRequest(http.MethodGet, "/api/v1/system/diagnostics", nil)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d for an unauthenticated request", rec.Code, http.StatusUnauthorized)
	}
	// A diagnostics payload leaking before the auth check would defeat the point
	// of protecting the route at all.
	if strings.Contains(rec.Body.String(), "dependencies") {
		t.Errorf("unauthenticated body carried diagnostics: %s", rec.Body.String())
	}
}

func TestDiagnosticsRouteReturnsTheContract(t *testing.T) {
	cfg := diagnosticsRouteConfig(t)
	db := testDB(t)
	if err := db.AutoMigrate(&model.User{}, &model.DocumentJob{}, &model.StorageCleanupJob{}); err != nil {
		t.Fatalf("migrate diagnostics route schema: %v", err)
	}
	user := model.User{Username: "diagnostics-route", PasswordHash: "hash", Role: model.SystemRoleAdmin}
	if err := db.Create(&user).Error; err != nil {
		t.Fatalf("create diagnostics route user: %v", err)
	}
	token, err := auth.GenerateToken(cfg, user.ID, user.Role)
	if err != nil {
		t.Fatalf("generate diagnostics route token: %v", err)
	}

	r := New(cfg, db, logger.New(cfg))
	req := httptest.NewRequest(http.MethodGet, "/api/v1/system/diagnostics", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d: %s", rec.Code, http.StatusOK, rec.Body.String())
	}

	var response dto.SystemDiagnosticsResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode diagnostics response: %v", err)
	}
	if response.Env != "test" {
		t.Errorf("env = %q, want test", response.Env)
	}
	if response.CheckedAt.IsZero() {
		t.Error("checkedAt is zero")
	}
	if len(response.Dependencies) != 3 {
		t.Fatalf("dependencies = %d, want database, redis and storage", len(response.Dependencies))
	}
	if len(response.Providers) != 4 {
		t.Fatalf("providers = %d, want four", len(response.Providers))
	}

	// The router wires the real repositories against the test database, so the
	// database probe must genuinely answer -- this is what catches a broken
	// SystemRepository.Ping.
	for _, dep := range response.Dependencies {
		if dep.Name == "database" && dep.Status != dto.SystemStatusOK {
			t.Errorf("database status = %q reason %q, want ok", dep.Status, dep.Reason)
		}
		// Redis is not wired by router.New, so it must report as unconfigured
		// rather than failing the request.
		if dep.Name == "redis" && dep.Status != dto.SystemStatusNotConfigured {
			t.Errorf("redis status = %q, want not_configured", dep.Status)
		}
	}

	if strings.Contains(rec.Body.String(), "routesecret") || strings.Contains(rec.Body.String(), "sk-chat-route-key") {
		t.Errorf("diagnostics response leaked a secret: %s", rec.Body.String())
	}
}

func TestLivenessReportsDependencyStatusesWithoutDetail(t *testing.T) {
	cfg := diagnosticsRouteConfig(t)
	db := testDB(t)
	if err := db.AutoMigrate(&model.User{}); err != nil {
		t.Fatalf("migrate liveness schema: %v", err)
	}
	r := New(cfg, db, logger.New(cfg))

	for _, path := range []string{"/healthz", "/api/v1/healthz"} {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)

		// Liveness stays 200 even when degraded: a 503 here makes an
		// orchestrator restart a container that is not the broken component.
		if rec.Code != http.StatusOK {
			t.Fatalf("%s status = %d, want %d", path, rec.Code, http.StatusOK)
		}

		var response dto.SystemHealthResponse
		if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
			t.Fatalf("%s decode: %v", path, err)
		}
		if response.Status != dto.SystemStatusOK {
			t.Errorf("%s status = %q, want ok", path, response.Status)
		}
		if response.Env != "test" {
			t.Errorf("%s env = %q, want test", path, response.Env)
		}
		if response.Dependencies["database"] != dto.SystemStatusOK {
			t.Errorf("%s database = %q, want ok", path, response.Dependencies["database"])
		}

		// Unauthenticated: names and statuses only. No reasons, no latencies, no
		// counts, nothing about the deployment's topology.
		body := rec.Body.String()
		for _, forbidden := range []string{"latencyMs", "reason", "routesecret", "db.internal", "providers", "queues"} {
			if strings.Contains(body, forbidden) {
				t.Errorf("%s body contains %q: %s", path, forbidden, body)
			}
		}
	}
}
