package repository

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"testing"

	"github.com/google/uuid"
	"kbchat/backend/internal/model"
)

func TestPostgresReleaseBatchAtomicityAndRecycleScope(t *testing.T) {
	db := newPostgresVectorTestDB(t)
	files, err := filepath.Glob("../../migrations/*.sql")
	if err != nil {
		t.Fatal(err)
	}
	sort.Strings(files)
	for _, file := range files {
		body, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		if err := db.Exec(string(body)).Error; err != nil {
			t.Fatal(err)
		}
	}
	ctx := context.Background()
	owner := model.User{Username: "release-owner", PasswordHash: "fixture", Status: "active", Role: "user"}
	if err := db.Create(&owner).Error; err != nil {
		t.Fatal(err)
	}
	a := model.KnowledgeBase{OwnerID: owner.ID, Name: "first"}
	b := model.KnowledgeBase{OwnerID: owner.ID, Name: "second"}
	for _, kb := range []*model.KnowledgeBase{&a, &b} {
		if err := db.Create(kb).Error; err != nil {
			t.Fatal(err)
		}
	}
	ids := []uuid.UUID{a.ID, b.ID}
	for _, sql := range []string{
		fmt.Sprintf(`CREATE FUNCTION reject_favorite() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF COALESCE(NEW.knowledge_base_id,OLD.knowledge_base_id) = '%s'::uuid THEN RAISE EXCEPTION 'rejected second item'; END IF; RETURN COALESCE(NEW,OLD); END $$`, b.ID),
		`CREATE TRIGGER reject_favorite BEFORE INSERT OR DELETE ON knowledge_base_favorites FOR EACH ROW EXECUTE FUNCTION reject_favorite()`,
	} {
		if err := db.Exec(sql).Error; err != nil {
			t.Fatal(err)
		}
	}
	fav := NewKnowledgeBaseFavoriteRepository(db)
	if err := fav.BatchSet(ctx, owner.ID, ids, true); err == nil {
		t.Fatal("expected insertion rejection")
	}
	var count int64
	if err := db.Model(&model.KnowledgeBaseFavorite{}).Count(&count).Error; err != nil || count != 0 {
		t.Fatalf("partial insert: %d %v", count, err)
	}
	if err := db.Exec("ALTER TABLE knowledge_base_favorites DISABLE TRIGGER reject_favorite").Error; err != nil {
		t.Fatal(err)
	}
	if err := fav.BatchSet(ctx, owner.ID, ids, true); err != nil {
		t.Fatal(err)
	}
	if err := db.Exec("ALTER TABLE knowledge_base_favorites ENABLE TRIGGER reject_favorite").Error; err != nil {
		t.Fatal(err)
	}
	if err := fav.BatchSet(ctx, owner.ID, ids, false); err == nil {
		t.Fatal("expected deletion rejection")
	}
	if err := db.Model(&model.KnowledgeBaseFavorite{}).Count(&count).Error; err != nil || count != 2 {
		t.Fatalf("partial delete: %d %v", count, err)
	}
	category := model.KnowledgeBaseCategory{OwnerID: owner.ID, Name: "target"}
	if err := db.Create(&category).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Exec(fmt.Sprintf(`CREATE FUNCTION reject_category() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id = '%s'::uuid THEN RAISE EXCEPTION 'rejected second item'; END IF; RETURN NEW; END $$`, b.ID)).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Exec(`CREATE TRIGGER reject_category BEFORE UPDATE OF category_id ON knowledge_bases FOR EACH ROW EXECUTE FUNCTION reject_category()`).Error; err != nil {
		t.Fatal(err)
	}
	if err := NewKnowledgeBaseRepository(db).BatchMoveCategory(ctx, owner.ID, ids, &category.ID); err == nil {
		t.Fatal("expected category rejection")
	}
	if err := db.Model(&model.KnowledgeBase{}).Where("category_id IS NOT NULL").Count(&count).Error; err != nil || count != 0 {
		t.Fatalf("partial category move: %d %v", count, err)
	}
	if err := db.Exec(fmt.Sprintf(`CREATE FUNCTION reject_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id = '%s'::uuid THEN RAISE EXCEPTION 'rejected second item'; END IF; RETURN NEW; END $$`, b.ID)).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Exec(`CREATE TRIGGER reject_delete BEFORE UPDATE OF deleted_at ON knowledge_bases FOR EACH ROW EXECUTE FUNCTION reject_delete()`).Error; err != nil {
		t.Fatal(err)
	}
	if err := NewKnowledgeBaseRepository(db).BatchDelete(ctx, ids); err == nil {
		t.Fatal("expected delete rejection")
	}
	if err := db.Model(&model.KnowledgeBase{}).Where("id IN ?", ids).Count(&count).Error; err != nil || count != 2 {
		t.Fatalf("partial soft delete: %d %v", count, err)
	}
	doc := model.Document{KnowledgeBaseID: a.ID, UploaderID: owner.ID, Filename: "retained.md", FileType: "md", StoragePath: "retained.md", Status: "completed"}
	if err := db.Create(&doc).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Delete(&doc).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Delete(&a).Error; err != nil {
		t.Fatal(err)
	}
	docs := NewDocumentRepository(db)
	if err := docs.EmptyDeletedForActor(ctx, owner.ID, nil); err != nil {
		t.Fatal(err)
	}
	if err := db.Unscoped().Model(&model.Document{}).Where("id = ?", doc.ID).Count(&count).Error; err != nil || count != 1 {
		t.Fatalf("purged inaccessible document: %d %v", count, err)
	}
	if _, total, err := docs.ListDeletedForActor(ctx, owner.ID, nil, 1, 20); err != nil || total != 0 {
		t.Fatalf("deleted base listed: %d %v", total, err)
	}
	if err := db.Model(&model.StorageCleanupJob{}).Count(&count).Error; err != nil || count != 0 {
		t.Fatalf("unexpected cleanup: %d %v", count, err)
	}
}
