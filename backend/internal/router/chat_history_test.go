package router

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"
	"kbchat/backend/internal/config"
	"kbchat/backend/internal/logger"
	"kbchat/backend/internal/model"
)

func TestChatHistoryRoutePaginationValidationAndAuthentication(t *testing.T) {
	cfg := config.Config{AppEnv: "test", ServerPort: "0", JWTSecret: "this-is-a-long-router-test-secret-1234", JWTExpiresIn: "1h"}
	db := testDB(t)
	if err := db.AutoMigrate(&model.User{}, &model.KnowledgeBase{}, &model.KnowledgeBaseMember{}, &model.ChatSession{}, &model.ChatSessionKnowledgeBase{}, &model.ChatMessage{}); err != nil {
		t.Fatal(err)
	}
	user, token := createRouteUser(t, cfg, db, "user")
	kb := model.KnowledgeBase{Name: "history", OwnerID: user.ID}
	if err := db.Create(&kb).Error; err != nil {
		t.Fatal(err)
	}
	session := model.ChatSession{ID: uuid.New(), UserID: user.ID, KnowledgeBaseID: kb.ID}
	if err := db.Create(&session).Error; err != nil {
		t.Fatal(err)
	}
	r := New(cfg, db, logger.New(cfg))
	path := "/api/v1/chat/sessions/" + session.ID.String() + "/messages"
	for _, query := range []string{"?limit=", "?limit=abc", "?limit=0", "?limit=101", "?limit=50&before=invalid", "?revision=invalid", "?after=invalid", "?around=invalid", "?around=" + uuid.NewString() + "&since=invalid"} {
		req := httptest.NewRequest(http.MethodGet, path+query, nil)
		req.Header.Set("Authorization", "Bearer "+token)
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("%s: %d %s", query, rec.Code, rec.Body.String())
		}
	}
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path+"?limit=50", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous page: %d", rec.Code)
	}
	req := httptest.NewRequest(http.MethodGet, path+"?limit=50", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	var body struct {
		Items []any `json:"items"`
	}
	if rec.Code != 200 || json.Unmarshal(rec.Body.Bytes(), &body) != nil || body.Items == nil || len(body.Items) != 0 {
		t.Fatalf("empty page: %d %s", rec.Code, rec.Body.String())
	}
}

func TestChatMessageSearchRouteValidationAuthenticationAndEnvelope(t *testing.T) {
	cfg := config.Config{AppEnv: "test", ServerPort: "0", JWTSecret: "this-is-a-long-router-test-secret-1234", JWTExpiresIn: "1h"}
	db := testDB(t)
	if err := db.AutoMigrate(&model.User{}, &model.KnowledgeBase{}, &model.KnowledgeBaseMember{}, &model.ChatSession{}, &model.ChatSessionKnowledgeBase{}, &model.ChatMessage{}); err != nil {
		t.Fatal(err)
	}
	_, token := createRouteUser(t, cfg, db, "user")
	r := New(cfg, db, logger.New(cfg))
	path := "/api/v1/chat/messages/search"
	for _, query := range []string{"", "?q=", "?q=foo&page=0", "?q=foo&page=oops", "?q=foo&pageSize=101", "?q=foo&pageSize=", "?q=foo&sessionId=invalid"} {
		req := httptest.NewRequest(http.MethodGet, path+query, nil)
		req.Header.Set("Authorization", "Bearer "+token)
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		if rec.Code != 400 {
			t.Fatalf("%s: %d %s", query, rec.Code, rec.Body.String())
		}
	}
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path+"?q=needle", nil))
	if rec.Code != 401 {
		t.Fatalf("anonymous search: %d", rec.Code)
	}
	req := httptest.NewRequest(http.MethodGet, path+"?q=needle", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	var body struct {
		Items    []any `json:"items"`
		Total    int   `json:"total"`
		Page     int   `json:"page"`
		PageSize int   `json:"pageSize"`
	}
	if rec.Code != 200 || json.Unmarshal(rec.Body.Bytes(), &body) != nil || body.Items == nil || body.Total != 0 || body.Page != 1 || body.PageSize != 20 {
		t.Fatalf("empty search: %d %s", rec.Code, rec.Body.String())
	}
}
