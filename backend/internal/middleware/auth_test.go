package middleware

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"kbchat/backend/internal/auth"
	"kbchat/backend/internal/config"
)

type fakeStatusChecker struct {
	active bool
	err    error
	calls  int
}

func (f *fakeStatusChecker) IsActive(context.Context, uuid.UUID) (bool, error) {
	f.calls++
	return f.active, f.err
}

func authTestConfig() config.Config {
	return config.Config{JWTSecret: "middleware-auth-test-secret-at-least-32", JWTExpiresIn: "1h"}
}

func serveAuth(t *testing.T, cfg config.Config, checker UserStatusChecker, token string) *httptest.ResponseRecorder {
	t.Helper()
	gin.SetMode(gin.TestMode)
	r := gin.New()
	var handler gin.HandlerFunc
	if checker == nil {
		handler = AuthRequired(cfg)
	} else {
		handler = AuthRequired(cfg, checker)
	}
	r.GET("/protected", handler, func(c *gin.Context) {
		id, ok := CurrentUserID(c)
		if !ok {
			c.String(http.StatusInternalServerError, "no user")
			return
		}
		c.String(http.StatusOK, id.String())
	})
	req := httptest.NewRequest(http.MethodGet, "/protected", nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	return rec
}

func TestAuthRequiredUsesTheAccountStatus(t *testing.T) {
	cfg := authTestConfig()
	userID := uuid.New()
	token, err := auth.GenerateToken(cfg, userID, "user")
	if err != nil {
		t.Fatal(err)
	}

	for _, test := range []struct {
		name    string
		checker *fakeStatusChecker
		status  int
		code    string
	}{
		{"active account passes", &fakeStatusChecker{active: true}, http.StatusOK, ""},
		// A disabled account and an account that no longer exists both answer
		// (false, nil) from the repository: the token is signed but not a login.
		{"disabled or missing account is rejected", &fakeStatusChecker{active: false}, http.StatusUnauthorized, "UNAUTHORIZED"},
		// Fail closed: an unverifiable token must not be trusted, but the client
		// must not discard a possibly valid token either, so it is 503 not 401.
		{"lookup failure fails closed", &fakeStatusChecker{active: true, err: errors.New("db down")}, http.StatusServiceUnavailable, "AUTH_UNAVAILABLE"},
	} {
		t.Run(test.name, func(t *testing.T) {
			rec := serveAuth(t, cfg, test.checker, token)
			if rec.Code != test.status {
				t.Fatalf("status %d, want %d: %s", rec.Code, test.status, rec.Body.String())
			}
			if test.checker.calls != 1 {
				t.Fatalf("checker calls = %d, want 1", test.checker.calls)
			}
			if test.code != "" && !strings.Contains(rec.Body.String(), test.code) {
				t.Fatalf("expected code %s in %s", test.code, rec.Body.String())
			}
			if test.status == http.StatusOK && rec.Body.String() != userID.String() {
				t.Fatalf("handler saw user %s, want %s", rec.Body.String(), userID)
			}
			if test.status != http.StatusOK && strings.Contains(rec.Body.String(), "db down") {
				t.Fatal("lookup error leaked to the client")
			}
		})
	}
}

func TestAuthRequiredWithoutCheckerKeepsTokenOnlyBehaviour(t *testing.T) {
	cfg := authTestConfig()
	token, err := auth.GenerateToken(cfg, uuid.New(), "user")
	if err != nil {
		t.Fatal(err)
	}
	if rec := serveAuth(t, cfg, nil, token); rec.Code != http.StatusOK {
		t.Fatalf("nil checker: status %d, want 200", rec.Code)
	}
	if rec := serveAuth(t, cfg, nil, ""); rec.Code != http.StatusUnauthorized {
		t.Fatalf("missing token: status %d, want 401", rec.Code)
	}
	if rec := serveAuth(t, cfg, nil, "not-a-token"); rec.Code != http.StatusUnauthorized {
		t.Fatalf("garbage token: status %d, want 401", rec.Code)
	}
}
