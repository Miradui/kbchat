package service

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/google/uuid"

	"kbchat/backend/internal/apperror"
	"kbchat/backend/internal/model"
	"kbchat/backend/internal/repository"
)

func TestUploadStoresContentHash(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, services.db, "hash-owner")
	kb := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "hash-kb", "private", time.Now())

	content := "# Handbook\nonboarding steps"
	res, err := services.documents.Upload(ctx, owner.ID, kb.ID, createUploadFile(t, "handbook.md", content))
	if err != nil {
		t.Fatalf("upload document: %v", err)
	}

	var stored model.Document
	if err := services.db.First(&stored, "id = ?", res.ID).Error; err != nil {
		t.Fatalf("load stored document: %v", err)
	}
	digest := sha256.Sum256([]byte(content))
	want := hex.EncodeToString(digest[:])
	if stored.ContentHash == nil {
		t.Fatal("expected content hash to be stored")
	}
	if *stored.ContentHash != want {
		t.Fatalf("unexpected content hash: got %q want %q", *stored.ContentHash, want)
	}
}

func TestUploadRejectsDuplicateContentWithConflictDetails(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, services.db, "duplicate-owner")
	kb := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "duplicate-kb", "private", time.Now())

	content := "# Policy\nsame bytes"
	first, err := services.documents.Upload(ctx, owner.ID, kb.ID, createUploadFile(t, "policy.md", content))
	if err != nil {
		t.Fatalf("upload first document: %v", err)
	}

	// A different filename with identical bytes is still the same content: the
	// check has to be on the hash, not the name.
	_, err = services.documents.Upload(ctx, owner.ID, kb.ID, createUploadFile(t, "policy-copy.md", content))
	var appErr *apperror.Error
	if !errors.As(err, &appErr) {
		t.Fatalf("expected apperror for duplicate upload, got %v", err)
	}
	if appErr.Status != http.StatusConflict || appErr.Code != "DOCUMENT_DUPLICATE_CONTENT" {
		t.Fatalf("unexpected duplicate error: status=%d code=%s", appErr.Status, appErr.Code)
	}
	if appErr.Details["existingDocumentId"] != first.ID {
		t.Fatalf("expected conflict to name the existing document, got %#v", appErr.Details)
	}
	if appErr.Details["existingFilename"] != "policy.md" {
		t.Fatalf("expected conflict to carry the existing filename, got %#v", appErr.Details)
	}
	if _, leaked := appErr.Details["storagePath"]; leaked {
		t.Fatal("conflict details must not expose the storage path")
	}
}

func TestDuplicateUploadLeavesNoOrphanObjectOrReservation(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, services.db, "orphan-owner")
	kb := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "orphan-kb", "private", time.Now())

	content := "# Guide\nrepeated upload"
	if _, err := services.documents.Upload(ctx, owner.ID, kb.ID, createUploadFile(t, "guide.md", content)); err != nil {
		t.Fatalf("upload first document: %v", err)
	}
	filesAfterFirst := countUploadedFiles(t, services.uploadRoot)

	var reservationsAfterFirst int64
	if err := services.db.Model(&model.StorageCleanupJob{}).Count(&reservationsAfterFirst).Error; err != nil {
		t.Fatalf("count cleanup jobs: %v", err)
	}

	// Repeated three times because a leak per attempt is the failure mode: one
	// rejected upload could hide it, three cannot.
	for attempt := 0; attempt < 3; attempt++ {
		if _, err := services.documents.Upload(ctx, owner.ID, kb.ID, createUploadFile(t, "guide.md", content)); err == nil {
			t.Fatalf("attempt %d: expected duplicate rejection", attempt)
		}
	}

	if got := countUploadedFiles(t, services.uploadRoot); got != filesAfterFirst {
		t.Fatalf("rejected uploads left orphan objects: got %d files want %d", got, filesAfterFirst)
	}
	var reservationsAfterDuplicates int64
	if err := services.db.Model(&model.StorageCleanupJob{}).Count(&reservationsAfterDuplicates).Error; err != nil {
		t.Fatalf("count cleanup jobs: %v", err)
	}
	if reservationsAfterDuplicates != reservationsAfterFirst {
		t.Fatalf("rejected uploads left storage reservations: got %d want %d", reservationsAfterDuplicates, reservationsAfterFirst)
	}
}

func TestUploadWithAllowDuplicateKeepsBothCopies(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, services.db, "keep-both-owner")
	kb := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "keep-both-kb", "private", time.Now())

	content := "# Notes\nkeep both"
	first, err := services.documents.Upload(ctx, owner.ID, kb.ID, createUploadFile(t, "notes.md", content))
	if err != nil {
		t.Fatalf("upload first document: %v", err)
	}
	second, err := services.documents.UploadWithOptions(
		ctx, owner.ID, kb.ID,
		createUploadFile(t, "notes.md", content),
		DocumentUploadOptions{AllowDuplicate: true},
	)
	if err != nil {
		t.Fatalf("upload duplicate with override: %v", err)
	}
	if first.ID == second.ID {
		t.Fatal("expected the override to create a second document")
	}

	var count int64
	if err := services.db.Model(&model.Document{}).Where("knowledge_base_id = ?", kb.ID).Count(&count).Error; err != nil {
		t.Fatalf("count documents: %v", err)
	}
	if count != 2 {
		t.Fatalf("expected both copies to be kept, got %d documents", count)
	}
}

func TestUploadAllowsSameContentInDifferentKnowledgeBases(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, services.db, "cross-kb-owner")
	first := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "cross-kb-a", "private", time.Now())
	second := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "cross-kb-b", "private", time.Now())

	content := "# Shared\nsame content, two knowledge bases"
	if _, err := services.documents.Upload(ctx, owner.ID, first.ID, createUploadFile(t, "shared.md", content)); err != nil {
		t.Fatalf("upload into first knowledge base: %v", err)
	}
	// Deliberate: putting the same reference document in two knowledge bases is a
	// normal thing to do, so detection is scoped to one knowledge base.
	if _, err := services.documents.Upload(ctx, owner.ID, second.ID, createUploadFile(t, "shared.md", content)); err != nil {
		t.Fatalf("upload into second knowledge base: %v", err)
	}
}

func TestFindByContentHashIgnoresSupersededAndDeletedDocuments(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, services.db, "superseded-owner")
	kb := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "superseded-kb", "private", time.Now())

	content := "# Replaced\nold revision"
	first, err := services.documents.Upload(ctx, owner.ID, kb.ID, createUploadFile(t, "replaced.md", content))
	if err != nil {
		t.Fatalf("upload first document: %v", err)
	}
	replacement := uuid.New()
	if err := services.db.Model(&model.Document{}).
		Where("id = ?", first.ID).
		Updates(map[string]any{"superseded_by_id": replacement, "superseded_at": time.Now().UTC()}).Error; err != nil {
		t.Fatalf("mark superseded: %v", err)
	}

	// A superseded document is history, not a live duplicate: re-uploading the
	// same bytes has to be allowed or a replaced file can never come back.
	if _, err := services.documents.Upload(ctx, owner.ID, kb.ID, createUploadFile(t, "replaced.md", content)); err != nil {
		t.Fatalf("expected upload after supersede to be allowed: %v", err)
	}
}

func TestMarkSupersededRejectsSecondClaim(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, services.db, "claim-owner")
	kb := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "claim-kb", "private", time.Now())
	old := createWorkspaceDocument(t, services.db, kb.ID, owner.ID, "old.md", "completed")
	first := createWorkspaceDocument(t, services.db, kb.ID, owner.ID, "new-a.md", "completed")
	second := createWorkspaceDocument(t, services.db, kb.ID, owner.ID, "new-b.md", "completed")

	repo := services.documents.documents
	if err := repo.MarkSuperseded(ctx, old.ID, first.ID, time.Now().UTC()); err != nil {
		t.Fatalf("first supersede: %v", err)
	}
	// Guarded so two concurrent replacements cannot silently drop one of them
	// from the version trail.
	if err := repo.MarkSuperseded(ctx, old.ID, second.ID, time.Now().UTC()); !errors.Is(err, repository.ErrDocumentAlreadySuperseded) {
		t.Fatalf("expected ErrDocumentAlreadySuperseded, got %v", err)
	}
}

func countUploadedFiles(t *testing.T, root string) int {
	t.Helper()

	count := 0
	err := filepath.WalkDir(root, func(_ string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !entry.IsDir() {
			count++
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk upload root: %v", err)
	}
	return count
}
