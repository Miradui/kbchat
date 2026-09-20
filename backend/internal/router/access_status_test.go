package router

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"kbchat/backend/internal/access"
	"kbchat/backend/internal/auth"
	"kbchat/backend/internal/config"
	"kbchat/backend/internal/logger"
	"kbchat/backend/internal/model"
	"kbchat/backend/internal/storage"
)

// The service-layer table in internal/service/access_contract_test.go asserts which
// app error a refusal produces. This file asserts what those errors become on the
// wire, which is a separate contract the frontend reads: a member who is inside the
// knowledge base but ranks too low gets 403 with the role it would take, and a
// caller with no standing gets 404 naming the resource they asked about, never 403
// -- because a 403 would confirm the id exists to somebody who cannot see it.
//
// Only the mapping is under test here, so one endpoint per capability is enough
// rather than the full endpoint list.

type statusCase struct {
	name string
	// insufficientRole is the highest member role that must still be refused.
	// Empty means every member holds the capability, so there is no 403 to assert.
	insufficientRole access.Role
	capability       access.Capability
	notFoundCode     string
	method           string
	// path is built per actor because chat resources belong to one caller.
	path func(f statusFixture, actor uuid.UUID) string
	body string
}

func statusCases() []statusCase {
	return []statusCase{
		{
			name:         "read a knowledge base",
			capability:   access.CapKnowledgeBaseRead,
			notFoundCode: "KNOWLEDGE_BASE_NOT_FOUND",
			method:       http.MethodGet,
			path:         func(f statusFixture, _ uuid.UUID) string { return "/api/v1/knowledge-bases/" + f.kbID.String() },
		},
		{
			name:             "rename a knowledge base",
			insufficientRole: access.RoleEditor,
			capability:       access.CapKnowledgeBaseWrite,
			notFoundCode:     "KNOWLEDGE_BASE_NOT_FOUND",
			method:           http.MethodPut,
			path:             func(f statusFixture, _ uuid.UUID) string { return "/api/v1/knowledge-bases/" + f.kbID.String() },
			body:             `{"name":"renamed by test"}`,
		},
		{
			name:             "delete a knowledge base",
			insufficientRole: access.RoleManager,
			capability:       access.CapKnowledgeBaseDelete,
			notFoundCode:     "KNOWLEDGE_BASE_NOT_FOUND",
			method:           http.MethodDelete,
			path:             func(f statusFixture, _ uuid.UUID) string { return "/api/v1/knowledge-bases/" + f.kbID.String() },
		},
		{
			name:             "read the member list",
			insufficientRole: access.RoleEditor,
			capability:       access.CapMembersRead,
			notFoundCode:     "KNOWLEDGE_BASE_NOT_FOUND",
			method:           http.MethodGet,
			path: func(f statusFixture, _ uuid.UUID) string {
				return "/api/v1/knowledge-bases/" + f.kbID.String() + "/permissions"
			},
		},
		{
			name:             "add a member",
			insufficientRole: access.RoleEditor,
			capability:       access.CapMembersWrite,
			notFoundCode:     "KNOWLEDGE_BASE_NOT_FOUND",
			method:           http.MethodPost,
			path: func(f statusFixture, _ uuid.UUID) string {
				return "/api/v1/knowledge-bases/" + f.kbID.String() + "/members"
			},
			// A syntactically valid id for somebody who does not exist: the
			// capability is checked before the user is looked up, so this reaches
			// the guard. uuid.Nil would not -- it fails `binding:"required"` and
			// the request would never leave the handler.
			body: `{"userId":"1a4c9f2e-6f19-4a4d-9c2b-2f0c0c1a7f31","role":"viewer"}`,
		},
		{
			name:         "search a knowledge base",
			capability:   access.CapKnowledgeBaseSearch,
			notFoundCode: "KNOWLEDGE_BASE_NOT_FOUND",
			method:       http.MethodPost,
			path: func(f statusFixture, _ uuid.UUID) string {
				return "/api/v1/knowledge-bases/" + f.kbID.String() + "/search"
			},
			body: `{"query":"status mapping"}`,
		},
		{
			name:         "read a document",
			capability:   access.CapDocumentRead,
			notFoundCode: "DOCUMENT_NOT_FOUND",
			method:       http.MethodGet,
			path:         func(f statusFixture, _ uuid.UUID) string { return "/api/v1/documents/" + f.document.String() },
		},
		{
			name:             "download a document",
			insufficientRole: access.RoleViewer,
			capability:       access.CapDocumentDownload,
			notFoundCode:     "DOCUMENT_NOT_FOUND",
			method:           http.MethodGet,
			path: func(f statusFixture, _ uuid.UUID) string {
				return "/api/v1/documents/" + f.document.String() + "/download"
			},
		},
		{
			name:             "rename a document",
			insufficientRole: access.RoleViewer,
			capability:       access.CapContentWrite,
			notFoundCode:     "DOCUMENT_NOT_FOUND",
			method:           http.MethodPut,
			path:             func(f statusFixture, _ uuid.UUID) string { return "/api/v1/documents/" + f.document.String() },
			body:             `{"filename":"renamed-by-test.pdf"}`,
		},
		{
			name:             "purge a deleted document",
			insufficientRole: access.RoleEditor,
			capability:       access.CapContentPurge,
			notFoundCode:     "DOCUMENT_NOT_FOUND",
			method:           http.MethodDelete,
			path: func(f statusFixture, _ uuid.UUID) string {
				return "/api/v1/documents/recycle-bin/" + f.deletedDocument.String()
			},
		},
		{
			name:         "read a chat session",
			capability:   access.CapChatUse,
			notFoundCode: "RESOURCE_NOT_FOUND",
			method:       http.MethodGet,
			path: func(f statusFixture, actor uuid.UUID) string {
				return "/api/v1/chat/sessions/" + f.sessions[actor].String()
			},
		},
		{
			name:         "export a chat session",
			capability:   access.CapChatExport,
			notFoundCode: "RESOURCE_NOT_FOUND",
			method:       http.MethodGet,
			path: func(f statusFixture, actor uuid.UUID) string {
				return "/api/v1/chat/sessions/" + f.sessions[actor].String() + "/export"
			},
		},
		{
			name:         "rate an answer",
			capability:   access.CapFeedbackWrite,
			notFoundCode: "RESOURCE_NOT_FOUND",
			method:       http.MethodPost,
			path: func(f statusFixture, actor uuid.UUID) string {
				return "/api/v1/chat/messages/" + f.messages[actor].String() + "/feedback"
			},
			body: `{"rating":"positive"}`,
		},
	}
}

type statusFixture struct {
	handler         http.Handler
	db              *gorm.DB
	kbID            uuid.UUID
	document        uuid.UUID
	deletedDocument uuid.UUID
	// One session and one assistant message per actor: a transcript belongs to the
	// caller who held it, so sharing the owner's would answer every non-owner with
	// RESOURCE_NOT_FOUND before the capability was ever consulted.
	sessions map[uuid.UUID]uuid.UUID
	messages map[uuid.UUID]uuid.UUID
	tokens   map[uuid.UUID]string
	actors   map[access.Role]uuid.UUID
	owner    uuid.UUID
	stranger uuid.UUID
}

func newStatusFixture(t *testing.T) statusFixture {
	t.Helper()

	cfg := config.Config{
		AppEnv:       "test",
		ServerPort:   "0",
		JWTSecret:    "this-is-a-long-router-test-secret-1234",
		JWTExpiresIn: "1h",
		UploadDir:    t.TempDir(),
	}
	db := testDB(t)
	if err := db.AutoMigrate(
		&model.User{},
		&model.KnowledgeBase{},
		&model.KnowledgeBaseMember{},
		&model.Document{},
		&model.DocumentChunk{},
		&model.ChatSession{},
		&model.ChatMessage{},
	); err != nil {
		t.Fatalf("migrate status mapping tables: %v", err)
	}

	fixture := statusFixture{
		db:       db,
		sessions: map[uuid.UUID]uuid.UUID{},
		messages: map[uuid.UUID]uuid.UUID{},
		tokens:   map[uuid.UUID]string{},
		actors:   map[access.Role]uuid.UUID{},
	}

	createUser := func(username string) uuid.UUID {
		user := model.User{Username: username, PasswordHash: "hash"}
		if err := db.Create(&user).Error; err != nil {
			t.Fatalf("create %s: %v", username, err)
		}
		token, err := auth.GenerateToken(cfg, user.ID, user.Role)
		if err != nil {
			t.Fatalf("generate token for %s: %v", username, err)
		}
		fixture.tokens[user.ID] = token
		return user.ID
	}

	fixture.owner = createUser("status-owner")
	fixture.actors[access.RoleOwner] = fixture.owner
	fixture.stranger = createUser("status-stranger")

	kb := model.KnowledgeBase{Name: "status kb", OwnerID: fixture.owner, Visibility: "private"}
	if err := db.Create(&kb).Error; err != nil {
		t.Fatalf("create status knowledge base: %v", err)
	}
	fixture.kbID = kb.ID

	for _, role := range access.AssignableRoles {
		actor := createUser("status-" + string(role))
		fixture.actors[role] = actor
		member := model.KnowledgeBaseMember{KnowledgeBaseID: kb.ID, UserID: actor, Role: string(role)}
		if err := db.Create(&member).Error; err != nil {
			t.Fatalf("create %s member: %v", role, err)
		}
	}

	document := model.Document{
		KnowledgeBaseID: kb.ID,
		UploaderID:      fixture.owner,
		Filename:        "status.pdf",
		StoragePath:     "status.pdf",
		Status:          "completed",
	}
	if err := db.Create(&document).Error; err != nil {
		t.Fatalf("create status document: %v", err)
	}
	fixture.document = document.ID

	deleted := model.Document{
		KnowledgeBaseID: kb.ID,
		UploaderID:      fixture.owner,
		Filename:        "purged.pdf",
		StoragePath:     "purged.pdf",
		Status:          "completed",
	}
	if err := db.Create(&deleted).Error; err != nil {
		t.Fatalf("create purge target: %v", err)
	}
	fixture.deletedDocument = deleted.ID
	// Written directly rather than through the delete endpoint, because that
	// endpoint is gated by content.write and this row exists to test content.purge.
	if err := db.Exec("UPDATE documents SET deleted_at = ? WHERE id = ?", db.NowFunc(), deleted.ID).Error; err != nil {
		t.Fatalf("soft delete purge target: %v", err)
	}

	for actor := range fixture.tokens {
		session := model.ChatSession{UserID: actor, KnowledgeBaseID: kb.ID, Title: "status chat"}
		if err := db.Create(&session).Error; err != nil {
			t.Fatalf("create session for %s: %v", actor, err)
		}
		fixture.sessions[actor] = session.ID
		message := model.ChatMessage{SessionID: session.ID, Role: "assistant", Content: "status answer"}
		if err := db.Create(&message).Error; err != nil {
			t.Fatalf("create message for %s: %v", actor, err)
		}
		fixture.messages[actor] = message.ID
	}

	fixture.handler = NewWithStorage(cfg, db, logger.New(cfg), storage.NewLocalStorage(cfg.UploadDir))
	return fixture
}

func (f statusFixture) do(t *testing.T, actor uuid.UUID, testCase statusCase, path string) (int, errorBody) {
	t.Helper()

	var reader io.Reader
	if testCase.body != "" {
		reader = strings.NewReader(testCase.body)
	}
	req := httptest.NewRequest(testCase.method, path, reader)
	req.Header.Set("Authorization", "Bearer "+f.tokens[actor])
	if testCase.body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	rec := httptest.NewRecorder()
	f.handler.ServeHTTP(rec, req)

	var body errorBody
	// A success response is not an error shape, so a decode failure is not a
	// finding by itself -- the status is what the caller asserts on.
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	return rec.Code, body
}

type errorBody struct {
	Code    string         `json:"code"`
	Message string         `json:"message"`
	Details map[string]any `json:"details"`
}

// A member who is inside the knowledge base but ranks below the capability gets
// 403, and the body says which role would have been enough. The frontend uses that
// field to tell the caller who to ask, so an empty details map is a regression even
// though the status is right.
func TestInsufficientRoleGets403NamingTheRequiredRole(t *testing.T) {
	fixture := newStatusFixture(t)

	for _, testCase := range statusCases() {
		if testCase.insufficientRole == "" {
			continue
		}
		t.Run(testCase.name, func(t *testing.T) {
			actor := fixture.actors[testCase.insufficientRole]
			status, body := fixture.do(t, actor, testCase, testCase.path(fixture, actor))
			if status != http.StatusForbidden {
				t.Fatalf("%s as %s: status = %d, want %d (body %#v)", testCase.name, testCase.insufficientRole, status, http.StatusForbidden, body)
			}
			if body.Code != "FORBIDDEN" {
				t.Fatalf("code = %q, want FORBIDDEN", body.Code)
			}
			if got := body.Details["role"]; got != string(testCase.insufficientRole) {
				t.Errorf("details.role = %v, want %q", got, testCase.insufficientRole)
			}
			if got := body.Details["capability"]; got != string(testCase.capability) {
				t.Errorf("details.capability = %v, want %q", got, testCase.capability)
			}
			if got := body.Details["requiredRole"]; got != string(access.MinRole(testCase.capability)) {
				t.Errorf("details.requiredRole = %v, want %q", got, access.MinRole(testCase.capability))
			}
			if body.Message == "" {
				t.Error("message is empty; the refusal is shown to a person")
			}
		})
	}
}

// No standing at all is 404, never 403: the caller asked about an id they cannot
// see, and 403 would confirm it exists. The path is built from the owner's
// resources on purpose -- the ids are real, and only the caller is wrong.
func TestCallersWithNoStandingGet404(t *testing.T) {
	fixture := newStatusFixture(t)

	revoked := fixture.actors[access.RoleManager]
	if err := fixture.db.Exec(
		"DELETE FROM knowledge_base_members WHERE knowledge_base_id = ? AND user_id = ?",
		fixture.kbID, revoked,
	).Error; err != nil {
		t.Fatalf("revoke manager: %v", err)
	}

	callers := map[string]uuid.UUID{
		"never a member": fixture.stranger,
		// A revoked member must be indistinguishable from someone who never joined.
		// They knew the ids while they had access, so leaking existence to them is
		// the same leak as leaking it to a stranger.
		"revoked member": revoked,
	}

	for name, caller := range callers {
		for _, testCase := range statusCases() {
			// Asked twice, because two different guards can produce the 404 and only
			// one of them is exercised by each. Against the owner's ids a chat
			// request is stopped by the session-ownership predicate before the
			// knowledge base is consulted; against the caller's own ids that
			// predicate passes and the knowledge base check is what refuses. A
			// revoked member still holds their own transcripts, so the second is the
			// realistic case, not a contrived one.
			for who, pathOwner := range map[string]uuid.UUID{"the owner's ids": fixture.owner, "their own ids": caller} {
				t.Run(name+"/"+testCase.name+"/"+who, func(t *testing.T) {
					status, body := fixture.do(t, caller, testCase, testCase.path(fixture, pathOwner))
					if status != http.StatusNotFound {
						t.Fatalf("status = %d, want %d (body %#v)", status, http.StatusNotFound, body)
					}
					if body.Code != testCase.notFoundCode {
						t.Fatalf("code = %q, want %q: the answer names the resource the caller asked about", body.Code, testCase.notFoundCode)
					}
				})
			}
		}
	}
}

// The mirror of the two tests above: at the role the matrix requires, the request
// is not refused. It may still fail for an unrelated reason -- there is no chat
// provider and the upload directory is empty -- so this asserts only the absence of
// a refusal, which is what distinguishes a working guard from one that denies
// everything.
func TestMinimumRoleIsNotRefused(t *testing.T) {
	for _, testCase := range statusCases() {
		t.Run(testCase.name, func(t *testing.T) {
			// A fixture per case, unlike the two refusal tests: these requests are
			// allowed through, so they mutate. Sharing one fixture would let the
			// delete case remove the knowledge base every later case reads.
			fixture := newStatusFixture(t)
			role := access.MinRole(testCase.capability)
			actor := fixture.actors[role]
			status, body := fixture.do(t, actor, testCase, testCase.path(fixture, actor))
			if status == http.StatusForbidden {
				t.Fatalf("%s as %s was refused with 403: %#v", testCase.name, role, body)
			}
			if status == http.StatusNotFound && body.Code == testCase.notFoundCode {
				t.Fatalf("%s as %s was refused with %s: %#v", testCase.name, role, testCase.notFoundCode, body)
			}
		})
	}
}
