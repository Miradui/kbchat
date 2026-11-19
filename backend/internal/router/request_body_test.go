package router

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"kbchat/backend/internal/config"
	"kbchat/backend/internal/logger"
)

type countedRequestBody struct {
	io.Reader
	read int
}

func (r *countedRequestBody) Read(p []byte) (int, error) {
	n, err := r.Reader.Read(p)
	r.read += n
	return n, err
}

func TestLoginRejectsOversizedJSONWithoutReadingEntireBody(t *testing.T) {
	cfg := config.Config{AppEnv: "test"}
	r := New(cfg, testDB(t), logger.New(cfg))
	for _, lengthKnown := range []bool{true, false} {
		payload := `{"username":"fixture","password":"fixture","padding":"` + strings.Repeat("x", 2<<20) + `"}`
		body := &countedRequestBody{Reader: strings.NewReader(payload)}
		req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", body)
		if lengthKnown {
			req.ContentLength = int64(len(payload))
		} else {
			req.ContentLength = -1
		}
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("oversized login: status=%d", rec.Code)
		}
		if body.read > (1<<20)+1 {
			t.Fatalf("read %d bytes from oversized request", body.read)
		}
	}
}
