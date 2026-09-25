package router

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"kbchat/backend/internal/auth"
	"kbchat/backend/internal/config"
	"kbchat/backend/internal/dto"
	"kbchat/backend/internal/logger"
	"kbchat/backend/internal/model"
)

func adminUsersRouteConfig() config.Config {
	return config.Config{
		AppEnv:       "test",
		ServerPort:   "0",
		JWTSecret:    "admin-users-route-secret-at-least-32-bytes",
		JWTExpiresIn: "1h",
	}
}

type adminUsersFixture struct {
	handler http.Handler
	db      *gorm.DB
	admin   model.User
	user    model.User
	// target is a second ordinary account that mutating requests act on, so a
	// successful admin call never touches the actor or the non-admin probe.
	target     model.User
	adminToken string
	userToken  string
}

func newAdminUsersFixture(t *testing.T) adminUsersFixture {
	t.Helper()
	cfg := adminUsersRouteConfig()
	db := testDB(t)
	if err := db.AutoMigrate(&model.User{}, &model.Activity{}); err != nil {
		t.Fatal(err)
	}
	admin, adminToken := createRouteUser(t, cfg, db, model.SystemRoleAdmin)
	user, userToken := createRouteUser(t, cfg, db, model.SystemRoleUser)
	target, _ := createRouteUser(t, cfg, db, model.SystemRoleUser)
	return adminUsersFixture{
		handler:    New(cfg, db, logger.New(cfg)),
		db:         db,
		admin:      admin,
		user:       user,
		target:     target,
		adminToken: adminToken,
		userToken:  userToken,
	}
}

func (f adminUsersFixture) request(t *testing.T, method, path, body, token string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	f.handler.ServeHTTP(rec, req)
	return rec
}

type adminUsersEndpoint struct {
	name   string
	method string
	path   func(f adminUsersFixture) string
	body   string
	// adminStatus is what a system administrator receives for a well-formed
	// request. It is asserted exactly so "reachable" cannot be satisfied by a
	// handler that answers 500 to everybody.
	adminStatus int
}

func adminUsersEndpoints() []adminUsersEndpoint {
	return []adminUsersEndpoint{
		{"list", http.MethodGet, func(adminUsersFixture) string { return "/api/v1/admin/users" }, "", http.StatusOK},
		{"create", http.MethodPost, func(adminUsersFixture) string { return "/api/v1/admin/users" }, `{"username":"route-created","displayName":"Route Created"}`, http.StatusCreated},
		{"update", http.MethodPut, func(f adminUsersFixture) string { return "/api/v1/admin/users/" + f.target.ID.String() }, `{"displayName":"Renamed","status":"active"}`, http.StatusOK},
		{"reset password", http.MethodPost, func(f adminUsersFixture) string {
			return "/api/v1/admin/users/" + f.target.ID.String() + "/reset-password"
		}, "", http.StatusOK},
		{"update role", http.MethodPut, func(f adminUsersFixture) string { return "/api/v1/admin/users/" + f.target.ID.String() + "/role" }, `{"role":"admin"}`, http.StatusOK},
	}
}

// Every /admin/users endpoint is closed to ordinary users with 403
// SYSTEM_ADMIN_REQUIRED and to anonymous callers with 401, and is reachable by a
// system administrator. Each case gets its own fixture so the create and role
// mutations of one case cannot change the answer of another.
func TestAdminUsersRoutesRequireSystemAdmin(t *testing.T) {
	for _, endpoint := range adminUsersEndpoints() {
		t.Run(endpoint.name, func(t *testing.T) {
			f := newAdminUsersFixture(t)
			path := endpoint.path(f)

			anonymous := f.request(t, endpoint.method, path, endpoint.body, "")
			if anonymous.Code != http.StatusUnauthorized {
				t.Fatalf("anonymous: status %d, want 401: %s", anonymous.Code, anonymous.Body.String())
			}

			denied := f.request(t, endpoint.method, path, endpoint.body, f.userToken)
			if denied.Code != http.StatusForbidden {
				t.Fatalf("non-admin: status %d, want 403: %s", denied.Code, denied.Body.String())
			}
			if !strings.Contains(denied.Body.String(), "SYSTEM_ADMIN_REQUIRED") {
				t.Fatalf("non-admin: missing SYSTEM_ADMIN_REQUIRED: %s", denied.Body.String())
			}
			for _, leaked := range []string{"items", "password", "initialPassword"} {
				if strings.Contains(denied.Body.String(), leaked) {
					t.Fatalf("non-admin response leaked %q: %s", leaked, denied.Body.String())
				}
			}

			allowed := f.request(t, endpoint.method, path, endpoint.body, f.adminToken)
			if allowed.Code != endpoint.adminStatus {
				t.Fatalf("admin: status %d, want %d: %s", allowed.Code, endpoint.adminStatus, allowed.Body.String())
			}
		})
	}
}

// A stale admin claim inside the token does not grant access: the role is read
// from the database on every request.
func TestAdminUsersRoutesIgnoreTheTokenRoleClaim(t *testing.T) {
	f := newAdminUsersFixture(t)
	cfg := adminUsersRouteConfig()
	forged, err := auth.GenerateToken(cfg, f.user.ID, model.SystemRoleAdmin)
	if err != nil {
		t.Fatal(err)
	}
	rec := f.request(t, http.MethodGet, "/api/v1/admin/users", "", forged)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status %d, want 403: %s", rec.Code, rec.Body.String())
	}
}

// A token for an account that was disabled (or never existed) is refused by the
// auth middleware before RequireSystemAdmin: 401, not 403.
func TestAdminUsersRoutesRejectDisabledAndUnknownAccounts(t *testing.T) {
	f := newAdminUsersFixture(t)
	cfg := adminUsersRouteConfig()

	if err := f.db.Model(&model.User{}).Where("id = ?", f.admin.ID).Update("status", "disabled").Error; err != nil {
		t.Fatal(err)
	}
	disabled := f.request(t, http.MethodGet, "/api/v1/admin/users", "", f.adminToken)
	if disabled.Code != http.StatusUnauthorized {
		t.Fatalf("disabled admin: status %d, want 401: %s", disabled.Code, disabled.Body.String())
	}

	ghostToken, err := auth.GenerateToken(cfg, uuid.New(), model.SystemRoleAdmin)
	if err != nil {
		t.Fatal(err)
	}
	ghost := f.request(t, http.MethodGet, "/api/v1/admin/users", "", ghostToken)
	if ghost.Code != http.StatusUnauthorized {
		t.Fatalf("unknown account: status %d, want 401: %s", ghost.Code, ghost.Body.String())
	}
}

func TestAdminUsersListContractAndFilters(t *testing.T) {
	f := newAdminUsersFixture(t)
	if err := f.db.Model(&model.User{}).Where("id = ?", f.target.ID).Updates(map[string]any{"status": "disabled", "display_name": "Filter Target"}).Error; err != nil {
		t.Fatal(err)
	}

	rec := f.request(t, http.MethodGet, "/api/v1/admin/users?page=1&pageSize=2", "", f.adminToken)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	var page dto.AdminUserListResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	if page.Total != 3 || page.Page != 1 || page.PageSize != 2 || len(page.Items) != 2 {
		t.Fatalf("pagination contract: total=%d page=%d pageSize=%d items=%d", page.Total, page.Page, page.PageSize, len(page.Items))
	}
	if strings.Contains(rec.Body.String(), "passwordHash") || strings.Contains(rec.Body.String(), "password_hash") {
		t.Fatalf("list leaked password hashes: %s", rec.Body.String())
	}

	rec = f.request(t, http.MethodGet, "/api/v1/admin/users?status=disabled", "", f.adminToken)
	if err := json.Unmarshal(rec.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	if page.Total != 1 || len(page.Items) != 1 || page.Items[0].ID != f.target.ID.String() || page.Items[0].Status != "disabled" {
		t.Fatalf("status filter: %+v", page)
	}

	rec = f.request(t, http.MethodGet, "/api/v1/admin/users?role=admin", "", f.adminToken)
	if err := json.Unmarshal(rec.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	if page.Total != 1 || len(page.Items) != 1 || page.Items[0].ID != f.admin.ID.String() {
		t.Fatalf("role filter: %+v", page)
	}

	rec = f.request(t, http.MethodGet, "/api/v1/admin/users?q=filter+target", "", f.adminToken)
	if err := json.Unmarshal(rec.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	if page.Total != 1 || len(page.Items) != 1 || page.Items[0].DisplayName != "Filter Target" {
		t.Fatalf("q filter: %+v", page)
	}
}

func TestAdminUsersRoutesMapBusinessErrors(t *testing.T) {
	f := newAdminUsersFixture(t)
	self := "/api/v1/admin/users/" + f.admin.ID.String()

	for _, test := range []struct {
		name, method, path, body string
		status                   int
		code                     string
	}{
		{"self disable", http.MethodPut, self, `{"displayName":"Me","status":"disabled"}`, http.StatusBadRequest, "ADMIN_SELF_MUTATION"},
		{"self demote", http.MethodPut, self + "/role", `{"role":"user"}`, http.StatusBadRequest, "ADMIN_SELF_MUTATION"},
		{"self reset password", http.MethodPost, self + "/reset-password", "", http.StatusBadRequest, "ADMIN_SELF_MUTATION"},
		{"duplicate username ignoring case", http.MethodPost, "/api/v1/admin/users", `{"username":"` + strings.ToUpper(f.user.Username) + `"}`, http.StatusConflict, "USERNAME_EXISTS"},
		{"short password", http.MethodPost, "/api/v1/admin/users", `{"username":"short-pw-route","password":"1234567"}`, http.StatusBadRequest, "VALIDATION_ERROR"},
		{"invalid username", http.MethodPost, "/api/v1/admin/users", `{"username":"has space"}`, http.StatusBadRequest, "VALIDATION_ERROR"},
		{"unknown user", http.MethodPut, "/api/v1/admin/users/" + uuid.NewString(), `{"displayName":"Ghost","status":"active"}`, http.StatusNotFound, "USER_NOT_FOUND"},
		{"malformed id", http.MethodPut, "/api/v1/admin/users/not-a-uuid", `{"displayName":"Ghost","status":"active"}`, http.StatusBadRequest, "VALIDATION_ERROR"},
	} {
		t.Run(test.name, func(t *testing.T) {
			rec := f.request(t, test.method, test.path, test.body, f.adminToken)
			if rec.Code != test.status {
				t.Fatalf("status %d, want %d: %s", rec.Code, test.status, rec.Body.String())
			}
			var response struct {
				Code    string         `json:"code"`
				Details map[string]any `json:"details"`
			}
			if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
				t.Fatal(err)
			}
			if response.Code != test.code {
				t.Fatalf("code %q, want %q: %s", response.Code, test.code, rec.Body.String())
			}
			if test.name == "short password" {
				if _, ok := response.Details["password"]; !ok {
					t.Fatalf("short password details = %v, want password key", response.Details)
				}
			}
		})
	}

}

// Over HTTP the actor is always an active administrator (the auth middleware
// and RequireSystemAdmin guarantee it), so demoting or disabling *another*
// account can never remove the last active admin; LAST_ADMIN_REQUIRED is only
// reachable by direct repository callers and races, which the service tests
// cover. What the old counting bug got wrong over HTTP was the other direction:
// it refused to demote a disabled admin. Both legitimate cases must succeed.
func TestAdminUsersRoutesAllowDemotionWhenAnotherActiveAdminRemains(t *testing.T) {
	f := newAdminUsersFixture(t)

	// Two active admins: demoting the peer is allowed.
	promote := f.request(t, http.MethodPut, "/api/v1/admin/users/"+f.user.ID.String()+"/role", `{"role":"admin"}`, f.adminToken)
	if promote.Code != http.StatusOK {
		t.Fatalf("promote: %d %s", promote.Code, promote.Body.String())
	}
	demote := f.request(t, http.MethodPut, "/api/v1/admin/users/"+f.user.ID.String()+"/role", `{"role":"user"}`, f.adminToken)
	if demote.Code != http.StatusOK {
		t.Fatalf("demote peer with the actor still active: %d %s", demote.Code, demote.Body.String())
	}

	// A disabled admin is not a remaining administrator, and demoting it does
	// not reduce the active set: allowed.
	if err := f.db.Model(&model.User{}).Where("id = ?", f.target.ID).Updates(map[string]any{"role": model.SystemRoleAdmin, "status": "disabled"}).Error; err != nil {
		t.Fatal(err)
	}
	demoteDisabled := f.request(t, http.MethodPut, "/api/v1/admin/users/"+f.target.ID.String()+"/role", `{"role":"user"}`, f.adminToken)
	if demoteDisabled.Code != http.StatusOK {
		t.Fatalf("demote disabled admin: %d %s", demoteDisabled.Code, demoteDisabled.Body.String())
	}
	var target model.User
	if err := f.db.First(&target, "id = ?", f.target.ID).Error; err != nil {
		t.Fatal(err)
	}
	if target.Role != model.SystemRoleUser {
		t.Fatalf("target role = %q, want user", target.Role)
	}
}
