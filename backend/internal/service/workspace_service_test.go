package service

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"

	"kbchat/backend/internal/apperror"
	"kbchat/backend/internal/config"
	"kbchat/backend/internal/dto"
	"kbchat/backend/internal/model"
	"kbchat/backend/internal/repository"
	"kbchat/backend/internal/retrieval"
	"kbchat/backend/internal/storage"
)

type workspaceTestServices struct {
	db         *gorm.DB
	uploadRoot string
	auth       *AuthService
	users      *UserService
	kbs        *KnowledgeBaseService
	chats      *ChatService
	categories *KnowledgeBaseCategoryService
	tags       *KnowledgeBaseTagService
	documents  *DocumentService
	search     *GlobalSearchService
	retrieval  *retrieval.Service
}

func newWorkspaceTestServices(t *testing.T) workspaceTestServices {
	t.Helper()

	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatalf("open sqlite db: %v", err)
	}
	if err := db.AutoMigrate(
		&model.User{},
		&model.UserAvatar{},
		&model.KnowledgeBase{},
		&model.KnowledgeBaseMember{},
		&model.KnowledgeBaseCategory{},
		&model.KnowledgeBaseWorkspacePreference{},
		&model.KnowledgeBaseTag{},
		&model.KnowledgeBaseTagBinding{},
		&model.KnowledgeBaseFavorite{},
		&model.KnowledgeBaseViewEvent{},
		&model.Document{},
		&model.DocumentJob{},
		&model.StorageCleanupJob{},
		&model.ChatSession{},
		&model.ChatMessage{},
		&model.DocumentChunk{},
	); err != nil {
		t.Fatalf("auto migrate: %v", err)
	}
	// AutoMigrate drops the WHERE clause of the partial index from
	// migrations/018_chat_message_intent_and_retrieval_query.sql, so create it
	// explicitly: it is what keeps rewrite-cluster lookups off conversation and
	// unclassified answers.
	if err := db.Exec(`
		CREATE INDEX IF NOT EXISTS idx_chat_messages_retrieval_query_norm
		ON chat_messages(session_id, retrieval_query_norm)
		WHERE role = 'assistant' AND retrieval_query_norm IS NOT NULL
	`).Error; err != nil {
		t.Fatalf("create chat message retrieval query index: %v", err)
	}

	kbRepo := repository.NewKnowledgeBaseRepository(db)
	categoryRepo := repository.NewKnowledgeBaseCategoryRepository(db)
	tagRepo := repository.NewKnowledgeBaseTagRepository(db)
	tagBindingRepo := repository.NewKnowledgeBaseTagBindingRepository(db)
	memberRepo := repository.NewKnowledgeBaseMemberRepository(db)
	favoriteRepo := repository.NewKnowledgeBaseFavoriteRepository(db)
	viewRepo := repository.NewKnowledgeBaseViewRepository(db)
	preferenceRepo := repository.NewKnowledgeBaseWorkspacePreferenceRepository(db)
	documentRepo := repository.NewDocumentRepository(db)
	storageCleanupRepo := repository.NewStorageCleanupRepository(db)
	chunkRepo := repository.NewChunkRepository(db)
	searchRepo := repository.NewGlobalSearchRepository(db)
	chatRepo := repository.NewChatRepository(db)
	userRepo := repository.NewUserRepository(db)
	uploadRoot := t.TempDir()

	kbService := NewKnowledgeBaseService(kbRepo, categoryRepo, favoriteRepo, viewRepo, preferenceRepo, tagRepo, tagBindingRepo, memberRepo, userRepo)
	return workspaceTestServices{
		retrieval: retrieval.NewService(
			config.Config{VectorTopN: 30, RerankTopK: 5},
			chunkRepo,
			kbRepo,
			unavailableEmbedder{},
			nil,
		),
		db:         db,
		uploadRoot: uploadRoot,
		auth:       NewAuthService(config.Config{JWTSecret: strings.Repeat("test-secret-", 4), JWTExpiresIn: "24h"}, userRepo),
		users:      NewUserService(userRepo),
		kbs:        kbService,
		chats:      NewChatService(config.Config{ChatHistoryLimit: 10}, chatRepo, kbRepo, nil, nil, nil),
		categories: NewKnowledgeBaseCategoryService(categoryRepo, kbRepo),
		tags:       NewKnowledgeBaseTagService(tagRepo, tagBindingRepo),
		documents:  NewDocumentService(config.Config{MaxUploadSizeMB: 50}, documentRepo, chunkRepo, kbRepo, storageCleanupRepo, storage.NewLocalStorage(uploadRoot)),
		search:     NewGlobalSearchService(searchRepo),
	}
}

// unavailableEmbedder makes every retrieval attempt fail after authorization.
//
// The access tests need to know whether the authorization check let a call through,
// not what retrieval returned; a provider that always fails means reaching the
// provider is itself the evidence. Wiring a working embedder would mean stubbing
// vector search too, for a result no test asserts on.
type unavailableEmbedder struct{}

func (unavailableEmbedder) EmbedTexts(context.Context, []string) ([][]float32, error) {
	return nil, errors.New("embedding provider not configured in tests")
}

func TestKnowledgeBaseWorkspacePreferenceDefaultsAndPersistedUpdate(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, services.db, "owner")
	categoryA := createWorkspaceCategory(t, services.db, owner.ID, "product")
	categoryB := createWorkspaceCategory(t, services.db, owner.ID, "manual")

	defaults, err := services.kbs.GetWorkspacePreference(ctx, owner.ID)
	if err != nil {
		t.Fatalf("get default workspace preference: %v", err)
	}
	if defaults.ViewMode != "table" || defaults.Scope != "all" || defaults.Sort != "updatedAt_desc" || defaults.Visibility != "all" {
		t.Fatalf("unexpected default workspace preference: %#v", defaults)
	}
	if len(defaults.ExpandedCategoryIDs) != 0 {
		t.Fatalf("expected empty expanded categories by default, got %#v", defaults.ExpandedCategoryIDs)
	}

	updated, err := services.kbs.UpdateWorkspacePreference(ctx, owner.ID, dto.KnowledgeBaseWorkspacePreferenceRequest{
		ViewMode:            "card",
		Scope:               "favorite",
		Sort:                "name_asc",
		Visibility:          "public",
		ExpandedCategoryIDs: []uuid.UUID{categoryB.ID, categoryA.ID, categoryB.ID},
	})
	if err != nil {
		t.Fatalf("update workspace preference: %v", err)
	}
	if updated.ViewMode != "card" || updated.Scope != "favorite" || updated.Sort != "name_asc" || updated.Visibility != "public" {
		t.Fatalf("unexpected updated workspace preference: %#v", updated)
	}
	if len(updated.ExpandedCategoryIDs) != 2 || updated.ExpandedCategoryIDs[0] != categoryB.ID.String() || updated.ExpandedCategoryIDs[1] != categoryA.ID.String() {
		t.Fatalf("expected deduped expanded categories, got %#v", updated.ExpandedCategoryIDs)
	}

	reloaded, err := services.kbs.GetWorkspacePreference(ctx, owner.ID)
	if err != nil {
		t.Fatalf("reload workspace preference: %v", err)
	}
	if reloaded.ViewMode != "card" || reloaded.Scope != "favorite" || reloaded.Sort != "name_asc" || reloaded.Visibility != "public" {
		t.Fatalf("expected persisted workspace preference, got %#v", reloaded)
	}
}

func TestKnowledgeBaseWorkspacePreferenceRejectsInvalidOptionsAndForeignCategory(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, services.db, "owner")
	other := createWorkspaceUser(t, services.db, "other")
	foreignCategory := createWorkspaceCategory(t, services.db, other.ID, "foreign")

	if _, err := services.kbs.UpdateWorkspacePreference(ctx, owner.ID, dto.KnowledgeBaseWorkspacePreferenceRequest{
		ViewMode: "board",
	}); err == nil {
		t.Fatalf("expected invalid view mode to be rejected")
	}

	if _, err := services.kbs.UpdateWorkspacePreference(ctx, owner.ID, dto.KnowledgeBaseWorkspacePreferenceRequest{
		ViewMode:            "table",
		ExpandedCategoryIDs: []uuid.UUID{foreignCategory.ID},
	}); err == nil {
		t.Fatalf("expected foreign expanded category to be rejected")
	}

	reloaded, err := services.kbs.GetWorkspacePreference(ctx, owner.ID)
	if err != nil {
		t.Fatalf("reload workspace preference after rejected update: %v", err)
	}
	if reloaded.ViewMode != "table" || reloaded.Scope != "all" || reloaded.Sort != "updatedAt_desc" || reloaded.Visibility != "all" || len(reloaded.ExpandedCategoryIDs) != 0 {
		t.Fatalf("expected rejected updates to leave defaults untouched, got %#v", reloaded)
	}
}

func TestKnowledgeBaseCategoriesRejectCrossOwnerParentAndNonEmptyDelete(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, services.db, "owner")
	other := createWorkspaceUser(t, services.db, "other")

	parent, err := services.categories.Create(ctx, owner.ID, dto.KnowledgeBaseCategoryRequest{
		Name:      "product-docs",
		SortOrder: 10,
	})
	if err != nil {
		t.Fatalf("create owner category: %v", err)
	}
	foreignParent, err := services.categories.Create(ctx, other.ID, dto.KnowledgeBaseCategoryRequest{
		Name: "other-category",
	})
	if err != nil {
		t.Fatalf("create foreign category: %v", err)
	}

	if _, err := services.categories.Create(ctx, owner.ID, dto.KnowledgeBaseCategoryRequest{
		Name:     "invalid-child",
		ParentID: &foreignParent.ID,
	}); err == nil {
		t.Fatalf("expected cross-owner parent category to be rejected")
	}

	child, err := services.categories.Create(ctx, owner.ID, dto.KnowledgeBaseCategoryRequest{
		Name:     "guides",
		ParentID: &parent.ID,
	})
	if err != nil {
		t.Fatalf("create child category: %v", err)
	}

	tree, err := services.categories.ListTree(ctx, owner.ID)
	if err != nil {
		t.Fatalf("list category tree: %v", err)
	}
	if len(tree.Items) != 1 || len(tree.Items[0].Children) != 1 || tree.Items[0].Children[0].ID != child.ID {
		t.Fatalf("expected owned category tree with child, got %#v", tree.Items)
	}

	if err := services.categories.Delete(ctx, owner.ID, parent.ID); err == nil {
		t.Fatalf("expected non-empty category deletion to be rejected")
	}
}

func TestKnowledgeBaseCategoriesReorderTree(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, services.db, "owner")
	rootA := createWorkspaceCategory(t, services.db, owner.ID, "root-a")
	rootB := createWorkspaceCategory(t, services.db, owner.ID, "root-b")
	childA := createWorkspaceCategory(t, services.db, owner.ID, "child-a")
	if err := services.db.Model(&childA).Update("parent_id", rootA.ID).Error; err != nil {
		t.Fatalf("attach child to root A: %v", err)
	}

	res, err := services.categories.Reorder(ctx, owner.ID, dto.KnowledgeBaseCategoryReorderRequest{
		Items: []dto.KnowledgeBaseCategoryReorderItem{
			{ID: rootB.ID, ParentID: nil, SortOrder: 10},
			{ID: rootA.ID, ParentID: &rootB.ID, SortOrder: 20},
			{ID: childA.ID, ParentID: &rootA.ID, SortOrder: 30},
		},
	})
	if err != nil {
		t.Fatalf("reorder category tree: %v", err)
	}
	if res.ProcessedCount != 3 {
		t.Fatalf("expected 3 processed categories, got %#v", res)
	}

	tree, err := services.categories.ListTree(ctx, owner.ID)
	if err != nil {
		t.Fatalf("list tree after reorder: %v", err)
	}
	if len(tree.Items) != 1 || tree.Items[0].ID != rootB.ID {
		t.Fatalf("expected root-b as only root after reorder, got %#v", tree.Items)
	}
	if len(tree.Items[0].Children) != 1 || tree.Items[0].Children[0].ID != rootA.ID {
		t.Fatalf("expected root-a moved under root-b, got %#v", tree.Items[0].Children)
	}
	if len(tree.Items[0].Children[0].Children) != 1 || tree.Items[0].Children[0].Children[0].ID != childA.ID {
		t.Fatalf("expected child-a retained under root-a, got %#v", tree.Items[0].Children[0].Children)
	}
}

func TestKnowledgeBaseCategoriesReorderRejectsForeignParentAndMissingOwnerCoverage(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, services.db, "owner")
	other := createWorkspaceUser(t, services.db, "other")
	rootA := createWorkspaceCategory(t, services.db, owner.ID, "root-a")
	rootB := createWorkspaceCategory(t, services.db, owner.ID, "root-b")
	foreignRoot := createWorkspaceCategory(t, services.db, other.ID, "foreign-root")

	if _, err := services.categories.Reorder(ctx, owner.ID, dto.KnowledgeBaseCategoryReorderRequest{
		Items: []dto.KnowledgeBaseCategoryReorderItem{
			{ID: rootA.ID, ParentID: &foreignRoot.ID, SortOrder: 10},
			{ID: rootB.ID, ParentID: nil, SortOrder: 20},
		},
	}); err == nil {
		t.Fatalf("expected foreign parent to be rejected")
	}

	afterForeignReject, err := services.categories.ListTree(ctx, owner.ID)
	if err != nil {
		t.Fatalf("list tree after foreign reject: %v", err)
	}
	if len(afterForeignReject.Items) != 2 {
		t.Fatalf("expected no partial mutation after foreign reject, got %#v", afterForeignReject.Items)
	}

	if _, err := services.categories.Reorder(ctx, owner.ID, dto.KnowledgeBaseCategoryReorderRequest{
		Items: []dto.KnowledgeBaseCategoryReorderItem{
			{ID: rootA.ID, ParentID: &rootB.ID, SortOrder: 10},
		},
	}); err == nil {
		t.Fatalf("expected reorder to require complete owner tree coverage")
	}

	afterCoverageReject, err := services.categories.ListTree(ctx, owner.ID)
	if err != nil {
		t.Fatalf("list tree after coverage reject: %v", err)
	}
	if len(afterCoverageReject.Items) != 2 {
		t.Fatalf("expected no partial mutation after coverage reject, got %#v", afterCoverageReject.Items)
	}
}

func TestKnowledgeBaseWorkspaceListFiltersFavoritesAndRecent(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, services.db, "owner")
	other := createWorkspaceUser(t, services.db, "other")
	category := createWorkspaceCategory(t, services.db, owner.ID, "product-docs")
	favoriteKB := createWorkspaceKB(t, services.db, owner.ID, category.ID, "product-kb", "public", time.Now().Add(-2*time.Hour))
	recentKB := createWorkspaceKB(t, services.db, owner.ID, category.ID, "tech-kb", "private", time.Now().Add(-1*time.Hour))
	foreignKB := createWorkspaceKB(t, services.db, other.ID, uuid.Nil, "foreign-kb", "public", time.Now())
	createWorkspaceDocument(t, services.db, favoriteKB.ID, owner.ID, "manual.pdf", "completed")
	createWorkspaceQuestion(t, services.db, favoriteKB.ID, owner.ID, "how to use product?")
	createWorkspaceQuestion(t, services.db, foreignKB.ID, other.ID, "should not count")

	if err := services.kbs.SetFavorite(ctx, owner.ID, favoriteKB.ID, true); err != nil {
		t.Fatalf("favorite knowledge base: %v", err)
	}
	if err := services.kbs.RecordView(ctx, owner.ID, recentKB.ID); err != nil {
		t.Fatalf("record recent view: %v", err)
	}
	if err := services.kbs.RecordView(ctx, owner.ID, recentKB.ID); err != nil {
		t.Fatalf("record second recent view: %v", err)
	}
	if err := services.kbs.RecordView(ctx, owner.ID, favoriteKB.ID); err != nil {
		t.Fatalf("record favorite view: %v", err)
	}

	favoriteList, err := services.kbs.ListWorkspace(ctx, owner.ID, dto.KnowledgeBaseListQuery{
		Scope:    "favorite",
		Page:     1,
		PageSize: 10,
	})
	if err != nil {
		t.Fatalf("list favorites: %v", err)
	}
	if favoriteList.Total != 1 || favoriteList.Items[0].ID != favoriteKB.ID.String() {
		t.Fatalf("expected only favorite knowledge base, got %#v", favoriteList)
	}
	if !favoriteList.Items[0].IsFavorite || favoriteList.Items[0].DocumentCount != 1 || favoriteList.Items[0].QuestionCount != 1 {
		t.Fatalf("expected aggregate fields on favorite item, got %#v", favoriteList.Items[0])
	}

	recentList, err := services.kbs.ListWorkspace(ctx, owner.ID, dto.KnowledgeBaseListQuery{
		Scope:    "recent",
		Page:     1,
		PageSize: 10,
	})
	if err != nil {
		t.Fatalf("list recent: %v", err)
	}
	if recentList.Total != 2 {
		t.Fatalf("expected two recently viewed owned knowledge bases, got %#v", recentList)
	}
	for _, item := range recentList.Items {
		if item.ID == foreignKB.ID.String() {
			t.Fatalf("recent list leaked foreign knowledge base: %#v", recentList.Items)
		}
		if item.LastViewedAt == nil {
			t.Fatalf("recent item should expose lastViewedAt: %#v", item)
		}
	}
}

func TestKnowledgeBaseWorkspaceUsesStoredUpdatedBy(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, services.db, "owner")
	editor := createWorkspaceUser(t, services.db, "editor")
	category := createWorkspaceCategory(t, services.db, owner.ID, "product-docs")
	kb := createWorkspaceKB(t, services.db, owner.ID, category.ID, "product-kb", "private", time.Now().Add(-3*time.Hour))

	updatedAt := time.Now().Add(-2 * time.Hour)
	if err := services.db.Exec(
		"UPDATE knowledge_bases SET updated_by_id = ?, updated_at = ? WHERE id = ?",
		editor.ID,
		updatedAt,
		kb.ID,
	).Error; err != nil {
		t.Fatalf("seed updated_by_id: %v", err)
	}

	list, err := services.kbs.ListWorkspace(ctx, owner.ID, dto.KnowledgeBaseListQuery{
		Page:     1,
		PageSize: 10,
	})
	if err != nil {
		t.Fatalf("list workspace: %v", err)
	}
	if len(list.Items) != 1 {
		t.Fatalf("expected one workspace item, got %#v", list.Items)
	}
	if list.Items[0].UpdatedBy == nil || list.Items[0].UpdatedBy.ID != editor.ID.String() {
		t.Fatalf("expected workspace list to use stored updatedBy, got %#v", list.Items[0].UpdatedBy)
	}

	detail, err := services.kbs.Get(ctx, owner.ID, kb.ID)
	if err != nil {
		t.Fatalf("get knowledge base: %v", err)
	}
	if detail.UpdatedBy == nil || detail.UpdatedBy.ID != editor.ID.String() {
		t.Fatalf("expected detail to use stored updatedBy, got %#v", detail.UpdatedBy)
	}
}

func TestKnowledgeBaseWorkspaceUploadTouchesUpdatedBy(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, services.db, "owner")
	editor := createWorkspaceUser(t, services.db, "editor")
	category := createWorkspaceCategory(t, services.db, owner.ID, "product-docs")

	created, err := services.kbs.Create(ctx, owner.ID, dto.KnowledgeBaseRequest{
		Name:        "product-kb",
		Description: "documents entry",
		CategoryID:  &category.ID,
		Visibility:  "private",
	})
	if err != nil {
		t.Fatalf("create knowledge base: %v", err)
	}

	oldUpdatedAt := time.Now().Add(-4 * time.Hour)
	kbID := mustParseUUID(t, created.ID)
	if err := services.db.Exec(
		"UPDATE knowledge_bases SET updated_by_id = ?, updated_at = ? WHERE id = ?",
		editor.ID,
		oldUpdatedAt,
		kbID,
	).Error; err != nil {
		t.Fatalf("seed old updater: %v", err)
	}

	file := createUploadFile(t, "manual.txt", "hello workspace")
	if _, err := services.documents.Upload(ctx, owner.ID, kbID, file); err != nil {
		t.Fatalf("upload document: %v", err)
	}

	detail, err := services.kbs.Get(ctx, owner.ID, kbID)
	if err != nil {
		t.Fatalf("get knowledge base after upload: %v", err)
	}
	if detail.UpdatedBy == nil || detail.UpdatedBy.ID != owner.ID.String() {
		t.Fatalf("expected upload to retouch updatedBy as owner, got %#v", detail.UpdatedBy)
	}
	if !detail.UpdatedAt.After(oldUpdatedAt) {
		t.Fatalf("expected upload to advance updatedAt beyond %s, got %s", oldUpdatedAt, detail.UpdatedAt)
	}
}

func TestKnowledgeBaseWorkspaceUploadRollsBackWhenTouchFails(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, services.db, "upload-rollback-owner")
	kb := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "upload-rollback-kb", "private", time.Now())
	if err := services.db.Exec(`
		CREATE TRIGGER fail_upload_kb_touch
		BEFORE UPDATE ON knowledge_bases
		BEGIN
			SELECT RAISE(FAIL, 'touch failed');
		END
	`).Error; err != nil {
		t.Fatalf("create touch failure trigger: %v", err)
	}

	file := createUploadFile(t, "rollback.txt", "must not persist")
	if _, err := services.documents.Upload(ctx, owner.ID, kb.ID, file); err == nil {
		t.Fatal("expected upload to fail when knowledge base touch fails")
	}

	var documentCount int64
	if err := services.db.Model(&model.Document{}).Count(&documentCount).Error; err != nil {
		t.Fatalf("count documents: %v", err)
	}
	var jobCount int64
	if err := services.db.Model(&model.DocumentJob{}).Count(&jobCount).Error; err != nil {
		t.Fatalf("count document jobs: %v", err)
	}
	if documentCount != 0 || jobCount != 0 {
		t.Fatalf("expected database rollback, got documents=%d jobs=%d", documentCount, jobCount)
	}
	files, err := filepath.Glob(filepath.Join(services.uploadRoot, kb.ID.String(), "*"))
	if err != nil {
		t.Fatalf("list uploaded files: %v", err)
	}
	if len(files) != 0 {
		t.Fatalf("expected uploaded file cleanup, got %v", files)
	}
}

func TestKnowledgeBaseWorkspaceUploadReportsCleanupFailure(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, services.db, "upload-cleanup-owner")
	kb := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "upload-cleanup-kb", "private", time.Now())
	if err := services.db.Exec(`
		CREATE TRIGGER fail_upload_kb_touch
		BEFORE UPDATE ON knowledge_bases
		BEGIN
			SELECT RAISE(FAIL, 'touch failed');
		END
	`).Error; err != nil {
		t.Fatalf("create touch failure trigger: %v", err)
	}
	cleanupErr := errors.New("cleanup failed")
	services.documents.storage = &failingCleanupStorage{
		path:      filepath.Join(services.uploadRoot, "orphan.txt"),
		deleteErr: cleanupErr,
	}

	file := createUploadFile(t, "cleanup.txt", "cleanup failure")
	_, err := services.documents.Upload(ctx, owner.ID, kb.ID, file)
	var appErr *apperror.Error
	if !errors.As(err, &appErr) || !errors.Is(appErr.Err, cleanupErr) {
		t.Fatalf("expected cleanup failure in internal cause, got %#v", err)
	}
	var cleanup model.StorageCleanupJob
	if err := services.db.First(&cleanup, "storage_path = ?", filepath.Join(services.uploadRoot, "orphan.txt")).Error; err != nil {
		t.Fatalf("expected failed cleanup to remain durably queued: %v", err)
	}
}

type failingCleanupStorage struct {
	path      string
	deleteErr error
}

func (s *failingCleanupStorage) NewKnowledgeBaseFileLocation(uuid.UUID, string) string {
	return s.path
}

func (s *failingCleanupStorage) SaveKnowledgeBaseFile(context.Context, string, *multipart.FileHeader) error {
	return nil
}

func (s *failingCleanupStorage) Delete(context.Context, string) error {
	return s.deleteErr
}

func (s *failingCleanupStorage) Open(context.Context, string) (io.ReadCloser, storage.ObjectInfo, error) {
	return nil, storage.ObjectInfo{}, errors.New("not implemented")
}

func (s *failingCleanupStorage) Read(context.Context, string) ([]byte, error) {
	return nil, errors.New("not implemented")
}

func (s *failingCleanupStorage) Stat(context.Context, string) (storage.ObjectInfo, error) {
	return storage.ObjectInfo{}, errors.New("not implemented")
}

func (s *failingCleanupStorage) Materialize(context.Context, string) (string, func(), error) {
	return "", nil, errors.New("not implemented")
}

func TestKnowledgeBaseMembersManageRolesAndPermissionsView(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, services.db, "owner")
	manager := createWorkspaceUser(t, services.db, "manager")
	viewer := createWorkspaceUser(t, services.db, "viewer")
	kb := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "product-kb", "private", time.Now())

	createdManager, err := services.kbs.AddMember(ctx, owner.ID, kb.ID, dto.KnowledgeBaseMemberRequest{
		UserID: manager.ID,
		Role:   "manager",
	})
	if err != nil {
		t.Fatalf("add manager: %v", err)
	}
	if createdManager.ID != manager.ID.String() || createdManager.Role != "manager" {
		t.Fatalf("unexpected manager response: %#v", createdManager)
	}
	if _, err := services.kbs.AddMember(ctx, owner.ID, kb.ID, dto.KnowledgeBaseMemberRequest{
		UserID: viewer.ID,
		Role:   "viewer",
	}); err != nil {
		t.Fatalf("add viewer: %v", err)
	}
	// The pre-020 role name is no longer assignable: those rows were rewritten to
	// viewer, and accepting the old name would keep writing a value that resolves
	// to no access at all.
	if _, err := services.kbs.AddMember(ctx, owner.ID, kb.ID, dto.KnowledgeBaseMemberRequest{
		UserID: viewer.ID,
		Role:   "member",
	}); err == nil {
		t.Fatal("expected the legacy \"member\" role to be rejected")
	}

	permissions, err := services.kbs.GetPermissions(ctx, owner.ID, kb.ID)
	if err != nil {
		t.Fatalf("get permissions: %v", err)
	}
	if permissions.KnowledgeBaseID != kb.ID.String() || permissions.Visibility != "private" {
		t.Fatalf("unexpected permission response: %#v", permissions)
	}
	if permissions.Owner.ID != owner.ID.String() {
		t.Fatalf("expected owner in permission response, got %#v", permissions.Owner)
	}
	if len(permissions.Managers) != 2 || permissions.Managers[0].Role != "owner" || permissions.Managers[1].ID != manager.ID.String() {
		t.Fatalf("expected owner and manager in managers, got %#v", permissions.Managers)
	}
	if len(permissions.Members) != 1 || permissions.Members[0].ID != viewer.ID.String() || permissions.Members[0].Role != "viewer" {
		t.Fatalf("expected viewer in permission response, got %#v", permissions.Members)
	}

	updated, err := services.kbs.UpdatePermissions(ctx, manager.ID, kb.ID, dto.KnowledgeBasePermissionUpdateRequest{
		Visibility: "public",
	})
	if err != nil {
		t.Fatalf("manager update permissions: %v", err)
	}
	if updated.Visibility != "public" {
		t.Fatalf("expected visibility update to persist, got %#v", updated)
	}

	if _, err := services.kbs.UpdateMember(ctx, viewer.ID, kb.ID, manager.ID, dto.KnowledgeBaseMemberRoleRequest{Role: "viewer"}); err == nil {
		t.Fatalf("expected a viewer to be rejected from member management")
	}
	if _, err := services.kbs.UpdateMember(ctx, manager.ID, kb.ID, owner.ID, dto.KnowledgeBaseMemberRoleRequest{Role: "viewer"}); err == nil {
		t.Fatalf("expected owner role update to be rejected")
	}
	if err := services.kbs.RemoveMember(ctx, owner.ID, kb.ID, owner.ID); err == nil {
		t.Fatalf("expected owner deletion to be rejected")
	}
	if err := services.kbs.RemoveMember(ctx, manager.ID, kb.ID, viewer.ID); err != nil {
		t.Fatalf("manager remove member: %v", err)
	}
	afterRemove, err := services.kbs.GetPermissions(ctx, owner.ID, kb.ID)
	if err != nil {
		t.Fatalf("get permissions after remove: %v", err)
	}
	if len(afterRemove.Members) != 0 {
		t.Fatalf("expected removed member to disappear, got %#v", afterRemove.Members)
	}
}

func TestKnowledgeBaseBatchFavoriteAndMoveCategory(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, services.db, "owner")
	categoryA := createWorkspaceCategory(t, services.db, owner.ID, "source")
	categoryB := createWorkspaceCategory(t, services.db, owner.ID, "target")
	kbA := createWorkspaceKB(t, services.db, owner.ID, categoryA.ID, "product-a", "private", time.Now())
	kbB := createWorkspaceKB(t, services.db, owner.ID, categoryA.ID, "product-b", "private", time.Now())

	favoriteRes, err := services.kbs.BatchSetFavorite(ctx, owner.ID, dto.KnowledgeBaseBatchFavoriteRequest{
		KnowledgeBaseIDs: []uuid.UUID{kbA.ID, kbB.ID},
		Favorite:         true,
	})
	if err != nil {
		t.Fatalf("batch favorite: %v", err)
	}
	if favoriteRes.ProcessedCount != 2 {
		t.Fatalf("expected 2 processed favorites, got %#v", favoriteRes)
	}

	favorites, err := services.kbs.ListWorkspace(ctx, owner.ID, dto.KnowledgeBaseListQuery{
		Scope:    "favorite",
		Page:     1,
		PageSize: 20,
	})
	if err != nil {
		t.Fatalf("list favorites after batch favorite: %v", err)
	}
	if favorites.Total != 2 {
		t.Fatalf("expected 2 favorites, got %#v", favorites.Items)
	}

	moveRes, err := services.kbs.BatchMoveCategory(ctx, owner.ID, dto.KnowledgeBaseBatchMoveCategoryRequest{
		KnowledgeBaseIDs: []uuid.UUID{kbA.ID, kbB.ID},
		CategoryID:       &categoryB.ID,
	})
	if err != nil {
		t.Fatalf("batch move category: %v", err)
	}
	if moveRes.ProcessedCount != 2 {
		t.Fatalf("expected 2 processed moves, got %#v", moveRes)
	}

	moved, err := services.kbs.ListWorkspace(ctx, owner.ID, dto.KnowledgeBaseListQuery{
		CategoryID: &categoryB.ID,
		Page:       1,
		PageSize:   20,
	})
	if err != nil {
		t.Fatalf("list moved knowledge bases: %v", err)
	}
	if moved.Total != 2 {
		t.Fatalf("expected both knowledge bases moved to target category, got %#v", moved.Items)
	}
}

func TestKnowledgeBaseBatchDeleteAndRestore(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, services.db, "owner")
	kbA := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "product-a", "private", time.Now())
	kbB := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "product-b", "private", time.Now())

	deleteRes, err := services.kbs.BatchDelete(ctx, owner.ID, dto.KnowledgeBaseBatchRequest{
		KnowledgeBaseIDs: []uuid.UUID{kbA.ID, kbB.ID},
	})
	if err != nil {
		t.Fatalf("batch delete: %v", err)
	}
	if deleteRes.ProcessedCount != 2 {
		t.Fatalf("expected 2 processed deletes, got %#v", deleteRes)
	}

	active, err := services.kbs.ListWorkspace(ctx, owner.ID, dto.KnowledgeBaseListQuery{
		Page:     1,
		PageSize: 20,
	})
	if err != nil {
		t.Fatalf("list workspace after batch delete: %v", err)
	}
	if active.Total != 0 {
		t.Fatalf("expected all knowledge bases hidden after batch delete, got %#v", active.Items)
	}

	recycle, err := services.kbs.ListRecycleBin(ctx, owner.ID, 1, 20)
	if err != nil {
		t.Fatalf("list recycle after batch delete: %v", err)
	}
	if recycle.Total != 2 {
		t.Fatalf("expected 2 deleted knowledge bases in recycle bin, got %#v", recycle.Items)
	}

	restoreRes, err := services.kbs.BatchRestore(ctx, owner.ID, dto.KnowledgeBaseBatchRequest{
		KnowledgeBaseIDs: []uuid.UUID{kbA.ID, kbB.ID},
	})
	if err != nil {
		t.Fatalf("batch restore: %v", err)
	}
	if restoreRes.ProcessedCount != 2 {
		t.Fatalf("expected 2 processed restores, got %#v", restoreRes)
	}

	restored, err := services.kbs.ListWorkspace(ctx, owner.ID, dto.KnowledgeBaseListQuery{
		Page:     1,
		PageSize: 20,
	})
	if err != nil {
		t.Fatalf("list workspace after batch restore: %v", err)
	}
	if restored.Total != 2 {
		t.Fatalf("expected all knowledge bases restored, got %#v", restored.Items)
	}
}

func TestKnowledgeBaseBatchOperationsRejectForeignIDsWithoutPartialMutation(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, services.db, "owner")
	other := createWorkspaceUser(t, services.db, "other")
	sourceCategory := createWorkspaceCategory(t, services.db, owner.ID, "source")
	targetCategory := createWorkspaceCategory(t, services.db, owner.ID, "target")
	ownKB := createWorkspaceKB(t, services.db, owner.ID, sourceCategory.ID, "product-a", "private", time.Now())
	foreignKB := createWorkspaceKB(t, services.db, other.ID, uuid.Nil, "foreign-kb", "private", time.Now())

	_, favoriteErr := services.kbs.BatchSetFavorite(ctx, owner.ID, dto.KnowledgeBaseBatchFavoriteRequest{
		KnowledgeBaseIDs: []uuid.UUID{ownKB.ID, foreignKB.ID},
		Favorite:         true,
	})
	if favoriteErr == nil {
		t.Fatalf("expected batch favorite with foreign knowledge base to fail")
	}
	var appErr *apperror.Error
	if !errors.As(favoriteErr, &appErr) || appErr.Message != "知识库不存在" {
		t.Fatalf("expected readable knowledge base not found error, got %v", favoriteErr)
	}

	favorites, err := services.kbs.ListWorkspace(ctx, owner.ID, dto.KnowledgeBaseListQuery{
		Scope:    "favorite",
		Page:     1,
		PageSize: 20,
	})
	if err != nil {
		t.Fatalf("list favorites after rejected batch favorite: %v", err)
	}
	if favorites.Total != 0 {
		t.Fatalf("expected no partial favorite side effect, got %#v", favorites.Items)
	}

	if _, err := services.kbs.BatchMoveCategory(ctx, owner.ID, dto.KnowledgeBaseBatchMoveCategoryRequest{
		KnowledgeBaseIDs: []uuid.UUID{ownKB.ID, foreignKB.ID},
		CategoryID:       &targetCategory.ID,
	}); err == nil {
		t.Fatalf("expected batch move with foreign knowledge base to fail")
	}

	detail, err := services.kbs.Get(ctx, owner.ID, ownKB.ID)
	if err != nil {
		t.Fatalf("get knowledge base after rejected move: %v", err)
	}
	if detail.CategoryID == nil || *detail.CategoryID != sourceCategory.ID.String() {
		t.Fatalf("expected no partial category move, got %#v", detail)
	}

	if _, err := services.kbs.BatchDelete(ctx, owner.ID, dto.KnowledgeBaseBatchRequest{
		KnowledgeBaseIDs: []uuid.UUID{ownKB.ID, foreignKB.ID},
	}); err == nil {
		t.Fatalf("expected batch delete with foreign knowledge base to fail")
	}

	active, err := services.kbs.ListWorkspace(ctx, owner.ID, dto.KnowledgeBaseListQuery{
		Page:     1,
		PageSize: 20,
	})
	if err != nil {
		t.Fatalf("list workspace after rejected delete: %v", err)
	}
	if active.Total != 1 || active.Items[0].ID != ownKB.ID.String() {
		t.Fatalf("expected no partial delete side effect, got %#v", active.Items)
	}

	if err := services.kbs.Delete(ctx, owner.ID, ownKB.ID); err != nil {
		t.Fatalf("delete own knowledge base for restore test: %v", err)
	}
	if err := services.kbs.Delete(ctx, other.ID, foreignKB.ID); err != nil {
		t.Fatalf("delete foreign knowledge base for restore test: %v", err)
	}

	if _, err := services.kbs.BatchRestore(ctx, owner.ID, dto.KnowledgeBaseBatchRequest{
		KnowledgeBaseIDs: []uuid.UUID{ownKB.ID, foreignKB.ID},
	}); err == nil {
		t.Fatalf("expected batch restore with foreign knowledge base to fail")
	}

	recycle, err := services.kbs.ListRecycleBin(ctx, owner.ID, 1, 20)
	if err != nil {
		t.Fatalf("list recycle after rejected restore: %v", err)
	}
	if recycle.Total != 1 || recycle.Items[0].ID != ownKB.ID.String() {
		t.Fatalf("expected own knowledge base to remain deleted after rejected restore, got %#v", recycle.Items)
	}
}

func TestKnowledgeBaseStatsUseOwnerDataOnly(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, services.db, "owner")
	other := createWorkspaceUser(t, services.db, "other")
	ownKB := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "company-policy", "private", time.Now())
	foreignKB := createWorkspaceKB(t, services.db, other.ID, uuid.Nil, "foreign-kb", "private", time.Now())
	createWorkspaceDocument(t, services.db, ownKB.ID, owner.ID, "policy.md", "completed")
	createWorkspaceDocument(t, services.db, foreignKB.ID, other.ID, "foreign.md", "completed")
	createWorkspaceQuestion(t, services.db, ownKB.ID, owner.ID, "what is the policy?")
	createWorkspaceQuestion(t, services.db, foreignKB.ID, other.ID, "should not count")
	if err := services.kbs.RecordView(ctx, owner.ID, ownKB.ID); err != nil {
		t.Fatalf("record owner view: %v", err)
	}

	stats, err := services.kbs.Stats(ctx, owner.ID, "month")
	if err != nil {
		t.Fatalf("load workspace stats: %v", err)
	}

	if stats.KnowledgeBases.Value != 1 || stats.Documents.Value != 1 || stats.Views.Value != 1 || stats.Questions.Value != 1 {
		t.Fatalf("expected stats to include only owner data, got %#v", stats)
	}
}

func TestKnowledgeBaseCountsExcludeSoftDeletedDocumentsAndSessions(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, services.db, "owner")
	kb := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "company-policy", "private", time.Now())
	document := createWorkspaceDocument(t, services.db, kb.ID, owner.ID, "policy.md", "completed")
	session := createWorkspaceChatSession(t, services.db, owner.ID, kb.ID, "policy question")
	message := model.ChatMessage{SessionID: session.ID, Role: "user", Content: "what is the policy?"}
	if err := services.db.Create(&message).Error; err != nil {
		t.Fatalf("create question: %v", err)
	}
	if err := services.documents.Delete(ctx, owner.ID, document.ID); err != nil {
		t.Fatalf("soft delete document: %v", err)
	}
	if err := services.db.Delete(&session).Error; err != nil {
		t.Fatalf("soft delete chat session: %v", err)
	}

	workspace, err := services.kbs.ListWorkspace(ctx, owner.ID, dto.KnowledgeBaseListQuery{Page: 1, PageSize: 20})
	if err != nil {
		t.Fatalf("list workspace: %v", err)
	}
	if len(workspace.Items) != 1 || workspace.Items[0].DocumentCount != 0 || workspace.Items[0].QuestionCount != 0 {
		t.Fatalf("expected deleted resources excluded from workspace counts, got %#v", workspace.Items)
	}

	stats, err := services.kbs.Stats(ctx, owner.ID, "month")
	if err != nil {
		t.Fatalf("load workspace stats: %v", err)
	}
	if stats.Documents.Value != 0 || stats.Questions.Value != 0 {
		t.Fatalf("expected deleted resources excluded from stats, got %#v", stats)
	}
}

func TestKnowledgeBaseWorkspaceReturnsDocumentReadinessCounts(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, services.db, "owner")
	kb := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "company-policy", "private", time.Now())
	createWorkspaceDocument(t, services.db, kb.ID, owner.ID, "ready.pdf", "completed")
	createWorkspaceDocument(t, services.db, kb.ID, owner.ID, "queued.pdf", "uploaded")
	createWorkspaceDocument(t, services.db, kb.ID, owner.ID, "parsing.pdf", "parsing")
	createWorkspaceDocument(t, services.db, kb.ID, owner.ID, "failed.pdf", "failed")
	deleted := createWorkspaceDocument(t, services.db, kb.ID, owner.ID, "deleted.pdf", "completed")
	if err := services.db.Delete(&deleted).Error; err != nil {
		t.Fatalf("soft delete document: %v", err)
	}
	createWorkspaceQuestion(t, services.db, kb.ID, owner.ID, "what is the policy?")
	if err := services.kbs.RecordView(ctx, owner.ID, kb.ID); err != nil {
		t.Fatalf("record knowledge base view: %v", err)
	}

	workspace, err := services.kbs.ListWorkspace(ctx, owner.ID, dto.KnowledgeBaseListQuery{Page: 1, PageSize: 20})
	if err != nil {
		t.Fatalf("list workspace: %v", err)
	}
	if len(workspace.Items) != 1 || workspace.Items[0].DocumentCount != 4 {
		t.Fatalf("expected four active documents, got %#v", workspace.Items)
	}
	payload, err := json.Marshal(workspace.Items[0])
	if err != nil {
		t.Fatalf("marshal workspace item: %v", err)
	}
	var item map[string]any
	if err := json.Unmarshal(payload, &item); err != nil {
		t.Fatalf("unmarshal workspace item: %v", err)
	}
	for field, expected := range map[string]float64{
		"completedDocumentCount":  1,
		"processingDocumentCount": 2,
		"failedDocumentCount":     1,
	} {
		if item[field] != expected {
			t.Fatalf("expected %s=%v, got %#v", field, expected, item[field])
		}
	}
}

func TestKnowledgeBaseMutationAndDetailResponsesOmitListOnlyDocumentReadinessCounts(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, services.db, "owner")
	created, err := services.kbs.Create(ctx, owner.ID, dto.KnowledgeBaseRequest{
		Name:       "company-policy",
		Visibility: "private",
	})
	if err != nil {
		t.Fatalf("create knowledge base: %v", err)
	}
	kbID := mustParseUUID(t, created.ID)
	createWorkspaceDocument(t, services.db, kbID, owner.ID, "ready.pdf", "completed")

	updated, err := services.kbs.Update(ctx, owner.ID, kbID, dto.KnowledgeBaseRequest{
		Name:        "company-handbook",
		Description: "updated",
		Visibility:  "private",
	})
	if err != nil {
		t.Fatalf("update knowledge base: %v", err)
	}
	detail, err := services.kbs.Get(ctx, owner.ID, kbID)
	if err != nil {
		t.Fatalf("get knowledge base detail: %v", err)
	}

	for responseName, response := range map[string]*dto.KnowledgeBaseResponse{
		"create": created,
		"update": updated,
		"detail": detail,
	} {
		payload, err := json.Marshal(response)
		if err != nil {
			t.Fatalf("marshal %s response: %v", responseName, err)
		}
		var item map[string]any
		if err := json.Unmarshal(payload, &item); err != nil {
			t.Fatalf("unmarshal %s response: %v", responseName, err)
		}
		for _, field := range []string{
			"completedDocumentCount",
			"processingDocumentCount",
			"failedDocumentCount",
		} {
			if _, exists := item[field]; exists {
				t.Fatalf("expected list-only field %s omitted from %s response, got %#v", field, responseName, item)
			}
		}
	}
}

func TestMetricHasNoChangeRatioWithoutPreviousBaseline(t *testing.T) {
	metricWithNewData := metric(3, 0)
	if metricWithNewData.ChangeRatio != nil {
		t.Fatalf("expected no comparable ratio for new data, got %v", *metricWithNewData.ChangeRatio)
	}

	metricWithoutData := metric(0, 0)
	if metricWithoutData.ChangeRatio != nil {
		t.Fatalf("expected no comparable ratio without data, got %v", *metricWithoutData.ChangeRatio)
	}
}

func TestGlobalDocumentListAndKeywordSearchUseOwnerScope(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, services.db, "owner")
	other := createWorkspaceUser(t, services.db, "other")
	ownKB := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "product-kb", "private", time.Now())
	foreignKB := createWorkspaceKB(t, services.db, other.ID, uuid.Nil, "foreign-kb", "private", time.Now())
	createWorkspaceDocument(t, services.db, ownKB.ID, owner.ID, "product-manual.pdf", "completed")
	createWorkspaceDocument(t, services.db, foreignKB.ID, other.ID, "foreign-manual.pdf", "completed")
	createWorkspaceChunk(t, services.db, ownKB.ID, "product install steps include upload and parsing")
	createWorkspaceChunk(t, services.db, foreignKB.ID, "foreign user content should never appear")

	documents, err := services.documents.ListGlobal(ctx, owner.ID, dto.GlobalDocumentListQuery{
		Q:        "product",
		Page:     1,
		PageSize: 10,
	})
	if err != nil {
		t.Fatalf("list global documents: %v", err)
	}
	if documents.Total != 1 || documents.Items[0].Filename != "product-manual.pdf" || documents.Items[0].KnowledgeBaseName != "product-kb" {
		t.Fatalf("expected only owned matching document, got %#v", documents)
	}

	search, err := services.search.Search(ctx, owner.ID, dto.GlobalSearchRequest{Query: "product"})
	if err != nil {
		t.Fatalf("global keyword search: %v", err)
	}
	if len(search.Items) == 0 {
		t.Fatalf("expected search results for owned content")
	}
	for _, item := range search.Items {
		if strings.Contains(item.Snippet, "foreign user") {
			t.Fatalf("global search leaked foreign content: %#v", search.Items)
		}
	}
}

func TestRecycleBinHidesDeletedKnowledgeBaseAndAllowsRestore(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, services.db, "owner")
	other := createWorkspaceUser(t, services.db, "other")

	ownKB := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "product-kb", "private", time.Now())
	createWorkspaceKB(t, services.db, other.ID, uuid.Nil, "foreign-kb", "private", time.Now())

	if err := services.kbs.Delete(ctx, owner.ID, ownKB.ID); err != nil {
		t.Fatalf("soft delete knowledge base: %v", err)
	}

	list, err := services.kbs.ListWorkspace(ctx, owner.ID, dto.KnowledgeBaseListQuery{
		Page:     1,
		PageSize: 20,
	})
	if err != nil {
		t.Fatalf("list workspace after delete: %v", err)
	}
	if list.Total != 0 {
		t.Fatalf("expected deleted knowledge base hidden from workspace list, got %#v", list.Items)
	}

	recycle, err := services.kbs.ListRecycleBin(ctx, owner.ID, 1, 20)
	if err != nil {
		t.Fatalf("list recycle bin: %v", err)
	}
	if recycle.Total != 1 || recycle.Items[0].ResourceType != "knowledgeBase" || recycle.Items[0].ID != ownKB.ID.String() {
		t.Fatalf("expected deleted knowledge base in recycle bin, got %#v", recycle.Items)
	}
	for _, item := range recycle.Items {
		if item.Name == "foreign-kb" {
			t.Fatalf("recycle bin leaked foreign resource: %#v", recycle.Items)
		}
	}

	if err := services.kbs.Restore(ctx, owner.ID, ownKB.ID); err != nil {
		t.Fatalf("restore knowledge base: %v", err)
	}

	restoredList, err := services.kbs.ListWorkspace(ctx, owner.ID, dto.KnowledgeBaseListQuery{
		Page:     1,
		PageSize: 20,
	})
	if err != nil {
		t.Fatalf("list workspace after restore: %v", err)
	}
	if restoredList.Total != 1 || restoredList.Items[0].ID != ownKB.ID.String() {
		t.Fatalf("expected restored knowledge base back in workspace, got %#v", restoredList.Items)
	}
}

func TestRecycleBinHidesDeletedDocumentAndAllowsRestore(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, services.db, "owner")
	other := createWorkspaceUser(t, services.db, "other")

	ownKB := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "product-kb", "private", time.Now())
	foreignKB := createWorkspaceKB(t, services.db, other.ID, uuid.Nil, "foreign-kb", "private", time.Now())
	ownDoc := createWorkspaceDocument(t, services.db, ownKB.ID, owner.ID, "manual.pdf", "completed")
	createWorkspaceDocument(t, services.db, foreignKB.ID, other.ID, "foreign.pdf", "completed")
	createWorkspaceChunk(t, services.db, ownKB.ID, "manual content for search")

	if err := services.documents.Delete(ctx, owner.ID, ownDoc.ID); err != nil {
		t.Fatalf("soft delete document: %v", err)
	}

	documentList, err := services.documents.List(ctx, owner.ID, ownKB.ID, dto.GlobalDocumentListQuery{})
	if err != nil {
		t.Fatalf("list documents after delete: %v", err)
	}
	if len(documentList.Items) != 0 {
		t.Fatalf("expected deleted document hidden from document list, got %#v", documentList.Items)
	}

	globalList, err := services.documents.ListGlobal(ctx, owner.ID, dto.GlobalDocumentListQuery{
		Page:     1,
		PageSize: 20,
	})
	if err != nil {
		t.Fatalf("list global documents after delete: %v", err)
	}
	if globalList.Total != 0 {
		t.Fatalf("expected deleted document hidden from global list, got %#v", globalList.Items)
	}

	search, err := services.search.Search(ctx, owner.ID, dto.GlobalSearchRequest{Query: "manual"})
	if err != nil {
		t.Fatalf("global search after delete: %v", err)
	}
	for _, item := range search.Items {
		if item.Filename == "manual.pdf" {
			t.Fatalf("expected deleted document hidden from global search, got %#v", search.Items)
		}
	}

	recycle, err := services.documents.ListRecycleBin(ctx, owner.ID, 1, 20)
	if err != nil {
		t.Fatalf("list document recycle bin: %v", err)
	}
	if recycle.Total != 1 || recycle.Items[0].ResourceType != "document" || recycle.Items[0].ID != ownDoc.ID.String() {
		t.Fatalf("expected deleted document in recycle bin, got %#v", recycle.Items)
	}

	if err := services.documents.Restore(ctx, owner.ID, ownDoc.ID); err != nil {
		t.Fatalf("restore document: %v", err)
	}

	restoredList, err := services.documents.List(ctx, owner.ID, ownKB.ID, dto.GlobalDocumentListQuery{})
	if err != nil {
		t.Fatalf("list documents after restore: %v", err)
	}
	if len(restoredList.Items) != 1 || restoredList.Items[0].ID != ownDoc.ID.String() {
		t.Fatalf("expected restored document back in document list, got %#v", restoredList.Items)
	}
}

func TestDocumentBatchDeleteRestoreAndReprocess(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, services.db, "owner")
	kb := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "product-kb", "private", time.Now())
	docA := createWorkspaceDocument(t, services.db, kb.ID, owner.ID, "manual-a.pdf", "completed")
	docB := createWorkspaceDocument(t, services.db, kb.ID, owner.ID, "manual-b.pdf", "failed")
	oldChunk := createWorkspaceDocumentChunk(t, services.db, kb.ID, docA.ID, 0, "manual content before reprocess")

	reprocessRes, err := services.documents.BatchReprocess(ctx, owner.ID, dto.DocumentBatchRequest{
		DocumentIDs: []uuid.UUID{docA.ID, docB.ID},
	})
	if err != nil {
		t.Fatalf("batch reprocess: %v", err)
	}
	if reprocessRes.ProcessedCount != 2 {
		t.Fatalf("expected 2 processed reprocess operations, got %#v", reprocessRes)
	}

	reprocessedA, err := services.documents.Get(ctx, owner.ID, docA.ID)
	if err != nil {
		t.Fatalf("get document A after reprocess: %v", err)
	}
	reprocessedB, err := services.documents.Get(ctx, owner.ID, docB.ID)
	if err != nil {
		t.Fatalf("get document B after reprocess: %v", err)
	}
	if reprocessedA.Status != "uploaded" || reprocessedB.Status != "uploaded" {
		t.Fatalf("expected reprocessed documents reset to uploaded, got %#v %#v", reprocessedA, reprocessedB)
	}
	var preservedChunkCount int64
	if err := services.db.Model(&model.DocumentChunk{}).Where("id = ?", oldChunk.ID).Count(&preservedChunkCount).Error; err != nil {
		t.Fatalf("count batch reprocess chunk: %v", err)
	}
	if preservedChunkCount != 1 {
		t.Fatalf("expected batch reprocess to preserve old chunk until processor replacement, got %d", preservedChunkCount)
	}

	deleteRes, err := services.documents.BatchDelete(ctx, owner.ID, dto.DocumentBatchRequest{
		DocumentIDs: []uuid.UUID{docA.ID, docB.ID},
	})
	if err != nil {
		t.Fatalf("batch delete documents: %v", err)
	}
	if deleteRes.ProcessedCount != 2 {
		t.Fatalf("expected 2 processed deletes, got %#v", deleteRes)
	}

	activeList, err := services.documents.List(ctx, owner.ID, kb.ID, dto.GlobalDocumentListQuery{})
	if err != nil {
		t.Fatalf("list documents after batch delete: %v", err)
	}
	if len(activeList.Items) != 0 {
		t.Fatalf("expected documents hidden after batch delete, got %#v", activeList.Items)
	}

	recycle, err := services.documents.ListRecycleBin(ctx, owner.ID, 1, 20)
	if err != nil {
		t.Fatalf("list recycle bin after batch delete: %v", err)
	}
	if recycle.Total != 2 {
		t.Fatalf("expected 2 deleted documents in recycle bin, got %#v", recycle.Items)
	}

	restoreRes, err := services.documents.BatchRestore(ctx, owner.ID, dto.DocumentBatchRequest{
		DocumentIDs: []uuid.UUID{docA.ID, docB.ID},
	})
	if err != nil {
		t.Fatalf("batch restore documents: %v", err)
	}
	if restoreRes.ProcessedCount != 2 {
		t.Fatalf("expected 2 processed restores, got %#v", restoreRes)
	}

	restoredList, err := services.documents.List(ctx, owner.ID, kb.ID, dto.GlobalDocumentListQuery{})
	if err != nil {
		t.Fatalf("list documents after batch restore: %v", err)
	}
	if len(restoredList.Items) != 2 {
		t.Fatalf("expected 2 restored documents, got %#v", restoredList.Items)
	}
}

func TestDocumentBatchDeleteRollsBackWhenLaterWriteFails(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, services.db, "owner")
	kb := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "product-kb", "private", time.Now())
	docA := createWorkspaceDocument(t, services.db, kb.ID, owner.ID, "manual-a.pdf", "completed")
	docB := createWorkspaceDocument(t, services.db, kb.ID, owner.ID, "manual-b.pdf", "completed")
	trigger := fmt.Sprintf(`
		CREATE TRIGGER fail_second_document_delete
		BEFORE UPDATE OF deleted_at ON documents
		WHEN NEW.id = '%s' AND NEW.deleted_at IS NOT NULL
		BEGIN
			SELECT RAISE(ABORT, 'forced delete failure');
		END`, docB.ID)
	if err := services.db.Exec(trigger).Error; err != nil {
		t.Fatalf("create delete failure trigger: %v", err)
	}

	if _, err := services.documents.BatchDelete(ctx, owner.ID, dto.DocumentBatchRequest{
		DocumentIDs: []uuid.UUID{docA.ID, docB.ID},
	}); err == nil {
		t.Fatal("expected batch delete to fail")
	}

	var activeCount int64
	if err := services.db.Unscoped().Model(&model.Document{}).
		Where("id IN ? AND deleted_at IS NULL", []uuid.UUID{docA.ID, docB.ID}).
		Count(&activeCount).Error; err != nil {
		t.Fatalf("count active documents: %v", err)
	}
	if activeCount != 2 {
		t.Fatalf("expected both documents to remain active after rollback, got %d", activeCount)
	}
}

func TestDocumentBatchRestoreRollsBackWhenLaterWriteFails(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, services.db, "owner")
	kb := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "product-kb", "private", time.Now())
	docA := createWorkspaceDocument(t, services.db, kb.ID, owner.ID, "manual-a.pdf", "completed")
	docB := createWorkspaceDocument(t, services.db, kb.ID, owner.ID, "manual-b.pdf", "completed")
	if err := services.documents.Delete(ctx, owner.ID, docA.ID); err != nil {
		t.Fatalf("delete document A: %v", err)
	}
	if err := services.documents.Delete(ctx, owner.ID, docB.ID); err != nil {
		t.Fatalf("delete document B: %v", err)
	}
	trigger := fmt.Sprintf(`
		CREATE TRIGGER fail_second_document_restore
		BEFORE UPDATE OF deleted_at ON documents
		WHEN NEW.id = '%s' AND NEW.deleted_at IS NULL
		BEGIN
			SELECT RAISE(ABORT, 'forced restore failure');
		END`, docB.ID)
	if err := services.db.Exec(trigger).Error; err != nil {
		t.Fatalf("create restore failure trigger: %v", err)
	}

	if _, err := services.documents.BatchRestore(ctx, owner.ID, dto.DocumentBatchRequest{
		DocumentIDs: []uuid.UUID{docA.ID, docB.ID},
	}); err == nil {
		t.Fatal("expected batch restore to fail")
	}

	var deletedCount int64
	if err := services.db.Unscoped().Model(&model.Document{}).
		Where("id IN ? AND deleted_at IS NOT NULL", []uuid.UUID{docA.ID, docB.ID}).
		Count(&deletedCount).Error; err != nil {
		t.Fatalf("count deleted documents: %v", err)
	}
	if deletedCount != 2 {
		t.Fatalf("expected both documents to remain deleted after rollback, got %d", deletedCount)
	}
}

func TestDocumentBatchReprocessRollsBackWhenLaterWriteFails(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, services.db, "owner")
	kb := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "product-kb", "private", time.Now())
	docA := createWorkspaceDocument(t, services.db, kb.ID, owner.ID, "manual-a.pdf", "completed")
	docB := createWorkspaceDocument(t, services.db, kb.ID, owner.ID, "manual-b.pdf", "completed")
	trigger := fmt.Sprintf(`
		CREATE TRIGGER fail_second_document_reprocess
		BEFORE UPDATE OF status ON documents
		WHEN NEW.id = '%s' AND NEW.status = 'uploaded'
		BEGIN
			SELECT RAISE(ABORT, 'forced reprocess failure');
		END`, docB.ID)
	if err := services.db.Exec(trigger).Error; err != nil {
		t.Fatalf("create reprocess failure trigger: %v", err)
	}

	if _, err := services.documents.BatchReprocess(ctx, owner.ID, dto.DocumentBatchRequest{
		DocumentIDs: []uuid.UUID{docA.ID, docB.ID},
	}); err == nil {
		t.Fatal("expected batch reprocess to fail")
	}

	var completedCount int64
	if err := services.db.Model(&model.Document{}).
		Where("id IN ? AND status = ?", []uuid.UUID{docA.ID, docB.ID}, "completed").
		Count(&completedCount).Error; err != nil {
		t.Fatalf("count completed documents: %v", err)
	}
	if completedCount != 2 {
		t.Fatalf("expected both document statuses to roll back, got %d", completedCount)
	}
	var jobCount int64
	if err := services.db.Model(&model.DocumentJob{}).
		Where("document_id IN ?", []uuid.UUID{docA.ID, docB.ID}).
		Count(&jobCount).Error; err != nil {
		t.Fatalf("count document jobs: %v", err)
	}
	if jobCount != 0 {
		t.Fatalf("expected queued jobs to roll back, got %d", jobCount)
	}
}

func TestDocumentBatchReprocessReusesActiveJobs(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, services.db, "owner")
	kb := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "product-kb", "private", time.Now())
	docA := createWorkspaceDocument(t, services.db, kb.ID, owner.ID, "manual-a.pdf", "embedding")
	docB := createWorkspaceDocument(t, services.db, kb.ID, owner.ID, "manual-b.pdf", "completed")
	activeJob := model.DocumentJob{DocumentID: docA.ID, JobType: "process_document", Status: "running"}
	if err := services.db.Create(&activeJob).Error; err != nil {
		t.Fatalf("create active document job: %v", err)
	}

	if _, err := services.documents.BatchReprocess(ctx, owner.ID, dto.DocumentBatchRequest{
		DocumentIDs: []uuid.UUID{docA.ID, docB.ID},
	}); err != nil {
		t.Fatalf("batch reprocess: %v", err)
	}

	var docAActiveCount int64
	if err := services.db.Model(&model.DocumentJob{}).
		Where("document_id = ? AND status IN ?", docA.ID, []string{"pending", "running"}).
		Count(&docAActiveCount).Error; err != nil {
		t.Fatalf("count document A jobs: %v", err)
	}
	if docAActiveCount != 1 {
		t.Fatalf("expected active job to be reused, got %d jobs", docAActiveCount)
	}
	var documents []model.Document
	if err := services.db.Where("id IN ?", []uuid.UUID{docA.ID, docB.ID}).Order("filename asc").Find(&documents).Error; err != nil {
		t.Fatalf("reload documents: %v", err)
	}
	if len(documents) != 2 || documents[0].Status != "embedding" || documents[1].Status != "uploaded" {
		t.Fatalf("expected active stage preserved and idle document queued, got %#v", documents)
	}
}

func TestDocumentReprocessPreservesChunksUntilProcessorReplacement(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, services.db, "owner")
	kb := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "product-kb", "private", time.Now())
	document := createWorkspaceDocument(t, services.db, kb.ID, owner.ID, "manual.pdf", "completed")
	oldChunk := createWorkspaceDocumentChunk(t, services.db, kb.ID, document.ID, 0, "old searchable content")

	if _, err := services.documents.Reprocess(ctx, owner.ID, document.ID); err != nil {
		t.Fatalf("reprocess document: %v", err)
	}

	var preservedCount int64
	if err := services.db.Model(&model.DocumentChunk{}).Where("id = ?", oldChunk.ID).Count(&preservedCount).Error; err != nil {
		t.Fatalf("count preserved chunk: %v", err)
	}
	if preservedCount != 1 {
		t.Fatalf("expected old chunk to remain until processor replacement, got %d", preservedCount)
	}
}

func TestDocumentReprocessReusesActiveProcessingJob(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, services.db, "owner")
	kb := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "product-kb", "private", time.Now())
	document := createWorkspaceDocument(t, services.db, kb.ID, owner.ID, "manual.pdf", "embedding")
	activeJob := model.DocumentJob{
		DocumentID: document.ID,
		JobType:    "process_document",
		Status:     "running",
	}
	if err := services.db.Create(&activeJob).Error; err != nil {
		t.Fatalf("create active document job: %v", err)
	}

	response, err := services.documents.Reprocess(ctx, owner.ID, document.ID)
	if err != nil {
		t.Fatalf("reprocess active document: %v", err)
	}

	var activeCount int64
	if err := services.db.Model(&model.DocumentJob{}).
		Where("document_id = ? AND status IN ?", document.ID, []string{"pending", "running"}).
		Count(&activeCount).Error; err != nil {
		t.Fatalf("count active document jobs: %v", err)
	}
	if activeCount != 1 {
		t.Fatalf("expected one active job after idempotent reprocess, got %d", activeCount)
	}
	if response.Status != "embedding" || response.JobStatus != "running" {
		t.Fatalf("expected current processing stage to remain unchanged, got %#v", response)
	}
}

func TestDocumentReprocessQueuesSuccessorWhileWorkerFinishes(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, services.db, "owner")
	kb := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "product-kb", "private", time.Now())
	document := createWorkspaceDocument(t, services.db, kb.ID, owner.ID, "manual.pdf", "completed")
	finishingJob := model.DocumentJob{DocumentID: document.ID, JobType: "process_document", Status: "running"}
	if err := services.db.Create(&finishingJob).Error; err != nil {
		t.Fatalf("create finishing document job: %v", err)
	}

	response, err := services.documents.Reprocess(ctx, owner.ID, document.ID)
	if err != nil {
		t.Fatalf("reprocess finishing document: %v", err)
	}

	var pendingCount int64
	if err := services.db.Model(&model.DocumentJob{}).
		Where("document_id = ? AND job_type = ? AND status = ?", document.ID, "process_document", "pending").
		Count(&pendingCount).Error; err != nil {
		t.Fatalf("count successor jobs: %v", err)
	}
	if pendingCount != 1 {
		t.Fatalf("expected one pending successor, got %d", pendingCount)
	}
	if response.Status != "uploaded" || response.JobStatus != "pending" {
		t.Fatalf("expected successor processing response, got %#v", response)
	}
}

func TestDocumentReprocessRollsBackWhenKnowledgeBaseTouchFails(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, services.db, "owner")
	kb := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "product-kb", "private", time.Now())
	document := createWorkspaceDocument(t, services.db, kb.ID, owner.ID, "manual.pdf", "completed")
	trigger := fmt.Sprintf(`
		CREATE TRIGGER fail_reprocess_knowledge_base_touch
		BEFORE UPDATE OF updated_by_id ON knowledge_bases
		WHEN NEW.id = '%s'
		BEGIN
			SELECT RAISE(ABORT, 'forced knowledge base touch failure');
		END`, kb.ID)
	if err := services.db.Exec(trigger).Error; err != nil {
		t.Fatalf("create knowledge base failure trigger: %v", err)
	}

	if _, err := services.documents.Reprocess(ctx, owner.ID, document.ID); err == nil {
		t.Fatal("expected reprocess to fail")
	}

	var stored model.Document
	if err := services.db.First(&stored, "id = ?", document.ID).Error; err != nil {
		t.Fatalf("reload document: %v", err)
	}
	if stored.Status != "completed" {
		t.Fatalf("expected document status rollback, got %q", stored.Status)
	}
	var jobCount int64
	if err := services.db.Model(&model.DocumentJob{}).Where("document_id = ?", document.ID).Count(&jobCount).Error; err != nil {
		t.Fatalf("count document jobs: %v", err)
	}
	if jobCount != 0 {
		t.Fatalf("expected queued job rollback, got %d", jobCount)
	}
}

func TestDocumentBatchReprocessRollsBackWhenKnowledgeBaseTouchFails(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, services.db, "owner")
	kbA := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "product-a", "private", time.Now())
	kbB := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "product-b", "private", time.Now())
	docA := createWorkspaceDocument(t, services.db, kbA.ID, owner.ID, "manual-a.pdf", "completed")
	docB := createWorkspaceDocument(t, services.db, kbB.ID, owner.ID, "manual-b.pdf", "completed")
	trigger := fmt.Sprintf(`
		CREATE TRIGGER fail_batch_reprocess_knowledge_base_touch
		BEFORE UPDATE OF updated_by_id ON knowledge_bases
		WHEN NEW.id = '%s'
		BEGIN
			SELECT RAISE(ABORT, 'forced batch knowledge base touch failure');
		END`, kbB.ID)
	if err := services.db.Exec(trigger).Error; err != nil {
		t.Fatalf("create knowledge base failure trigger: %v", err)
	}

	if _, err := services.documents.BatchReprocess(ctx, owner.ID, dto.DocumentBatchRequest{
		DocumentIDs: []uuid.UUID{docA.ID, docB.ID},
	}); err == nil {
		t.Fatal("expected batch reprocess to fail")
	}

	var completedCount int64
	if err := services.db.Model(&model.Document{}).
		Where("id IN ? AND status = ?", []uuid.UUID{docA.ID, docB.ID}, "completed").
		Count(&completedCount).Error; err != nil {
		t.Fatalf("count completed documents: %v", err)
	}
	if completedCount != 2 {
		t.Fatalf("expected document statuses rollback, got %d", completedCount)
	}
	var jobCount int64
	if err := services.db.Model(&model.DocumentJob{}).
		Where("document_id IN ?", []uuid.UUID{docA.ID, docB.ID}).
		Count(&jobCount).Error; err != nil {
		t.Fatalf("count document jobs: %v", err)
	}
	if jobCount != 0 {
		t.Fatalf("expected queued jobs rollback, got %d", jobCount)
	}
}

func TestDocumentBatchOperationsRejectForeignIDsWithoutPartialMutation(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, services.db, "owner")
	other := createWorkspaceUser(t, services.db, "other")
	ownKB := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "product-kb", "private", time.Now())
	foreignKB := createWorkspaceKB(t, services.db, other.ID, uuid.Nil, "foreign-kb", "private", time.Now())
	ownDoc := createWorkspaceDocument(t, services.db, ownKB.ID, owner.ID, "manual.pdf", "completed")
	foreignDoc := createWorkspaceDocument(t, services.db, foreignKB.ID, other.ID, "foreign.pdf", "completed")

	if _, err := services.documents.BatchReprocess(ctx, owner.ID, dto.DocumentBatchRequest{
		DocumentIDs: []uuid.UUID{ownDoc.ID, foreignDoc.ID},
	}); err == nil {
		t.Fatalf("expected batch reprocess with foreign document to fail")
	}
	afterReprocess, err := services.documents.Get(ctx, owner.ID, ownDoc.ID)
	if err != nil {
		t.Fatalf("get own document after rejected batch reprocess: %v", err)
	}
	if afterReprocess.Status != "completed" {
		t.Fatalf("expected no partial reprocess side effect, got %#v", afterReprocess)
	}

	if _, err := services.documents.BatchDelete(ctx, owner.ID, dto.DocumentBatchRequest{
		DocumentIDs: []uuid.UUID{ownDoc.ID, foreignDoc.ID},
	}); err == nil {
		t.Fatalf("expected batch delete with foreign document to fail")
	}
	activeList, err := services.documents.List(ctx, owner.ID, ownKB.ID, dto.GlobalDocumentListQuery{})
	if err != nil {
		t.Fatalf("list own documents after rejected batch delete: %v", err)
	}
	if len(activeList.Items) != 1 || activeList.Items[0].ID != ownDoc.ID.String() {
		t.Fatalf("expected no partial delete side effect, got %#v", activeList.Items)
	}

	if err := services.documents.Delete(ctx, owner.ID, ownDoc.ID); err != nil {
		t.Fatalf("delete own document for restore test: %v", err)
	}
	if err := services.documents.Delete(ctx, other.ID, foreignDoc.ID); err != nil {
		t.Fatalf("delete foreign document for restore test: %v", err)
	}

	if _, err := services.documents.BatchRestore(ctx, owner.ID, dto.DocumentBatchRequest{
		DocumentIDs: []uuid.UUID{ownDoc.ID, foreignDoc.ID},
	}); err == nil {
		t.Fatalf("expected batch restore with foreign document to fail")
	}
	recycle, err := services.documents.ListRecycleBin(ctx, owner.ID, 1, 20)
	if err != nil {
		t.Fatalf("list recycle after rejected batch restore: %v", err)
	}
	if recycle.Total != 1 || recycle.Items[0].ID != ownDoc.ID.String() {
		t.Fatalf("expected own document to remain deleted after rejected restore, got %#v", recycle.Items)
	}
}

func TestUserSearchFindsUsersByUsernameAndDisplayName(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	createWorkspaceUser(t, services.db, "alice")
	bob := createWorkspaceUser(t, services.db, "bob")
	if err := services.db.Model(&bob).Update("display_name", "Product Manager").Error; err != nil {
		t.Fatalf("update display name: %v", err)
	}

	users, err := services.users.Search(ctx, "product", 20)
	if err != nil {
		t.Fatalf("search users: %v", err)
	}
	if len(users.Items) != 1 || users.Items[0].ID != bob.ID.String() {
		t.Fatalf("expected search to find bob by display name, got %#v", users.Items)
	}
}

func TestChatSessionManagementRequiresOwnedSessionAndKnowledgeBase(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, services.db, "owner")
	other := createWorkspaceUser(t, services.db, "other")
	kb := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "product-kb", "private", time.Now())
	session := createWorkspaceChatSession(t, services.db, owner.ID, kb.ID, "old title")
	foreignKB := createWorkspaceKB(t, services.db, other.ID, uuid.Nil, "foreign-kb", "private", time.Now())
	createWorkspaceChatSession(t, services.db, owner.ID, foreignKB.ID, "foreign knowledge base")

	list, err := services.chats.ListSessions(ctx, owner.ID, dto.ChatSessionListQuery{})
	if err != nil {
		t.Fatalf("list owned sessions: %v", err)
	}
	if len(list.Items) != 1 || list.Items[0].ID != session.ID.String() {
		t.Fatalf("expected only session from an owned knowledge base, got %#v", list.Items)
	}

	got, err := services.chats.GetSession(ctx, owner.ID, session.ID)
	if err != nil {
		t.Fatalf("get session: %v", err)
	}
	if got.ID != session.ID.String() || got.Title != "old title" {
		t.Fatalf("unexpected session response: %#v", got)
	}

	updated, err := services.chats.UpdateSession(ctx, owner.ID, session.ID, dto.UpdateChatSessionRequest{Title: "new title"})
	if err != nil {
		t.Fatalf("update session: %v", err)
	}
	if updated.Title != "new title" {
		t.Fatalf("expected updated title, got %#v", updated)
	}

	if _, err := services.chats.GetSession(ctx, other.ID, session.ID); err == nil {
		t.Fatalf("expected other user to be rejected from session")
	}
	if err := services.db.Delete(&kb).Error; err != nil {
		t.Fatalf("soft delete knowledge base: %v", err)
	}
	if _, err := services.chats.GetSession(ctx, owner.ID, session.ID); err == nil {
		t.Fatalf("expected session with deleted knowledge base to be rejected")
	}
	list, err = services.chats.ListSessions(ctx, owner.ID, dto.ChatSessionListQuery{})
	if err != nil {
		t.Fatalf("list sessions after knowledge base deletion: %v", err)
	}
	if len(list.Items) != 0 {
		t.Fatalf("expected sessions from deleted knowledge bases to be hidden, got %#v", list.Items)
	}
}

// G15: deleting a session hides it but keeps the messages, so a restore from the
// recycle bin brings back the real conversation rather than an empty shell.
func TestChatSessionDeleteHidesSessionAndKeepsMessages(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, services.db, "owner")
	kb := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "product-kb", "private", time.Now())
	session := createWorkspaceChatSession(t, services.db, owner.ID, kb.ID, "old title")
	message := model.ChatMessage{SessionID: session.ID, Role: "user", Content: "hello"}
	if err := services.db.Create(&message).Error; err != nil {
		t.Fatalf("create chat message: %v", err)
	}

	if err := services.chats.DeleteSession(ctx, owner.ID, session.ID); err != nil {
		t.Fatalf("delete session: %v", err)
	}
	if _, err := services.chats.GetSession(ctx, owner.ID, session.ID); err == nil {
		t.Fatalf("expected deleted session to be hidden")
	}
	var messageCount int64
	if err := services.db.Model(&model.ChatMessage{}).Where("session_id = ?", session.ID).Count(&messageCount).Error; err != nil {
		t.Fatalf("count messages: %v", err)
	}
	if messageCount != 1 {
		t.Fatalf("expected soft delete to keep messages, got %d", messageCount)
	}
}

func TestChatSessionArchiveHidesFromListButKeepsDetail(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, services.db, "owner")
	other := createWorkspaceUser(t, services.db, "other")
	kb := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "product-kb", "private", time.Now())
	session := createWorkspaceChatSession(t, services.db, owner.ID, kb.ID, "archive me")

	if _, err := services.chats.ArchiveSession(ctx, other.ID, session.ID); err == nil {
		t.Fatalf("expected foreign user archive to be rejected")
	}
	archived, err := services.chats.ArchiveSession(ctx, owner.ID, session.ID)
	if err != nil {
		t.Fatalf("archive session: %v", err)
	}
	if archived.ArchivedAt == nil || archived.ID != session.ID.String() {
		t.Fatalf("expected archive response with archivedAt, got %#v", archived)
	}
	idempotent, err := services.chats.ArchiveSession(ctx, owner.ID, session.ID)
	if err != nil {
		t.Fatalf("archive session idempotently: %v", err)
	}
	if idempotent.ArchivedAt == nil || !idempotent.ArchivedAt.Equal(*archived.ArchivedAt) {
		t.Fatalf("expected stable idempotent archive response, first=%#v second=%#v", archived, idempotent)
	}
	list, err := services.chats.ListSessions(ctx, owner.ID, dto.ChatSessionListQuery{})
	if err != nil {
		t.Fatalf("list sessions after archive: %v", err)
	}
	if len(list.Items) != 0 {
		t.Fatalf("expected archived session hidden from default list, got %#v", list.Items)
	}
	detail, err := services.chats.GetSession(ctx, owner.ID, session.ID)
	if err != nil {
		t.Fatalf("get archived session detail: %v", err)
	}
	if detail.ArchivedAt == nil {
		t.Fatalf("expected archivedAt on archived session, got %#v", detail)
	}
}

func TestChatSessionConcurrentArchiveReturnsStableTimestamp(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	services.db.Config.SkipDefaultTransaction = true
	sqlDB, err := services.db.DB()
	if err != nil {
		t.Fatalf("get sql database: %v", err)
	}
	sqlDB.SetMaxOpenConns(1)

	owner := createWorkspaceUser(t, services.db, "concurrent-archive-owner")
	kb := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "concurrent-archive-kb", "private", time.Now())
	session := createWorkspaceChatSession(t, services.db, owner.ID, kb.ID, "archive concurrently")

	var archiveUpdates atomic.Int32
	firstUpdateBlocked := make(chan struct{})
	releaseFirstUpdate := make(chan struct{})
	callbackName := "test:block_first_chat_archive_update"
	if err := services.db.Callback().Update().Before("gorm:update").Register(callbackName, func(tx *gorm.DB) {
		values, ok := tx.Statement.Dest.(map[string]any)
		if !ok {
			return
		}
		if _, ok := values["archived_at"]; !ok {
			return
		}
		if archiveUpdates.Add(1) == 1 {
			close(firstUpdateBlocked)
			<-releaseFirstUpdate
		}
	}); err != nil {
		t.Fatalf("register archive update callback: %v", err)
	}
	defer services.db.Callback().Update().Remove(callbackName)

	type archiveResult struct {
		session *dto.ChatSessionResponse
		err     error
	}
	archive := func(results chan<- archiveResult) {
		archived, archiveErr := services.chats.ArchiveSession(ctx, owner.ID, session.ID)
		results <- archiveResult{session: archived, err: archiveErr}
	}

	firstResult := make(chan archiveResult, 1)
	go archive(firstResult)
	select {
	case <-firstUpdateBlocked:
	case <-time.After(2 * time.Second):
		close(releaseFirstUpdate)
		t.Fatal("timed out waiting for first archive update")
	}

	time.Sleep(10 * time.Millisecond)
	secondResult := make(chan archiveResult, 1)
	go archive(secondResult)
	var second archiveResult
	select {
	case second = <-secondResult:
	case <-time.After(2 * time.Second):
		close(releaseFirstUpdate)
		t.Fatal("timed out waiting for second archive result")
	}
	close(releaseFirstUpdate)

	var first archiveResult
	select {
	case first = <-firstResult:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for first archive result")
	}
	if first.err != nil || second.err != nil {
		t.Fatalf("archive concurrently: first=%v second=%v", first.err, second.err)
	}
	if first.session.ArchivedAt == nil || second.session.ArchivedAt == nil {
		t.Fatalf("expected archivedAt in both responses, first=%#v second=%#v", first.session, second.session)
	}
	if !first.session.ArchivedAt.Equal(*second.session.ArchivedAt) {
		t.Fatalf("expected concurrent archive responses to share one timestamp, first=%s second=%s", first.session.ArchivedAt, second.session.ArchivedAt)
	}
}

func TestDocumentDownloadAndMissingFileError(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, services.db, "owner")
	other := createWorkspaceUser(t, services.db, "other")
	kb := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "product-kb", "private", time.Now())
	doc := createWorkspaceDocument(t, services.db, kb.ID, owner.ID, "manual.txt", "completed")

	file, err := services.documents.Download(ctx, owner.ID, doc.ID)
	if err == nil {
		t.Fatalf("expected missing local file to return an error, got %#v", file)
	}
	if _, err := services.documents.Download(ctx, other.ID, doc.ID); err == nil {
		t.Fatalf("expected foreign user download to be rejected")
	}

	storedPath := filepath.Join(t.TempDir(), "manual.txt")
	if err := os.WriteFile(storedPath, []byte("hello"), 0644); err != nil {
		t.Fatalf("write stored file: %v", err)
	}
	if err := services.db.Model(&model.Document{}).Where("id = ?", doc.ID).Update("storage_path", storedPath).Error; err != nil {
		t.Fatalf("update storage path: %v", err)
	}
	file, err = services.documents.Download(ctx, owner.ID, doc.ID)
	if err != nil {
		t.Fatalf("download existing file: %v", err)
	}
	defer file.Reader.Close()
	content, readErr := io.ReadAll(file.Reader)
	if readErr != nil {
		t.Fatalf("read download: %v", readErr)
	}
	if string(content) != "hello" || file.Size != int64(len(content)) || file.Filename != "manual.txt" || file.ContentType != "text/plain; charset=utf-8" {
		t.Fatalf("unexpected download response: %#v", file)
	}
}

func TestDocumentPreviewReturnsTextForOwnedTextFiles(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, services.db, "owner")
	other := createWorkspaceUser(t, services.db, "other")
	kb := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "product-kb", "private", time.Now())
	doc := createWorkspaceDocument(t, services.db, kb.ID, owner.ID, "manual.md", "completed")
	storedPath := filepath.Join(t.TempDir(), "manual.md")
	if err := os.WriteFile(storedPath, []byte("# Manual\nhello"), 0644); err != nil {
		t.Fatalf("write preview file: %v", err)
	}
	if err := services.db.Model(&model.Document{}).Where("id = ?", doc.ID).Update("storage_path", storedPath).Error; err != nil {
		t.Fatalf("update storage path: %v", err)
	}

	preview, err := services.documents.Preview(ctx, owner.ID, doc.ID)
	if err != nil {
		t.Fatalf("preview document: %v", err)
	}
	if preview.Kind != "text" || preview.Content != "# Manual\nhello" || preview.DownloadURL == "" {
		t.Fatalf("unexpected preview response: %#v", preview)
	}
	if _, err := services.documents.Preview(ctx, other.ID, doc.ID); err == nil {
		t.Fatalf("expected foreign user preview to be rejected")
	}
}

func TestDocumentPreviewReturnsPDFMetadataWithoutReadingContent(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, services.db, "owner")
	kb := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "product-kb", "private", time.Now())
	doc := createWorkspaceDocument(t, services.db, kb.ID, owner.ID, "manual.pdf", "completed")
	storedPath := filepath.Join(t.TempDir(), "manual.pdf")
	if err := os.WriteFile(storedPath, []byte("%PDF-1.4"), 0644); err != nil {
		t.Fatalf("write preview pdf: %v", err)
	}
	if err := services.db.Model(&model.Document{}).Where("id = ?", doc.ID).Update("storage_path", storedPath).Error; err != nil {
		t.Fatalf("update storage path: %v", err)
	}

	preview, err := services.documents.Preview(ctx, owner.ID, doc.ID)
	if err != nil {
		t.Fatalf("preview pdf: %v", err)
	}
	if preview.Kind != "file" || preview.Content != "" || preview.ContentType != "application/pdf" || preview.DownloadURL == "" {
		t.Fatalf("unexpected pdf preview response: %#v", preview)
	}
}

func TestDocumentResponsesExposeLatestJobProgress(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	services.documents.cfg.WorkerMaxRetries = 5
	owner := createWorkspaceUser(t, services.db, "owner")
	kb := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "product-kb", "private", time.Now())
	doc := createWorkspaceDocument(t, services.db, kb.ID, owner.ID, "manual.pdf", "embedding")
	oldJob := model.DocumentJob{
		DocumentID: doc.ID,
		JobType:    "process_document",
		Status:     "failed",
		RetryCount: 1,
		CreatedAt:  time.Now().Add(-1 * time.Hour),
		UpdatedAt:  time.Now().Add(-1 * time.Hour),
	}
	latestJob := model.DocumentJob{
		DocumentID: doc.ID,
		JobType:    "process_document",
		Status:     "running",
		Progress:   83,
		RetryCount: 2,
		CreatedAt:  time.Now(),
		UpdatedAt:  time.Now(),
	}
	if err := services.db.Create(&oldJob).Error; err != nil {
		t.Fatalf("create old document job: %v", err)
	}
	if err := services.db.Create(&latestJob).Error; err != nil {
		t.Fatalf("create latest document job: %v", err)
	}

	detail, err := services.documents.Get(ctx, owner.ID, doc.ID)
	if err != nil {
		t.Fatalf("get document detail: %v", err)
	}
	if detail.JobStatus != "running" || detail.Stage != "embedding" || detail.Progress != 83 {
		t.Fatalf("expected running embedding progress on detail, got %#v", detail)
	}
	if detail.RetryCount != 2 || detail.MaxRetries != 5 || detail.NextRetryAt != nil {
		t.Fatalf("unexpected retry fields on detail: %#v", detail)
	}

	kbList, err := services.documents.List(ctx, owner.ID, kb.ID, dto.GlobalDocumentListQuery{})
	if err != nil {
		t.Fatalf("list knowledge base documents: %v", err)
	}
	if len(kbList.Items) != 1 || kbList.Items[0].JobStatus != "running" || kbList.Items[0].Progress != 83 {
		t.Fatalf("expected progress fields on knowledge base document list, got %#v", kbList.Items)
	}

	globalList, err := services.documents.ListGlobal(ctx, owner.ID, dto.GlobalDocumentListQuery{Page: 1, PageSize: 20})
	if err != nil {
		t.Fatalf("list global documents: %v", err)
	}
	if len(globalList.Items) != 1 || globalList.Items[0].JobStatus != "running" || globalList.Items[0].Progress != 83 {
		t.Fatalf("expected progress fields on global document list, got %#v", globalList.Items)
	}
}

func TestFailedDocumentProgressIsNotComplete(t *testing.T) {
	progress := documentProgress("failed", nil, 3)
	if progress.JobStatus != "failed" || progress.Stage != "failed" {
		t.Fatalf("expected failed state to remain explicit, got %#v", progress)
	}
	if progress.Progress != 0 {
		t.Fatalf("expected failed progress to avoid completed 100%%, got %d", progress.Progress)
	}
}

func TestDocumentResponseHidesTechnicalProcessingErrors(t *testing.T) {
	configurationMessage := publicDocumentErrorMessage("EMBEDDING_API_KEY is required")
	if configurationMessage != "文档处理服务尚未配置完成，请联系管理员完成配置后再重处理。" {
		t.Fatalf("unexpected configuration message: %q", configurationMessage)
	}

	processingMessage := publicDocumentErrorMessage("dial tcp 127.0.0.1: connection refused")
	if processingMessage != "文档处理失败，请检查文件内容或稍后重处理。" {
		t.Fatalf("unexpected processing message: %q", processingMessage)
	}
}

func TestDocumentPendingRetryResponseExposesNextRetryAt(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, services.db, "owner")
	kb := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "product-kb", "private", time.Now())
	doc := createWorkspaceDocument(t, services.db, kb.ID, owner.ID, "manual.pdf", "uploaded")
	retryAt := time.Now().Add(5 * time.Minute).UTC().Truncate(time.Second)
	job := model.DocumentJob{
		DocumentID: doc.ID,
		JobType:    "process_document",
		Status:     "pending",
		RetryCount: 1,
		LockedAt:   &retryAt,
	}
	if err := services.db.Create(&job).Error; err != nil {
		t.Fatalf("create retry document job: %v", err)
	}

	detail, err := services.documents.Get(ctx, owner.ID, doc.ID)
	if err != nil {
		t.Fatalf("get document detail: %v", err)
	}

	if detail.JobStatus != "pending" || detail.Stage != "uploaded" || detail.Progress != 0 {
		t.Fatalf("expected pending uploaded progress, got %#v", detail)
	}
	if detail.NextRetryAt == nil || !detail.NextRetryAt.Equal(retryAt) {
		t.Fatalf("expected next retry time from lockedAt, got %#v", detail.NextRetryAt)
	}
}

func TestDocumentChunksSupportPaginationAndSearch(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, services.db, "owner")
	kb := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "product-kb", "private", time.Now())
	doc := createWorkspaceDocument(t, services.db, kb.ID, owner.ID, "manual.pdf", "completed")
	createWorkspaceDocumentChunk(t, services.db, kb.ID, doc.ID, 0, "alpha content")
	createWorkspaceDocumentChunk(t, services.db, kb.ID, doc.ID, 1, "beta content")
	createWorkspaceDocumentChunk(t, services.db, kb.ID, doc.ID, 2, "alpha second")

	page, err := services.documents.Chunks(ctx, owner.ID, doc.ID, dto.ChunkListQuery{Page: 1, PageSize: 1, Q: "alpha"})
	if err != nil {
		t.Fatalf("list chunks: %v", err)
	}
	if page.Total != 2 || page.Page != 1 || page.PageSize != 1 || len(page.Items) != 1 || page.Items[0].ChunkIndex != 0 {
		t.Fatalf("unexpected chunk page: %#v", page)
	}
}

func TestDocumentChunksSupportExactChunkLookupAndScope(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, services.db, "owner")
	otherOwner := createWorkspaceUser(t, services.db, "other-owner")
	kb := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "product-kb", "private", time.Now())
	doc := createWorkspaceDocument(t, services.db, kb.ID, owner.ID, "manual.pdf", "completed")
	otherDoc := createWorkspaceDocument(t, services.db, kb.ID, owner.ID, "appendix.pdf", "completed")
	target := createWorkspaceDocumentChunk(t, services.db, kb.ID, doc.ID, 0, "target content")
	otherChunk := createWorkspaceDocumentChunk(t, services.db, kb.ID, otherDoc.ID, 0, "other content")
	zeroChunkID := uuid.Nil

	zeroID, err := services.documents.Chunks(ctx, owner.ID, doc.ID, dto.ChunkListQuery{ChunkID: &zeroChunkID})
	if err != nil {
		t.Fatalf("query zero chunk ID: %v", err)
	}
	if zeroID.Total != 0 || len(zeroID.Items) != 0 {
		t.Fatalf("expected zero chunk ID to be an exact empty lookup, got %#v", zeroID)
	}

	exact, err := services.documents.Chunks(ctx, owner.ID, doc.ID, dto.ChunkListQuery{ChunkID: &target.ID})
	if err != nil {
		t.Fatalf("get exact chunk: %v", err)
	}
	if exact.Total != 1 || len(exact.Items) != 1 || exact.Items[0].ID != target.ID.String() || exact.Items[0].Content != "target content" {
		t.Fatalf("unexpected exact chunk response: %#v", exact)
	}

	crossDocument, err := services.documents.Chunks(ctx, owner.ID, doc.ID, dto.ChunkListQuery{ChunkID: &otherChunk.ID})
	if err != nil {
		t.Fatalf("query cross-document chunk: %v", err)
	}
	if crossDocument.Total != 0 || len(crossDocument.Items) != 0 {
		t.Fatalf("expected cross-document chunk to be hidden, got %#v", crossDocument)
	}

	if response, err := services.documents.Chunks(ctx, otherOwner.ID, doc.ID, dto.ChunkListQuery{ChunkID: &target.ID}); err == nil || response != nil {
		t.Fatalf("expected foreign document lookup to be rejected, got response=%#v err=%v", response, err)
	}
}

func TestRecycleBinPermanentDeleteAndEmptyUseOwnerScope(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, services.db, "owner")
	other := createWorkspaceUser(t, services.db, "other")
	ownerKB := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "owner-kb", "private", time.Now())
	otherKB := createWorkspaceKB(t, services.db, other.ID, uuid.Nil, "other-kb", "private", time.Now())
	ownerDoc := createWorkspaceDocument(t, services.db, ownerKB.ID, owner.ID, "owner.pdf", "completed")
	otherDoc := createWorkspaceDocument(t, services.db, otherKB.ID, other.ID, "other.pdf", "completed")
	createWorkspaceDocumentChunk(t, services.db, ownerKB.ID, ownerDoc.ID, 0, "owner chunk")
	createWorkspaceDocumentChunk(t, services.db, otherKB.ID, otherDoc.ID, 0, "other chunk")
	createWorkspaceChatSession(t, services.db, owner.ID, ownerKB.ID, "owner session")

	if err := services.documents.Delete(ctx, owner.ID, ownerDoc.ID); err != nil {
		t.Fatalf("soft delete owner document: %v", err)
	}
	if err := services.documents.PermanentDelete(ctx, other.ID, ownerDoc.ID); err == nil {
		t.Fatalf("expected foreign permanent document delete to be rejected")
	}
	if err := services.documents.PermanentDelete(ctx, owner.ID, ownerDoc.ID); err != nil {
		t.Fatalf("permanent delete owner document: %v", err)
	}
	var ownerDocCount int64
	if err := services.db.Unscoped().Model(&model.Document{}).Where("id = ?", ownerDoc.ID).Count(&ownerDocCount).Error; err != nil {
		t.Fatalf("count owner document: %v", err)
	}
	if ownerDocCount != 0 {
		t.Fatalf("expected permanent deleted document removed, got %d", ownerDocCount)
	}

	if err := services.kbs.Delete(ctx, owner.ID, ownerKB.ID); err != nil {
		t.Fatalf("soft delete owner kb: %v", err)
	}
	if err := services.kbs.Delete(ctx, other.ID, otherKB.ID); err != nil {
		t.Fatalf("soft delete other kb: %v", err)
	}
	if err := services.kbs.EmptyRecycleBin(ctx, owner.ID); err != nil {
		t.Fatalf("empty owner kb recycle bin: %v", err)
	}
	var ownerKBCount, otherKBCount int64
	if err := services.db.Unscoped().Model(&model.KnowledgeBase{}).Where("id = ?", ownerKB.ID).Count(&ownerKBCount).Error; err != nil {
		t.Fatalf("count owner kb: %v", err)
	}
	if err := services.db.Unscoped().Model(&model.KnowledgeBase{}).Where("id = ?", otherKB.ID).Count(&otherKBCount).Error; err != nil {
		t.Fatalf("count other kb: %v", err)
	}
	if ownerKBCount != 0 || otherKBCount != 1 {
		t.Fatalf("expected only owner recycle bin emptied, got owner=%d other=%d", ownerKBCount, otherKBCount)
	}
}

func createWorkspaceUser(t *testing.T, db *gorm.DB, username string) model.User {
	t.Helper()
	user := model.User{
		Username:     username,
		PasswordHash: "hash",
		DisplayName:  username,
	}
	if err := db.Create(&user).Error; err != nil {
		t.Fatalf("create user %s: %v", username, err)
	}
	return user
}

func createWorkspaceCategory(t *testing.T, db *gorm.DB, ownerID uuid.UUID, name string) model.KnowledgeBaseCategory {
	t.Helper()
	category := model.KnowledgeBaseCategory{
		OwnerID: ownerID,
		Name:    name,
	}
	if err := db.Create(&category).Error; err != nil {
		t.Fatalf("create category %s: %v", name, err)
	}
	return category
}

func createWorkspaceKB(t *testing.T, db *gorm.DB, ownerID, categoryID uuid.UUID, name, visibility string, updatedAt time.Time) model.KnowledgeBase {
	t.Helper()
	kb := model.KnowledgeBase{
		Name:        name,
		Description: name + " description",
		OwnerID:     ownerID,
		Visibility:  visibility,
		UpdatedAt:   updatedAt,
	}
	if categoryID != uuid.Nil {
		kb.CategoryID = &categoryID
	}
	if err := db.Create(&kb).Error; err != nil {
		t.Fatalf("create kb %s: %v", name, err)
	}
	return kb
}

func createWorkspaceDocument(t *testing.T, db *gorm.DB, kbID, uploaderID uuid.UUID, filename, status string) model.Document {
	t.Helper()
	document := model.Document{
		KnowledgeBaseID: kbID,
		UploaderID:      uploaderID,
		Filename:        filename,
		FileType:        "pdf",
		FileSize:        1024,
		StoragePath:     "/tmp/" + filename,
		Status:          status,
	}
	if err := db.Create(&document).Error; err != nil {
		t.Fatalf("create document %s: %v", filename, err)
	}
	return document
}

func createWorkspaceQuestion(t *testing.T, db *gorm.DB, kbID, userID uuid.UUID, content string) {
	t.Helper()
	session := createWorkspaceChatSession(t, db, userID, kbID, "test-session")
	message := model.ChatMessage{
		SessionID: session.ID,
		Role:      "user",
		Content:   content,
	}
	if err := db.Create(&message).Error; err != nil {
		t.Fatalf("create chat message: %v", err)
	}
}

func createWorkspaceChatSession(t *testing.T, db *gorm.DB, userID, kbID uuid.UUID, title string) model.ChatSession {
	t.Helper()
	session := model.ChatSession{
		UserID:          userID,
		KnowledgeBaseID: kbID,
		Title:           title,
	}
	if err := db.Create(&session).Error; err != nil {
		t.Fatalf("create chat session: %v", err)
	}
	return session
}

func createWorkspaceChunk(t *testing.T, db *gorm.DB, kbID uuid.UUID, content string) {
	t.Helper()
	var document model.Document
	if err := db.Where("knowledge_base_id = ?", kbID).First(&document).Error; err != nil {
		t.Fatalf("find document for chunk: %v", err)
	}
	chunk := model.DocumentChunk{
		DocumentID:      document.ID,
		KnowledgeBaseID: kbID,
		ChunkIndex:      0,
		Content:         content,
	}
	if err := db.Create(&chunk).Error; err != nil {
		t.Fatalf("create chunk: %v", err)
	}
}

func createWorkspaceDocumentChunk(t *testing.T, db *gorm.DB, kbID, documentID uuid.UUID, index int, content string) model.DocumentChunk {
	t.Helper()
	chunk := model.DocumentChunk{
		DocumentID:      documentID,
		KnowledgeBaseID: kbID,
		ChunkIndex:      index,
		Content:         content,
	}
	if err := db.Create(&chunk).Error; err != nil {
		t.Fatalf("create document chunk: %v", err)
	}
	return chunk
}

func createUploadFile(t *testing.T, filename string, content string) *multipart.FileHeader {
	t.Helper()

	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormFile("file", filename)
	if err != nil {
		t.Fatalf("create form file: %v", err)
	}
	if _, err := part.Write([]byte(content)); err != nil {
		t.Fatalf("write form file: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close multipart writer: %v", err)
	}

	req := httptest.NewRequest("POST", "/upload", &body)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	if err := req.ParseMultipartForm(int64(body.Len()) + 1024); err != nil {
		t.Fatalf("parse multipart form: %v", err)
	}

	files := req.MultipartForm.File["file"]
	if len(files) != 1 {
		t.Fatalf("expected one uploaded file, got %d", len(files))
	}
	return files[0]
}

func mustParseUUID(t *testing.T, value string) uuid.UUID {
	t.Helper()

	id, err := uuid.Parse(value)
	if err != nil {
		t.Fatalf("parse uuid %q: %v", value, err)
	}
	return id
}
