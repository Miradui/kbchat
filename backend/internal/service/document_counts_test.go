package service

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"

	"kbchat/backend/internal/dto"
	"kbchat/backend/internal/model"
)

func TestDocumentCountsRespectScopeFiltersAndAccess(t *testing.T) {
	ctx := context.Background()
	f := newDocumentAccessFixture(t)
	for _, stage := range []string{"uploaded", "parsing", "chunking", "embedding", "failed"} {
		createWorkspaceDocument(t, f.services.db, f.kbID, f.owner, stage+".pdf", stage)
	}
	other := createWorkspaceKB(t, f.services.db, f.owner, uuid.Nil, "Other policy", "private", time.Now())
	otherDocument := createWorkspaceDocument(t, f.services.db, other.ID, f.owner, "other.md", "completed")
	if err := f.services.db.Model(&otherDocument).Update("file_type", "md").Error; err != nil {
		t.Fatal(err)
	}
	outsider := createWorkspaceUser(t, f.services.db, "counts-outsider")
	foreign := createWorkspaceKB(t, f.services.db, outsider.ID, uuid.Nil, "foreign", "public", time.Now())
	createWorkspaceDocument(t, f.services.db, foreign.ID, outsider.ID, "hidden.pdf", "failed")
	deleted := createWorkspaceDocument(t, f.services.db, f.kbID, f.owner, "deleted.pdf", "failed")
	if err := f.services.documents.Delete(ctx, f.owner, deleted.ID); err != nil {
		t.Fatal(err)
	}
	deletedKB := createWorkspaceKB(t, f.services.db, f.owner, uuid.Nil, "deleted-kb", "private", time.Now())
	createWorkspaceDocument(t, f.services.db, deletedKB.ID, f.owner, "hidden.pdf", "failed")
	if err := f.services.db.Model(&model.KnowledgeBase{}).Where("id = ?", deletedKB.ID).Update("deleted_at", time.Now()).Error; err != nil {
		t.Fatal(err)
	}
	if err := f.services.db.Model(&model.User{}).Where("id = ?", f.stranger).Update("role", "admin").Error; err != nil {
		t.Fatal(err)
	}
	scope, hiddenScope := f.kbID.String(), foreign.ID.String()
	for _, test := range []struct {
		name  string
		actor uuid.UUID
		query dto.DocumentCountsQuery
		want  dto.DocumentCountsResponse
	}{
		{"owner", f.owner, dto.DocumentCountsQuery{}, dto.DocumentCountsResponse{Total: 7, Completed: 2, Processing: 4, Failed: 1}},
		{"viewer", f.viewer, dto.DocumentCountsQuery{}, dto.DocumentCountsResponse{Total: 6, Completed: 1, Processing: 4, Failed: 1}},
		{"editor", f.editor, dto.DocumentCountsQuery{}, dto.DocumentCountsResponse{Total: 6, Completed: 1, Processing: 4, Failed: 1}},
		{"manager", f.manager, dto.DocumentCountsQuery{}, dto.DocumentCountsResponse{Total: 6, Completed: 1, Processing: 4, Failed: 1}},
		{"unrelated admin", f.stranger, dto.DocumentCountsQuery{}, dto.DocumentCountsResponse{}},
		{"knowledge base", f.owner, dto.DocumentCountsQuery{KnowledgeBaseID: &scope}, dto.DocumentCountsResponse{Total: 6, Completed: 1, Processing: 4, Failed: 1}},
		{"foreign knowledge base", f.owner, dto.DocumentCountsQuery{KnowledgeBaseID: &hiddenScope}, dto.DocumentCountsResponse{}},
		{"file type", f.owner, dto.DocumentCountsQuery{FileType: "md"}, dto.DocumentCountsResponse{Total: 1, Completed: 1}},
		{"filename", f.owner, dto.DocumentCountsQuery{Q: " EMBEDDING ", KnowledgeBaseID: &scope, FileType: "pdf"}, dto.DocumentCountsResponse{Total: 1, Processing: 1}},
		{"knowledge base name", f.owner, dto.DocumentCountsQuery{Q: "POLICY"}, dto.DocumentCountsResponse{Total: 1, Completed: 1}},
		{"empty", f.owner, dto.DocumentCountsQuery{Q: "not-present"}, dto.DocumentCountsResponse{}},
	} {
		t.Run(test.name, func(t *testing.T) {
			got, err := f.services.documents.CountsGlobal(ctx, test.actor, test.query)
			if err != nil || got == nil || *got != test.want {
				t.Fatalf("counts = %#v, %v; want %#v", got, err, test.want)
			}
		})
	}
	if err := f.services.db.Where("knowledge_base_id = ? AND user_id = ?", f.kbID, f.viewer).Delete(&model.KnowledgeBaseMember{}).Error; err != nil {
		t.Fatal(err)
	}
	got, err := f.services.documents.CountsGlobal(ctx, f.viewer, dto.DocumentCountsQuery{KnowledgeBaseID: &scope})
	if err != nil || got == nil || *got != (dto.DocumentCountsResponse{}) {
		t.Fatalf("revoked member counts = %#v, %v", got, err)
	}
	invalid := "not-a-uuid"
	_, err = f.services.documents.CountsGlobal(ctx, f.owner, dto.DocumentCountsQuery{KnowledgeBaseID: &invalid})
	assertAppError(t, err, "VALIDATION_ERROR")
}
