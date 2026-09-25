package service

import (
	"context"
	"testing"

	"github.com/google/uuid"

	"kbchat/backend/internal/access"
	"kbchat/backend/internal/dto"
	"kbchat/backend/internal/model"
)

// updated_by_id names whoever last changed the knowledge base. Save used to
// write it back from the preloaded UpdatedBy association, so the column kept the
// previous editor, and because the service stored the address of its actor
// parameter, that parameter was silently rewritten too.
func TestKnowledgeBaseEditsRecordTheEditorAndKeepTheOwner(t *testing.T) {
	ctx := context.Background()
	f := newContractFixture(t)
	owner := f.actors[access.RoleOwner]
	manager := f.actors[access.RoleManager]

	res, err := f.services.kbs.Update(ctx, manager, f.kbID, dto.KnowledgeBaseRequest{Name: "manager-renamed", Visibility: "private"})
	if err != nil {
		t.Fatalf("manager rename: %v", err)
	}
	if res.Name != "manager-renamed" {
		t.Fatalf("response carries stale name %q", res.Name)
	}
	assertKnowledgeBaseEditor(t, f, manager, owner)

	if _, err := f.services.kbs.Update(ctx, owner, f.kbID, dto.KnowledgeBaseRequest{
		Name:            "owner-renamed",
		Visibility:      "private",
		RetrievalConfig: &dto.RetrievalConfig{VectorTopN: 20, RerankTopK: 5, ScoreThreshold: 0.3, EnableRerank: true},
	}); err != nil {
		t.Fatalf("owner update: %v", err)
	}
	assertKnowledgeBaseEditor(t, f, owner, owner)

	if _, err := f.services.kbs.UpdatePermissions(ctx, manager, f.kbID, dto.KnowledgeBasePermissionUpdateRequest{Visibility: "private"}); err != nil {
		t.Fatalf("manager permissions: %v", err)
	}
	assertKnowledgeBaseEditor(t, f, manager, owner)

	category := createWorkspaceCategory(t, f.services.db, owner, "moved")
	if _, err := f.services.kbs.BatchMoveCategory(ctx, owner, dto.KnowledgeBaseBatchMoveCategoryRequest{
		KnowledgeBaseIDs: []uuid.UUID{f.kbID},
		CategoryID:       &category.ID,
	}); err != nil {
		t.Fatalf("owner batch move: %v", err)
	}
	assertKnowledgeBaseEditor(t, f, owner, owner)
}

func assertKnowledgeBaseEditor(t *testing.T, f contractFixture, editor, owner uuid.UUID) {
	t.Helper()
	var stored model.KnowledgeBase
	if err := f.services.db.First(&stored, "id = ?", f.kbID).Error; err != nil {
		t.Fatalf("load knowledge base: %v", err)
	}
	if stored.UpdatedByID == nil || *stored.UpdatedByID != editor {
		t.Fatalf("updated_by_id = %v, want %s", stored.UpdatedByID, editor)
	}
	if stored.OwnerID != owner {
		t.Fatalf("owner_id changed to %s, want %s", stored.OwnerID, owner)
	}
}
