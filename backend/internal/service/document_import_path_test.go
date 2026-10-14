package service

import (
	"context"
	"github.com/google/uuid"
	"kbchat/backend/internal/dto"
	"strings"
	"testing"
	"time"
)

func TestFolderImportStoresSourcePathAndRejectsTraversal(t *testing.T) {
	f := newWorkspaceTestServices(t)
	ctx := context.Background()
	owner := createWorkspaceUser(t, f.db, "folder-owner")
	kb := createWorkspaceKB(t, f.db, owner.ID, uuid.Nil, "folder", "private", time.Now())
	doc, err := f.documents.UploadWithOptions(ctx, owner.ID, kb.ID, createUploadFile(t, "政策.md", "policy"), DocumentUploadOptions{SourcePath: `资料\制度\政策.md`})
	if err != nil || doc.SourcePath != "资料/制度/政策.md" {
		t.Fatalf("source: %+v %v", doc, err)
	}
	listed, err := f.documents.List(ctx, owner.ID, kb.ID, dto.GlobalDocumentListQuery{Page: 1, PageSize: 20})
	if err != nil || listed.Items[0].SourcePath != doc.SourcePath {
		t.Fatalf("list source: %+v %v", listed, err)
	}
	for _, path := range []string{"../政策.md", "C:/政策.md", "/政策.md", "a//政策.md", "x/other.md", "a\x00/政策.md", strings.Repeat("字", 400) + "/政策.md"} {
		_, err = f.documents.UploadWithOptions(ctx, owner.ID, kb.ID, createUploadFile(t, "政策.md", "other"), DocumentUploadOptions{SourcePath: path})
		assertAppError(t, err, "VALIDATION_ERROR")
	}
	next, err := f.documents.Replace(ctx, owner.ID, uuid.MustParse(doc.ID), createUploadFile(t, "政策.md", "new"), DocumentUploadOptions{SourcePath: "新版.zip/政策.md"})
	if err != nil || next.SourcePath != "新版.zip/政策.md" {
		t.Fatalf("replace provenance: %+v %v", next, err)
	}
}
