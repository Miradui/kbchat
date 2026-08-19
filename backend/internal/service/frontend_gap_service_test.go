package service

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"testing"
	"time"
	"unicode/utf16"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"rag/backend/internal/apperror"
	"rag/backend/internal/auth"
	"rag/backend/internal/config"
	"rag/backend/internal/dto"
	"rag/backend/internal/model"
	"rag/backend/internal/repository"
	"rag/backend/internal/retrieval"
)

// assertAppError fails unless err is an apperror with the given public code.
func assertAppError(t *testing.T, err error, code string) {
	t.Helper()
	if err == nil {
		t.Fatalf("expected error with code %s, got nil", code)
	}
	var appErr *apperror.Error
	if !errors.As(err, &appErr) {
		t.Fatalf("expected apperror with code %s, got %T: %v", code, err, err)
	}
	if appErr.Code != code {
		t.Fatalf("expected error code %s, got %s (%v)", code, appErr.Code, err)
	}
}

// G1: the session list must filter server side and carry the rail's display data.
func TestChatSessionListFiltersAndEnrichesItems(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, services.db, "owner")
	base := time.Now().Add(-time.Hour)

	productKB := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "product-kb", "private", base)
	supportKB := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "support-kb", "private", base)

	productSession := createWorkspaceChatSession(t, services.db, owner.ID, productKB.ID, "退货政策")
	supportSession := createWorkspaceChatSession(t, services.db, owner.ID, supportKB.ID, "工单流程")
	touchSessionUpdatedAt(t, services.db, productSession.ID, base.Add(2*time.Minute))
	touchSessionUpdatedAt(t, services.db, supportSession.ID, base.Add(time.Minute))

	createChatMessageAt(t, services.db, productSession.ID, "user", "退货政策是什么", base)
	createChatMessageAt(t, services.db, productSession.ID, "assistant", "退货政策规定 30 天内可退。", base.Add(time.Second))

	list, err := services.chats.ListSessions(ctx, owner.ID, dto.ChatSessionListQuery{})
	if err != nil {
		t.Fatalf("list sessions: %v", err)
	}
	if list.Total != 2 || len(list.Items) != 2 {
		t.Fatalf("expected both active sessions, got total=%d items=%#v", list.Total, list.Items)
	}
	if list.Page != 1 || list.PageSize != 20 {
		t.Fatalf("expected default pagination, got page=%d pageSize=%d", list.Page, list.PageSize)
	}
	if list.Items[0].ID != productSession.ID.String() {
		t.Fatalf("expected most recently updated session first, got %#v", list.Items)
	}
	first := list.Items[0]
	if first.KnowledgeBaseName != "product-kb" {
		t.Fatalf("expected knowledge base name on list item, got %#v", first)
	}
	if first.MessageCount == nil || *first.MessageCount != 2 {
		t.Fatalf("expected message count 2, got %#v", first.MessageCount)
	}
	if first.LastMessagePreview != "退货政策规定 30 天内可退。" {
		t.Fatalf("expected latest message preview, got %q", first.LastMessagePreview)
	}
	if list.Items[1].MessageCount == nil || *list.Items[1].MessageCount != 0 {
		t.Fatalf("expected empty session to report zero messages, got %#v", list.Items[1].MessageCount)
	}

	byKB, err := services.chats.ListSessions(ctx, owner.ID, dto.ChatSessionListQuery{KnowledgeBaseID: &supportKB.ID})
	if err != nil {
		t.Fatalf("list sessions by knowledge base: %v", err)
	}
	if byKB.Total != 1 || byKB.Items[0].ID != supportSession.ID.String() {
		t.Fatalf("expected knowledge base filter to narrow the list, got %#v", byKB)
	}

	byQuery, err := services.chats.ListSessions(ctx, owner.ID, dto.ChatSessionListQuery{Q: "工单"})
	if err != nil {
		t.Fatalf("list sessions by keyword: %v", err)
	}
	if byQuery.Total != 1 || byQuery.Items[0].ID != supportSession.ID.String() {
		t.Fatalf("expected title keyword filter, got %#v", byQuery)
	}

	firstPage, err := services.chats.ListSessions(ctx, owner.ID, dto.ChatSessionListQuery{Page: 1, PageSize: 1})
	if err != nil {
		t.Fatalf("list sessions page 1: %v", err)
	}
	secondPage, err := services.chats.ListSessions(ctx, owner.ID, dto.ChatSessionListQuery{Page: 2, PageSize: 1})
	if err != nil {
		t.Fatalf("list sessions page 2: %v", err)
	}
	if firstPage.Total != 2 || secondPage.Total != 2 {
		t.Fatalf("expected stable total across pages, got %d and %d", firstPage.Total, secondPage.Total)
	}
	if len(firstPage.Items) != 1 || len(secondPage.Items) != 1 {
		t.Fatalf("expected one item per page, got %#v and %#v", firstPage.Items, secondPage.Items)
	}
	if firstPage.Items[0].ID == secondPage.Items[0].ID {
		t.Fatalf("expected distinct pages, both returned %s", firstPage.Items[0].ID)
	}
}

// G1: previews are bounded so a long answer cannot dominate the list payload.
func TestChatSessionListTruncatesLongPreview(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, services.db, "owner")
	kb := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "product-kb", "private", time.Now())
	session := createWorkspaceChatSession(t, services.db, owner.ID, kb.ID, "长回答")
	createChatMessageAt(t, services.db, session.ID, "assistant", strings.Repeat("政", 400), time.Now())

	list, err := services.chats.ListSessions(ctx, owner.ID, dto.ChatSessionListQuery{})
	if err != nil {
		t.Fatalf("list sessions: %v", err)
	}
	preview := []rune(list.Items[0].LastMessagePreview)
	if len(preview) != chatSessionPreviewRunes+1 {
		t.Fatalf("expected preview truncated to %d runes plus ellipsis, got %d", chatSessionPreviewRunes, len(preview))
	}
	if preview[len(preview)-1] != '…' {
		t.Fatalf("expected ellipsis suffix, got %q", string(preview[len(preview)-1]))
	}
}

// G1 + G3: archived sessions leave the default list, and unarchive puts them back.
func TestChatSessionArchivedFilterAndUnarchive(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, services.db, "owner")
	other := createWorkspaceUser(t, services.db, "other")
	kb := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "product-kb", "private", time.Now())
	session := createWorkspaceChatSession(t, services.db, owner.ID, kb.ID, "archive me")

	if _, err := services.chats.ArchiveSession(ctx, owner.ID, session.ID); err != nil {
		t.Fatalf("archive session: %v", err)
	}

	active, err := services.chats.ListSessions(ctx, owner.ID, dto.ChatSessionListQuery{})
	if err != nil {
		t.Fatalf("list active sessions: %v", err)
	}
	if active.Total != 0 {
		t.Fatalf("expected archived session hidden by default, got %#v", active.Items)
	}

	archived, err := services.chats.ListSessions(ctx, owner.ID, dto.ChatSessionListQuery{Archived: true})
	if err != nil {
		t.Fatalf("list archived sessions: %v", err)
	}
	if archived.Total != 1 || archived.Items[0].ID != session.ID.String() {
		t.Fatalf("expected archived filter to surface the session, got %#v", archived)
	}
	if archived.Items[0].ArchivedAt == nil {
		t.Fatalf("expected archivedAt on archived list item, got %#v", archived.Items[0])
	}

	if _, err := services.chats.UnarchiveSession(ctx, other.ID, session.ID); err == nil {
		t.Fatalf("expected foreign user unarchive to be rejected")
	}

	restored, err := services.chats.UnarchiveSession(ctx, owner.ID, session.ID)
	if err != nil {
		t.Fatalf("unarchive session: %v", err)
	}
	if restored.ArchivedAt != nil {
		t.Fatalf("expected archivedAt cleared, got %#v", restored)
	}

	idempotent, err := services.chats.UnarchiveSession(ctx, owner.ID, session.ID)
	if err != nil {
		t.Fatalf("unarchive session idempotently: %v", err)
	}
	if idempotent.ArchivedAt != nil {
		t.Fatalf("expected repeated unarchive to stay cleared, got %#v", idempotent)
	}

	back, err := services.chats.ListSessions(ctx, owner.ID, dto.ChatSessionListQuery{})
	if err != nil {
		t.Fatalf("list sessions after unarchive: %v", err)
	}
	if back.Total != 1 || back.Items[0].ID != session.ID.String() {
		t.Fatalf("expected unarchived session back in the default list, got %#v", back)
	}
}

// G4: the tag list reports how many knowledge bases block deletion.
func TestKnowledgeBaseTagListReportsKnowledgeBaseCount(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, services.db, "owner")
	other := createWorkspaceUser(t, services.db, "other")

	used, err := services.tags.Create(ctx, owner.ID, "product")
	if err != nil {
		t.Fatalf("create used tag: %v", err)
	}
	if used.KnowledgeBaseCount == nil || *used.KnowledgeBaseCount != 0 {
		t.Fatalf("expected new tag to report zero usage, got %#v", used.KnowledgeBaseCount)
	}
	unused, err := services.tags.Create(ctx, owner.ID, "draft")
	if err != nil {
		t.Fatalf("create unused tag: %v", err)
	}

	for _, name := range []string{"kb-a", "kb-b"} {
		if _, err := services.kbs.Create(ctx, owner.ID, dto.KnowledgeBaseRequest{
			Name:       name,
			Visibility: "private",
			TagIDs:     uuidSlicePtr(used.ID),
		}); err != nil {
			t.Fatalf("create tagged knowledge base %s: %v", name, err)
		}
	}

	list, err := services.tags.List(ctx, owner.ID)
	if err != nil {
		t.Fatalf("list tags: %v", err)
	}
	counts := make(map[uuid.UUID]int64, len(list.Items))
	for _, item := range list.Items {
		if item.KnowledgeBaseCount == nil {
			t.Fatalf("expected knowledgeBaseCount on every list item, got %#v", item)
		}
		counts[item.ID] = *item.KnowledgeBaseCount
	}
	if counts[used.ID] != 2 {
		t.Fatalf("expected used tag count 2, got %d", counts[used.ID])
	}
	if counts[unused.ID] != 0 {
		t.Fatalf("expected unused tag count 0, got %d", counts[unused.ID])
	}

	// The reported count must predict the TAG_NOT_EMPTY guard exactly.
	if err := services.tags.Delete(ctx, owner.ID, used.ID); err == nil {
		t.Fatalf("expected deleting a tag with usage to be rejected")
	}
	if err := services.tags.Delete(ctx, owner.ID, unused.ID); err != nil {
		t.Fatalf("expected deleting a tag with zero usage to succeed, got %v", err)
	}

	foreign, err := services.tags.List(ctx, other.ID)
	if err != nil {
		t.Fatalf("list foreign tags: %v", err)
	}
	if len(foreign.Items) != 0 {
		t.Fatalf("expected tag list to stay owner scoped, got %#v", foreign.Items)
	}
}

// G5: the category tree carries both direct and rolled-up knowledge base counts.
func TestKnowledgeBaseCategoryTreeReportsCounts(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, services.db, "owner")

	parent := createWorkspaceCategory(t, services.db, owner.ID, "产品")
	child := createWorkspaceCategory(t, services.db, owner.ID, "产品手册")
	grandchild := createWorkspaceCategory(t, services.db, owner.ID, "旧版手册")
	empty := createWorkspaceCategory(t, services.db, owner.ID, "空分类")
	reparent(t, services.db, child.ID, parent.ID)
	reparent(t, services.db, grandchild.ID, child.ID)

	now := time.Now()
	createWorkspaceKB(t, services.db, owner.ID, parent.ID, "parent-kb", "private", now)
	createWorkspaceKB(t, services.db, owner.ID, child.ID, "child-kb-a", "private", now)
	createWorkspaceKB(t, services.db, owner.ID, child.ID, "child-kb-b", "private", now)
	createWorkspaceKB(t, services.db, owner.ID, grandchild.ID, "grandchild-kb", "private", now)
	deleted := createWorkspaceKB(t, services.db, owner.ID, parent.ID, "recycled-kb", "private", now)
	if err := services.db.Delete(&deleted).Error; err != nil {
		t.Fatalf("soft delete knowledge base: %v", err)
	}

	tree, err := services.categories.ListTree(ctx, owner.ID)
	if err != nil {
		t.Fatalf("list category tree: %v", err)
	}

	nodes := flattenCategories(tree.Items)
	assertCategoryCounts(t, nodes, parent.ID, 1, 4)
	assertCategoryCounts(t, nodes, child.ID, 2, 3)
	assertCategoryCounts(t, nodes, grandchild.ID, 1, 1)
	assertCategoryCounts(t, nodes, empty.ID, 0, 0)
}

func assertCategoryCounts(t *testing.T, nodes map[uuid.UUID]dto.KnowledgeBaseCategoryResponse, id uuid.UUID, direct, total int64) {
	t.Helper()
	node, ok := nodes[id]
	if !ok {
		t.Fatalf("category %s missing from tree", id)
	}
	if node.DirectCount == nil || node.TotalCount == nil {
		t.Fatalf("expected counts on category %s, got %#v", node.Name, node)
	}
	if *node.DirectCount != direct || *node.TotalCount != total {
		t.Fatalf("category %s: expected direct=%d total=%d, got direct=%d total=%d",
			node.Name, direct, total, *node.DirectCount, *node.TotalCount)
	}
}

func flattenCategories(items []dto.KnowledgeBaseCategoryResponse) map[uuid.UUID]dto.KnowledgeBaseCategoryResponse {
	result := make(map[uuid.UUID]dto.KnowledgeBaseCategoryResponse)
	var walk func([]dto.KnowledgeBaseCategoryResponse)
	walk = func(nodes []dto.KnowledgeBaseCategoryResponse) {
		for i := range nodes {
			result[nodes[i].ID] = nodes[i]
			walk(nodes[i].Children)
		}
	}
	walk(items)
	return result
}

func reparent(t *testing.T, db *gorm.DB, id, parentID uuid.UUID) {
	t.Helper()
	if err := db.Model(&model.KnowledgeBaseCategory{}).
		Where("id = ?", id).
		Update("parent_id", parentID).Error; err != nil {
		t.Fatalf("reparent category: %v", err)
	}
}

func touchSessionUpdatedAt(t *testing.T, db *gorm.DB, sessionID uuid.UUID, updatedAt time.Time) {
	t.Helper()
	if err := db.Model(&model.ChatSession{}).
		Where("id = ?", sessionID).
		Update("updated_at", updatedAt).Error; err != nil {
		t.Fatalf("touch session updated_at: %v", err)
	}
}

func createChatMessageAt(t *testing.T, db *gorm.DB, sessionID uuid.UUID, role, content string, createdAt time.Time) {
	t.Helper()
	message := model.ChatMessage{
		SessionID: sessionID,
		Role:      role,
		Content:   content,
		CreatedAt: createdAt,
	}
	if err := db.Create(&message).Error; err != nil {
		t.Fatalf("create chat message: %v", err)
	}
}

// G20: the scoped document list must accept the same query surface as the global
// one while staying pinned to its knowledge base.
func TestScopedDocumentListMatchesGlobalQuerySurface(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, services.db, "owner")
	other := createWorkspaceUser(t, services.db, "other")
	now := time.Now()

	kb := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "product-kb", "private", now)
	otherKB := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "support-kb", "private", now)
	foreignKB := createWorkspaceKB(t, services.db, other.ID, uuid.Nil, "foreign-kb", "private", now)

	createWorkspaceDocument(t, services.db, kb.ID, owner.ID, "handbook.pdf", "completed")
	createWorkspaceDocument(t, services.db, kb.ID, owner.ID, "policy.pdf", "completed")
	createWorkspaceDocument(t, services.db, kb.ID, owner.ID, "draft.pdf", "failed")
	createWorkspaceDocument(t, services.db, otherKB.ID, owner.ID, "handbook.pdf", "completed")

	all, err := services.documents.List(ctx, owner.ID, kb.ID, dto.GlobalDocumentListQuery{})
	if err != nil {
		t.Fatalf("list scoped documents: %v", err)
	}
	if all.Total != 3 || len(all.Items) != 3 {
		t.Fatalf("expected only this knowledge base's documents, got total=%d items=%#v", all.Total, all.Items)
	}
	if all.Page != 1 || all.PageSize != 20 {
		t.Fatalf("expected default pagination, got page=%d pageSize=%d", all.Page, all.PageSize)
	}
	for _, item := range all.Items {
		if item.KnowledgeBaseID != kb.ID.String() {
			t.Fatalf("expected scoped items only, got %#v", item)
		}
		if item.KnowledgeBaseName != "product-kb" {
			t.Fatalf("expected knowledge base name on scoped items, got %#v", item)
		}
	}

	filtered, err := services.documents.List(ctx, owner.ID, kb.ID, dto.GlobalDocumentListQuery{Status: "failed"})
	if err != nil {
		t.Fatalf("list scoped documents by status: %v", err)
	}
	if filtered.Total != 1 || filtered.Items[0].Filename != "draft.pdf" {
		t.Fatalf("expected status filter to apply, got %#v", filtered)
	}

	searched, err := services.documents.List(ctx, owner.ID, kb.ID, dto.GlobalDocumentListQuery{Q: "policy"})
	if err != nil {
		t.Fatalf("list scoped documents by keyword: %v", err)
	}
	if searched.Total != 1 || searched.Items[0].Filename != "policy.pdf" {
		t.Fatalf("expected keyword filter to apply, got %#v", searched)
	}

	paged, err := services.documents.List(ctx, owner.ID, kb.ID, dto.GlobalDocumentListQuery{Page: 1, PageSize: 2})
	if err != nil {
		t.Fatalf("list scoped documents page 1: %v", err)
	}
	if paged.Total != 3 || len(paged.Items) != 2 {
		t.Fatalf("expected paging with stable total, got %#v", paged)
	}

	// A knowledge base the caller does not own must stay a 404, not an empty page.
	if _, err := services.documents.List(ctx, owner.ID, foreignKB.ID, dto.GlobalDocumentListQuery{}); err == nil {
		t.Fatalf("expected foreign knowledge base to be rejected")
	}
}

// G6: capabilities must report the same limits the request path enforces.
func TestSystemCapabilitiesReportEnforcedLimits(t *testing.T) {
	cfg := config.Config{RerankEnabled: true, MaxUploadSizeMB: 50}
	res := NewSystemService(cfg).Capabilities()

	if !res.RerankEnabled {
		t.Fatalf("expected rerankEnabled to follow config, got %#v", res)
	}
	if res.Upload.MaxFileBytes != 50*1024*1024 {
		t.Fatalf("expected upload limit derived from MaxUploadSizeMB, got %d", res.Upload.MaxFileBytes)
	}
	if len(res.Upload.AllowedExtensions) != len(AllowedDocumentExtensions) {
		t.Fatalf("expected the enforced allow list, got %#v", res.Upload.AllowedExtensions)
	}
	for i, ext := range AllowedDocumentExtensions {
		if res.Upload.AllowedExtensions[i] != ext {
			t.Fatalf("expected allow list to match validateFile, got %#v", res.Upload.AllowedExtensions)
		}
	}
	if res.Retrieval.MaxVectorTopN != retrieval.MaxVectorTopN || res.Retrieval.MaxRerankTopK != retrieval.MaxRerankTopK {
		t.Fatalf("expected retrieval ceilings to match the retrieval package, got %#v", res.Retrieval)
	}

	// The response must not alias the package-level allow list.
	res.Upload.AllowedExtensions[0] = "mutated"
	if AllowedDocumentExtensions[0] == "mutated" {
		t.Fatalf("capabilities response must not alias AllowedDocumentExtensions")
	}

	disabled := NewSystemService(config.Config{RerankEnabled: false, MaxUploadSizeMB: 10}).Capabilities()
	if disabled.RerankEnabled {
		t.Fatalf("expected rerankEnabled false, got %#v", disabled)
	}
	if disabled.Upload.MaxFileBytes != 10*1024*1024 {
		t.Fatalf("expected upload limit to track config, got %d", disabled.Upload.MaxFileBytes)
	}
}

// G12: batch tagging covers the three modes and shares the all-or-nothing
// contract of the other batch endpoints.
func TestKnowledgeBaseBatchTagAppliesEveryMode(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, services.db, "owner")
	base := time.Now().Add(-time.Hour)

	first := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "first", "private", base)
	second := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "second", "private", base)

	product, err := services.tags.Create(ctx, owner.ID, "product")
	if err != nil {
		t.Fatalf("create product tag: %v", err)
	}
	support, err := services.tags.Create(ctx, owner.ID, "support")
	if err != nil {
		t.Fatalf("create support tag: %v", err)
	}
	archive, err := services.tags.Create(ctx, owner.ID, "archive")
	if err != nil {
		t.Fatalf("create archive tag: %v", err)
	}

	ids := []uuid.UUID{first.ID, second.ID}
	added, err := services.kbs.BatchTag(ctx, owner.ID, dto.KnowledgeBaseBatchTagRequest{
		KnowledgeBaseIDs: ids,
		TagIDs:           []uuid.UUID{product.ID, support.ID},
		Mode:             dto.KnowledgeBaseBatchTagModeAdd,
	})
	if err != nil {
		t.Fatalf("batch add tags: %v", err)
	}
	if added.ProcessedCount != 2 {
		t.Fatalf("expected two processed knowledge bases, got %#v", added)
	}
	assertKnowledgeBaseTagNames(t, services, owner.ID, first.ID, []string{"product", "support"})
	assertKnowledgeBaseTagNames(t, services, owner.ID, second.ID, []string{"product", "support"})

	// Re-adding a bound tag stays idempotent instead of erroring on the
	// composite primary key.
	if _, err := services.kbs.BatchTag(ctx, owner.ID, dto.KnowledgeBaseBatchTagRequest{
		KnowledgeBaseIDs: ids,
		TagIDs:           []uuid.UUID{product.ID},
		Mode:             dto.KnowledgeBaseBatchTagModeAdd,
	}); err != nil {
		t.Fatalf("re-adding an existing tag should be idempotent: %v", err)
	}
	assertKnowledgeBaseTagNames(t, services, owner.ID, first.ID, []string{"product", "support"})

	if _, err := services.kbs.BatchTag(ctx, owner.ID, dto.KnowledgeBaseBatchTagRequest{
		KnowledgeBaseIDs: []uuid.UUID{first.ID},
		TagIDs:           []uuid.UUID{support.ID},
		Mode:             dto.KnowledgeBaseBatchTagModeRemove,
	}); err != nil {
		t.Fatalf("batch remove tags: %v", err)
	}
	assertKnowledgeBaseTagNames(t, services, owner.ID, first.ID, []string{"product"})
	assertKnowledgeBaseTagNames(t, services, owner.ID, second.ID, []string{"product", "support"})

	if _, err := services.kbs.BatchTag(ctx, owner.ID, dto.KnowledgeBaseBatchTagRequest{
		KnowledgeBaseIDs: ids,
		TagIDs:           []uuid.UUID{archive.ID},
		Mode:             dto.KnowledgeBaseBatchTagModeReplace,
	}); err != nil {
		t.Fatalf("batch replace tags: %v", err)
	}
	assertKnowledgeBaseTagNames(t, services, owner.ID, first.ID, []string{"archive"})
	assertKnowledgeBaseTagNames(t, services, owner.ID, second.ID, []string{"archive"})

	// Only replace has a meaningful empty payload: it clears every tag.
	if _, err := services.kbs.BatchTag(ctx, owner.ID, dto.KnowledgeBaseBatchTagRequest{
		KnowledgeBaseIDs: ids,
		TagIDs:           nil,
		Mode:             dto.KnowledgeBaseBatchTagModeReplace,
	}); err != nil {
		t.Fatalf("batch replace with empty tags: %v", err)
	}
	assertKnowledgeBaseTagNames(t, services, owner.ID, first.ID, nil)
	assertKnowledgeBaseTagNames(t, services, owner.ID, second.ID, nil)
}

// G12: an unowned knowledge base or tag anywhere in the payload fails the whole
// batch without leaving a partial change behind.
func TestKnowledgeBaseBatchTagIsAllOrNothing(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, services.db, "owner")
	other := createWorkspaceUser(t, services.db, "other")
	base := time.Now().Add(-time.Hour)

	mine := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "mine", "private", base)
	theirs := createWorkspaceKB(t, services.db, other.ID, uuid.Nil, "theirs", "private", base)

	mineTag, err := services.tags.Create(ctx, owner.ID, "product")
	if err != nil {
		t.Fatalf("create owner tag: %v", err)
	}
	theirTag, err := services.tags.Create(ctx, other.ID, "foreign")
	if err != nil {
		t.Fatalf("create foreign tag: %v", err)
	}

	_, err = services.kbs.BatchTag(ctx, owner.ID, dto.KnowledgeBaseBatchTagRequest{
		KnowledgeBaseIDs: []uuid.UUID{mine.ID, theirs.ID},
		TagIDs:           []uuid.UUID{mineTag.ID},
		Mode:             dto.KnowledgeBaseBatchTagModeAdd,
	})
	assertAppError(t, err, "KNOWLEDGE_BASE_NOT_FOUND")
	assertKnowledgeBaseTagNames(t, services, owner.ID, mine.ID, nil)

	_, err = services.kbs.BatchTag(ctx, owner.ID, dto.KnowledgeBaseBatchTagRequest{
		KnowledgeBaseIDs: []uuid.UUID{mine.ID},
		TagIDs:           []uuid.UUID{mineTag.ID, theirTag.ID},
		Mode:             dto.KnowledgeBaseBatchTagModeAdd,
	})
	assertAppError(t, err, "TAG_NOT_FOUND")
	assertKnowledgeBaseTagNames(t, services, owner.ID, mine.ID, nil)

	_, err = services.kbs.BatchTag(ctx, owner.ID, dto.KnowledgeBaseBatchTagRequest{
		KnowledgeBaseIDs: []uuid.UUID{mine.ID},
		TagIDs:           []uuid.UUID{mineTag.ID},
		Mode:             "toggle",
	})
	assertAppError(t, err, "INVALID_BATCH_TAG_MODE")

	_, err = services.kbs.BatchTag(ctx, owner.ID, dto.KnowledgeBaseBatchTagRequest{
		KnowledgeBaseIDs: []uuid.UUID{mine.ID},
		TagIDs:           nil,
		Mode:             dto.KnowledgeBaseBatchTagModeAdd,
	})
	assertAppError(t, err, "VALIDATION_ERROR")

	_, err = services.kbs.BatchTag(ctx, owner.ID, dto.KnowledgeBaseBatchTagRequest{
		KnowledgeBaseIDs: nil,
		TagIDs:           []uuid.UUID{mineTag.ID},
		Mode:             dto.KnowledgeBaseBatchTagModeAdd,
	})
	assertAppError(t, err, "VALIDATION_ERROR")

	// An omitted mode defaults to add rather than silently clearing tags.
	if _, err := services.kbs.BatchTag(ctx, owner.ID, dto.KnowledgeBaseBatchTagRequest{
		KnowledgeBaseIDs: []uuid.UUID{mine.ID},
		TagIDs:           []uuid.UUID{mineTag.ID},
	}); err != nil {
		t.Fatalf("default mode should add: %v", err)
	}
	assertKnowledgeBaseTagNames(t, services, owner.ID, mine.ID, []string{"product"})
}

func assertKnowledgeBaseTagNames(t *testing.T, services workspaceTestServices, ownerID, kbID uuid.UUID, want []string) {
	t.Helper()
	res, err := services.kbs.Get(context.Background(), ownerID, kbID)
	if err != nil {
		t.Fatalf("get knowledge base: %v", err)
	}
	got := make([]string, 0, len(res.Tags))
	for _, tag := range res.Tags {
		got = append(got, tag.Name)
	}
	if len(got) != len(want) {
		t.Fatalf("expected tags %v, got %v", want, got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("expected tags %v, got %v", want, got)
		}
	}
}

// G11: profile updates are limited to the presentation fields and reject values
// the storage layer or the UI cannot safely take.
func TestAuthUpdateProfileValidatesAndPersists(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	user := createWorkspaceUser(t, services.db, "owner")

	res, err := services.auth.UpdateProfile(ctx, user.ID, dto.UpdateProfileRequest{
		DisplayName: "  产品团队  ",
		AvatarURL:   "https://cdn.example.com/a.png",
	})
	if err != nil {
		t.Fatalf("update profile: %v", err)
	}
	if res.DisplayName != "产品团队" {
		t.Fatalf("expected trimmed display name, got %q", res.DisplayName)
	}
	if res.Username != "owner" {
		t.Fatalf("username must stay untouched, got %q", res.Username)
	}

	reloaded, err := services.auth.Me(ctx, user.ID)
	if err != nil {
		t.Fatalf("reload profile: %v", err)
	}
	if reloaded.DisplayName != "产品团队" || reloaded.AvatarURL != "https://cdn.example.com/a.png" {
		t.Fatalf("expected profile to persist, got %#v", reloaded)
	}

	_, err = services.auth.UpdateProfile(ctx, user.ID, dto.UpdateProfileRequest{DisplayName: "  "})
	assertAppError(t, err, "VALIDATION_ERROR")

	_, err = services.auth.UpdateProfile(ctx, user.ID, dto.UpdateProfileRequest{
		DisplayName: strings.Repeat("名", MaxDisplayNameLength+1),
	})
	assertAppError(t, err, "VALIDATION_ERROR")

	// The display name limit is counted in runes, not bytes.
	if _, err := services.auth.UpdateProfile(ctx, user.ID, dto.UpdateProfileRequest{
		DisplayName: strings.Repeat("名", MaxDisplayNameLength),
	}); err != nil {
		t.Fatalf("expected rune-counted display name limit, got %v", err)
	}

	for _, avatar := range []string{"javascript:alert(1)", "data:text/html,payload", "//evil.example.com/a.png"} {
		_, err := services.auth.UpdateProfile(ctx, user.ID, dto.UpdateProfileRequest{
			DisplayName: "owner",
			AvatarURL:   avatar,
		})
		if err == nil {
			t.Fatalf("expected avatar %q to be rejected", avatar)
		}
		assertAppError(t, err, "VALIDATION_ERROR")
	}

	for _, avatar := range []string{"", "/static/avatar.png", "http://example.com/a.png"} {
		if _, err := services.auth.UpdateProfile(ctx, user.ID, dto.UpdateProfileRequest{
			DisplayName: "owner",
			AvatarURL:   avatar,
		}); err != nil {
			t.Fatalf("expected avatar %q to be accepted, got %v", avatar, err)
		}
	}
}

// G11: changing the password requires proving the current one, and the stored
// hash actually rotates.
func TestAuthChangePasswordRequiresCurrentPassword(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	user := createWorkspaceUser(t, services.db, "owner")

	hash, err := auth.HashPassword("current-secret")
	if err != nil {
		t.Fatalf("hash password: %v", err)
	}
	if err := services.db.Model(&model.User{}).Where("id = ?", user.ID).Update("password_hash", hash).Error; err != nil {
		t.Fatalf("seed password: %v", err)
	}

	err = services.auth.ChangePassword(ctx, user.ID, dto.ChangePasswordRequest{
		CurrentPassword: "wrong-secret",
		NewPassword:     "next-secret",
	})
	assertAppError(t, err, "INVALID_CURRENT_PASSWORD")

	err = services.auth.ChangePassword(ctx, user.ID, dto.ChangePasswordRequest{
		CurrentPassword: "current-secret",
		NewPassword:     strings.Repeat("a", MinPasswordLength-1),
	})
	assertAppError(t, err, "VALIDATION_ERROR")

	err = services.auth.ChangePassword(ctx, user.ID, dto.ChangePasswordRequest{
		CurrentPassword: "current-secret",
		NewPassword:     "current-secret",
	})
	assertAppError(t, err, "PASSWORD_UNCHANGED")

	if err := services.auth.ChangePassword(ctx, user.ID, dto.ChangePasswordRequest{
		CurrentPassword: "current-secret",
		NewPassword:     "next-secret",
	}); err != nil {
		t.Fatalf("change password: %v", err)
	}

	if _, err := services.auth.Login(ctx, dto.LoginRequest{Username: "owner", Password: "current-secret"}); err == nil {
		t.Fatalf("expected the old password to stop working")
	}
	if _, err := services.auth.Login(ctx, dto.LoginRequest{Username: "owner", Password: "next-secret"}); err != nil {
		t.Fatalf("expected the new password to work: %v", err)
	}
}

func TestAuthChangePasswordEnforcesBcryptUTF8ByteLimit(t *testing.T) {
	tests := []struct {
		name        string
		newPassword string
		wantError   bool
	}{
		{name: "72 ASCII bytes succeed", newPassword: strings.Repeat("a", 72)},
		{name: "73 ASCII bytes are rejected", newPassword: strings.Repeat("a", 73), wantError: true},
		{name: "24 Chinese characters are 72 bytes", newPassword: strings.Repeat("界", 24)},
		{name: "25 Chinese characters are 75 bytes", newPassword: strings.Repeat("界", 25), wantError: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ctx := context.Background()
			services := newWorkspaceTestServices(t)
			user := createWorkspaceUser(t, services.db, "owner")
			currentPassword := "current-secret"
			hash, err := auth.HashPassword(currentPassword)
			if err != nil {
				t.Fatalf("hash current password: %v", err)
			}
			if err := services.db.Model(&model.User{}).
				Where("id = ?", user.ID).
				Update("password_hash", hash).Error; err != nil {
				t.Fatalf("seed current password: %v", err)
			}

			err = services.auth.ChangePassword(ctx, user.ID, dto.ChangePasswordRequest{
				CurrentPassword: currentPassword,
				NewPassword:     tt.newPassword,
			})
			if tt.wantError {
				assertAppError(t, err, "VALIDATION_ERROR")
				var appErr *apperror.Error
				if !errors.As(err, &appErr) || appErr.Status != 400 {
					t.Fatalf("expected a stable 4xx validation error, got %v", err)
				}
				if _, loginErr := services.auth.Login(ctx, dto.LoginRequest{
					Username: "owner",
					Password: currentPassword,
				}); loginErr != nil {
					t.Fatalf("rejected password must leave the old password valid: %v", loginErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("change password: %v", err)
			}
			if _, loginErr := services.auth.Login(ctx, dto.LoginRequest{
				Username: "owner",
				Password: tt.newPassword,
			}); loginErr != nil {
				t.Fatalf("expected boundary password to work: %v", loginErr)
			}
		})
	}
}

func TestAuthProfileSaveCannotRestoreAStalePasswordHash(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	services.db.Config.SkipDefaultTransaction = true
	sqlDB, err := services.db.DB()
	if err != nil {
		t.Fatalf("get sql database: %v", err)
	}
	sqlDB.SetMaxOpenConns(1)

	user := createWorkspaceUser(t, services.db, "owner")
	currentPassword := "current-secret"
	nextPassword := "next-secret"
	hash, err := auth.HashPassword(currentPassword)
	if err != nil {
		t.Fatalf("hash current password: %v", err)
	}
	if err := services.db.Model(&model.User{}).
		Where("id = ?", user.ID).
		Update("password_hash", hash).Error; err != nil {
		t.Fatalf("seed current password: %v", err)
	}

	profileUpdateBlocked := make(chan struct{})
	releaseProfileUpdate := make(chan struct{})
	callbackName := "test:block_stale_profile_update"
	if err := services.db.Callback().Update().Before("gorm:update").Register(callbackName, func(tx *gorm.DB) {
		values, ok := tx.Statement.Dest.(map[string]any)
		if !ok || values["display_name"] != "Profile After Password Change" {
			return
		}
		select {
		case <-profileUpdateBlocked:
		default:
			close(profileUpdateBlocked)
		}
		<-releaseProfileUpdate
	}); err != nil {
		t.Fatalf("register profile update callback: %v", err)
	}
	defer services.db.Callback().Update().Remove(callbackName)

	type profileResult struct {
		profile *dto.UserResponse
		err     error
	}
	profileDone := make(chan profileResult, 1)
	go func() {
		profile, profileErr := services.auth.UpdateProfile(ctx, user.ID, dto.UpdateProfileRequest{
			DisplayName: "Profile After Password Change",
			AvatarURL:   "/avatar.png",
		})
		profileDone <- profileResult{profile: profile, err: profileErr}
	}()

	select {
	case <-profileUpdateBlocked:
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for stale profile update")
	}

	if err := services.auth.ChangePassword(ctx, user.ID, dto.ChangePasswordRequest{
		CurrentPassword: currentPassword,
		NewPassword:     nextPassword,
	}); err != nil {
		close(releaseProfileUpdate)
		t.Fatalf("change password while profile save is paused: %v", err)
	}
	close(releaseProfileUpdate)

	var saved profileResult
	select {
	case saved = <-profileDone:
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for profile save")
	}
	if saved.err != nil {
		t.Fatalf("save profile: %v", saved.err)
	}
	if saved.profile == nil || saved.profile.DisplayName != "Profile After Password Change" || saved.profile.AvatarURL != "/avatar.png" {
		t.Fatalf("expected profile fields to save, got %#v", saved.profile)
	}

	if _, err := services.auth.Login(ctx, dto.LoginRequest{Username: "owner", Password: nextPassword}); err != nil {
		t.Fatalf("expected the new password to remain valid after stale profile save: %v", err)
	}
	if _, err := services.auth.Login(ctx, dto.LoginRequest{Username: "owner", Password: currentPassword}); err == nil {
		t.Fatal("expected the old password to remain invalid")
	}
}

// G11: the account limits the frontend validates against are the ones this path
// enforces, not a second copy.
func TestSystemCapabilitiesReportAccountLimits(t *testing.T) {
	res := NewSystemService(config.Config{MaxUploadSizeMB: 20}).Capabilities()
	if res.Account.MinPasswordLength != MinPasswordLength ||
		res.Account.MaxPasswordBytes != auth.MaxPasswordBytes ||
		res.Account.MaxDisplayNameLength != MaxDisplayNameLength ||
		res.Account.MaxAvatarURLLength != MaxAvatarURLLength {
		t.Fatalf("expected account limits to match the service constants, got %#v", res.Account)
	}
}

// G13: per knowledge base stats stay scoped to that knowledge base and to the
// caller, and never leak into the detail payload.
func TestKnowledgeBaseDetailStatsAreScopedToOneKnowledgeBase(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, services.db, "owner")
	other := createWorkspaceUser(t, services.db, "other")
	base := time.Now().Add(-time.Hour)

	target := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "target", "private", base)
	neighbour := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "neighbour", "private", base)
	foreign := createWorkspaceKB(t, services.db, other.ID, uuid.Nil, "foreign", "private", base)

	createWorkspaceDocument(t, services.db, target.ID, owner.ID, "a.pdf", "completed")
	createWorkspaceDocument(t, services.db, target.ID, owner.ID, "b.pdf", "completed")
	createWorkspaceDocument(t, services.db, neighbour.ID, owner.ID, "c.pdf", "completed")

	createWorkspaceQuestion(t, services.db, target.ID, owner.ID, "问题一")
	createWorkspaceQuestion(t, services.db, neighbour.ID, owner.ID, "问题二")

	if err := services.kbs.RecordView(ctx, owner.ID, target.ID); err != nil {
		t.Fatalf("record view: %v", err)
	}
	if err := services.kbs.RecordView(ctx, owner.ID, neighbour.ID); err != nil {
		t.Fatalf("record neighbour view: %v", err)
	}

	res, err := services.kbs.DetailStats(ctx, owner.ID, target.ID, "month")
	if err != nil {
		t.Fatalf("detail stats: %v", err)
	}
	if res.KnowledgeBaseID != target.ID.String() || res.Period != "month" {
		t.Fatalf("unexpected stats envelope: %#v", res)
	}
	if res.Documents.Value != 2 {
		t.Fatalf("expected only this knowledge base documents, got %#v", res.Documents)
	}
	if res.Questions.Value != 1 {
		t.Fatalf("expected only this knowledge base questions, got %#v", res.Questions)
	}
	if res.Views.Value != 1 {
		t.Fatalf("expected only this knowledge base views, got %#v", res.Views)
	}

	global, err := services.kbs.Stats(ctx, owner.ID, "month")
	if err != nil {
		t.Fatalf("global stats: %v", err)
	}
	if global.Documents.Value != 3 {
		t.Fatalf("expected the global view to still count every document, got %#v", global.Documents)
	}

	// An unknown period falls back to month, matching the global endpoint.
	fallback, err := services.kbs.DetailStats(ctx, owner.ID, target.ID, "century")
	if err != nil {
		t.Fatalf("detail stats fallback: %v", err)
	}
	if fallback.Period != "month" {
		t.Fatalf("expected unknown period to fall back to month, got %q", fallback.Period)
	}

	_, err = services.kbs.DetailStats(ctx, owner.ID, foreign.ID, "month")
	assertAppError(t, err, "KNOWLEDGE_BASE_NOT_FOUND")

	// The detail payload itself must stay free of these aggregates.
	detail, err := services.kbs.Get(ctx, owner.ID, target.ID)
	if err != nil {
		t.Fatalf("get knowledge base: %v", err)
	}
	encoded, err := json.Marshal(detail)
	if err != nil {
		t.Fatalf("marshal detail: %v", err)
	}
	var payload map[string]any
	if err := json.Unmarshal(encoded, &payload); err != nil {
		t.Fatalf("unmarshal detail: %v", err)
	}
	for _, field := range []string{"viewCount", "questionCount"} {
		if _, ok := payload[field]; ok {
			t.Fatalf("detail response must not carry %s, got %v", field, payload)
		}
	}
}

// G7: renaming keeps the extension so fileType and the parser stay in agreement.
func TestDocumentUpdateRenamesWithinTheSameExtension(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, services.db, "owner")
	base := time.Now().Add(-time.Hour)
	kb := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "kb", "private", base)
	document := createWorkspaceDocument(t, services.db, kb.ID, owner.ID, "报告.pdf", "completed")

	res, err := services.documents.Update(ctx, owner.ID, document.ID, dto.DocumentUpdateRequest{
		Filename: "  季度报告.pdf  ",
	})
	if err != nil {
		t.Fatalf("rename document: %v", err)
	}
	if res.Filename != "季度报告.pdf" {
		t.Fatalf("expected trimmed filename, got %q", res.Filename)
	}
	if res.KnowledgeBaseID != kb.ID.String() {
		t.Fatalf("rename must not move the document, got %#v", res)
	}

	_, err = services.documents.Update(ctx, owner.ID, document.ID, dto.DocumentUpdateRequest{
		Filename: "季度报告.txt",
	})
	assertAppError(t, err, "DOCUMENT_EXTENSION_IMMUTABLE")

	_, err = services.documents.Update(ctx, owner.ID, document.ID, dto.DocumentUpdateRequest{
		Filename: "../etc/passwd.pdf",
	})
	assertAppError(t, err, "VALIDATION_ERROR")

	_, err = services.documents.Update(ctx, owner.ID, document.ID, dto.DocumentUpdateRequest{
		Filename: strings.Repeat("名", MaxDocumentFilenameLength+1) + ".pdf",
	})
	assertAppError(t, err, "VALIDATION_ERROR")

	// An empty payload is a no-op rather than an error or a blank filename.
	unchanged, err := services.documents.Update(ctx, owner.ID, document.ID, dto.DocumentUpdateRequest{})
	if err != nil {
		t.Fatalf("empty update: %v", err)
	}
	if unchanged.Filename != "季度报告.pdf" {
		t.Fatalf("empty update must not clear the filename, got %q", unchanged.Filename)
	}
}

// G7: a move carries the chunks with it, because the composite key ties a chunk's
// knowledge base to its document's.
func TestDocumentUpdateMovesChunksWithTheDocument(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, services.db, "owner")
	other := createWorkspaceUser(t, services.db, "other")
	base := time.Now().Add(-time.Hour)

	source := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "source", "private", base)
	target := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "target", "private", base)
	foreign := createWorkspaceKB(t, services.db, other.ID, uuid.Nil, "foreign", "private", base)

	document := createWorkspaceDocument(t, services.db, source.ID, owner.ID, "手册.pdf", "completed")
	createWorkspaceDocumentChunk(t, services.db, source.ID, document.ID, 0, "第一段")
	createWorkspaceDocumentChunk(t, services.db, source.ID, document.ID, 1, "第二段")

	_, err := services.documents.Update(ctx, owner.ID, document.ID, dto.DocumentUpdateRequest{
		KnowledgeBaseID: &foreign.ID,
	})
	assertAppError(t, err, "KNOWLEDGE_BASE_NOT_FOUND")

	res, err := services.documents.Update(ctx, owner.ID, document.ID, dto.DocumentUpdateRequest{
		Filename:        "操作手册.pdf",
		KnowledgeBaseID: &target.ID,
	})
	if err != nil {
		t.Fatalf("move document: %v", err)
	}
	if res.KnowledgeBaseID != target.ID.String() || res.Filename != "操作手册.pdf" {
		t.Fatalf("expected a combined rename and move, got %#v", res)
	}

	var strayChunks int64
	if err := services.db.Model(&model.DocumentChunk{}).
		Where("document_id = ? AND knowledge_base_id <> ?", document.ID, target.ID).
		Count(&strayChunks).Error; err != nil {
		t.Fatalf("count stray chunks: %v", err)
	}
	if strayChunks != 0 {
		t.Fatalf("expected every chunk to follow the document, %d stayed behind", strayChunks)
	}

	// Both sides of the move are visible in the workspace, so both were touched.
	for _, kbID := range []uuid.UUID{source.ID, target.ID} {
		var kb model.KnowledgeBase
		if err := services.db.Where("id = ?", kbID).First(&kb).Error; err != nil {
			t.Fatalf("reload knowledge base: %v", err)
		}
		if kb.UpdatedByID == nil || *kb.UpdatedByID != owner.ID {
			t.Fatalf("expected knowledge base %s to record the mover, got %#v", kb.Name, kb.UpdatedByID)
		}
		if !kb.UpdatedAt.After(base) {
			t.Fatalf("expected knowledge base %s updatedAt to advance, got %v", kb.Name, kb.UpdatedAt)
		}
	}
}

// G7: a queued or running job pins the document to its knowledge base — the
// processor would otherwise publish chunks under the knowledge base it read at
// claim time.
func TestDocumentUpdateRejectsMoveWhileAJobIsActive(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, services.db, "owner")
	base := time.Now().Add(-time.Hour)
	source := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "source", "private", base)
	target := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "target", "private", base)
	document := createWorkspaceDocument(t, services.db, source.ID, owner.ID, "手册.pdf", "embedding")

	job := model.DocumentJob{DocumentID: document.ID, JobType: "process_document", Status: "running"}
	if err := services.db.Create(&job).Error; err != nil {
		t.Fatalf("create running job: %v", err)
	}

	_, err := services.documents.Update(ctx, owner.ID, document.ID, dto.DocumentUpdateRequest{
		KnowledgeBaseID: &target.ID,
	})
	assertAppError(t, err, "DOCUMENT_JOB_ACTIVE")

	// A rename is unaffected: the processor never reads the filename.
	if _, err := services.documents.Update(ctx, owner.ID, document.ID, dto.DocumentUpdateRequest{
		Filename: "操作手册.pdf",
	}); err != nil {
		t.Fatalf("rename during processing: %v", err)
	}
}

// G8: cancelling terminates the job and the document together, and a worker that
// finishes afterwards cannot write its result over the cancel.
func TestDocumentCancelIsFinalAgainstALateWorker(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, services.db, "owner")
	base := time.Now().Add(-time.Hour)
	kb := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "kb", "private", base)
	document := createWorkspaceDocument(t, services.db, kb.ID, owner.ID, "大文件.pdf", "embedding")

	job := model.DocumentJob{DocumentID: document.ID, JobType: "process_document", Status: "running"}
	if err := services.db.Create(&job).Error; err != nil {
		t.Fatalf("create running job: %v", err)
	}

	res, err := services.documents.CancelJob(ctx, owner.ID, document.ID)
	if err != nil {
		t.Fatalf("cancel job: %v", err)
	}
	if res.JobStatus != "cancelled" {
		t.Fatalf("expected jobStatus cancelled, got %#v", res)
	}
	if res.Status != "failed" {
		t.Fatalf("expected the document to land on failed, got %#v", res)
	}
	if res.ErrorMessage == nil || *res.ErrorMessage != "文档处理已取消。" {
		t.Fatalf("expected the public cancel message, got %#v", res.ErrorMessage)
	}

	repo := repository.NewDocumentRepository(services.db)

	// Every worker terminal path is guarded on status='running', so a processor
	// that finishes after the cancel changes nothing.
	if err := repo.CompleteJob(ctx, job.ID); err == nil {
		t.Fatalf("expected CompleteJob to refuse a cancelled job")
	}
	if err := repo.RetryJob(ctx, job.ID, 1, time.Now().Add(time.Minute), "boom"); err != nil {
		t.Fatalf("RetryJob on a cancelled job should be a silent no-op: %v", err)
	}
	if err := repo.FailJob(ctx, job.ID, "boom"); err == nil {
		t.Fatalf("expected FailJob to refuse a cancelled job")
	}
	// Stage writes are scoped to the claiming job, so an in-flight processor
	// cannot walk the document back to "embedding".
	if err := repo.UpdateStatus(ctx, document.ID, job.ID, "embedding", 50, ""); !errors.Is(err, repository.ErrDocumentJobCancelled) {
		t.Fatalf("expected ErrDocumentJobCancelled, got %v", err)
	}

	var reloadedJob model.DocumentJob
	if err := services.db.Where("id = ?", job.ID).First(&reloadedJob).Error; err != nil {
		t.Fatalf("reload job: %v", err)
	}
	if reloadedJob.Status != "cancelled" {
		t.Fatalf("expected the job to stay cancelled, got %q", reloadedJob.Status)
	}

	after, err := services.documents.Get(ctx, owner.ID, document.ID)
	if err != nil {
		t.Fatalf("reload document: %v", err)
	}
	if after.Status != "failed" || after.JobStatus != "cancelled" {
		t.Fatalf("expected the cancel to survive the worker, got %#v", after)
	}

	// Nothing left to cancel now.
	_, err = services.documents.CancelJob(ctx, owner.ID, document.ID)
	assertAppError(t, err, "DOCUMENT_JOB_NOT_CANCELLABLE")

	// A cancelled document can still be reprocessed from scratch.
	if _, err := services.documents.Reprocess(ctx, owner.ID, document.ID); err != nil {
		t.Fatalf("reprocess after cancel: %v", err)
	}
	pending, err := services.documents.CancelJob(ctx, owner.ID, document.ID)
	if err != nil {
		t.Fatalf("cancel the requeued job: %v", err)
	}
	if pending.JobStatus != "cancelled" {
		t.Fatalf("expected a pending job to be cancellable too, got %#v", pending)
	}
}

// G8: a document with no active job has nothing to cancel, and cancelling is
// scoped to the caller.
func TestDocumentCancelRequiresAnActiveJobAndOwnership(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, services.db, "owner")
	other := createWorkspaceUser(t, services.db, "other")
	base := time.Now().Add(-time.Hour)
	kb := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "kb", "private", base)
	foreignKB := createWorkspaceKB(t, services.db, other.ID, uuid.Nil, "foreign", "private", base)

	settled := createWorkspaceDocument(t, services.db, kb.ID, owner.ID, "完成.pdf", "completed")
	if err := services.db.Create(&model.DocumentJob{
		DocumentID: settled.ID,
		JobType:    "process_document",
		Status:     "completed",
	}).Error; err != nil {
		t.Fatalf("create completed job: %v", err)
	}
	_, err := services.documents.CancelJob(ctx, owner.ID, settled.ID)
	assertAppError(t, err, "DOCUMENT_JOB_NOT_CANCELLABLE")

	foreignDocument := createWorkspaceDocument(t, services.db, foreignKB.ID, other.ID, "别人的.pdf", "embedding")
	if err := services.db.Create(&model.DocumentJob{
		DocumentID: foreignDocument.ID,
		JobType:    "process_document",
		Status:     "running",
	}).Error; err != nil {
		t.Fatalf("create foreign job: %v", err)
	}
	_, err = services.documents.CancelJob(ctx, owner.ID, foreignDocument.ID)
	assertAppError(t, err, "DOCUMENT_NOT_FOUND")
}

// G9: highlight offsets are UTF-16 code units, i.e. JavaScript string indices.
// Rune indices and UTF-8 byte offsets disagree with those as soon as the text is
// not ASCII, which is exactly when a silent misalignment would appear.
func TestSearchHighlightOffsetsAreUTF16CodeUnits(t *testing.T) {
	cases := []struct {
		name  string
		text  string
		query string
		want  []dto.SearchHighlight
	}{
		{
			name:  "ascii offsets match byte offsets",
			text:  "quarterly report",
			query: "report",
			want:  []dto.SearchHighlight{{Field: "snippet", Start: 10, End: 16}},
		},
		{
			name:  "case folding does not move the offsets",
			text:  "Quarterly REPORT",
			query: "report",
			want:  []dto.SearchHighlight{{Field: "snippet", Start: 10, End: 16}},
		},
		{
			// UTF-8 bytes would put this at 9..15, runes at 3..5.
			name:  "cjk counts one unit per character",
			text:  "本季度退货政策说明",
			query: "退货",
			want:  []dto.SearchHighlight{{Field: "snippet", Start: 3, End: 5}},
		},
		{
			// Each emoji is a surrogate pair, so it costs two UTF-16 units.
			name:  "astral characters count as surrogate pairs",
			text:  "🙂🙂ab",
			query: "ab",
			want:  []dto.SearchHighlight{{Field: "snippet", Start: 4, End: 6}},
		},
		{
			name:  "every occurrence is reported",
			text:  "报告 报告",
			query: "报告",
			want: []dto.SearchHighlight{
				{Field: "snippet", Start: 0, End: 2},
				{Field: "snippet", Start: 3, End: 5},
			},
		},
		{
			name:  "no match yields no ranges",
			text:  "quarterly report",
			query: "missing",
			want:  nil,
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			got := highlightRanges("snippet", testCase.text, testCase.query)
			if len(got) != len(testCase.want) {
				t.Fatalf("expected %#v, got %#v", testCase.want, got)
			}
			for i := range testCase.want {
				if got[i] != testCase.want[i] {
					t.Fatalf("expected %#v, got %#v", testCase.want, got)
				}
			}

			// The declared contract: slicing a JS string with these offsets
			// yields the matched text. utf16 indices are what that means in Go.
			encoded := utf16.Encode([]rune(testCase.text))
			for _, highlight := range got {
				matched := strings.ToLower(string(utf16.Decode(encoded[highlight.Start:highlight.End])))
				if matched != strings.ToLower(testCase.query) {
					t.Fatalf("offset %d..%d selected %q, expected %q", highlight.Start, highlight.End, matched, testCase.query)
				}
			}
		})
	}
}

// G9: highlights come back on real results, covering both fields, so the frontend
// can drop its client-side substring pass.
func TestGlobalSearchReturnsHighlightsForBothFields(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, services.db, "owner")
	base := time.Now().Add(-time.Hour)

	kb := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "退货知识库", "private", base)
	document := createWorkspaceDocument(t, services.db, kb.ID, owner.ID, "退货手册.pdf", "completed")
	createWorkspaceDocumentChunk(t, services.db, kb.ID, document.ID, 0, "本季度退货政策说明，退货需在 30 天内。")

	res, err := services.search.Search(ctx, owner.ID, dto.GlobalSearchRequest{Query: "退货"})
	if err != nil {
		t.Fatalf("global search: %v", err)
	}
	if len(res.Items) == 0 {
		t.Fatalf("expected search results, got %#v", res)
	}

	var sawTitle, sawSnippet bool
	for _, item := range res.Items {
		if len(item.Highlights) == 0 {
			t.Fatalf("every matching result must carry highlights, got %#v", item)
		}
		for _, highlight := range item.Highlights {
			field := item.Title
			switch highlight.Field {
			case "title":
				sawTitle = true
			case "snippet":
				field = item.Snippet
				sawSnippet = true
			default:
				t.Fatalf("unexpected highlight field %q", highlight.Field)
			}
			encoded := utf16.Encode([]rune(field))
			if highlight.Start < 0 || highlight.End > len(encoded) || highlight.Start >= highlight.End {
				t.Fatalf("highlight %#v out of range for %q", highlight, field)
			}
			if string(utf16.Decode(encoded[highlight.Start:highlight.End])) != "退货" {
				t.Fatalf("highlight %#v does not select the query in %q", highlight, field)
			}
		}
	}
	if !sawTitle || !sawSnippet {
		t.Fatalf("expected both title and snippet highlights, got title=%v snippet=%v", sawTitle, sawSnippet)
	}
}

// G10: suggest is title-level only and stays inside the caller's data.
func TestSearchSuggestReturnsTitlesOnly(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, services.db, "owner")
	other := createWorkspaceUser(t, services.db, "other")
	base := time.Now().Add(-time.Hour)

	kb := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "退货知识库", "private", base)
	document := createWorkspaceDocument(t, services.db, kb.ID, owner.ID, "退货手册.pdf", "completed")
	// Content that only matches inside a chunk must not surface here.
	createWorkspaceDocumentChunk(t, services.db, kb.ID, document.ID, 0, "赔付标准说明")

	foreignKB := createWorkspaceKB(t, services.db, other.ID, uuid.Nil, "退货外部库", "private", base)
	createWorkspaceDocument(t, services.db, foreignKB.ID, other.ID, "退货外部.pdf", "completed")

	res, err := services.search.Suggest(ctx, owner.ID, dto.SearchSuggestRequest{Query: "退货"})
	if err != nil {
		t.Fatalf("suggest: %v", err)
	}
	if len(res.Items) != 2 {
		t.Fatalf("expected the knowledge base and the document only, got %#v", res.Items)
	}
	if res.Items[0].Type != "knowledgeBase" || res.Items[0].Title != "退货知识库" {
		t.Fatalf("expected knowledge bases first, got %#v", res.Items)
	}
	if res.Items[1].Type != "document" || res.Items[1].Title != "退货手册.pdf" {
		t.Fatalf("expected the document second, got %#v", res.Items)
	}
	if res.Items[1].DocumentID != document.ID.String() {
		t.Fatalf("expected the document id for deep linking, got %#v", res.Items[1])
	}

	chunkOnly, err := services.search.Suggest(ctx, owner.ID, dto.SearchSuggestRequest{Query: "赔付"})
	if err != nil {
		t.Fatalf("suggest chunk term: %v", err)
	}
	if len(chunkOnly.Items) != 0 {
		t.Fatalf("suggest must not search chunk content, got %#v", chunkOnly.Items)
	}

	limited, err := services.search.Suggest(ctx, owner.ID, dto.SearchSuggestRequest{Query: "退货", Limit: 1})
	if err != nil {
		t.Fatalf("suggest with limit: %v", err)
	}
	if len(limited.Items) != 1 {
		t.Fatalf("expected the limit to apply, got %#v", limited.Items)
	}

	capped, err := services.search.Suggest(ctx, owner.ID, dto.SearchSuggestRequest{Query: "退货", Limit: 500})
	if err != nil {
		t.Fatalf("suggest with oversized limit: %v", err)
	}
	if len(capped.Items) != 2 {
		t.Fatalf("expected an oversized limit to be capped, not rejected, got %#v", capped.Items)
	}

	_, err = services.search.Suggest(ctx, owner.ID, dto.SearchSuggestRequest{Query: "  "})
	assertAppError(t, err, "VALIDATION_ERROR")
}

// G15: the chat recycle bin behaves like the knowledge base and document ones —
// restore brings the conversation back intact, permanent delete clears messages.
func TestChatSessionRecycleBinRestoresAndPurges(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, services.db, "owner")
	kb := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "product-kb", "private", time.Now())

	session := createWorkspaceChatSession(t, services.db, owner.ID, kb.ID, "退货政策")
	createChatMessageAt(t, services.db, session.ID, "user", "退货政策是什么", time.Now().Add(-time.Minute))
	createChatMessageAt(t, services.db, session.ID, "assistant", "30 天内可退。", time.Now())

	if err := services.chats.DeleteSession(ctx, owner.ID, session.ID); err != nil {
		t.Fatalf("delete session: %v", err)
	}

	active, err := services.chats.ListSessions(ctx, owner.ID, dto.ChatSessionListQuery{})
	if err != nil {
		t.Fatalf("list active sessions: %v", err)
	}
	if active.Total != 0 {
		t.Fatalf("expected the deleted session to leave the active list, got %#v", active)
	}

	bin, err := services.chats.ListRecycleBin(ctx, owner.ID, 1, 20)
	if err != nil {
		t.Fatalf("list chat recycle bin: %v", err)
	}
	if bin.Total != 1 || len(bin.Items) != 1 {
		t.Fatalf("expected one session in the recycle bin, got %#v", bin)
	}
	item := bin.Items[0]
	if item.ResourceType != "chatSession" || item.ID != session.ID.String() {
		t.Fatalf("unexpected recycle bin item: %#v", item)
	}
	if item.Name != "退货政策" || item.KnowledgeBaseName != "product-kb" {
		t.Fatalf("expected the title and knowledge base name, got %#v", item)
	}
	if item.DeletedAt.IsZero() {
		t.Fatalf("expected deletedAt to be populated, got %#v", item)
	}

	restored, err := services.chats.RestoreSession(ctx, owner.ID, session.ID)
	if err != nil {
		t.Fatalf("restore session: %v", err)
	}
	if restored.ID != session.ID.String() {
		t.Fatalf("unexpected restored session: %#v", restored)
	}
	messages, err := services.chats.ListMessages(ctx, owner.ID, session.ID)
	if err != nil {
		t.Fatalf("list messages after restore: %v", err)
	}
	if len(messages.Items) != 2 {
		t.Fatalf("expected the restored session to keep its history, got %#v", messages.Items)
	}

	// Restoring is only valid from the bin.
	_, err = services.chats.RestoreSession(ctx, owner.ID, session.ID)
	assertAppError(t, err, "RESOURCE_NOT_FOUND")

	if err := services.chats.DeleteSession(ctx, owner.ID, session.ID); err != nil {
		t.Fatalf("re-delete session: %v", err)
	}
	if err := services.chats.PermanentDeleteSession(ctx, owner.ID, session.ID); err != nil {
		t.Fatalf("permanent delete session: %v", err)
	}
	var remaining int64
	if err := services.db.Model(&model.ChatMessage{}).Where("session_id = ?", session.ID).Count(&remaining).Error; err != nil {
		t.Fatalf("count messages: %v", err)
	}
	if remaining != 0 {
		t.Fatalf("expected permanent delete to clear messages, got %d", remaining)
	}
	empty, err := services.chats.ListRecycleBin(ctx, owner.ID, 1, 20)
	if err != nil {
		t.Fatalf("list chat recycle bin after purge: %v", err)
	}
	if empty.Total != 0 {
		t.Fatalf("expected an empty recycle bin, got %#v", empty)
	}
}

// G15: the recycle bin and its destructive operations stay inside the caller's
// own sessions.
func TestChatSessionRecycleBinIsScopedToTheCaller(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, services.db, "owner")
	other := createWorkspaceUser(t, services.db, "other")
	ownerKB := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "mine", "private", time.Now())
	otherKB := createWorkspaceKB(t, services.db, other.ID, uuid.Nil, "theirs", "private", time.Now())

	mine := createWorkspaceChatSession(t, services.db, owner.ID, ownerKB.ID, "我的会话")
	theirs := createWorkspaceChatSession(t, services.db, other.ID, otherKB.ID, "别人的会话")
	if err := services.chats.DeleteSession(ctx, owner.ID, mine.ID); err != nil {
		t.Fatalf("delete own session: %v", err)
	}
	if err := services.chats.DeleteSession(ctx, other.ID, theirs.ID); err != nil {
		t.Fatalf("delete foreign session: %v", err)
	}

	bin, err := services.chats.ListRecycleBin(ctx, owner.ID, 1, 20)
	if err != nil {
		t.Fatalf("list recycle bin: %v", err)
	}
	if bin.Total != 1 || bin.Items[0].ID != mine.ID.String() {
		t.Fatalf("expected only the caller's session, got %#v", bin)
	}

	_, err = services.chats.RestoreSession(ctx, owner.ID, theirs.ID)
	assertAppError(t, err, "RESOURCE_NOT_FOUND")
	err = services.chats.PermanentDeleteSession(ctx, owner.ID, theirs.ID)
	assertAppError(t, err, "RESOURCE_NOT_FOUND")

	if err := services.chats.EmptyRecycleBin(ctx, owner.ID); err != nil {
		t.Fatalf("empty recycle bin: %v", err)
	}
	var theirsRemaining int64
	if err := services.db.Unscoped().Model(&model.ChatSession{}).
		Where("id = ?", theirs.ID).Count(&theirsRemaining).Error; err != nil {
		t.Fatalf("count foreign session: %v", err)
	}
	if theirsRemaining != 1 {
		t.Fatalf("emptying one user's bin must not touch another's, got %d", theirsRemaining)
	}
	afterEmpty, err := services.chats.ListRecycleBin(ctx, owner.ID, 1, 20)
	if err != nil {
		t.Fatalf("list recycle bin after empty: %v", err)
	}
	if afterEmpty.Total != 0 {
		t.Fatalf("expected the caller's bin to be empty, got %#v", afterEmpty)
	}
}

func TestChatSessionRecycleBinEmptyMatchesTheVisibleListScope(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, services.db, "owner")
	other := createWorkspaceUser(t, services.db, "other")
	visibleKB := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "visible-kb", "private", time.Now())
	hiddenKB := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "deleted-kb", "private", time.Now())
	otherKB := createWorkspaceKB(t, services.db, other.ID, uuid.Nil, "other-kb", "private", time.Now())

	visible := createWorkspaceChatSession(t, services.db, owner.ID, visibleKB.ID, "visible session")
	hidden := createWorkspaceChatSession(t, services.db, owner.ID, hiddenKB.ID, "hidden session")
	foreign := createWorkspaceChatSession(t, services.db, other.ID, otherKB.ID, "foreign session")
	createChatMessageAt(t, services.db, hidden.ID, "user", "hidden history", time.Now())
	createChatMessageAt(t, services.db, foreign.ID, "user", "foreign history", time.Now())

	for _, target := range []struct {
		userID    uuid.UUID
		sessionID uuid.UUID
	}{
		{userID: owner.ID, sessionID: visible.ID},
		{userID: owner.ID, sessionID: hidden.ID},
		{userID: other.ID, sessionID: foreign.ID},
	} {
		if err := services.chats.DeleteSession(ctx, target.userID, target.sessionID); err != nil {
			t.Fatalf("delete session %s: %v", target.sessionID, err)
		}
	}
	if err := services.kbs.Delete(ctx, owner.ID, hiddenKB.ID); err != nil {
		t.Fatalf("delete knowledge base containing hidden session: %v", err)
	}

	before, err := services.chats.ListRecycleBin(ctx, owner.ID, 1, 20)
	if err != nil {
		t.Fatalf("list visible chat recycle bin: %v", err)
	}
	if before.Total != 1 || len(before.Items) != 1 || before.Items[0].ID != visible.ID.String() {
		t.Fatalf("expected only the active-knowledge-base session to be visible, got %#v", before)
	}

	if err := services.chats.EmptyRecycleBin(ctx, owner.ID); err != nil {
		t.Fatalf("empty visible chat recycle bin: %v", err)
	}

	assertSessionExists := func(sessionID uuid.UUID, want bool) {
		t.Helper()
		var count int64
		if err := services.db.Unscoped().Model(&model.ChatSession{}).
			Where("id = ?", sessionID).Count(&count).Error; err != nil {
			t.Fatalf("count session %s: %v", sessionID, err)
		}
		if (count == 1) != want {
			t.Fatalf("session %s existence=%d, want exists=%v", sessionID, count, want)
		}
	}
	assertSessionExists(visible.ID, false)
	assertSessionExists(hidden.ID, true)
	assertSessionExists(foreign.ID, true)

	if err := services.kbs.Restore(ctx, owner.ID, hiddenKB.ID); err != nil {
		t.Fatalf("restore hidden knowledge base: %v", err)
	}
	afterRestore, err := services.chats.ListRecycleBin(ctx, owner.ID, 1, 20)
	if err != nil {
		t.Fatalf("list recycle bin after knowledge base restore: %v", err)
	}
	if afterRestore.Total != 1 || len(afterRestore.Items) != 1 || afterRestore.Items[0].ID != hidden.ID.String() {
		t.Fatalf("expected the hidden session to reappear after restoring its knowledge base, got %#v", afterRestore)
	}
	if _, err := services.chats.RestoreSession(ctx, owner.ID, hidden.ID); err != nil {
		t.Fatalf("restore the preserved session: %v", err)
	}
	messages, err := services.chats.ListMessages(ctx, owner.ID, hidden.ID)
	if err != nil {
		t.Fatalf("list preserved session history: %v", err)
	}
	if len(messages.Items) != 1 || messages.Items[0].Content != "hidden history" {
		t.Fatalf("expected the preserved session history, got %#v", messages.Items)
	}
}

// G17: one request answers the whole workspace landing page, with server-owned
// limits and the real totals so the page never has to guess a pageSize.
func TestHomeSummaryAggregatesEveryRegion(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	home := NewHomeService(services.kbs, services.documents, services.chats)
	owner := createWorkspaceUser(t, services.db, "owner")
	other := createWorkspaceUser(t, services.db, "other")
	base := time.Now().Add(-time.Hour)

	kb := createWorkspaceKB(t, services.db, owner.ID, uuid.Nil, "product-kb", "private", base)
	foreignKB := createWorkspaceKB(t, services.db, other.ID, uuid.Nil, "foreign-kb", "private", base)

	// More rows than the limit, so truncation and totals are both exercised.
	for i := 0; i < HomeSummaryItemLimit+2; i++ {
		createWorkspaceDocument(t, services.db, kb.ID, owner.ID, "ok-"+strconv.Itoa(i)+".pdf", "completed")
	}
	createWorkspaceDocument(t, services.db, kb.ID, owner.ID, "broken.pdf", "failed")
	createWorkspaceDocument(t, services.db, foreignKB.ID, other.ID, "foreign.pdf", "completed")

	session := createWorkspaceChatSession(t, services.db, owner.ID, kb.ID, "退货政策")
	createWorkspaceChatSession(t, services.db, other.ID, foreignKB.ID, "别人的会话")

	res, err := home.Summary(ctx, owner.ID, "month")
	if err != nil {
		t.Fatalf("home summary: %v", err)
	}
	if res.Period != "month" {
		t.Fatalf("expected the requested period, got %q", res.Period)
	}
	if res.Stats.Documents.Value != int64(HomeSummaryItemLimit+3) {
		t.Fatalf("expected stats to count every owned document, got %#v", res.Stats.Documents)
	}

	if len(res.KnowledgeBases) != 1 || res.KnowledgeBases[0].Name != "product-kb" {
		t.Fatalf("expected only the caller's knowledge bases, got %#v", res.KnowledgeBases)
	}
	if res.KnowledgeBaseTotal != 1 {
		t.Fatalf("expected the knowledge base total, got %d", res.KnowledgeBaseTotal)
	}

	if len(res.Documents) != HomeSummaryItemLimit {
		t.Fatalf("expected the server-owned limit, got %d", len(res.Documents))
	}
	if res.DocumentTotal != int64(HomeSummaryItemLimit+3) {
		t.Fatalf("expected the unfiltered total alongside the truncated list, got %d", res.DocumentTotal)
	}
	for _, document := range res.Documents {
		if document.KnowledgeBaseID != kb.ID.String() {
			t.Fatalf("home summary leaked another user's document: %#v", document)
		}
	}

	if len(res.FailedDocuments) != 1 || res.FailedDocuments[0].Filename != "broken.pdf" {
		t.Fatalf("expected only failed documents in that region, got %#v", res.FailedDocuments)
	}
	if res.FailedDocumentTotal != 1 {
		t.Fatalf("expected the failed total, got %d", res.FailedDocumentTotal)
	}

	if len(res.Sessions) != 1 || res.Sessions[0].ID != session.ID.String() {
		t.Fatalf("expected only the caller's sessions, got %#v", res.Sessions)
	}
	if res.SessionTotal != 1 {
		t.Fatalf("expected the session total, got %d", res.SessionTotal)
	}

	// Soft-deleted sessions stay out, same as the standalone list endpoint.
	if err := services.chats.DeleteSession(ctx, owner.ID, session.ID); err != nil {
		t.Fatalf("delete session: %v", err)
	}
	afterDelete, err := home.Summary(ctx, owner.ID, "day")
	if err != nil {
		t.Fatalf("home summary after delete: %v", err)
	}
	if afterDelete.Period != "day" {
		t.Fatalf("expected the day period to pass through, got %q", afterDelete.Period)
	}
	if len(afterDelete.Sessions) != 0 || afterDelete.SessionTotal != 0 {
		t.Fatalf("expected the deleted session to drop out, got %#v", afterDelete.Sessions)
	}
}

// G18: the timeline records the events the home page could not reconstruct from
// lists — deletes, restores and membership changes — and survives the resource
// being permanently deleted.
func TestActivityFeedRecordsLifecycleEvents(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	if err := services.db.AutoMigrate(&model.Activity{}); err != nil {
		t.Fatalf("auto migrate activities: %v", err)
	}

	activityRepo := repository.NewActivityRepository(services.db)
	recorder := NewActivityRecorder(activityRepo)
	activities := NewActivityService(activityRepo)
	services.kbs.SetActivityRecorder(recorder)
	services.documents.SetActivityRecorder(recorder)
	services.chats.SetActivityRecorder(recorder)

	owner := createWorkspaceUser(t, services.db, "owner")
	other := createWorkspaceUser(t, services.db, "other")

	created, err := services.kbs.Create(ctx, owner.ID, dto.KnowledgeBaseRequest{Name: "产品知识库"})
	if err != nil {
		t.Fatalf("create knowledge base: %v", err)
	}
	kbID := uuid.MustParse(created.ID)

	document := createWorkspaceDocument(t, services.db, kbID, owner.ID, "手册.pdf", "completed")
	if err := services.documents.Delete(ctx, owner.ID, document.ID); err != nil {
		t.Fatalf("delete document: %v", err)
	}
	if err := services.documents.Restore(ctx, owner.ID, document.ID); err != nil {
		t.Fatalf("restore document: %v", err)
	}

	session := createWorkspaceChatSession(t, services.db, owner.ID, kbID, "退货政策")
	if err := services.chats.DeleteSession(ctx, owner.ID, session.ID); err != nil {
		t.Fatalf("delete session: %v", err)
	}

	if _, err := services.kbs.AddMember(ctx, owner.ID, kbID, dto.KnowledgeBaseMemberRequest{
		UserID: other.ID,
		Role:   "member",
	}); err != nil {
		t.Fatalf("add member: %v", err)
	}
	if err := services.kbs.RemoveMember(ctx, owner.ID, kbID, other.ID); err != nil {
		t.Fatalf("remove member: %v", err)
	}

	if err := services.kbs.Delete(ctx, owner.ID, kbID); err != nil {
		t.Fatalf("delete knowledge base: %v", err)
	}

	feed, err := activities.List(ctx, owner.ID, 20)
	if err != nil {
		t.Fatalf("list activities: %v", err)
	}

	seen := make(map[string]dto.ActivityResponse, len(feed.Items))
	for _, item := range feed.Items {
		seen[item.Action] = item
	}
	for _, action := range []string{
		ActivityKnowledgeBaseCreated,
		ActivityDocumentDeleted,
		ActivityDocumentRestored,
		ActivityChatSessionDeleted,
		ActivityMemberAdded,
		ActivityMemberRemoved,
		ActivityKnowledgeBaseDeleted,
	} {
		if _, ok := seen[action]; !ok {
			t.Fatalf("expected %s in the feed, got %#v", action, feed.Items)
		}
	}
	if seen[ActivityDocumentDeleted].ResourceName != "手册.pdf" {
		t.Fatalf("expected the document name on its entry, got %#v", seen[ActivityDocumentDeleted])
	}
	if seen[ActivityMemberAdded].ResourceName != "other" {
		t.Fatalf("expected the member name on its entry, got %#v", seen[ActivityMemberAdded])
	}
	if seen[ActivityKnowledgeBaseDeleted].KnowledgeBaseName != "产品知识库" {
		t.Fatalf("expected the knowledge base name to be denormalised, got %#v", seen[ActivityKnowledgeBaseDeleted])
	}

	// Newest first.
	for i := 1; i < len(feed.Items); i++ {
		if feed.Items[i].CreatedAt.After(feed.Items[i-1].CreatedAt) {
			t.Fatalf("expected newest-first ordering, got %#v", feed.Items)
		}
	}

	// The name survives a permanent delete: that is the point of storing it.
	if err := services.kbs.PermanentDelete(ctx, owner.ID, kbID); err != nil {
		t.Fatalf("permanent delete knowledge base: %v", err)
	}
	afterPurge, err := activities.List(ctx, owner.ID, 20)
	if err != nil {
		t.Fatalf("list activities after purge: %v", err)
	}
	var found bool
	for _, item := range afterPurge.Items {
		if item.Action == ActivityKnowledgeBaseDeleted && item.KnowledgeBaseName == "产品知识库" {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected the entry to outlive the resource, got %#v", afterPurge.Items)
	}

	// The feed is per user, and the limit is honoured and capped.
	foreign, err := activities.List(ctx, other.ID, 20)
	if err != nil {
		t.Fatalf("list foreign activities: %v", err)
	}
	if len(foreign.Items) != 0 {
		t.Fatalf("expected an empty feed for the other user, got %#v", foreign.Items)
	}
	limited, err := activities.List(ctx, owner.ID, 2)
	if err != nil {
		t.Fatalf("list limited activities: %v", err)
	}
	if len(limited.Items) != 2 {
		t.Fatalf("expected the limit to apply, got %d", len(limited.Items))
	}
	capped, err := activities.List(ctx, owner.ID, MaxActivityLimit+500)
	if err != nil {
		t.Fatalf("list capped activities: %v", err)
	}
	if len(capped.Items) != len(afterPurge.Items) {
		t.Fatalf("expected an oversized limit to be capped, not rejected, got %d", len(capped.Items))
	}
}

// G18: recording must never fail the operation that triggered it. A service with
// no recorder behaves exactly as before.
func TestActivityRecordingIsOptional(t *testing.T) {
	ctx := context.Background()
	services := newWorkspaceTestServices(t)
	owner := createWorkspaceUser(t, services.db, "owner")

	// No recorder wired, and no activities table exists in this database.
	created, err := services.kbs.Create(ctx, owner.ID, dto.KnowledgeBaseRequest{Name: "无时间线"})
	if err != nil {
		t.Fatalf("create without a recorder: %v", err)
	}
	if err := services.kbs.Delete(ctx, owner.ID, uuid.MustParse(created.ID)); err != nil {
		t.Fatalf("delete without a recorder: %v", err)
	}

	// A recorder pointed at a database with no activities table still must not
	// break the operation.
	services.kbs.SetActivityRecorder(NewActivityRecorder(repository.NewActivityRepository(services.db)))
	if _, err := services.kbs.Create(ctx, owner.ID, dto.KnowledgeBaseRequest{Name: "记录失败"}); err != nil {
		t.Fatalf("a failing recorder must not fail the operation: %v", err)
	}
}
