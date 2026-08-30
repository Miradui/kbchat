package service

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"

	"kbchat/backend/internal/model"
)

func TestDocumentResponseCarriesStalenessAndTheThreshold(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	services.documents.cfg.StaleDocumentAfterDays = 30
	owner := createWorkspaceUser(t, services.db, "stale-owner")
	kb := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "stale-kb", "private", time.Now())
	document := createWorkspaceDocument(t, services.db, kb.ID, owner.ID, "old.md", "completed")

	// UpdatedAt is set through the DB because GORM maintains it on save; UTC because
	// SQLite compares timestamps as text and a local offset would not match.
	old := time.Now().UTC().AddDate(0, 0, -90)
	if err := services.db.Model(&model.Document{}).
		Where("id = ?", document.ID).
		UpdateColumn("updated_at", old).Error; err != nil {
		t.Fatalf("age the document: %v", err)
	}

	res, err := services.documents.Get(ctx, owner.ID, document.ID)
	if err != nil {
		t.Fatalf("get document: %v", err)
	}
	if !res.IsStale {
		t.Fatal("expected the document to be flagged stale")
	}
	// The threshold is echoed so the client can explain the flag rather than
	// asserting it.
	if res.StaleAfterDays != 30 {
		t.Fatalf("expected the threshold to be echoed, got %d", res.StaleAfterDays)
	}
}

func TestDocumentResponseReportsThresholdZeroWhenDisabled(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	services.documents.cfg.StaleDocumentAfterDays = 0
	owner := createWorkspaceUser(t, services.db, "no-stale-owner")
	kb := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "no-stale-kb", "private", time.Now())
	document := createWorkspaceDocument(t, services.db, kb.ID, owner.ID, "ancient.md", "completed")

	old := time.Now().UTC().AddDate(-10, 0, 0)
	if err := services.db.Model(&model.Document{}).
		Where("id = ?", document.ID).
		UpdateColumn("updated_at", old).Error; err != nil {
		t.Fatalf("age the document: %v", err)
	}

	res, err := services.documents.Get(ctx, owner.ID, document.ID)
	if err != nil {
		t.Fatalf("get document: %v", err)
	}
	if res.IsStale {
		t.Fatal("expected no staleness flag when the threshold is disabled")
	}
	if res.StaleAfterDays != 0 {
		t.Fatalf("expected threshold 0 when disabled, got %d", res.StaleAfterDays)
	}
}

func TestStalenessNeverAffectsRetrievalEligibility(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	services.documents.cfg.StaleDocumentAfterDays = 1
	owner := createWorkspaceUser(t, services.db, "stale-retrieval-owner")
	kb := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "stale-retrieval-kb", "private", time.Now())
	document := createWorkspaceDocument(t, services.db, kb.ID, owner.ID, "aging.md", "completed")

	old := time.Now().UTC().AddDate(0, 0, -400)
	if err := services.db.Model(&model.Document{}).
		Where("id = ?", document.ID).
		UpdateColumn("updated_at", old).Error; err != nil {
		t.Fatalf("age the document: %v", err)
	}

	// Staleness is a display hint. A stale document keeps its chunks and its
	// completed status, because silently demoting content the user still relies on
	// would make answers worse with no way to see why.
	res, err := services.documents.Get(ctx, owner.ID, document.ID)
	if err != nil {
		t.Fatalf("get document: %v", err)
	}
	if !res.IsStale {
		t.Fatal("expected the document to be flagged stale")
	}
	if res.Status != "completed" {
		t.Fatalf("staleness must not change status, got %q", res.Status)
	}

	var stored model.Document
	if err := services.db.First(&stored, "id = ?", document.ID).Error; err != nil {
		t.Fatalf("load document: %v", err)
	}
	if stored.DeletedAt.Valid {
		t.Fatal("staleness must never delete a document")
	}
}
