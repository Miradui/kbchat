package router

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"

	"kbchat/backend/internal/config"
	"kbchat/backend/internal/logger"
)

func TestRetiredChatAndSearchFeaturesReturnNotFound(t *testing.T) {
	cfg := config.Config{AppEnv: "test", JWTSecret: "retired-feature-router-secret-123456", JWTExpiresIn: "1h"}
	db := testDB(t)
	_, token := createRouteUser(t, cfg, db, "retired-features")
	r := New(cfg, db, logger.New(cfg))
	id := uuid.NewString()
	for _, test := range []struct{ method, path string }{
		{http.MethodGet, "/api/v1/chat/templates"},
		{http.MethodPost, "/api/v1/chat/templates"},
		{http.MethodPut, "/api/v1/chat/templates/" + id},
		{http.MethodDelete, "/api/v1/chat/templates/" + id},
		{http.MethodPost, "/api/v1/chat/sessions/" + id + "/branches"},
		{http.MethodGet, "/api/v1/search/export?q=policy&type=chunk"},
	} {
		t.Run(test.method+" "+test.path, func(t *testing.T) {
			req := httptest.NewRequest(test.method, test.path, strings.NewReader("{}"))
			req.Header.Set("Authorization", "Bearer "+token)
			req.Header.Set("Content-Type", "application/json")
			rec := httptest.NewRecorder()
			r.ServeHTTP(rec, req)
			if rec.Code != http.StatusNotFound {
				t.Fatalf("retired endpoint returned %d, want 404", rec.Code)
			}
		})
	}
}
