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
)

// documentAccessFixture is one knowledge base with one document and one member per
// role, so each test states only what it asserts about a role.
type documentAccessFixture struct {
	services workspaceTestServices
	owner    uuid.UUID
	viewer   uuid.UUID
	editor   uuid.UUID
	manager  uuid.UUID
	stranger uuid.UUID
	kbID     uuid.UUID
	document uuid.UUID
}

func newDocumentAccessFixture(t *testing.T) documentAccessFixture {
	t.Helper()
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, services.db, "owner")
	kb := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "docs-kb", "private", time.Now())
	document := createWorkspaceDocument(t, services.db, kb.ID, owner.ID, "guide.pdf", "completed")

	fixture := documentAccessFixture{
		services: services,
		owner:    owner.ID,
		stranger: createWorkspaceUser(t, services.db, "stranger").ID,
		kbID:     kb.ID,
		document: document.ID,
	}
	for _, member := range []struct {
		name string
		role access.Role
		out  *uuid.UUID
	}{
		{"viewer", access.RoleViewer, &fixture.viewer},
		{"editor", access.RoleEditor, &fixture.editor},
		{"manager", access.RoleManager, &fixture.manager},
	} {
		user := createWorkspaceUser(t, services.db, member.name)
		*member.out = user.ID
		if _, err := services.kbs.AddMember(ctx, owner.ID, kb.ID, dto.KnowledgeBaseMemberRequest{
			UserID: user.ID,
			Role:   string(member.role),
		}); err != nil {
			t.Fatalf("add %s: %v", member.name, err)
		}
	}
	return fixture
}

// A viewer can read a document's metadata, chunks and text preview: those are the
// same content the answer citations already show them.
func TestViewerReadsDocumentsInASharedKnowledgeBase(t *testing.T) {
	ctx := context.Background()
	f := newDocumentAccessFixture(t)

	if _, err := f.services.documents.Get(ctx, f.viewer, f.document); err != nil {
		t.Fatalf("viewer get: %v", err)
	}
	if _, err := f.services.documents.Chunks(ctx, f.viewer, f.document, dto.ChunkListQuery{}); err != nil {
		t.Fatalf("viewer chunks: %v", err)
	}
	list, err := f.services.documents.List(ctx, f.viewer, f.kbID, dto.GlobalDocumentListQuery{})
	if err != nil {
		t.Fatalf("viewer list: %v", err)
	}
	if list.Total != 1 {
		t.Fatalf("viewer list total = %d, want 1", list.Total)
	}
}

// Download is separated from read because it is the one document read that hands
// over the original file, which then leaves the product entirely. Everything else
// a viewer sees stays inside the app.
func TestDownloadRequiresEditorWhileReadDoesNot(t *testing.T) {
	ctx := context.Background()
	f := newDocumentAccessFixture(t)

	_, err := f.services.documents.Download(ctx, f.viewer, f.document)
	assertAppError(t, err, "FORBIDDEN")
	assertRequiredRole(t, err, access.RoleEditor)

	// The editor's own download fails on storage, not on permission: the fixture
	// writes no file. DOCUMENT_FILE_NOT_FOUND is proof the check was passed.
	_, err = f.services.documents.Download(ctx, f.editor, f.document)
	assertAppError(t, err, "DOCUMENT_FILE_NOT_FOUND")
}

// Writing content is an editor capability, so a viewer cannot delete, rename,
// reprocess or upload, and an editor can.
func TestContentWriteRequiresEditor(t *testing.T) {
	ctx := context.Background()
	f := newDocumentAccessFixture(t)

	assertAppError(t, f.services.documents.Delete(ctx, f.viewer, f.document), "FORBIDDEN")
	_, err := f.services.documents.Update(ctx, f.viewer, f.document, dto.DocumentUpdateRequest{Filename: "renamed.pdf"})
	assertAppError(t, err, "FORBIDDEN")
	assertRequiredRole(t, err, access.RoleEditor)
	_, err = f.services.documents.Upload(ctx, f.viewer, f.kbID, createUploadFile(t, "viewer.txt", "content"))
	assertAppError(t, err, "FORBIDDEN")

	if _, err := f.services.documents.Update(ctx, f.editor, f.document, dto.DocumentUpdateRequest{Filename: "renamed.pdf"}); err != nil {
		t.Fatalf("editor rename: %v", err)
	}
	if _, err := f.services.documents.Upload(ctx, f.editor, f.kbID, createUploadFile(t, "editor.txt", "content")); err != nil {
		t.Fatalf("editor upload: %v", err)
	}
	if err := f.services.documents.Delete(ctx, f.editor, f.document); err != nil {
		t.Fatalf("editor delete: %v", err)
	}
}

// Permanent deletion is irreversible, so it stops at manager even though an editor
// could put the document in the recycle bin in the first place.
func TestPermanentDeleteRequiresManagerWhileRestoreDoesNot(t *testing.T) {
	ctx := context.Background()
	f := newDocumentAccessFixture(t)
	if err := f.services.documents.Delete(ctx, f.editor, f.document); err != nil {
		t.Fatalf("editor delete: %v", err)
	}

	err := f.services.documents.PermanentDelete(ctx, f.editor, f.document)
	assertAppError(t, err, "FORBIDDEN")
	assertRequiredRole(t, err, access.RoleManager)

	// An editor can undo their own delete: restoring puts content back rather than
	// destroying it, so it belongs with the other content writes.
	if err := f.services.documents.Restore(ctx, f.editor, f.document); err != nil {
		t.Fatalf("editor restore: %v", err)
	}
	if err := f.services.documents.Delete(ctx, f.editor, f.document); err != nil {
		t.Fatalf("editor delete again: %v", err)
	}
	if err := f.services.documents.PermanentDelete(ctx, f.manager, f.document); err != nil {
		t.Fatalf("manager permanent delete: %v", err)
	}
}

// The guard moved out of the repository's WHERE clause, so the case that used to be
// handled by a query returning no rows now has to be handled by an explicit check.
// A stranger must not be able to tell a document id apart from a made-up one.
func TestDocumentsAreInvisibleToNonMembers(t *testing.T) {
	ctx := context.Background()
	f := newDocumentAccessFixture(t)
	missing := uuid.New()

	for _, id := range []uuid.UUID{f.document, missing} {
		_, err := f.services.documents.Get(ctx, f.stranger, id)
		assertAppError(t, err, "DOCUMENT_NOT_FOUND")
		_, err = f.services.documents.Chunks(ctx, f.stranger, id, dto.ChunkListQuery{})
		assertAppError(t, err, "DOCUMENT_NOT_FOUND")
		assertAppError(t, f.services.documents.Delete(ctx, f.stranger, id), "DOCUMENT_NOT_FOUND")
		_, err = f.services.documents.Download(ctx, f.stranger, id)
		assertAppError(t, err, "DOCUMENT_NOT_FOUND")
	}

	// A knowledge base id the caller cannot reach answers about the knowledge base,
	// because that is the resource they named.
	_, err := f.services.documents.List(ctx, f.stranger, f.kbID, dto.GlobalDocumentListQuery{})
	assertAppError(t, err, "KNOWLEDGE_BASE_NOT_FOUND")
}

// Moving a document is writing content into the destination, and the role on the
// source knowledge base says nothing about the destination.
func TestMovingADocumentChecksTheDestinationKnowledgeBase(t *testing.T) {
	ctx := context.Background()
	f := newDocumentAccessFixture(t)
	outsider := createWorkspaceUser(t, f.services.db, "outsider")
	foreign := createWorkspaceKB(t, f.services.db, outsider.ID, uuid.Nil, "foreign-kb", "private", time.Now())
	readable := createWorkspaceKB(t, f.services.db, outsider.ID, uuid.Nil, "readable-kb", "private", time.Now())
	if _, err := f.services.kbs.AddMember(ctx, outsider.ID, readable.ID, dto.KnowledgeBaseMemberRequest{
		UserID: f.manager,
		Role:   string(access.RoleViewer),
	}); err != nil {
		t.Fatalf("add viewer on destination: %v", err)
	}

	// Unreachable destination: 404, so the move cannot be used to probe ids.
	_, err := f.services.documents.Update(ctx, f.manager, f.document, dto.DocumentUpdateRequest{KnowledgeBaseID: &foreign.ID})
	assertAppError(t, err, "KNOWLEDGE_BASE_NOT_FOUND")

	// Reachable but read-only destination: 403, naming the role the caller needs.
	_, err = f.services.documents.Update(ctx, f.manager, f.document, dto.DocumentUpdateRequest{KnowledgeBaseID: &readable.ID})
	assertAppError(t, err, "FORBIDDEN")
	assertRequiredRole(t, err, access.RoleEditor)

	if _, err := f.services.documents.Update(ctx, f.owner, f.document, dto.DocumentUpdateRequest{Filename: "kept.pdf"}); err != nil {
		t.Fatalf("owner rename: %v", err)
	}
}

// Batches are all-or-nothing: a batch that skipped the ids the caller may not touch
// would report a processed count that does not match what happened.
func TestDocumentBatchesRejectTheWholeRequestOnOneForbiddenID(t *testing.T) {
	ctx := context.Background()
	f := newDocumentAccessFixture(t)
	second := createWorkspaceDocument(t, f.services.db, f.kbID, f.owner, "second.pdf", "completed")
	outsider := createWorkspaceUser(t, f.services.db, "outsider")
	foreignKB := createWorkspaceKB(t, f.services.db, outsider.ID, uuid.Nil, "foreign-kb", "private", time.Now())
	foreignDocument := createWorkspaceDocument(t, f.services.db, foreignKB.ID, outsider.ID, "foreign.pdf", "completed")

	_, err := f.services.documents.BatchDelete(ctx, f.editor, dto.DocumentBatchRequest{
		DocumentIDs: []uuid.UUID{f.document, foreignDocument.ID},
	})
	assertAppError(t, err, "DOCUMENT_NOT_FOUND")

	var remaining int64
	if err := f.services.db.Model(&struct{}{}).Table("documents").
		Where("knowledge_base_id = ? AND deleted_at IS NULL", f.kbID).Count(&remaining).Error; err != nil {
		t.Fatalf("count documents: %v", err)
	}
	if remaining != 2 {
		t.Fatalf("expected both documents untouched, got %d live", remaining)
	}

	if _, err := f.services.documents.BatchDelete(ctx, f.editor, dto.DocumentBatchRequest{
		DocumentIDs: []uuid.UUID{f.document, second.ID},
	}); err != nil {
		t.Fatalf("editor batch delete: %v", err)
	}
}

// The cross-knowledge-base lists cannot authorize row by row, so their scoping is a
// query predicate. That predicate has to agree with the per-resource checks, or the
// list shows rows whose endpoints then answer 404.
func TestGlobalDocumentListsFollowTheSameReachabilityAsTheEndpoints(t *testing.T) {
	ctx := context.Background()
	f := newDocumentAccessFixture(t)
	outsider := createWorkspaceUser(t, f.services.db, "outsider")
	foreignKB := createWorkspaceKB(t, f.services.db, outsider.ID, uuid.Nil, "foreign-kb", "private", time.Now())
	createWorkspaceDocument(t, f.services.db, foreignKB.ID, outsider.ID, "foreign.pdf", "completed")

	for _, actor := range []struct {
		name string
		id   uuid.UUID
		want int64
	}{
		{"owner", f.owner, 1},
		{"viewer", f.viewer, 1},
		{"stranger", f.stranger, 0},
	} {
		list, err := f.services.documents.ListGlobal(ctx, actor.id, dto.GlobalDocumentListQuery{})
		if err != nil {
			t.Fatalf("%s global list: %v", actor.name, err)
		}
		if list.Total != actor.want {
			t.Fatalf("%s sees %d documents, want %d", actor.name, list.Total, actor.want)
		}
	}
}

// Aggregate filtering must happen before counting and pagination, inside the
// existing reachability predicate used by both document endpoints.
func TestProcessingDocumentFilterCoversAllStagesAndKeepsScope(t *testing.T) {
	ctx := context.Background()
	f := newDocumentAccessFixture(t)
	for _, stage := range []string{"uploaded", "parsing", "chunking", "embedding", "failed"} {
		createWorkspaceDocument(t, f.services.db, f.kbID, f.owner, stage+".pdf", stage)
	}
	otherKB := createWorkspaceKB(t, f.services.db, f.owner, uuid.Nil, "other-owned", "private", time.Now())
	createWorkspaceDocument(t, f.services.db, otherKB.ID, f.owner, "other.pdf", "embedding")
	foreignKB := createWorkspaceKB(t, f.services.db, f.stranger, uuid.Nil, "foreign", "private", time.Now())
	createWorkspaceDocument(t, f.services.db, foreignKB.ID, f.stranger, "foreign.pdf", "uploaded")
	deleted := createWorkspaceDocument(t, f.services.db, f.kbID, f.owner, "deleted.pdf", "uploaded")
	if err := f.services.documents.Delete(ctx, f.owner, deleted.ID); err != nil {
		t.Fatal(err)
	}

	global, err := f.services.documents.ListGlobal(ctx, f.owner, dto.GlobalDocumentListQuery{Status: "processing"})
	if err != nil || global.Total != 5 {
		t.Fatalf("global processing list: got %#v, err %v", global, err)
	}
	scope := f.kbID.String()
	seen := map[string]bool{}
	for page := 1; page <= 2; page++ {
		result, err := f.services.documents.ListGlobal(ctx, f.owner, dto.GlobalDocumentListQuery{
			KnowledgeBaseID: &scope, Status: "processing", FileType: "pdf", Sort: "filename_asc", Page: page, PageSize: 2,
		})
		if err != nil || result.Total != 4 || len(result.Items) != 2 {
			t.Fatalf("scoped page %d: got %#v, err %v", page, result, err)
		}
		otherID := otherKB.ID.String()
		pinned, err := f.services.documents.List(ctx, f.owner, f.kbID, dto.GlobalDocumentListQuery{
			KnowledgeBaseID: &otherID, Status: "processing", FileType: "pdf", Sort: "filename_asc", Page: page, PageSize: 2,
		})
		if err != nil || pinned.Total != result.Total || len(pinned.Items) != len(result.Items) {
			t.Fatalf("knowledge-base endpoint disagrees with global query: %#v, %v", pinned, err)
		}
		for index := range result.Items {
			if pinned.Items[index].ID != result.Items[index].ID {
				t.Fatalf("path scope was overridden or pagination differs: %#v", pinned)
			}
		}
		for _, item := range result.Items {
			if item.KnowledgeBaseID != scope || item.Status == "completed" || item.Status == "failed" || seen[item.Status] {
				t.Fatalf("unexpected or repeated processing document: %#v", item)
			}
			seen[item.Status] = true
		}
	}
	for _, stage := range []string{"uploaded", "parsing", "chunking", "embedding"} {
		if !seen[stage] {
			t.Fatalf("missing processing stage %q", stage)
		}
	}
	stage, err := f.services.documents.ListGlobal(ctx, f.owner, dto.GlobalDocumentListQuery{
		KnowledgeBaseID: &scope, Status: "embedding",
	})
	if err != nil || stage.Total != 1 || len(stage.Items) != 1 || stage.Items[0].Status != "embedding" {
		t.Fatalf("concrete stage filter changed: got %#v, err %v", stage, err)
	}
	_, err = f.services.documents.List(ctx, f.stranger, f.kbID, dto.GlobalDocumentListQuery{
		Status: "processing",
	})
	assertAppError(t, err, "KNOWLEDGE_BASE_NOT_FOUND")
}

// The recycle bin is scoped to content.write rather than document.read, because
// its restore and purge actions must be available to the caller.
func TestRecycleBinIsScopedToWhoCanActOnIt(t *testing.T) {
	ctx := context.Background()
	f := newDocumentAccessFixture(t)
	if err := f.services.documents.Delete(ctx, f.editor, f.document); err != nil {
		t.Fatalf("editor delete: %v", err)
	}

	for _, actor := range []struct {
		name string
		id   uuid.UUID
		want int64
	}{
		{"owner", f.owner, 1},
		{"editor", f.editor, 1},
		{"viewer", f.viewer, 0},
		{"stranger", f.stranger, 0},
	} {
		bin, err := f.services.documents.ListRecycleBin(ctx, actor.id, 1, 20)
		if err != nil {
			t.Fatalf("%s recycle bin: %v", actor.name, err)
		}
		if bin.Total != actor.want {
			t.Fatalf("%s sees %d deleted documents, want %d", actor.name, bin.Total, actor.want)
		}
	}

	// Emptying the bin is a purge, so an editor who can see and restore an item
	// still cannot destroy it in bulk.
	if err := f.services.documents.EmptyRecycleBin(ctx, f.editor); err != nil {
		t.Fatalf("editor empty bin: %v", err)
	}
	bin, err := f.services.documents.ListRecycleBin(ctx, f.owner, 1, 20)
	if err != nil {
		t.Fatalf("owner recycle bin: %v", err)
	}
	if bin.Total != 1 {
		t.Fatalf("an editor emptied the bin: %d items left, want 1", bin.Total)
	}

	if err := f.services.documents.EmptyRecycleBin(ctx, f.manager); err != nil {
		t.Fatalf("manager empty bin: %v", err)
	}
	bin, err = f.services.documents.ListRecycleBin(ctx, f.owner, 1, 20)
	if err != nil {
		t.Fatalf("owner recycle bin after purge: %v", err)
	}
	if bin.Total != 0 {
		t.Fatalf("manager purge left %d items", bin.Total)
	}
}

// assertRequiredRole checks the 403 tells the caller which role would be enough.
// Without it the user cannot tell whether to ask for a higher role or stop trying.
func assertRequiredRole(t *testing.T, err error, want access.Role) {
	t.Helper()
	var appErr *apperror.Error
	if !errors.As(err, &appErr) {
		t.Fatalf("expected an apperror, got %T: %v", err, err)
	}
	if appErr.Details["requiredRole"] != string(want) {
		t.Fatalf("requiredRole = %v, want %s", appErr.Details["requiredRole"], want)
	}
}
