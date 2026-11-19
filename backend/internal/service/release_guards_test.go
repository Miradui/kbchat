package service

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/google/uuid"
	"kbchat/backend/internal/dto"
	"kbchat/backend/internal/model"
)

func TestBatchWorkspaceWritesRollBackOnLaterFailure(t *testing.T) {
	for _, operation := range []string{"favorite", "unfavorite", "category", "delete"} {
		t.Run(operation, func(t *testing.T) {
			ctx := context.Background()
			s := newWorkspaceTestServices(t)
			owner := createWorkspaceUser(t, s.db, "owner")
			a := createWorkspaceCategory(t, s.db, owner.ID, "a")
			b := createWorkspaceCategory(t, s.db, owner.ID, "b")
			first := createWorkspaceKB(t, s.db, owner.ID, a.ID, "first", "private", time.Now())
			second := createWorkspaceKB(t, s.db, owner.ID, a.ID, "second", "private", time.Now())
			ids := []uuid.UUID{first.ID, second.ID}
			if operation == "unfavorite" {
				if _, err := s.kbs.BatchSetFavorite(ctx, owner.ID, dto.KnowledgeBaseBatchFavoriteRequest{KnowledgeBaseIDs: ids, Favorite: true}); err != nil {
					t.Fatal(err)
				}
			}
			trigger := fmt.Sprintf(`CREATE TRIGGER reject_second BEFORE INSERT ON knowledge_base_favorites WHEN NEW.knowledge_base_id = '%s' BEGIN SELECT RAISE(ABORT, 'second write rejected'); END`, second.ID)
			if operation == "unfavorite" {
				trigger = fmt.Sprintf(`CREATE TRIGGER reject_second BEFORE DELETE ON knowledge_base_favorites WHEN OLD.knowledge_base_id = '%s' BEGIN SELECT RAISE(ABORT, 'second write rejected'); END`, second.ID)
			}
			if operation == "category" {
				trigger = fmt.Sprintf(`CREATE TRIGGER reject_second BEFORE UPDATE OF category_id ON knowledge_bases WHEN NEW.id = '%s' BEGIN SELECT RAISE(ABORT, 'second write rejected'); END`, second.ID)
			}
			if operation == "delete" {
				trigger = fmt.Sprintf(`CREATE TRIGGER reject_second BEFORE UPDATE OF deleted_at ON knowledge_bases WHEN NEW.id = '%s' BEGIN SELECT RAISE(ABORT, 'second write rejected'); END`, second.ID)
			}
			if err := s.db.Exec(trigger).Error; err != nil {
				t.Fatal(err)
			}
			var err error
			if operation == "category" {
				_, err = s.kbs.BatchMoveCategory(ctx, owner.ID, dto.KnowledgeBaseBatchMoveCategoryRequest{KnowledgeBaseIDs: ids, CategoryID: &b.ID})
			} else if operation == "delete" {
				_, err = s.kbs.BatchDelete(ctx, owner.ID, dto.KnowledgeBaseBatchRequest{KnowledgeBaseIDs: ids})
			} else {
				_, err = s.kbs.BatchSetFavorite(ctx, owner.ID, dto.KnowledgeBaseBatchFavoriteRequest{KnowledgeBaseIDs: ids, Favorite: operation == "favorite"})
			}
			if err == nil {
				t.Fatal("expected later write failure")
			}
			if operation == "category" || operation == "delete" {
				var unchanged int64
				if err := s.db.Model(&model.KnowledgeBase{}).Where("id IN ? AND category_id = ?", ids, a.ID).Count(&unchanged).Error; err != nil {
					t.Fatal(err)
				}
				if unchanged != 2 {
					t.Fatalf("partial %s change: %d unchanged", operation, unchanged)
				}
			} else {
				var count int64
				if err := s.db.Model(&model.KnowledgeBaseFavorite{}).Where("user_id = ?", owner.ID).Count(&count).Error; err != nil {
					t.Fatal(err)
				}
				want := int64(0)
				if operation == "unfavorite" {
					want = 2
				}
				if count != want {
					t.Fatalf("partial favorite change: got %d want %d", count, want)
				}
			}
		})
	}
}

func TestDocumentRecycleBinExcludesDeletedKnowledgeBases(t *testing.T) {
	for _, actorName := range []string{"owner", "manager"} {
		t.Run(actorName, func(t *testing.T) {
			ctx := context.Background()
			f := newDocumentAccessFixture(t)
			s := f.services
			actor := f.owner
			if actorName == "manager" {
				actor = f.manager
			}
			if err := s.documents.Delete(ctx, f.owner, f.document); err != nil {
				t.Fatal(err)
			}
			if err := s.db.Model(&model.KnowledgeBase{}).Where("id = ?", f.kbID).Update("deleted_at", time.Now()).Error; err != nil {
				t.Fatal(err)
			}
			bin, err := s.documents.ListRecycleBin(ctx, actor, 1, 20)
			if err != nil {
				t.Fatal(err)
			}
			if bin.Total != 0 {
				t.Fatalf("deleted knowledge base leaked %d recycled documents", bin.Total)
			}
			if err := s.documents.EmptyRecycleBin(ctx, actor); err != nil {
				t.Fatal(err)
			}
			var retained int64
			if err := s.db.Unscoped().Model(&model.Document{}).Where("id = ?", f.document).Count(&retained).Error; err != nil {
				t.Fatal(err)
			}
			if retained != 1 {
				t.Fatal("purged a document from a deleted knowledge base")
			}
			var cleanup int64
			if err := s.db.Model(&model.StorageCleanupJob{}).Count(&cleanup).Error; err != nil {
				t.Fatal(err)
			}
			if cleanup != 0 {
				t.Fatal("enqueued cleanup for inaccessible data")
			}
			if err := s.db.Unscoped().Model(&model.KnowledgeBase{}).Where("id = ?", f.kbID).Update("deleted_at", nil).Error; err != nil {
				t.Fatal(err)
			}
			bin, err = s.documents.ListRecycleBin(ctx, actor, 1, 20)
			if err != nil || bin.Total != 1 {
				t.Fatalf("restored base should reveal retained document: %+v %v", bin, err)
			}
		})
	}
}
