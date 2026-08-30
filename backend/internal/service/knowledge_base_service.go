package service

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"gorm.io/datatypes"

	"kbchat/backend/internal/access"
	"kbchat/backend/internal/apperror"
	"kbchat/backend/internal/dto"
	"kbchat/backend/internal/model"
	"kbchat/backend/internal/repository"
)

var defaultRetrievalConfig = dto.RetrievalConfig{
	VectorTopN:     30,
	RerankTopK:     5,
	ScoreThreshold: 0.3,
	EnableRerank:   true,
}

type KnowledgeBaseService struct {
	repo        *repository.KnowledgeBaseRepository
	categories  *repository.KnowledgeBaseCategoryRepository
	favorites   *repository.KnowledgeBaseFavoriteRepository
	views       *repository.KnowledgeBaseViewRepository
	preferences *repository.KnowledgeBaseWorkspacePreferenceRepository
	tags        *repository.KnowledgeBaseTagRepository
	tagBindings *repository.KnowledgeBaseTagBindingRepository
	members     *repository.KnowledgeBaseMemberRepository
	users       *repository.UserRepository
	activities  *ActivityRecorder
}

// SetActivityRecorder wires the workspace timeline. It is optional on purpose:
// a service without one records nothing, so every existing construction site and
// test keeps working unchanged.
func (s *KnowledgeBaseService) SetActivityRecorder(recorder *ActivityRecorder) {
	s.activities = recorder
}

func NewKnowledgeBaseService(
	repo *repository.KnowledgeBaseRepository,
	categories *repository.KnowledgeBaseCategoryRepository,
	favorites *repository.KnowledgeBaseFavoriteRepository,
	views *repository.KnowledgeBaseViewRepository,
	preferences *repository.KnowledgeBaseWorkspacePreferenceRepository,
	tags *repository.KnowledgeBaseTagRepository,
	tagBindings *repository.KnowledgeBaseTagBindingRepository,
	members *repository.KnowledgeBaseMemberRepository,
	users *repository.UserRepository,
) *KnowledgeBaseService {
	return &KnowledgeBaseService{
		repo:        repo,
		categories:  categories,
		favorites:   favorites,
		views:       views,
		preferences: preferences,
		tags:        tags,
		tagBindings: tagBindings,
		members:     members,
		users:       users,
	}
}

func (s *KnowledgeBaseService) Create(ctx context.Context, ownerID uuid.UUID, req dto.KnowledgeBaseRequest) (*dto.KnowledgeBaseResponse, error) {
	config := defaultConfig(req.RetrievalConfig)
	configJSON, err := json.Marshal(config)
	if err != nil {
		return nil, apperror.Internal(err)
	}

	kb := &model.KnowledgeBase{
		Name:            req.Name,
		Description:     req.Description,
		OwnerID:         ownerID,
		UpdatedByID:     &ownerID,
		CategoryID:      req.CategoryID,
		Visibility:      normalizedVisibility(req.Visibility),
		RetrievalConfig: datatypes.JSON(configJSON),
	}
	if err := s.ensureCategoryOwner(ctx, ownerID, kb.CategoryID); err != nil {
		return nil, err
	}
	tagIDs := normalizeUUIDs(optionalUUIDs(req.TagIDs))
	if err := s.ensureTagsOwner(ctx, ownerID, tagIDs); err != nil {
		return nil, err
	}
	if err := validateVisibility(kb.Visibility); err != nil {
		return nil, err
	}
	if err := s.repo.Create(ctx, kb); err != nil {
		return nil, apperror.Internal(err)
	}
	if req.TagIDs != nil {
		if err := s.tagBindings.ReplaceForKnowledgeBase(ctx, kb.ID, tagIDs); err != nil {
			return nil, apperror.Internal(err)
		}
	}
	created, err := s.repo.FindByIDAndOwner(ctx, kb.ID, ownerID)
	if err != nil {
		return nil, apperror.Internal(err)
	}
	if created == nil {
		return nil, apperror.NotFound("KNOWLEDGE_BASE_NOT_FOUND", "知识库不存在")
	}

	tags, err := s.repo.ListTags(ctx, created.ID)
	if err != nil {
		return nil, apperror.Internal(err)
	}
	s.activities.Record(ctx, ownerID, ActivityEntry{
		Action:            ActivityKnowledgeBaseCreated,
		ResourceType:      "knowledgeBase",
		ResourceID:        created.ID,
		ResourceName:      created.Name,
		KnowledgeBaseID:   &created.ID,
		KnowledgeBaseName: created.Name,
	})
	res := toKnowledgeBaseResponse(created, tags)
	return &res, nil
}

func (s *KnowledgeBaseService) List(ctx context.Context, ownerID uuid.UUID) (*dto.KnowledgeBaseListResponse, error) {
	return s.ListWorkspace(ctx, ownerID, dto.KnowledgeBaseListQuery{
		Page:     1,
		PageSize: 100,
		Sort:     "createdAt_desc",
	})
}

func (s *KnowledgeBaseService) GetWorkspacePreference(ctx context.Context, ownerID uuid.UUID) (*dto.KnowledgeBaseWorkspacePreferenceResponse, error) {
	item, err := s.preferences.FindByUserID(ctx, ownerID)
	if err != nil {
		return nil, apperror.Internal(err)
	}
	if item == nil {
		res := defaultWorkspacePreferenceResponse()
		return &res, nil
	}
	res := toWorkspacePreferenceResponse(item)
	return &res, nil
}

func (s *KnowledgeBaseService) UpdateWorkspacePreference(ctx context.Context, ownerID uuid.UUID, req dto.KnowledgeBaseWorkspacePreferenceRequest) (*dto.KnowledgeBaseWorkspacePreferenceResponse, error) {
	viewMode := normalizeWorkspaceViewMode(req.ViewMode)
	scope := normalizeWorkspaceScope(req.Scope)
	sort := normalizeWorkspacePreferenceSort(req.Sort)
	visibility := normalizeWorkspacePreferenceVisibility(req.Visibility)
	if err := validateWorkspaceViewMode(viewMode); err != nil {
		return nil, err
	}
	if err := validateWorkspaceScope(scope); err != nil {
		return nil, err
	}
	if err := validateWorkspacePreferenceSort(sort); err != nil {
		return nil, err
	}
	if err := validateWorkspacePreferenceVisibility(visibility); err != nil {
		return nil, err
	}

	expandedCategoryIDs := normalizeUUIDs(req.ExpandedCategoryIDs)
	if err := s.ensureCategoriesOwner(ctx, ownerID, expandedCategoryIDs); err != nil {
		return nil, err
	}
	expandedCategoryJSON, err := json.Marshal(expandedCategoryIDs)
	if err != nil {
		return nil, apperror.Internal(err)
	}

	item := &model.KnowledgeBaseWorkspacePreference{
		UserID:              ownerID,
		ViewMode:            viewMode,
		Scope:               scope,
		Sort:                sort,
		Visibility:          visibility,
		ExpandedCategoryIDs: datatypes.JSON(expandedCategoryJSON),
	}
	if err := s.preferences.Save(ctx, item); err != nil {
		return nil, apperror.Internal(err)
	}

	saved, err := s.preferences.FindByUserID(ctx, ownerID)
	if err != nil {
		return nil, apperror.Internal(err)
	}
	if saved == nil {
		res := defaultWorkspacePreferenceResponse()
		return &res, nil
	}
	res := toWorkspacePreferenceResponse(saved)
	return &res, nil
}

func (s *KnowledgeBaseService) ListWorkspace(ctx context.Context, ownerID uuid.UUID, query dto.KnowledgeBaseListQuery) (*dto.KnowledgeBaseListResponse, error) {
	query = normalizeKnowledgeBaseListQuery(query)
	items, total, err := s.repo.ListWorkspace(ctx, ownerID, query)
	if err != nil {
		return nil, apperror.Internal(err)
	}
	kbIDs := make([]uuid.UUID, 0, len(items))
	for i := range items {
		kbIDs = append(kbIDs, items[i].ID)
	}
	tagMap, err := s.tagBindings.ListByKnowledgeBaseIDs(ctx, kbIDs)
	if err != nil {
		return nil, apperror.Internal(err)
	}

	res := dto.KnowledgeBaseListResponse{
		Items:    make([]dto.KnowledgeBaseResponse, 0, len(items)),
		Total:    total,
		Page:     query.Page,
		PageSize: query.PageSize,
	}
	for i := range items {
		res.Items = append(res.Items, toWorkspaceKnowledgeBaseResponse(&items[i], tagMap[items[i].ID]))
	}
	return &res, nil
}

func (s *KnowledgeBaseService) Get(ctx context.Context, ownerID, id uuid.UUID) (*dto.KnowledgeBaseResponse, error) {
	kb, err := s.findKnowledgeBaseForCapability(ctx, ownerID, id, access.CapKnowledgeBaseRead)
	if err != nil {
		return nil, err
	}

	tags, err := s.repo.ListTags(ctx, kb.ID)
	if err != nil {
		return nil, apperror.Internal(err)
	}
	res := toKnowledgeBaseResponse(kb, tags)
	return &res, nil
}

func (s *KnowledgeBaseService) Update(ctx context.Context, ownerID, id uuid.UUID, req dto.KnowledgeBaseRequest) (*dto.KnowledgeBaseResponse, error) {
	kb, err := s.findKnowledgeBaseForCapability(ctx, ownerID, id, access.CapKnowledgeBaseWrite)
	if err != nil {
		return nil, err
	}

	config := defaultConfig(req.RetrievalConfig)
	configJSON, err := json.Marshal(config)
	if err != nil {
		return nil, apperror.Internal(err)
	}
	visibility := normalizedVisibility(req.Visibility)
	if err := validateVisibility(visibility); err != nil {
		return nil, err
	}
	if err := s.ensureCategoryOwner(ctx, ownerID, req.CategoryID); err != nil {
		return nil, err
	}
	tagIDs := normalizeUUIDs(optionalUUIDs(req.TagIDs))
	if err := s.ensureTagsOwner(ctx, ownerID, tagIDs); err != nil {
		return nil, err
	}

	kb.Name = req.Name
	kb.Description = req.Description
	kb.UpdatedByID = &ownerID
	kb.CategoryID = req.CategoryID
	kb.Visibility = visibility
	kb.RetrievalConfig = datatypes.JSON(configJSON)
	if err := s.repo.Update(ctx, kb); err != nil {
		return nil, apperror.Internal(err)
	}
	if req.TagIDs != nil {
		if err := s.tagBindings.ReplaceForKnowledgeBase(ctx, kb.ID, tagIDs); err != nil {
			return nil, apperror.Internal(err)
		}
	}
	updated, err := s.repo.FindByIDAndOwner(ctx, kb.ID, ownerID)
	if err != nil {
		return nil, apperror.Internal(err)
	}
	if updated == nil {
		return nil, apperror.NotFound("KNOWLEDGE_BASE_NOT_FOUND", "知识库不存在")
	}

	tags, err := s.repo.ListTags(ctx, updated.ID)
	if err != nil {
		return nil, apperror.Internal(err)
	}
	res := toKnowledgeBaseResponse(updated, tags)
	return &res, nil
}

func (s *KnowledgeBaseService) Delete(ctx context.Context, ownerID, id uuid.UUID) error {
	kb, err := s.findKnowledgeBaseForCapability(ctx, ownerID, id, access.CapKnowledgeBaseDelete)
	if err != nil {
		return err
	}

	if err := s.repo.Delete(ctx, kb); err != nil {
		return err
	}
	s.activities.Record(ctx, ownerID, ActivityEntry{
		Action:            ActivityKnowledgeBaseDeleted,
		ResourceType:      "knowledgeBase",
		ResourceID:        kb.ID,
		ResourceName:      kb.Name,
		KnowledgeBaseID:   &kb.ID,
		KnowledgeBaseName: kb.Name,
	})
	return nil
}

func (s *KnowledgeBaseService) ListRecycleBin(ctx context.Context, ownerID uuid.UUID, page, pageSize int) (*dto.RecycleBinListResponse, error) {
	items, total, err := s.repo.ListDeleted(ctx, ownerID, page, pageSize)
	if err != nil {
		return nil, apperror.Internal(err)
	}
	page, pageSize = normalizedRecyclePage(page, pageSize)
	res := &dto.RecycleBinListResponse{
		Items:    make([]dto.RecycleBinItemResponse, 0, len(items)),
		Total:    total,
		Page:     page,
		PageSize: pageSize,
	}
	for i := range items {
		res.Items = append(res.Items, dto.RecycleBinItemResponse{
			ResourceType: "knowledgeBase",
			ID:           items[i].ID.String(),
			Name:         items[i].Name,
			DeletedAt:    items[i].DeletedAt,
		})
	}
	return res, nil
}

// Restore keeps the owner-filtered lookup rather than going through the capability
// matrix. CapKnowledgeBaseDelete is owner-only anyway, so the outcome is identical,
// and the recycle bin is the owner's private space: a manager should get 404 for a
// knowledge base sitting in it, not a 403 that confirms it is there. The same
// reasoning covers PermanentDelete and the batch equivalents.
func (s *KnowledgeBaseService) Restore(ctx context.Context, ownerID, id uuid.UUID) error {
	kb, err := s.repo.FindDeletedByIDAndOwner(ctx, id, ownerID)
	if err != nil {
		return apperror.Internal(err)
	}
	if kb == nil {
		return apperror.NotFound("KNOWLEDGE_BASE_NOT_FOUND", "知识库不存在")
	}
	if err := s.repo.Restore(ctx, id); err != nil {
		if errors.Is(err, repository.ErrKnowledgeBaseNotDeleted) {
			return apperror.NotFound("KNOWLEDGE_BASE_NOT_FOUND", "知识库不存在")
		}
		return apperror.Internal(err)
	}
	s.activities.Record(ctx, ownerID, ActivityEntry{
		Action:            ActivityKnowledgeBaseRestored,
		ResourceType:      "knowledgeBase",
		ResourceID:        kb.ID,
		ResourceName:      kb.Name,
		KnowledgeBaseID:   &kb.ID,
		KnowledgeBaseName: kb.Name,
	})
	return nil
}

func (s *KnowledgeBaseService) SetFavorite(ctx context.Context, ownerID, id uuid.UUID, favorite bool) error {
	if _, err := s.findKnowledgeBaseForCapability(ctx, ownerID, id, access.CapKnowledgeBaseRead); err != nil {
		return err
	}
	if err := s.favorites.Set(ctx, ownerID, id, favorite); err != nil {
		return apperror.Internal(err)
	}
	return nil
}

func (s *KnowledgeBaseService) BatchSetFavorite(ctx context.Context, ownerID uuid.UUID, req dto.KnowledgeBaseBatchFavoriteRequest) (*dto.KnowledgeBaseBatchResultResponse, error) {
	ids := normalizeUUIDs(req.KnowledgeBaseIDs)
	if len(ids) == 0 {
		return nil, apperror.Validation(map[string]any{"knowledgeBaseIds": "知识库 ID 不能为空"})
	}
	if err := s.ensureKnowledgeBasesCapability(ctx, ownerID, ids, access.CapKnowledgeBaseRead); err != nil {
		return nil, err
	}
	for _, id := range ids {
		if err := s.favorites.Set(ctx, ownerID, id, req.Favorite); err != nil {
			return nil, apperror.Internal(err)
		}
	}
	return &dto.KnowledgeBaseBatchResultResponse{ProcessedCount: len(ids)}, nil
}

func (s *KnowledgeBaseService) BatchMoveCategory(ctx context.Context, ownerID uuid.UUID, req dto.KnowledgeBaseBatchMoveCategoryRequest) (*dto.KnowledgeBaseBatchResultResponse, error) {
	ids := normalizeUUIDs(req.KnowledgeBaseIDs)
	if len(ids) == 0 {
		return nil, apperror.Validation(map[string]any{"knowledgeBaseIds": "知识库 ID 不能为空"})
	}
	if err := s.ensureKnowledgeBasesCapability(ctx, ownerID, ids, access.CapKnowledgeBaseWrite); err != nil {
		return nil, err
	}
	if err := s.ensureCategoryOwner(ctx, ownerID, req.CategoryID); err != nil {
		return nil, err
	}
	for _, id := range ids {
		kb, err := s.findKnowledgeBaseForCapability(ctx, ownerID, id, access.CapKnowledgeBaseWrite)
		if err != nil {
			return nil, err
		}
		kb.CategoryID = req.CategoryID
		kb.UpdatedByID = &ownerID
		if err := s.repo.Update(ctx, kb); err != nil {
			return nil, apperror.Internal(err)
		}
	}
	return &dto.KnowledgeBaseBatchResultResponse{ProcessedCount: len(ids)}, nil
}

// BatchTag applies one tag mutation across several knowledge bases. Like the
// other batch endpoints it is all-or-nothing: ownership of every knowledge base
// and every tag is verified up front, and the mutation itself runs in a single
// repository transaction.
func (s *KnowledgeBaseService) BatchTag(ctx context.Context, ownerID uuid.UUID, req dto.KnowledgeBaseBatchTagRequest) (*dto.KnowledgeBaseBatchResultResponse, error) {
	ids := normalizeUUIDs(req.KnowledgeBaseIDs)
	if len(ids) == 0 {
		return nil, apperror.Validation(map[string]any{"knowledgeBaseIds": "知识库 ID 不能为空"})
	}
	mode := normalizeBatchTagMode(req.Mode)
	if err := validateBatchTagMode(mode); err != nil {
		return nil, err
	}
	tagIDs := normalizeUUIDs(req.TagIDs)
	// Only replace has a meaningful empty payload: it clears every tag. Add and
	// remove with no tags would silently do nothing, so reject them instead.
	if len(tagIDs) == 0 && mode != dto.KnowledgeBaseBatchTagModeReplace {
		return nil, apperror.Validation(map[string]any{"tagIds": "标签 ID 不能为空"})
	}
	if err := s.ensureKnowledgeBasesCapability(ctx, ownerID, ids, access.CapKnowledgeBaseWrite); err != nil {
		return nil, err
	}
	if err := s.ensureTagsOwner(ctx, ownerID, tagIDs); err != nil {
		return nil, err
	}
	if err := s.tagBindings.ApplyForKnowledgeBases(ctx, ids, tagIDs, mode, ownerID); err != nil {
		return nil, apperror.Internal(err)
	}
	return &dto.KnowledgeBaseBatchResultResponse{ProcessedCount: len(ids)}, nil
}

func (s *KnowledgeBaseService) BatchDelete(ctx context.Context, ownerID uuid.UUID, req dto.KnowledgeBaseBatchRequest) (*dto.KnowledgeBaseBatchResultResponse, error) {
	ids := normalizeUUIDs(req.KnowledgeBaseIDs)
	if len(ids) == 0 {
		return nil, apperror.Validation(map[string]any{"knowledgeBaseIds": "知识库 ID 不能为空"})
	}
	if err := s.ensureKnowledgeBasesCapability(ctx, ownerID, ids, access.CapKnowledgeBaseDelete); err != nil {
		return nil, err
	}
	for _, id := range ids {
		kb, err := s.findKnowledgeBaseForCapability(ctx, ownerID, id, access.CapKnowledgeBaseDelete)
		if err != nil {
			return nil, err
		}
		if err := s.repo.Delete(ctx, kb); err != nil {
			return nil, apperror.Internal(err)
		}
	}
	return &dto.KnowledgeBaseBatchResultResponse{ProcessedCount: len(ids)}, nil
}

func (s *KnowledgeBaseService) BatchRestore(ctx context.Context, ownerID uuid.UUID, req dto.KnowledgeBaseBatchRequest) (*dto.KnowledgeBaseBatchResultResponse, error) {
	ids := normalizeUUIDs(req.KnowledgeBaseIDs)
	if len(ids) == 0 {
		return nil, apperror.Validation(map[string]any{"knowledgeBaseIds": "知识库 ID 不能为空"})
	}
	if err := s.ensureDeletedKnowledgeBasesOwner(ctx, ownerID, ids); err != nil {
		return nil, err
	}
	if err := s.repo.BatchRestore(ctx, ids); err != nil {
		if errors.Is(err, repository.ErrKnowledgeBaseNotDeleted) {
			return nil, apperror.NotFound("KNOWLEDGE_BASE_NOT_FOUND", "知识库不存在")
		}
		return nil, apperror.Internal(err)
	}
	return &dto.KnowledgeBaseBatchResultResponse{ProcessedCount: len(ids)}, nil
}

func (s *KnowledgeBaseService) RecordView(ctx context.Context, ownerID, id uuid.UUID) error {
	if _, err := s.findKnowledgeBaseForCapability(ctx, ownerID, id, access.CapKnowledgeBaseRead); err != nil {
		return err
	}
	if err := s.views.Record(ctx, ownerID, id); err != nil {
		return apperror.Internal(err)
	}
	return nil
}

func (s *KnowledgeBaseService) GetPermissions(ctx context.Context, ownerID, id uuid.UUID) (*dto.KnowledgeBasePermissionResponse, error) {
	kb, err := s.findKnowledgeBaseForCapability(ctx, ownerID, id, access.CapMembersRead)
	if err != nil {
		return nil, err
	}

	members, err := s.members.ListByKnowledgeBase(ctx, kb.ID)
	if err != nil {
		return nil, apperror.Internal(err)
	}
	res := toKnowledgeBasePermissionResponse(kb, members)
	return &res, nil
}

func (s *KnowledgeBaseService) UpdatePermissions(ctx context.Context, ownerID, id uuid.UUID, req dto.KnowledgeBasePermissionUpdateRequest) (*dto.KnowledgeBasePermissionResponse, error) {
	kb, err := s.findKnowledgeBaseForCapability(ctx, ownerID, id, access.CapMembersWrite)
	if err != nil {
		return nil, err
	}

	visibility := normalizedVisibility(strings.TrimSpace(req.Visibility))
	if err := validateVisibility(visibility); err != nil {
		return nil, err
	}

	kb.Visibility = visibility
	kb.UpdatedByID = &ownerID
	if err := s.repo.Update(ctx, kb); err != nil {
		return nil, apperror.Internal(err)
	}

	updated, err := s.repo.FindByID(ctx, id)
	if err != nil {
		return nil, apperror.Internal(err)
	}
	if updated == nil {
		return nil, apperror.NotFound("KNOWLEDGE_BASE_NOT_FOUND", "知识库不存在")
	}

	members, err := s.members.ListByKnowledgeBase(ctx, updated.ID)
	if err != nil {
		return nil, apperror.Internal(err)
	}
	res := toKnowledgeBasePermissionResponse(updated, members)
	return &res, nil
}

func (s *KnowledgeBaseService) AddMember(ctx context.Context, actorID, kbID uuid.UUID, req dto.KnowledgeBaseMemberRequest) (*dto.PermissionMember, error) {
	kb, err := s.findKnowledgeBaseForCapability(ctx, actorID, kbID, access.CapMembersWrite)
	if err != nil {
		return nil, err
	}
	role := normalizeMemberRole(req.Role)
	if err := validateAssignableMemberRole(role); err != nil {
		return nil, err
	}
	if req.UserID == uuid.Nil {
		return nil, apperror.Validation(map[string]any{"userId": "用户 ID 不合法"})
	}
	if req.UserID == kb.OwnerID {
		return nil, apperror.New(http.StatusBadRequest, "OWNER_MEMBER_IMMUTABLE", "owner 权限不能通过成员接口修改")
	}
	user, err := s.users.FindByID(ctx, req.UserID)
	if err != nil {
		return nil, apperror.Internal(err)
	}
	if user == nil {
		return nil, apperror.NotFound("USER_NOT_FOUND", "用户不存在")
	}
	member := &model.KnowledgeBaseMember{
		KnowledgeBaseID: kb.ID,
		UserID:          req.UserID,
		Role:            role,
	}
	if err := s.members.Save(ctx, member); err != nil {
		return nil, apperror.Internal(err)
	}
	s.recordMemberActivity(ctx, actorID, ActivityMemberAdded, kb, user)
	res := permissionMemberFromUser(user, role)
	return &res, nil
}

func (s *KnowledgeBaseService) UpdateMember(ctx context.Context, actorID, kbID, userID uuid.UUID, req dto.KnowledgeBaseMemberRoleRequest) (*dto.PermissionMember, error) {
	kb, err := s.findKnowledgeBaseForCapability(ctx, actorID, kbID, access.CapMembersWrite)
	if err != nil {
		return nil, err
	}
	role := normalizeMemberRole(req.Role)
	if err := validateAssignableMemberRole(role); err != nil {
		return nil, err
	}
	if userID == kb.OwnerID {
		return nil, apperror.New(http.StatusBadRequest, "OWNER_MEMBER_IMMUTABLE", "owner 权限不能通过成员接口修改")
	}
	member, err := s.members.Find(ctx, kb.ID, userID)
	if err != nil {
		return nil, apperror.Internal(err)
	}
	if member == nil {
		return nil, apperror.NotFound("MEMBER_NOT_FOUND", "成员不存在")
	}
	user, err := s.users.FindByID(ctx, userID)
	if err != nil {
		return nil, apperror.Internal(err)
	}
	if user == nil {
		return nil, apperror.NotFound("USER_NOT_FOUND", "用户不存在")
	}
	member.Role = role
	if err := s.members.Save(ctx, member); err != nil {
		return nil, apperror.Internal(err)
	}
	s.recordMemberActivity(ctx, actorID, ActivityMemberRoleChanged, kb, user)
	res := permissionMemberFromUser(user, role)
	return &res, nil
}

func (s *KnowledgeBaseService) RemoveMember(ctx context.Context, actorID, kbID, userID uuid.UUID) error {
	kb, err := s.findKnowledgeBaseForCapability(ctx, actorID, kbID, access.CapMembersWrite)
	if err != nil {
		return err
	}
	if userID == kb.OwnerID {
		return apperror.New(http.StatusBadRequest, "OWNER_MEMBER_IMMUTABLE", "owner 不能被删除")
	}
	member, err := s.members.Find(ctx, kb.ID, userID)
	if err != nil {
		return apperror.Internal(err)
	}
	if member == nil {
		return apperror.NotFound("MEMBER_NOT_FOUND", "成员不存在")
	}
	if err := s.members.Delete(ctx, kb.ID, userID); err != nil {
		return apperror.Internal(err)
	}
	removed, err := s.users.FindByID(ctx, userID)
	if err == nil {
		s.recordMemberActivity(ctx, actorID, ActivityMemberRemoved, kb, removed)
	}
	return nil
}

// recordMemberActivity names the affected member, not the knowledge base: the
// knowledge base is already carried in its own fields.
func (s *KnowledgeBaseService) recordMemberActivity(
	ctx context.Context,
	actorID uuid.UUID,
	action string,
	kb *model.KnowledgeBase,
	member *model.User,
) {
	if s.activities == nil || member == nil {
		return
	}
	name := member.DisplayName
	if strings.TrimSpace(name) == "" {
		name = member.Username
	}
	s.activities.Record(ctx, actorID, ActivityEntry{
		Action:            action,
		ResourceType:      "member",
		ResourceID:        member.ID,
		ResourceName:      name,
		KnowledgeBaseID:   &kb.ID,
		KnowledgeBaseName: kb.Name,
	})
}

func (s *KnowledgeBaseService) PermanentDelete(ctx context.Context, ownerID, id uuid.UUID) error {
	kb, err := s.repo.FindDeletedByIDAndOwner(ctx, id, ownerID)
	if err != nil {
		return apperror.Internal(err)
	}
	if kb == nil {
		return apperror.NotFound("KNOWLEDGE_BASE_NOT_FOUND", "知识库不存在")
	}
	if err := s.repo.PermanentDelete(ctx, id); err != nil {
		if errors.Is(err, repository.ErrKnowledgeBaseNotDeleted) {
			return apperror.NotFound("KNOWLEDGE_BASE_NOT_FOUND", "知识库不存在")
		}
		return apperror.Internal(err)
	}
	return nil
}

func (s *KnowledgeBaseService) EmptyRecycleBin(ctx context.Context, ownerID uuid.UUID) error {
	if err := s.repo.EmptyDeletedByOwner(ctx, ownerID); err != nil {
		return apperror.Internal(err)
	}
	return nil
}

func (s *KnowledgeBaseService) Stats(ctx context.Context, ownerID uuid.UUID, period string) (*dto.KnowledgeBaseStatsResponse, error) {
	period = normalizePeriod(period)
	now := time.Now()
	start := periodStart(now, period)
	previousStart := previousPeriodStart(start, period)
	current, previous, err := s.repo.Stats(ctx, ownerID, start, previousStart)
	if err != nil {
		return nil, apperror.Internal(err)
	}

	return &dto.KnowledgeBaseStatsResponse{
		Period:         period,
		KnowledgeBases: metric(current.KnowledgeBaseCount, previous.KnowledgeBaseCount),
		Documents:      metric(current.DocumentCount, previous.DocumentCount),
		Views:          metric(current.ViewCount, previous.ViewCount),
		Questions:      metric(current.QuestionCount, previous.QuestionCount),
	}, nil
}

// DetailStats is a standalone endpoint on purpose. Knowledge base create/update/
// detail responses stay free of list-only aggregates (see
// TestKnowledgeBaseMutationAndDetailResponsesOmitListOnlyDocumentReadinessCounts),
// so trend data gets its own request rather than widening those payloads.
func (s *KnowledgeBaseService) DetailStats(ctx context.Context, ownerID, id uuid.UUID, period string) (*dto.KnowledgeBaseDetailStatsResponse, error) {
	kb, err := s.findKnowledgeBaseForCapability(ctx, ownerID, id, access.CapKnowledgeBaseRead)
	if err != nil {
		return nil, err
	}

	period = normalizePeriod(period)
	now := time.Now()
	start := periodStart(now, period)
	previousStart := previousPeriodStart(start, period)
	current, previous, err := s.repo.StatsForKnowledgeBase(ctx, ownerID, kb.ID, start, previousStart)
	if err != nil {
		return nil, apperror.Internal(err)
	}

	return &dto.KnowledgeBaseDetailStatsResponse{
		KnowledgeBaseID: kb.ID.String(),
		Period:          period,
		Documents:       metric(current.DocumentCount, previous.DocumentCount),
		Views:           metric(current.ViewCount, previous.ViewCount),
		Questions:       metric(current.QuestionCount, previous.QuestionCount),
	}, nil
}

// findKnowledgeBaseForCapability is the single authorization entry point for this
// service. It replaces both the owner-only findKnowledgeBase and the
// manager-only management helper.
func (s *KnowledgeBaseService) findKnowledgeBaseForCapability(
	ctx context.Context,
	actorID, id uuid.UUID,
	capability access.Capability,
) (*model.KnowledgeBase, error) {
	granted, err := authorizeKnowledgeBase(ctx, s.repo, actorID, id, capability)
	if err != nil {
		return nil, err
	}
	return granted.knowledgeBase, nil
}

// ensureKnowledgeBasesCapability authorizes every id in a batch before any of them
// is touched.
//
// All-or-nothing on purpose: a batch that stops halfway would leave the user with
// a partial result and no way to tell which ids went through. The pre-pass costs
// one extra query per id, which a batch endpoint can afford.
func (s *KnowledgeBaseService) ensureKnowledgeBasesCapability(
	ctx context.Context,
	actorID uuid.UUID,
	ids []uuid.UUID,
	capability access.Capability,
) error {
	for _, id := range ids {
		if _, err := s.findKnowledgeBaseForCapability(ctx, actorID, id, capability); err != nil {
			return err
		}
	}
	return nil
}

// ensureDeletedKnowledgeBasesOwner is the recycle-bin counterpart. It stays
// owner-filtered rather than capability-based for the reason recorded on Restore:
// a knowledge base in the recycle bin should read as absent to everyone but its
// owner.
func (s *KnowledgeBaseService) ensureDeletedKnowledgeBasesOwner(ctx context.Context, ownerID uuid.UUID, ids []uuid.UUID) error {
	for _, id := range ids {
		kb, err := s.repo.FindDeletedByIDAndOwner(ctx, id, ownerID)
		if err != nil {
			return apperror.Internal(err)
		}
		if kb == nil {
			return apperror.NotFound("KNOWLEDGE_BASE_NOT_FOUND", "知识库不存在")
		}
	}
	return nil
}

func (s *KnowledgeBaseService) ensureCategoryOwner(ctx context.Context, ownerID uuid.UUID, categoryID *uuid.UUID) error {
	if categoryID == nil {
		return nil
	}
	category, err := s.categories.FindByIDAndOwner(ctx, *categoryID, ownerID)
	if err != nil {
		return apperror.Internal(err)
	}
	if category == nil {
		return apperror.NotFound("CATEGORY_NOT_FOUND", "分类不存在")
	}
	return nil
}

func (s *KnowledgeBaseService) ensureCategoriesOwner(ctx context.Context, ownerID uuid.UUID, categoryIDs []uuid.UUID) error {
	for _, categoryID := range categoryIDs {
		if err := s.ensureCategoryOwner(ctx, ownerID, &categoryID); err != nil {
			return err
		}
	}
	return nil
}

func (s *KnowledgeBaseService) ensureTagsOwner(ctx context.Context, ownerID uuid.UUID, tagIDs []uuid.UUID) error {
	if len(tagIDs) == 0 {
		return nil
	}
	items, err := s.tags.FindByIDsAndOwner(ctx, ownerID, tagIDs)
	if err != nil {
		return apperror.Internal(err)
	}
	if len(items) != len(tagIDs) {
		return apperror.NotFound("TAG_NOT_FOUND", "标签不存在")
	}
	return nil
}

func defaultConfig(config *dto.RetrievalConfig) dto.RetrievalConfig {
	if config == nil {
		return defaultRetrievalConfig
	}
	return *config
}

func toKnowledgeBaseResponse(kb *model.KnowledgeBase, tags []model.KnowledgeBaseTag) dto.KnowledgeBaseResponse {
	config := defaultRetrievalConfig
	if len(kb.RetrievalConfig) > 0 {
		_ = json.Unmarshal(kb.RetrievalConfig, &config)
	}
	var categoryID *string
	if kb.CategoryID != nil {
		value := kb.CategoryID.String()
		categoryID = &value
	}
	visibility := kb.Visibility
	if visibility == "" {
		visibility = "private"
	}

	return dto.KnowledgeBaseResponse{
		ID:              kb.ID.String(),
		Name:            kb.Name,
		Description:     kb.Description,
		CategoryID:      categoryID,
		Visibility:      visibility,
		RetrievalConfig: config,
		CreatedAt:       kb.CreatedAt,
		UpdatedAt:       kb.UpdatedAt,
		UpdatedBy:       toKnowledgeBaseUserSummary(kb.UpdatedBy, &kb.Owner),
		Tags:            toTagResponses(tags),
	}
}

func toWorkspaceKnowledgeBaseResponse(item *repository.KnowledgeBaseListItem, tags []model.KnowledgeBaseTag) dto.KnowledgeBaseResponse {
	config := defaultRetrievalConfig
	if len(item.RetrievalConfig) > 0 {
		_ = json.Unmarshal(item.RetrievalConfig, &config)
	}
	var categoryID *string
	if item.CategoryID != nil {
		value := item.CategoryID.String()
		categoryID = &value
	}
	visibility := item.Visibility
	if visibility == "" {
		visibility = "private"
	}
	lastViewedAt := parseOptionalTime(item.LastViewedAt)
	return dto.KnowledgeBaseResponse{
		ID:                      item.ID.String(),
		Name:                    item.Name,
		Description:             item.Description,
		CategoryID:              categoryID,
		Visibility:              visibility,
		RetrievalConfig:         config,
		CreatedAt:               item.CreatedAt,
		UpdatedAt:               item.UpdatedAt,
		DocumentCount:           item.DocumentCount,
		CompletedDocumentCount:  &item.CompletedDocumentCount,
		ProcessingDocumentCount: &item.ProcessingDocumentCount,
		FailedDocumentCount:     &item.FailedDocumentCount,
		ViewCount:               item.ViewCount,
		QuestionCount:           item.QuestionCount,
		IsFavorite:              item.IsFavorite,
		LastViewedAt:            lastViewedAt,
		UpdatedBy:               workspaceUserSummary(item),
		Tags:                    toTagResponses(tags),
	}
}

func toKnowledgeBaseUserSummary(primary *model.User, fallback *model.User) *dto.UserSummary {
	if primary != nil {
		return &dto.UserSummary{
			ID:          primary.ID.String(),
			Username:    primary.Username,
			DisplayName: primary.DisplayName,
			AvatarURL:   primary.AvatarURL,
		}
	}
	if fallback == nil {
		return nil
	}
	return &dto.UserSummary{
		ID:          fallback.ID.String(),
		Username:    fallback.Username,
		DisplayName: fallback.DisplayName,
		AvatarURL:   fallback.AvatarURL,
	}
}

func workspaceUserSummary(item *repository.KnowledgeBaseListItem) *dto.UserSummary {
	if item.UpdatedByID != nil && item.UpdatedByUsername != nil && item.UpdatedByDisplayName != nil {
		summary := &dto.UserSummary{
			ID:          item.UpdatedByID.String(),
			Username:    *item.UpdatedByUsername,
			DisplayName: *item.UpdatedByDisplayName,
		}
		if item.UpdatedByAvatarURL != nil {
			summary.AvatarURL = *item.UpdatedByAvatarURL
		}
		return summary
	}
	return &dto.UserSummary{
		ID:          item.OwnerID.String(),
		Username:    item.OwnerUsername,
		DisplayName: item.OwnerDisplayName,
		AvatarURL:   item.OwnerAvatarURL,
	}
}

func toKnowledgeBasePermissionResponse(kb *model.KnowledgeBase, members []model.KnowledgeBaseMember) dto.KnowledgeBasePermissionResponse {
	owner := toKnowledgeBaseUserSummary(&kb.Owner, nil)
	response := dto.KnowledgeBasePermissionResponse{
		KnowledgeBaseID: kb.ID.String(),
		Visibility:      normalizedVisibility(kb.Visibility),
		Managers:        make([]dto.PermissionMember, 0, 1),
		Members:         []dto.PermissionMember{},
	}
	if owner != nil {
		response.Owner = *owner
		response.Managers = append(response.Managers, dto.PermissionMember{
			ID:          owner.ID,
			Username:    owner.Username,
			DisplayName: owner.DisplayName,
			AvatarURL:   owner.AvatarURL,
			Role:        string(access.RoleOwner),
		})
	}
	for i := range members {
		member := permissionMemberFromUser(&members[i].User, members[i].Role)
		// Managers are grouped with the owner because both can administer the base;
		// viewers and editors are the people it was shared with.
		if member.Role == string(access.RoleManager) {
			response.Managers = append(response.Managers, member)
			continue
		}
		response.Members = append(response.Members, member)
	}
	return response
}

func permissionMemberFromUser(user *model.User, role string) dto.PermissionMember {
	return dto.PermissionMember{
		ID:          user.ID.String(),
		Username:    user.Username,
		DisplayName: user.DisplayName,
		AvatarURL:   user.AvatarURL,
		Role:        role,
	}
}

func parseOptionalTime(value *string) *time.Time {
	if value == nil || *value == "" {
		return nil
	}
	formats := []string{
		time.RFC3339Nano,
		"2006-01-02 15:04:05.999999999-07:00",
		"2006-01-02 15:04:05.999999999Z07:00",
		"2006-01-02 15:04:05.999999999",
		"2006-01-02 15:04:05",
	}
	for _, format := range formats {
		parsed, err := time.Parse(format, *value)
		if err == nil {
			return &parsed
		}
	}
	return nil
}

func toTagResponses(tags []model.KnowledgeBaseTag) []dto.KnowledgeBaseTagResponse {
	if len(tags) == 0 {
		return nil
	}
	items := make([]dto.KnowledgeBaseTagResponse, 0, len(tags))
	for i := range tags {
		items = append(items, dto.KnowledgeBaseTagResponse{
			ID:        tags[i].ID,
			Name:      tags[i].Name,
			CreatedAt: tags[i].CreatedAt,
			UpdatedAt: tags[i].UpdatedAt,
		})
	}
	return items
}

func optionalUUIDs(value *[]uuid.UUID) []uuid.UUID {
	if value == nil {
		return nil
	}
	return *value
}

func normalizeUUIDs(ids []uuid.UUID) []uuid.UUID {
	if len(ids) == 0 {
		return nil
	}
	result := make([]uuid.UUID, 0, len(ids))
	seen := make(map[uuid.UUID]struct{}, len(ids))
	for _, id := range ids {
		if id == uuid.Nil {
			continue
		}
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		result = append(result, id)
	}
	return result
}

func normalizedRecyclePage(page, pageSize int) (int, int) {
	if page <= 0 {
		page = 1
	}
	if pageSize <= 0 {
		pageSize = 20
	}
	if pageSize > 100 {
		pageSize = 100
	}
	return page, pageSize
}

func normalizeKnowledgeBaseListQuery(query dto.KnowledgeBaseListQuery) dto.KnowledgeBaseListQuery {
	if query.Scope == "" {
		query.Scope = "all"
	}
	switch query.Scope {
	case "all", "created", "managed", "favorite", "recent":
	default:
		query.Scope = "all"
	}
	switch query.Sort {
	case "updatedAt_desc", "createdAt_desc", "name_asc":
	default:
		query.Sort = "updatedAt_desc"
	}
	if query.Page <= 0 {
		query.Page = 1
	}
	if query.PageSize <= 0 {
		query.PageSize = 20
	}
	if query.PageSize > 100 {
		query.PageSize = 100
	}
	query.Q = strings.TrimSpace(query.Q)
	return query
}

func normalizedVisibility(value string) string {
	if value == "" {
		return "private"
	}
	return value
}

func validateVisibility(value string) error {
	if value == "private" || value == "public" {
		return nil
	}
	return apperror.New(http.StatusBadRequest, "INVALID_VISIBILITY", "知识库可见性不合法")
}

func normalizeMemberRole(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}

// validateAssignableMemberRole rejects anything the member table may not hold.
//
// The set comes from access.AssignableRoles rather than a literal list here, so
// the API, the Go matrix and the CHECK constraint cannot drift apart. "member" is
// no longer accepted: migration 020 rewrote those rows to "viewer", and continuing
// to accept the old name would keep writing a value that resolves to no access.
func validateAssignableMemberRole(value string) error {
	if access.Valid(access.Role(value)) {
		return nil
	}
	if value == string(access.RoleOwner) {
		return apperror.New(http.StatusBadRequest, "OWNER_MEMBER_IMMUTABLE", "owner 权限来自知识库 owner_id，不能通过成员接口分配")
	}
	return apperror.New(http.StatusBadRequest, "INVALID_MEMBER_ROLE", "成员角色不合法")
}

func normalizeBatchTagMode(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	if value == "" {
		return dto.KnowledgeBaseBatchTagModeAdd
	}
	return value
}

func validateBatchTagMode(value string) error {
	switch value {
	case dto.KnowledgeBaseBatchTagModeAdd,
		dto.KnowledgeBaseBatchTagModeRemove,
		dto.KnowledgeBaseBatchTagModeReplace:
		return nil
	default:
		return apperror.New(http.StatusBadRequest, "INVALID_BATCH_TAG_MODE", "批量标签模式不合法")
	}
}

func normalizePeriod(period string) string {
	if period == "day" {
		return "day"
	}
	return "month"
}

func periodStart(now time.Time, period string) time.Time {
	if period == "day" {
		return time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	}
	return time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, now.Location())
}

func previousPeriodStart(start time.Time, period string) time.Time {
	if period == "day" {
		return start.AddDate(0, 0, -1)
	}
	return start.AddDate(0, -1, 0)
}

func metric(current, previous int64) dto.WorkspaceMetric {
	var change *float64
	if previous > 0 {
		value := float64(current-previous) / float64(previous)
		change = &value
	}
	return dto.WorkspaceMetric{
		Value:       current,
		ChangeRatio: change,
	}
}

func defaultWorkspacePreferenceResponse() dto.KnowledgeBaseWorkspacePreferenceResponse {
	return dto.KnowledgeBaseWorkspacePreferenceResponse{
		ViewMode:            "table",
		Scope:               "all",
		Sort:                "updatedAt_desc",
		Visibility:          "all",
		ExpandedCategoryIDs: []string{},
	}
}

func toWorkspacePreferenceResponse(item *model.KnowledgeBaseWorkspacePreference) dto.KnowledgeBaseWorkspacePreferenceResponse {
	var expandedCategoryIDs []uuid.UUID
	if len(item.ExpandedCategoryIDs) > 0 {
		_ = json.Unmarshal(item.ExpandedCategoryIDs, &expandedCategoryIDs)
	}
	response := dto.KnowledgeBaseWorkspacePreferenceResponse{
		ViewMode:            normalizeWorkspaceViewMode(item.ViewMode),
		Scope:               normalizeWorkspaceScope(item.Scope),
		Sort:                normalizeWorkspacePreferenceSort(item.Sort),
		Visibility:          normalizeWorkspacePreferenceVisibility(item.Visibility),
		ExpandedCategoryIDs: make([]string, 0, len(expandedCategoryIDs)),
	}
	for _, id := range expandedCategoryIDs {
		response.ExpandedCategoryIDs = append(response.ExpandedCategoryIDs, id.String())
	}
	return response
}

func normalizeWorkspaceViewMode(value string) string {
	if value == "" {
		return "table"
	}
	return value
}

func validateWorkspaceViewMode(value string) error {
	switch value {
	case "table", "card":
		return nil
	default:
		return apperror.New(http.StatusBadRequest, "INVALID_WORKSPACE_VIEW_MODE", "invalid workspace view mode")
	}
}

func normalizeWorkspaceScope(value string) string {
	if value == "" {
		return "all"
	}
	return value
}

func validateWorkspaceScope(value string) error {
	switch value {
	case "all", "created", "managed", "favorite", "recent":
		return nil
	default:
		return apperror.New(http.StatusBadRequest, "INVALID_WORKSPACE_SCOPE", "invalid workspace scope")
	}
}

func normalizeWorkspacePreferenceSort(value string) string {
	if value == "" {
		return "updatedAt_desc"
	}
	return value
}

func validateWorkspacePreferenceSort(value string) error {
	switch value {
	case "updatedAt_desc", "createdAt_desc", "name_asc":
		return nil
	default:
		return apperror.New(http.StatusBadRequest, "INVALID_WORKSPACE_SORT", "invalid workspace sort")
	}
}

func normalizeWorkspacePreferenceVisibility(value string) string {
	if value == "" {
		return "all"
	}
	return value
}

func validateWorkspacePreferenceVisibility(value string) error {
	switch value {
	case "all", "public", "private":
		return nil
	default:
		return apperror.New(http.StatusBadRequest, "INVALID_WORKSPACE_VISIBILITY", "invalid workspace visibility")
	}
}
