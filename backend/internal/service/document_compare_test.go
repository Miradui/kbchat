package service

import (
	"context"
	"github.com/google/uuid"
	"kbchat/backend/internal/model"
	"strings"
	"testing"
	"time"
)

func TestDocumentVersionCompareChainPermissionsAndText(t *testing.T) {
	f := newWorkspaceTestServices(t)
	ctx := context.Background()
	owner := createWorkspaceUser(t, f.db, "diff-owner")
	other := createWorkspaceUser(t, f.db, "diff-other")
	kb := createWorkspaceKB(t, f.db, owner.ID, uuid.Nil, "versions", "private", time.Now())
	old, err := f.documents.Upload(ctx, owner.ID, kb.ID, createUploadFile(t, "v1.md", "# 制度\n旧条款\n保持\n"))
	if err != nil {
		t.Fatal(err)
	}
	next, err := f.documents.Replace(ctx, owner.ID, uuid.MustParse(old.ID), createUploadFile(t, "v2.md", "# 制度\n新条款\n保持\n增加"))
	if err != nil {
		t.Fatal(err)
	}
	if err = f.db.Model(&model.Document{}).Where("knowledge_base_id = ?", kb.ID).Update("status", "completed").Error; err != nil {
		t.Fatal(err)
	}
	versions, err := f.documents.Versions(ctx, owner.ID, uuid.MustParse(next.ID))
	if err != nil || len(versions.Items) != 2 {
		t.Fatalf("chain: %+v %v", versions, err)
	}
	diff, err := f.documents.Compare(ctx, owner.ID, uuid.MustParse(old.ID), uuid.MustParse(next.ID))
	if err != nil || diff.AddedLines != 2 || diff.RemovedLines != 1 {
		t.Fatalf("diff: %+v %v", diff, err)
	}
	if diff.Lines[1].Kind != "remove" || *diff.Lines[1].BaseLine != 2 {
		t.Fatalf("line numbers: %+v", diff.Lines)
	}
	_, err = f.documents.Compare(ctx, other.ID, uuid.MustParse(old.ID), uuid.MustParse(next.ID))
	assertAppError(t, err, "DOCUMENT_NOT_FOUND")
	unrelated, err := f.documents.Upload(ctx, owner.ID, kb.ID, createUploadFile(t, "unrelated.txt", "other"))
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.documents.Compare(ctx, owner.ID, uuid.MustParse(unrelated.ID), uuid.MustParse(next.ID))
	assertAppError(t, err, "VALIDATION_ERROR")
	if err = f.db.Delete(&model.Document{}, "id = ?", old.ID).Error; err != nil {
		t.Fatal(err)
	}
	versions, err = f.documents.Versions(ctx, owner.ID, uuid.MustParse(next.ID))
	if err != nil || len(versions.Items) != 1 {
		t.Fatalf("deleted version: %+v %v", versions, err)
	}
	_, err = f.documents.Compare(ctx, owner.ID, uuid.MustParse(old.ID), uuid.MustParse(next.ID))
	assertAppError(t, err, "DOCUMENT_NOT_FOUND")
}
func TestDocumentCompareLimitsAndStableRepeatedLines(t *testing.T) {
	ctx := context.Background()
	lines, add, remove, err := diffDocumentLines(ctx, []string{"重复", "删除", "重复"}, []string{"重复", "重复", "新增"})
	if err != nil || add != 1 || remove != 1 || len(lines) != 4 || lines[1].Content != "删除" {
		t.Fatalf("diff: %+v %d %d %v", lines, add, remove, err)
	}
	_, _, _, err = diffDocumentLines(ctx, strings.Split(strings.Repeat("a\n", maxCompareLines), "\n"), nil)
	assertAppError(t, err, "DOCUMENT_COMPARE_TOO_LARGE")
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	_, _, _, err = diffDocumentLines(cancelled, []string{"a"}, []string{"b"})
	if err != context.Canceled {
		t.Fatalf("cancellation: %v", err)
	}
}
