package service

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"

	"kbchat/backend/internal/access"
	"kbchat/backend/internal/apperror"
	"kbchat/backend/internal/dto"
	"kbchat/backend/internal/model"
)

// This file is the compensation for moving the authorization boundary out of the
// repository predicates. While a query said `WHERE owner_id = ?`, a forgotten check
// returned nothing; now it returns somebody else's data, and nothing in the
// compiler notices. So the guarantee is stated once here, per endpoint, and every
// endpoint is listed:
//
//   - the capability it requires is the one the matrix says it requires,
//   - a caller with no standing gets 404, never 403, for every resource id,
//   - a revoked member is exactly a caller with no standing,
//   - a soft-deleted knowledge base is unreachable through any of its resources,
//     including by its owner.
//
// A new endpoint that takes an actor and a resource id belongs in this table. That
// is the whole mechanism: the table is the checklist, and a missing row is the only
// way an endpoint escapes all four assertions.

// contractCase is one endpoint, the capability it should require, and how to call
// it with a given actor.
type contractCase struct {
	name string
	// capability the endpoint requires. The expected outcome per role is derived
	// from the matrix rather than written out, so a matrix change moves the
	// expectations with it instead of leaving them stale.
	capability access.Capability
	// notFoundCode is what the endpoint answers with when the actor has no
	// standing. It names the resource the caller asked about, not the knowledge base
	// the refusal came from: a document id answers DOCUMENT_NOT_FOUND, a session id
	// answers RESOURCE_NOT_FOUND.
	notFoundCode string
	call         func(t *testing.T, ctx context.Context, f contractFixture, actor uuid.UUID) error
}

// contractFixture is one knowledge base with a member per role, a document, and a
// chat session per actor.
//
// Rebuilt for every case and every actor, because most of these endpoints mutate:
// a shared fixture would have Delete answering for a document that Restore had
// already brought back, and the order of the table would start to matter.
type contractFixture struct {
	services workspaceTestServices
	kbID     uuid.UUID
	document uuid.UUID
	// sessions is a chat session per actor, since a session belongs to whoever
	// opened it. The actor's own session is the case where authorization has to come
	// from the knowledge base rather than from row ownership.
	sessions map[uuid.UUID]uuid.UUID
	// messages is an assistant message in each actor's own session. Feedback is
	// rating an answer in your own transcript, so one shared message would answer
	// every non-owner with NOT_FOUND before the capability was ever consulted.
	messages map[uuid.UUID]uuid.UUID
	actors   map[access.Role]uuid.UUID
}

func newContractFixture(t *testing.T) contractFixture {
	t.Helper()
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, services.db, "contract-owner")
	kb := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "contract-kb", "private", time.Now())
	document := createWorkspaceDocument(t, services.db, kb.ID, owner.ID, "contract.pdf", "completed")

	fixture := contractFixture{
		services: services,
		kbID:     kb.ID,
		document: document.ID,
		sessions: map[uuid.UUID]uuid.UUID{},
		messages: map[uuid.UUID]uuid.UUID{},
		actors:   map[access.Role]uuid.UUID{access.RoleOwner: owner.ID},
	}
	for _, role := range access.AssignableRoles {
		user := createWorkspaceUser(t, services.db, "contract-"+string(role))
		fixture.actors[role] = user.ID
		if _, err := services.kbs.AddMember(ctx, owner.ID, kb.ID, dto.KnowledgeBaseMemberRequest{
			UserID: user.ID,
			Role:   string(role),
		}); err != nil {
			t.Fatalf("add %s: %v", role, err)
		}
	}
	// The stranger is deliberately not in fixture.actors: they hold no role, so the
	// matrix has nothing to say about them and they are asserted separately.
	stranger := createWorkspaceUser(t, services.db, "contract-stranger")
	fixture.actors[access.RoleNone] = stranger.ID

	// A second knowledge base, owned by somebody else, where every actor including
	// the stranger is a manager.
	//
	// Without it "a member of this base" and "a member of any base" would be the
	// same set, so a membership lookup that ignored the knowledge base id would pass
	// every assertion in this file. With it, such a lookup promotes the viewer to
	// manager and lets the stranger in, which is what the table is for.
	decoyOwner := createWorkspaceUser(t, services.db, "contract-decoy-owner")
	decoyKB := createWorkspaceKB(t, services.db, decoyOwner.ID, uuid.Nil, "decoy-kb", "private", time.Now())
	for _, actor := range fixture.actors {
		if actor == owner.ID {
			continue
		}
		if _, err := services.kbs.AddMember(ctx, decoyOwner.ID, decoyKB.ID, dto.KnowledgeBaseMemberRequest{
			UserID: actor,
			Role:   string(access.RoleManager),
		}); err != nil {
			t.Fatalf("add decoy manager: %v", err)
		}
	}

	for _, actor := range fixture.actors {
		session := createWorkspaceChatSession(t, services.db, actor, kb.ID, "contract session")
		fixture.sessions[actor] = session.ID
		message := model.ChatMessage{SessionID: session.ID, Role: "assistant", Content: "answer"}
		if err := services.db.Create(&message).Error; err != nil {
			t.Fatalf("create assistant message: %v", err)
		}
		fixture.messages[actor] = message.ID
	}
	return fixture
}

// softDelete puts a row in the recycle bin without going through a service.
//
// The restore and purge endpoints only see deleted rows, so reaching them needs a
// deleted row first — and getting there through the service would mean the delete
// capability gating the restore assertion. Writing deleted_at directly keeps each
// row of the table testing one capability.
func (f contractFixture) softDelete(t *testing.T, table string, id uuid.UUID) {
	t.Helper()
	if err := f.services.db.Exec(
		"UPDATE "+table+" SET deleted_at = ? WHERE id = ?", time.Now().UTC(), id,
	).Error; err != nil {
		t.Fatalf("soft delete %s: %v", table, err)
	}
}

func contractCases() []contractCase {
	kbCases := []contractCase{
		{"knowledgeBase.get", access.CapKnowledgeBaseRead, "KNOWLEDGE_BASE_NOT_FOUND",
			func(t *testing.T, ctx context.Context, f contractFixture, actor uuid.UUID) error {
				_, err := f.services.kbs.Get(ctx, actor, f.kbID)
				return err
			}},
		{"knowledgeBase.detailStats", access.CapKnowledgeBaseRead, "KNOWLEDGE_BASE_NOT_FOUND",
			func(t *testing.T, ctx context.Context, f contractFixture, actor uuid.UUID) error {
				_, err := f.services.kbs.DetailStats(ctx, actor, f.kbID, "month")
				return err
			}},
		{"knowledgeBase.recordView", access.CapKnowledgeBaseRead, "KNOWLEDGE_BASE_NOT_FOUND",
			func(t *testing.T, ctx context.Context, f contractFixture, actor uuid.UUID) error {
				return f.services.kbs.RecordView(ctx, actor, f.kbID)
			}},
		{"knowledgeBase.setFavorite", access.CapKnowledgeBaseRead, "KNOWLEDGE_BASE_NOT_FOUND",
			func(t *testing.T, ctx context.Context, f contractFixture, actor uuid.UUID) error {
				return f.services.kbs.SetFavorite(ctx, actor, f.kbID, true)
			}},
		{"knowledgeBase.batchSetFavorite", access.CapKnowledgeBaseRead, "KNOWLEDGE_BASE_NOT_FOUND",
			func(t *testing.T, ctx context.Context, f contractFixture, actor uuid.UUID) error {
				_, err := f.services.kbs.BatchSetFavorite(ctx, actor, dto.KnowledgeBaseBatchFavoriteRequest{
					KnowledgeBaseIDs: []uuid.UUID{f.kbID},
					Favorite:         true,
				})
				return err
			}},
		{"knowledgeBase.update", access.CapKnowledgeBaseWrite, "KNOWLEDGE_BASE_NOT_FOUND",
			func(t *testing.T, ctx context.Context, f contractFixture, actor uuid.UUID) error {
				_, err := f.services.kbs.Update(ctx, actor, f.kbID, dto.KnowledgeBaseRequest{
					Name:       "renamed",
					Visibility: "private",
				})
				return err
			}},
		{"knowledgeBase.batchMoveCategory", access.CapKnowledgeBaseWrite, "KNOWLEDGE_BASE_NOT_FOUND",
			func(t *testing.T, ctx context.Context, f contractFixture, actor uuid.UUID) error {
				_, err := f.services.kbs.BatchMoveCategory(ctx, actor, dto.KnowledgeBaseBatchMoveCategoryRequest{
					KnowledgeBaseIDs: []uuid.UUID{f.kbID},
				})
				return err
			}},
		{"knowledgeBase.batchTag", access.CapKnowledgeBaseWrite, "KNOWLEDGE_BASE_NOT_FOUND",
			func(t *testing.T, ctx context.Context, f contractFixture, actor uuid.UUID) error {
				_, err := f.services.kbs.BatchTag(ctx, actor, dto.KnowledgeBaseBatchTagRequest{
					KnowledgeBaseIDs: []uuid.UUID{f.kbID},
					Mode:             dto.KnowledgeBaseBatchTagModeReplace,
				})
				return err
			}},
		{"knowledgeBase.delete", access.CapKnowledgeBaseDelete, "KNOWLEDGE_BASE_NOT_FOUND",
			func(t *testing.T, ctx context.Context, f contractFixture, actor uuid.UUID) error {
				return f.services.kbs.Delete(ctx, actor, f.kbID)
			}},
		{"knowledgeBase.transfer", access.CapKnowledgeBaseTransfer, "KNOWLEDGE_BASE_NOT_FOUND",
			func(t *testing.T, ctx context.Context, f contractFixture, actor uuid.UUID) error {
				_, err := f.services.kbs.TransferOwnership(ctx, actor, f.kbID, dto.TransferOwnershipRequest{NewOwnerID: f.actors[access.RoleViewer]})
				return err
			}},
		{"knowledgeBase.batchDelete", access.CapKnowledgeBaseDelete, "KNOWLEDGE_BASE_NOT_FOUND",
			func(t *testing.T, ctx context.Context, f contractFixture, actor uuid.UUID) error {
				_, err := f.services.kbs.BatchDelete(ctx, actor, dto.KnowledgeBaseBatchRequest{
					KnowledgeBaseIDs: []uuid.UUID{f.kbID},
				})
				return err
			}},
		{"knowledgeBase.getPermissions", access.CapMembersRead, "KNOWLEDGE_BASE_NOT_FOUND",
			func(t *testing.T, ctx context.Context, f contractFixture, actor uuid.UUID) error {
				_, err := f.services.kbs.GetPermissions(ctx, actor, f.kbID)
				return err
			}},
		{"knowledgeBase.updatePermissions", access.CapMembersWrite, "KNOWLEDGE_BASE_NOT_FOUND",
			func(t *testing.T, ctx context.Context, f contractFixture, actor uuid.UUID) error {
				_, err := f.services.kbs.UpdatePermissions(ctx, actor, f.kbID, dto.KnowledgeBasePermissionUpdateRequest{
					Visibility: "private",
				})
				return err
			}},
		{"knowledgeBase.addMember", access.CapMembersWrite, "KNOWLEDGE_BASE_NOT_FOUND",
			func(t *testing.T, ctx context.Context, f contractFixture, actor uuid.UUID) error {
				invitee := createWorkspaceUser(t, f.services.db, "contract-invitee-"+actor.String()[:8])
				_, err := f.services.kbs.AddMember(ctx, actor, f.kbID, dto.KnowledgeBaseMemberRequest{
					UserID: invitee.ID,
					Role:   string(access.RoleViewer),
				})
				return err
			}},
		{"knowledgeBase.updateMember", access.CapMembersWrite, "KNOWLEDGE_BASE_NOT_FOUND",
			func(t *testing.T, ctx context.Context, f contractFixture, actor uuid.UUID) error {
				_, err := f.services.kbs.UpdateMember(ctx, actor, f.kbID, f.actors[access.RoleViewer],
					dto.KnowledgeBaseMemberRoleRequest{Role: string(access.RoleEditor)})
				return err
			}},
		{"knowledgeBase.removeMember", access.CapMembersWrite, "KNOWLEDGE_BASE_NOT_FOUND",
			func(t *testing.T, ctx context.Context, f contractFixture, actor uuid.UUID) error {
				return f.services.kbs.RemoveMember(ctx, actor, f.kbID, f.actors[access.RoleViewer])
			}},
	}

	documentCases := []contractCase{
		{"document.list", access.CapDocumentRead, "KNOWLEDGE_BASE_NOT_FOUND",
			func(t *testing.T, ctx context.Context, f contractFixture, actor uuid.UUID) error {
				_, err := f.services.documents.List(ctx, actor, f.kbID, dto.GlobalDocumentListQuery{})
				return err
			}},
		{"document.get", access.CapDocumentRead, "DOCUMENT_NOT_FOUND",
			func(t *testing.T, ctx context.Context, f contractFixture, actor uuid.UUID) error {
				_, err := f.services.documents.Get(ctx, actor, f.document)
				return err
			}},
		{"document.chunks", access.CapDocumentRead, "DOCUMENT_NOT_FOUND",
			func(t *testing.T, ctx context.Context, f contractFixture, actor uuid.UUID) error {
				_, err := f.services.documents.Chunks(ctx, actor, f.document, dto.ChunkListQuery{})
				return err
			}},
		{"document.preview", access.CapDocumentRead, "DOCUMENT_NOT_FOUND",
			func(t *testing.T, ctx context.Context, f contractFixture, actor uuid.UUID) error {
				_, err := f.services.documents.Preview(ctx, actor, f.document)
				return err
			}},
		{"document.download", access.CapDocumentDownload, "DOCUMENT_NOT_FOUND",
			func(t *testing.T, ctx context.Context, f contractFixture, actor uuid.UUID) error {
				_, err := f.services.documents.Download(ctx, actor, f.document)
				return err
			}},
		{"document.upload", access.CapContentWrite, "KNOWLEDGE_BASE_NOT_FOUND",
			func(t *testing.T, ctx context.Context, f contractFixture, actor uuid.UUID) error {
				_, err := f.services.documents.Upload(ctx, actor, f.kbID,
					createUploadFile(t, "contract-upload.md", "content"))
				return err
			}},
		{"document.text", access.CapContentWrite, "KNOWLEDGE_BASE_NOT_FOUND",
			func(t *testing.T, ctx context.Context, f contractFixture, actor uuid.UUID) error {
				_, err := f.services.documents.CreateText(ctx, actor, f.kbID, dto.TextDocumentRequest{Title: "note", Content: "# heading\nbody"})
				return err
			}},
		{"document.update", access.CapContentWrite, "DOCUMENT_NOT_FOUND",
			func(t *testing.T, ctx context.Context, f contractFixture, actor uuid.UUID) error {
				_, err := f.services.documents.Update(ctx, actor, f.document, dto.DocumentUpdateRequest{Filename: "renamed.pdf"})
				return err
			}},
		{"document.delete", access.CapContentWrite, "DOCUMENT_NOT_FOUND",
			func(t *testing.T, ctx context.Context, f contractFixture, actor uuid.UUID) error {
				return f.services.documents.Delete(ctx, actor, f.document)
			}},
		{"document.batchDelete", access.CapContentWrite, "DOCUMENT_NOT_FOUND",
			func(t *testing.T, ctx context.Context, f contractFixture, actor uuid.UUID) error {
				_, err := f.services.documents.BatchDelete(ctx, actor, dto.DocumentBatchRequest{
					DocumentIDs: []uuid.UUID{f.document},
				})
				return err
			}},
		{"document.reprocess", access.CapContentWrite, "DOCUMENT_NOT_FOUND",
			func(t *testing.T, ctx context.Context, f contractFixture, actor uuid.UUID) error {
				_, err := f.services.documents.Reprocess(ctx, actor, f.document)
				return err
			}},
		{"document.cancelJob", access.CapContentWrite, "DOCUMENT_NOT_FOUND",
			func(t *testing.T, ctx context.Context, f contractFixture, actor uuid.UUID) error {
				_, err := f.services.documents.CancelJob(ctx, actor, f.document)
				return err
			}},
		{"document.restore", access.CapContentWrite, "DOCUMENT_NOT_FOUND",
			func(t *testing.T, ctx context.Context, f contractFixture, actor uuid.UUID) error {
				f.softDelete(t, "documents", f.document)
				return f.services.documents.Restore(ctx, actor, f.document)
			}},
		{"document.permanentDelete", access.CapContentPurge, "DOCUMENT_NOT_FOUND",
			func(t *testing.T, ctx context.Context, f contractFixture, actor uuid.UUID) error {
				f.softDelete(t, "documents", f.document)
				return f.services.documents.PermanentDelete(ctx, actor, f.document)
			}},
	}

	chatCases := []contractCase{
		{"chat.createSession", access.CapChatUse, "KNOWLEDGE_BASE_NOT_FOUND",
			func(t *testing.T, ctx context.Context, f contractFixture, actor uuid.UUID) error {
				_, err := f.services.chats.CreateSession(ctx, actor, dto.CreateChatSessionRequest{
					KnowledgeBaseID: f.kbID.String(),
				})
				return err
			}},
		{"chat.getSession", access.CapChatUse, "RESOURCE_NOT_FOUND",
			func(t *testing.T, ctx context.Context, f contractFixture, actor uuid.UUID) error {
				_, err := f.services.chats.GetSession(ctx, actor, f.sessions[actor])
				return err
			}},
		{"chat.listMessages", access.CapChatUse, "RESOURCE_NOT_FOUND",
			func(t *testing.T, ctx context.Context, f contractFixture, actor uuid.UUID) error {
				_, err := f.services.chats.ListMessages(ctx, actor, f.sessions[actor])
				return err
			}},
		{"chat.updateSession", access.CapChatUse, "RESOURCE_NOT_FOUND",
			func(t *testing.T, ctx context.Context, f contractFixture, actor uuid.UUID) error {
				_, err := f.services.chats.UpdateSession(ctx, actor, f.sessions[actor], dto.UpdateChatSessionRequest{Title: "renamed session"})
				return err
			}},
		{"chat.archiveSession", access.CapChatUse, "RESOURCE_NOT_FOUND",
			func(t *testing.T, ctx context.Context, f contractFixture, actor uuid.UUID) error {
				_, err := f.services.chats.ArchiveSession(ctx, actor, f.sessions[actor])
				return err
			}},
		{"chat.deleteSession", access.CapChatUse, "RESOURCE_NOT_FOUND",
			func(t *testing.T, ctx context.Context, f contractFixture, actor uuid.UUID) error {
				return f.services.chats.DeleteSession(ctx, actor, f.sessions[actor])
			}},
		{"chat.permanentDeleteSession", access.CapChatUse, "RESOURCE_NOT_FOUND",
			func(t *testing.T, ctx context.Context, f contractFixture, actor uuid.UUID) error {
				f.softDelete(t, "chat_sessions", f.sessions[actor])
				return f.services.chats.PermanentDeleteSession(ctx, actor, f.sessions[actor])
			}},
		{"chat.exportSession", access.CapChatExport, "RESOURCE_NOT_FOUND",
			func(t *testing.T, ctx context.Context, f contractFixture, actor uuid.UUID) error {
				_, err := f.services.chats.ExportSession(ctx, actor, f.sessions[actor])
				return err
			}},
		{"chat.setMessageFeedback", access.CapFeedbackWrite, "RESOURCE_NOT_FOUND",
			func(t *testing.T, ctx context.Context, f contractFixture, actor uuid.UUID) error {
				_, err := f.services.chats.SetMessageFeedback(ctx, actor, f.messages[actor], "negative")
				return err
			}},
		{"chat.qualityOverview", access.CapQualityRead, "KNOWLEDGE_BASE_NOT_FOUND",
			func(t *testing.T, ctx context.Context, f contractFixture, actor uuid.UUID) error {
				kbID := f.kbID
				_, err := f.services.chats.GetQualityOverview(ctx, actor, dto.ChatQualityOverviewQuery{
					Period:          "month",
					KnowledgeBaseID: &kbID,
				})
				return err
			}},
		{"chat.knowledgeGaps", access.CapQualityRead, "KNOWLEDGE_BASE_NOT_FOUND",
			func(t *testing.T, ctx context.Context, f contractFixture, actor uuid.UUID) error {
				kbID := f.kbID
				_, err := f.services.chats.ListKnowledgeGaps(ctx, actor, dto.ChatKnowledgeGapQuery{
					Period:          "month",
					KnowledgeBaseID: &kbID,
				})
				return err
			}},
		{"chat.negativeFeedback", access.CapQualityRead, "KNOWLEDGE_BASE_NOT_FOUND",
			func(t *testing.T, ctx context.Context, f contractFixture, actor uuid.UUID) error {
				kbID := f.kbID
				_, err := f.services.chats.ListNegativeFeedback(ctx, actor, dto.ChatQualityFeedbackQuery{
					Period:          "month",
					KnowledgeBaseID: &kbID,
				})
				return err
			}},
	}

	retrievalCases := []contractCase{
		{"retrieval.search", access.CapKnowledgeBaseSearch, "KNOWLEDGE_BASE_NOT_FOUND",
			func(t *testing.T, ctx context.Context, f contractFixture, actor uuid.UUID) error {
				_, err := f.services.retrieval.Search(ctx, actor, f.kbID, dto.SearchRequest{Query: "contract"})
				return err
			}},
	}

	cases := append(kbCases, documentCases...)
	cases = append(cases, chatCases...)
	return append(cases, retrievalCases...)
}

// Every endpoint requires exactly the capability the matrix assigns it: each role
// is either allowed through, or refused with a 403 naming the role it would need.
func TestEndpointsRequireTheCapabilityTheMatrixAssigns(t *testing.T) {
	for _, testCase := range contractCases() {
		for _, role := range append([]access.Role{access.RoleOwner}, access.AssignableRoles...) {
			t.Run(testCase.name+"/"+string(role), func(t *testing.T) {
				ctx := context.Background()
				f := newContractFixture(t)
				err := testCase.call(t, ctx, f, f.actors[role])
				if access.Allows(role, testCase.capability) {
					assertNotRefused(t, err, testCase.notFoundCode)
					return
				}
				assertForbiddenRequiring(t, err, access.MinRole(testCase.capability))
			})
		}
	}
}

// A caller with no standing gets 404 for every resource id. Not 403: a 403 would
// confirm the id exists, which is what someone walking ids wants to learn.
func TestNonMembersGetNotFoundForEveryResourceID(t *testing.T) {
	for _, testCase := range contractCases() {
		t.Run(testCase.name, func(t *testing.T) {
			ctx := context.Background()
			f := newContractFixture(t)
			assertAppError(t, testCase.call(t, ctx, f, f.actors[access.RoleNone]), testCase.notFoundCode)
		})
	}
}

// Revoking a membership is not a downgrade to "can read but not write": it returns
// the caller to having no standing, on every endpoint, including the sessions they
// opened while they were a member.
func TestRevokedMembersGetNotFoundForEveryResourceID(t *testing.T) {
	for _, testCase := range contractCases() {
		for _, role := range access.AssignableRoles {
			t.Run(testCase.name+"/"+string(role), func(t *testing.T) {
				ctx := context.Background()
				f := newContractFixture(t)
				actor := f.actors[role]
				if err := f.services.kbs.RemoveMember(ctx, f.actors[access.RoleOwner], f.kbID, actor); err != nil {
					t.Fatalf("revoke %s: %v", role, err)
				}
				assertAppError(t, testCase.call(t, ctx, f, actor), testCase.notFoundCode)
			})
		}
	}
}

// A soft-deleted knowledge base takes its documents and sessions with it, for
// everybody including the owner. While it is in the recycle bin the only paths that
// still reach it are restore and permanent delete, which are owner-only and go
// through the deleted-row lookup rather than through this table.
func TestDeletedKnowledgeBasesAreUnreachableThroughEveryResourceID(t *testing.T) {
	for _, testCase := range contractCases() {
		t.Run(testCase.name, func(t *testing.T) {
			ctx := context.Background()
			f := newContractFixture(t)
			owner := f.actors[access.RoleOwner]
			if err := f.services.kbs.Delete(ctx, owner, f.kbID); err != nil {
				t.Fatalf("delete knowledge base: %v", err)
			}
			assertAppError(t, testCase.call(t, ctx, f, owner), testCase.notFoundCode)
		})
	}
}

// assertNotRefused fails when err is an authorization refusal.
//
// It cannot assert err == nil: several of these endpoints go on to fail for
// unrelated reasons in a test environment with no object storage and no chat
// provider. Passing the check is the property under test, and getting past it to a
// different failure is the evidence.
func assertNotRefused(t *testing.T, err error, notFoundCode string) {
	t.Helper()
	if err == nil {
		return
	}
	var appErr *apperror.Error
	if !errors.As(err, &appErr) {
		return
	}
	if appErr.Code == "FORBIDDEN" || appErr.Code == notFoundCode {
		t.Fatalf("expected the capability check to pass, got %s: %v (details %v)", appErr.Code, err, appErr.Details)
	}
}

// assertForbiddenRequiring asserts a 403 that says which role the caller needs.
//
// The required role is part of the contract, not decoration: without it the user
// cannot tell whether to ask for a higher role or stop trying.
func assertForbiddenRequiring(t *testing.T, err error, want access.Role) {
	t.Helper()
	var appErr *apperror.Error
	if !errors.As(err, &appErr) {
		t.Fatalf("expected a 403, got %T: %v", err, err)
	}
	if appErr.Code != "FORBIDDEN" {
		t.Fatalf("expected FORBIDDEN, got %s: %v", appErr.Code, err)
	}
	if appErr.Details["requiredRole"] != string(want) {
		t.Fatalf("expected requiredRole %s, got %v", want, appErr.Details)
	}
}
