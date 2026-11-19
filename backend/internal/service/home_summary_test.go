package service

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/google/uuid"

	"kbchat/backend/internal/dto"
	"kbchat/backend/internal/model"
)

func TestHomeSummaryCountsAllActionableDocumentsBeyondRecentRows(t *testing.T) {
	ctx := context.Background()
	f := newDocumentAccessFixture(t)
	home := NewHomeService(f.services.kbs, f.services.documents, f.services.chats)
	for i := range 7 {
		createWorkspaceDocument(t, f.services.db, f.kbID, f.owner, fmt.Sprintf("processing-%d.pdf", i), "embedding")
		createWorkspaceDocument(t, f.services.db, f.kbID, f.owner, fmt.Sprintf("failed-%d.pdf", i), "failed")
	}
	for i := range 6 {
		cancelled := createWorkspaceDocument(t, f.services.db, f.kbID, f.owner, fmt.Sprintf("cancelled-%d.pdf", i), "failed")
		if err := f.services.db.Model(&cancelled).Update("error_code", "cancelled").Error; err != nil {
			t.Fatal(err)
		}
	}
	legacyCancelled := createWorkspaceDocument(t, f.services.db, f.kbID, f.owner, "legacy-cancelled.pdf", "failed")
	if err := f.services.db.Create(&model.DocumentJob{ID: uuid.New(), DocumentID: legacyCancelled.ID, JobType: "process_document", Status: "cancelled"}).Error; err != nil {
		t.Fatal(err)
	}
	retried := createWorkspaceDocument(t, f.services.db, f.kbID, f.owner, "retry-failed.pdf", "failed")
	stamp := time.Now().Add(-time.Hour)
	for i, status := range []string{"cancelled", "failed"} {
		if err := f.services.db.Create(&model.DocumentJob{ID: uuid.New(), DocumentID: retried.ID, JobType: "process_document", Status: status, CreatedAt: stamp.Add(time.Duration(i) * time.Second)}).Error; err != nil {
			t.Fatal(err)
		}
	}
	// Newer completed documents push every processing row out of the recent list.
	for i := range 6 {
		createWorkspaceDocument(t, f.services.db, f.kbID, f.owner, fmt.Sprintf("recent-%d.pdf", i), "completed")
	}
	outsider := createWorkspaceUser(t, f.services.db, "home-outsider")
	foreign := createWorkspaceKB(t, f.services.db, outsider.ID, uuid.Nil, "foreign public", "public", time.Now())
	createWorkspaceDocument(t, f.services.db, foreign.ID, outsider.ID, "hidden.pdf", "embedding")
	createWorkspaceDocument(t, f.services.db, foreign.ID, outsider.ID, "hidden-failure.pdf", "failed")
	deletedKB := createWorkspaceKB(t, f.services.db, f.owner, uuid.Nil, "deleted", "private", time.Now())
	createWorkspaceDocument(t, f.services.db, deletedKB.ID, f.owner, "deleted-kb.pdf", "embedding")
	if err := f.services.db.Delete(&deletedKB).Error; err != nil {
		t.Fatal(err)
	}
	deleted := createWorkspaceDocument(t, f.services.db, f.kbID, f.owner, "deleted.pdf", "failed")
	if err := f.services.db.Delete(&deleted).Error; err != nil {
		t.Fatal(err)
	}
	if err := f.services.db.Model(&model.User{}).Where("id = ?", f.stranger).Update("role", "admin").Error; err != nil {
		t.Fatal(err)
	}
	publicCounts, err := f.services.documents.CountsGlobal(ctx, f.owner, dto.DocumentCountsQuery{})
	if err != nil || publicCounts.Failed != 15 {
		t.Fatalf("document ledger must still include cancelled work: %#v, %v", publicCounts, err)
	}
	for _, actor := range []uuid.UUID{f.owner, f.viewer, f.editor, f.manager, f.stranger} {
		t.Run(actor.String(), func(t *testing.T) {
			res, err := home.Summary(ctx, actor, "month")
			if err != nil {
				t.Fatal(err)
			}
			want := float64(7)
			wantFailures := int64(8)
			if actor == f.stranger {
				want = 0
				wantFailures = 0
			}
			assertHomeProcessingTotal(t, res, want)
			if res.FailedDocumentTotal != wantFailures {
				t.Fatalf("actionable failure total = %d, want %d", res.FailedDocumentTotal, wantFailures)
			}
			for _, row := range res.Documents {
				if row.Status != "completed" || row.KnowledgeBaseID != f.kbID.String() {
					t.Fatalf("recent list leaked or unexpectedly contains older work: %#v", row)
				}
			}
			for _, row := range res.FailedDocuments {
				if row.ErrorCode == "cancelled" || row.JobStatus == "cancelled" || row.KnowledgeBaseID != f.kbID.String() {
					t.Fatalf("failure samples include cancelled or inaccessible work: %#v", row)
				}
			}
			if want > 0 && (len(res.Documents) != HomeSummaryItemLimit || len(res.FailedDocuments) != HomeSummaryItemLimit) {
				t.Fatalf("recent samples = %d/%d, want the server limit", len(res.Documents), len(res.FailedDocuments))
			}
		})
	}
	if err := f.services.db.Where("knowledge_base_id = ? AND user_id = ?", f.kbID, f.viewer).Delete(&model.KnowledgeBaseMember{}).Error; err != nil {
		t.Fatal(err)
	}
	res, err := home.Summary(ctx, f.viewer, "month")
	if err != nil {
		t.Fatal(err)
	}
	assertHomeProcessingTotal(t, res, 0)
	if res.FailedDocumentTotal != 0 || len(res.Documents) != 0 || len(res.FailedDocuments) != 0 {
		t.Fatalf("revoked member still has home work: %#v", res)
	}
}

func assertHomeProcessingTotal(t *testing.T, summary *dto.HomeSummaryResponse, want float64) {
	t.Helper()
	// Read the public shape so this same regression compiles against the old DTO.
	raw, err := json.Marshal(summary)
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]any
	if err := json.Unmarshal(raw, &fields); err != nil {
		t.Fatal(err)
	}
	if got, ok := fields["processingDocumentTotal"].(float64); !ok || got != want {
		t.Fatalf("processingDocumentTotal = %#v, want %.0f", fields["processingDocumentTotal"], want)
	}
}
