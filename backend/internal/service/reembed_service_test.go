package service

import (
	"context"
	"github.com/google/uuid"
	"kbchat/backend/internal/config"
	"kbchat/backend/internal/model"
	"kbchat/backend/internal/repository"
	"testing"
	"time"
)

func TestReembedFiltersDryRunAndQueue(t *testing.T) {
	ctx := context.Background()
	f := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, f.db, "owner")
	kb := createWorkspaceKB(t, f.db, owner.ID, uuid.Nil, "target", "private", time.Now())
	otherKB := createWorkspaceKB(t, f.db, owner.ID, uuid.Nil, "other", "private", time.Now())
	var docs []model.Document
	for _, name := range []string{"unknown", "mismatch", "match", "active", "deleted", "superseded"} {
		docs = append(docs, createWorkspaceDocument(t, f.db, kb.ID, owner.ID, name, "completed"))
	}
	modelName := "new"
	dimension := 3
	if err := f.db.Model(&docs[2]).Updates(map[string]any{"embedding_model": modelName, "embedding_dimension": dimension}).Error; err != nil {
		t.Fatal(err)
	}
	if err := f.db.Model(&docs[1]).Updates(map[string]any{"embedding_model": "old", "embedding_dimension": 3}).Error; err != nil {
		t.Fatal(err)
	}
	if err := f.db.Create(&model.DocumentJob{DocumentID: docs[3].ID, JobType: "process_document", Status: "running"}).Error; err != nil {
		t.Fatal(err)
	}
	if err := f.db.Delete(&docs[4]).Error; err != nil {
		t.Fatal(err)
	}
	if err := f.db.Model(&docs[5]).Update("superseded_by_id", docs[2].ID).Error; err != nil {
		t.Fatal(err)
	}
	createWorkspaceDocument(t, f.db, otherKB.ID, owner.ID, "other", "completed")
	options := ReembedOptions{KnowledgeBaseID: &kb.ID, Identity: repository.EmbeddingIdentity{Model: modelName, Dimension: dimension}, OnlyMismatched: true, DryRun: true, Batch: 1}
	repo := repository.NewDocumentRepository(f.db)
	result, err := Reembed(ctx, repo, options)
	if err != nil || result.Selected != 3 || result.Queued != 0 {
		t.Fatalf("dry-run: %+v %v", result, err)
	}
	var count int64
	f.db.Model(&model.DocumentJob{}).Count(&count)
	if count != 1 {
		t.Fatalf("dry-run wrote jobs: %d", count)
	}
	svc := NewSystemService(config.Config{EmbeddingModel: modelName, EmbeddingDimension: dimension})
	svc.SetDiagnosticsDeps(SystemDiagnosticsDeps{Docs: repo})
	inventory := svc.embeddingStatus(ctx)
	if inventory.TotalDocuments != 6 || inventory.UnknownDocuments != 4 || inventory.MismatchedDocuments != 1 || len(inventory.Groups) != 3 {
		t.Fatalf("inventory: %+v", inventory)
	}
	options.DryRun = false
	result, err = Reembed(ctx, repo, options)
	if err != nil || result.Queued != 3 {
		t.Fatalf("queue: %+v %v", result, err)
	}
	result, err = Reembed(ctx, repo, options)
	if err != nil || result.Selected != 0 || result.Queued != 0 {
		t.Fatalf("repeat: %+v %v", result, err)
	}
	options.OnlyMismatched = false
	result, err = Reembed(ctx, repo, options)
	if err != nil || result.Queued != 1 {
		t.Fatalf("all: %+v %v", result, err)
	}
}
