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

func TestEvaluationHTTPContractsAndAccess(t *testing.T) {
	cfg := config.Config{AppEnv: "test", JWTSecret: "evaluation-router-test-secret-123456", JWTExpiresIn: "1h"}
	db := testDB(t)
	if err := db.AutoMigrate(&model.User{}, &model.KnowledgeBase{}, &model.KnowledgeBaseMember{}, &model.EvaluationCase{}, &model.EvaluationRun{}); err != nil {
		t.Fatal(err)
	}
	owner := model.User{Username: "evaluation-owner", PasswordHash: "hash"}
	if err := db.Create(&owner).Error; err != nil {
		t.Fatal(err)
	}
	kb := model.KnowledgeBase{OwnerID: owner.ID, Name: "Evaluation contract", Visibility: "private"}
	if err := db.Create(&kb).Error; err != nil {
		t.Fatal(err)
	}
	token, err := auth.GenerateToken(cfg, owner.ID, owner.Role)
	if err != nil {
		t.Fatal(err)
	}
	// The outsider must be a real, active account: the auth middleware now
	// rejects tokens for unknown users before any resource lookup.
	other := model.User{Username: "evaluation-outsider", PasswordHash: "hash"}
	if err := db.Create(&other).Error; err != nil {
		t.Fatal(err)
	}
	otherToken, err := auth.GenerateToken(cfg, other.ID, "user")
	if err != nil {
		t.Fatal(err)
	}
	r := New(cfg, db, logger.New(cfg))
	base := "/api/v1/knowledge-bases/" + kb.ID.String()
	request := func(method, path, body, credential string, status int) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		if credential != "" {
			req.Header.Set("Authorization", "Bearer "+credential)
		}
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		if rec.Code != status {
			t.Fatalf("%s %s: status %d, want %d: %s", method, path, rec.Code, status, rec.Body.String())
		}
		return rec
	}
	request(http.MethodGet, base+"/evaluation-cases", "", "", http.StatusUnauthorized)
	request(http.MethodPost, base+"/evaluation-cases", `{"question":" "}`, token, http.StatusBadRequest)
	request(http.MethodPost, base+"/evaluation-cases", `{"question":"private question"}`, otherToken, http.StatusNotFound)
	created := request(http.MethodPost, base+"/evaluation-cases", `{"question":"退货规则","expectedAnswer":"7 天内","requiredKeywords":["7"],"requireCitation":true}`, token, http.StatusCreated)
	var item dto.EvaluationCaseResponse
	if err := json.Unmarshal(created.Body.Bytes(), &item); err != nil {
		t.Fatal(err)
	}
	if item.ID == "" || item.KnowledgeBaseID != kb.ID.String() || item.Question != "退货规则" || !item.RequireCitation {
		t.Fatalf("wrong case contract: %+v", item)
	}
	request(http.MethodPut, base+"/evaluation-cases/"+item.ID, `{"question":"退货要什么","requiredKeywords":["订单号"],"requireCitation":true}`, token, http.StatusOK)
	payload := dto.EvaluationRunRequest{ClientRequestID: uuid.NewString(), CaseIDs: []string{item.ID}, Name: "接口验收", Config: dto.RetrievalConfig{VectorTopN: 10, RerankTopK: 3, ScoreThreshold: 0, EnableRerank: true}}
	encoded, _ := json.Marshal(payload)
	created = request(http.MethodPost, base+"/evaluation-runs", string(encoded), token, http.StatusAccepted)
	var run dto.EvaluationRunResponse
	if err := json.Unmarshal(created.Body.Bytes(), &run); err != nil {
		t.Fatal(err)
	}
	if run.Status != "queued" || run.Total != 1 || len(run.Cases) != 1 || run.Config.ScoreThreshold != 0 {
		t.Fatalf("wrong run contract: %+v", run)
	}
	repeated := request(http.MethodPost, base+"/evaluation-runs", string(encoded), token, http.StatusAccepted)
	var replay dto.EvaluationRunResponse
	if err := json.Unmarshal(repeated.Body.Bytes(), &replay); err != nil {
		t.Fatal(err)
	}
	if replay.ID != run.ID {
		t.Fatal("HTTP retry created a duplicate run")
	}
	payload.Config.ScoreThreshold = .5
	encoded, _ = json.Marshal(payload)
	request(http.MethodPost, base+"/evaluation-runs", string(encoded), token, http.StatusConflict)
	request(http.MethodGet, base+"/evaluation-runs/"+run.ID, "", otherToken, http.StatusNotFound)
	request(http.MethodPost, base+"/evaluation-runs/"+run.ID+"/cancel", "", otherToken, http.StatusNotFound)
	request(http.MethodGet, base+"/evaluation-runs", "", token, http.StatusOK)
	cancelled := request(http.MethodPost, base+"/evaluation-runs/"+run.ID+"/cancel", "", token, http.StatusOK)
	if err := json.Unmarshal(cancelled.Body.Bytes(), &replay); err != nil {
		t.Fatal(err)
	}
	if replay.Status != "cancelled" || replay.FinishedAt == nil {
		t.Fatalf("cancel contract: %+v", replay)
	}
	request(http.MethodDelete, base+"/evaluation-cases/"+item.ID, "", token, http.StatusNoContent)
	snapshot := request(http.MethodGet, base+"/evaluation-runs/"+run.ID, "", token, http.StatusOK)
	if !strings.Contains(snapshot.Body.String(), "退货要什么") {
		t.Fatal("deleting a case removed its run snapshot")
	}
}
