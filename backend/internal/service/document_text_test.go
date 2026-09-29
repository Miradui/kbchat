package service

import (
	"context"
	"github.com/google/uuid"
	"kbchat/backend/internal/dto"
	"kbchat/backend/internal/model"
	"os"
	"strings"
	"testing"
	"time"
)

func TestCreateTextUsesUploadStorageDedupAndQueue(t *testing.T) {
	ctx := context.Background()
	f := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, f.db, "text-owner")
	kb := createWorkspaceKB(t, f.db, owner.ID, uuid.Nil, "text", "private", time.Now())
	req := dto.TextDocumentRequest{Title: "  安全/指南  ", Content: "# 标题\n\n正文中文 🐈\n", Format: "md"}
	result, err := f.documents.CreateText(ctx, owner.ID, kb.ID, req)
	if err != nil {
		t.Fatal(err)
	}
	var doc model.Document
	if err := f.db.First(&doc, "id = ?", result.ID).Error; err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(doc.StoragePath)
	if err != nil || string(content) != req.Content {
		t.Fatalf("content: %q %v", content, err)
	}
	if doc.Filename != "安全_指南.md" || doc.FileSize != int64(len(req.Content)) || doc.ContentHash == nil {
		t.Fatalf("doc: %+v", doc)
	}
	var job model.DocumentJob
	if err := f.db.First(&job, "document_id = ?", doc.ID).Error; err != nil || job.Status != "pending" {
		t.Fatalf("job: %+v %v", job, err)
	}
	_, err = f.documents.Upload(ctx, owner.ID, kb.ID, createUploadFile(t, "same.md", req.Content))
	assertAdminError(t, err, 409, "DOCUMENT_DUPLICATE_CONTENT")
	_, err = f.documents.CreateText(ctx, owner.ID, kb.ID, req)
	assertAdminError(t, err, 409, "DOCUMENT_DUPLICATE_CONTENT")
	req.AllowDuplicate = true
	if _, err = f.documents.CreateText(ctx, owner.ID, kb.ID, req); err != nil {
		t.Fatal(err)
	}
	var count int64
	f.db.Model(&model.Document{}).Count(&count)
	if count != 2 {
		t.Fatalf("documents: %d", count)
	}
}

func TestCreateTextValidatesBeforeWriting(t *testing.T) {
	ctx := context.Background()
	f := newWorkspaceTestServices(t)
	f.documents.cfg.MaxUploadSizeMB = 1
	owner := createWorkspaceUser(t, f.db, "owner")
	stranger := createWorkspaceUser(t, f.db, "stranger")
	kb := createWorkspaceKB(t, f.db, owner.ID, uuid.Nil, "text", "private", time.Now())
	for _, req := range []dto.TextDocumentRequest{{Title: " ", Content: "body"}, {Title: strings.Repeat("中", 201), Content: "body"}, {Title: "title", Content: " \n "}, {Title: "title", Content: strings.Repeat("x", 1024*1024+1)}, {Title: "title", Content: "body", Format: "pdf"}} {
		_, err := f.documents.CreateText(ctx, owner.ID, kb.ID, req)
		assertAdminError(t, err, 400, "VALIDATION_ERROR")
	}
	_, err := f.documents.CreateText(ctx, stranger.ID, kb.ID, dto.TextDocumentRequest{Title: "ok", Content: "body"})
	assertAdminError(t, err, 404, "KNOWLEDGE_BASE_NOT_FOUND")
	var count int64
	f.db.Model(&model.Document{}).Count(&count)
	if count != 0 {
		t.Fatalf("documents written: %d", count)
	}
}
