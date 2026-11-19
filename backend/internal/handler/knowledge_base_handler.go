package handler

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"kbchat/backend/internal/apperror"
	"kbchat/backend/internal/dto"
	"kbchat/backend/internal/middleware"
	"kbchat/backend/internal/service"
)

type KnowledgeBaseHandler struct {
	knowledgeBases *service.KnowledgeBaseService
}

func NewKnowledgeBaseHandler(knowledgeBases *service.KnowledgeBaseService) *KnowledgeBaseHandler {
	return &KnowledgeBaseHandler{knowledgeBases: knowledgeBases}
}

func (h *KnowledgeBaseHandler) Create(c *gin.Context) {
	userID, ok := currentUserIDOrError(c)
	if !ok {
		return
	}

	var req dto.KnowledgeBaseRequest
	if err := bindJSON(c, &req); err != nil {
		RespondError(c, apperror.Validation(map[string]any{"body": "请求参数不合法"}))
		return
	}

	res, err := h.knowledgeBases.Create(c.Request.Context(), userID, req)
	if err != nil {
		RespondError(c, err)
		return
	}

	c.JSON(http.StatusCreated, res)
}

func (h *KnowledgeBaseHandler) List(c *gin.Context) {
	userID, ok := currentUserIDOrError(c)
	if !ok {
		return
	}

	query, ok := parseKnowledgeBaseListQuery(c)
	if !ok {
		return
	}
	res, err := h.knowledgeBases.ListWorkspace(c.Request.Context(), userID, query)
	if err != nil {
		RespondError(c, err)
		return
	}

	c.JSON(http.StatusOK, res)
}

func (h *KnowledgeBaseHandler) GetWorkspacePreference(c *gin.Context) {
	userID, ok := currentUserIDOrError(c)
	if !ok {
		return
	}
	res, err := h.knowledgeBases.GetWorkspacePreference(c.Request.Context(), userID)
	if err != nil {
		RespondError(c, err)
		return
	}
	c.JSON(http.StatusOK, res)
}

func (h *KnowledgeBaseHandler) UpdateWorkspacePreference(c *gin.Context) {
	userID, ok := currentUserIDOrError(c)
	if !ok {
		return
	}
	var req dto.KnowledgeBaseWorkspacePreferenceRequest
	if err := bindJSON(c, &req); err != nil {
		RespondError(c, apperror.Validation(map[string]any{"body": "request body is invalid"}))
		return
	}
	res, err := h.knowledgeBases.UpdateWorkspacePreference(c.Request.Context(), userID, req)
	if err != nil {
		RespondError(c, err)
		return
	}
	c.JSON(http.StatusOK, res)
}

func (h *KnowledgeBaseHandler) BatchFavorite(c *gin.Context) {
	userID, ok := currentUserIDOrError(c)
	if !ok {
		return
	}
	var req dto.KnowledgeBaseBatchFavoriteRequest
	if err := bindJSON(c, &req); err != nil {
		RespondError(c, apperror.Validation(map[string]any{"body": "请求参数不合法"}))
		return
	}
	res, err := h.knowledgeBases.BatchSetFavorite(c.Request.Context(), userID, req)
	if err != nil {
		RespondError(c, err)
		return
	}
	c.JSON(http.StatusOK, res)
}

func (h *KnowledgeBaseHandler) BatchMoveCategory(c *gin.Context) {
	userID, ok := currentUserIDOrError(c)
	if !ok {
		return
	}
	var req dto.KnowledgeBaseBatchMoveCategoryRequest
	if err := bindJSON(c, &req); err != nil {
		RespondError(c, apperror.Validation(map[string]any{"body": "请求参数不合法"}))
		return
	}
	res, err := h.knowledgeBases.BatchMoveCategory(c.Request.Context(), userID, req)
	if err != nil {
		RespondError(c, err)
		return
	}
	c.JSON(http.StatusOK, res)
}

func (h *KnowledgeBaseHandler) BatchTag(c *gin.Context) {
	userID, ok := currentUserIDOrError(c)
	if !ok {
		return
	}
	var req dto.KnowledgeBaseBatchTagRequest
	if err := bindJSON(c, &req); err != nil {
		RespondError(c, apperror.Validation(map[string]any{"body": "请求参数不合法"}))
		return
	}
	res, err := h.knowledgeBases.BatchTag(c.Request.Context(), userID, req)
	if err != nil {
		RespondError(c, err)
		return
	}
	c.JSON(http.StatusOK, res)
}

func (h *KnowledgeBaseHandler) BatchDelete(c *gin.Context) {
	userID, ok := currentUserIDOrError(c)
	if !ok {
		return
	}
	var req dto.KnowledgeBaseBatchRequest
	if err := bindJSON(c, &req); err != nil {
		RespondError(c, apperror.Validation(map[string]any{"body": "请求参数不合法"}))
		return
	}
	res, err := h.knowledgeBases.BatchDelete(c.Request.Context(), userID, req)
	if err != nil {
		RespondError(c, err)
		return
	}
	c.JSON(http.StatusOK, res)
}

func (h *KnowledgeBaseHandler) BatchRestore(c *gin.Context) {
	userID, ok := currentUserIDOrError(c)
	if !ok {
		return
	}
	var req dto.KnowledgeBaseBatchRequest
	if err := bindJSON(c, &req); err != nil {
		RespondError(c, apperror.Validation(map[string]any{"body": "请求参数不合法"}))
		return
	}
	res, err := h.knowledgeBases.BatchRestore(c.Request.Context(), userID, req)
	if err != nil {
		RespondError(c, err)
		return
	}
	c.JSON(http.StatusOK, res)
}

func (h *KnowledgeBaseHandler) Stats(c *gin.Context) {
	userID, ok := currentUserIDOrError(c)
	if !ok {
		return
	}
	res, err := h.knowledgeBases.Stats(c.Request.Context(), userID, c.Query("period"))
	if err != nil {
		RespondError(c, err)
		return
	}
	c.JSON(http.StatusOK, res)
}

func (h *KnowledgeBaseHandler) DetailStats(c *gin.Context) {
	userID, id, ok := userAndKnowledgeBaseID(c)
	if !ok {
		return
	}
	res, err := h.knowledgeBases.DetailStats(c.Request.Context(), userID, id, c.Query("period"))
	if err != nil {
		RespondError(c, err)
		return
	}
	c.JSON(http.StatusOK, res)
}

func (h *KnowledgeBaseHandler) Get(c *gin.Context) {
	userID, id, ok := userAndKnowledgeBaseID(c)
	if !ok {
		return
	}

	res, err := h.knowledgeBases.Get(c.Request.Context(), userID, id)
	if err != nil {
		RespondError(c, err)
		return
	}

	c.JSON(http.StatusOK, res)
}

func (h *KnowledgeBaseHandler) Update(c *gin.Context) {
	userID, id, ok := userAndKnowledgeBaseID(c)
	if !ok {
		return
	}

	var req dto.KnowledgeBaseRequest
	if err := bindJSON(c, &req); err != nil {
		RespondError(c, apperror.Validation(map[string]any{"body": "请求参数不合法"}))
		return
	}

	res, err := h.knowledgeBases.Update(c.Request.Context(), userID, id, req)
	if err != nil {
		RespondError(c, err)
		return
	}

	c.JSON(http.StatusOK, res)
}

func (h *KnowledgeBaseHandler) Delete(c *gin.Context) {
	userID, id, ok := userAndKnowledgeBaseID(c)
	if !ok {
		return
	}

	if err := h.knowledgeBases.Delete(c.Request.Context(), userID, id); err != nil {
		RespondError(c, err)
		return
	}

	c.Status(http.StatusNoContent)
}

func (h *KnowledgeBaseHandler) Favorite(c *gin.Context) {
	h.setFavorite(c, true)
}

func (h *KnowledgeBaseHandler) Unfavorite(c *gin.Context) {
	h.setFavorite(c, false)
}

func (h *KnowledgeBaseHandler) RecordView(c *gin.Context) {
	userID, id, ok := userAndKnowledgeBaseID(c)
	if !ok {
		return
	}
	if err := h.knowledgeBases.RecordView(c.Request.Context(), userID, id); err != nil {
		RespondError(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}

func (h *KnowledgeBaseHandler) GetPermissions(c *gin.Context) {
	userID, id, ok := userAndKnowledgeBaseID(c)
	if !ok {
		return
	}
	res, err := h.knowledgeBases.GetPermissions(c.Request.Context(), userID, id)
	if err != nil {
		RespondError(c, err)
		return
	}
	c.JSON(http.StatusOK, res)
}

func (h *KnowledgeBaseHandler) UpdatePermissions(c *gin.Context) {
	userID, id, ok := userAndKnowledgeBaseID(c)
	if !ok {
		return
	}

	var req dto.KnowledgeBasePermissionUpdateRequest
	if err := bindJSON(c, &req); err != nil {
		RespondError(c, apperror.Validation(map[string]any{"body": "请求参数不合法"}))
		return
	}

	res, err := h.knowledgeBases.UpdatePermissions(c.Request.Context(), userID, id, req)
	if err != nil {
		RespondError(c, err)
		return
	}
	c.JSON(http.StatusOK, res)
}

func (h *KnowledgeBaseHandler) AddMember(c *gin.Context) {
	userID, id, ok := userAndKnowledgeBaseID(c)
	if !ok {
		return
	}
	var req dto.KnowledgeBaseMemberRequest
	if err := bindJSON(c, &req); err != nil {
		RespondError(c, apperror.Validation(map[string]any{"body": "request body is invalid"}))
		return
	}
	res, err := h.knowledgeBases.AddMember(c.Request.Context(), userID, id, req)
	if err != nil {
		RespondError(c, err)
		return
	}
	c.JSON(http.StatusCreated, res)
}

func (h *KnowledgeBaseHandler) UpdateMember(c *gin.Context) {
	userID, id, ok := userAndKnowledgeBaseID(c)
	if !ok {
		return
	}
	memberID, ok := parseUUIDParam(c, "userId", "用户 ID 不合法")
	if !ok {
		return
	}
	var req dto.KnowledgeBaseMemberRoleRequest
	if err := bindJSON(c, &req); err != nil {
		RespondError(c, apperror.Validation(map[string]any{"body": "request body is invalid"}))
		return
	}
	res, err := h.knowledgeBases.UpdateMember(c.Request.Context(), userID, id, memberID, req)
	if err != nil {
		RespondError(c, err)
		return
	}
	c.JSON(http.StatusOK, res)
}

func (h *KnowledgeBaseHandler) RemoveMember(c *gin.Context) {
	userID, id, ok := userAndKnowledgeBaseID(c)
	if !ok {
		return
	}
	memberID, ok := parseUUIDParam(c, "userId", "用户 ID 不合法")
	if !ok {
		return
	}
	if err := h.knowledgeBases.RemoveMember(c.Request.Context(), userID, id, memberID); err != nil {
		RespondError(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}

func (h *KnowledgeBaseHandler) ListRecycleBin(c *gin.Context) {
	userID, ok := currentUserIDOrError(c)
	if !ok {
		return
	}
	res, err := h.knowledgeBases.ListRecycleBin(c.Request.Context(), userID, queryInt(c, "page", 1), queryInt(c, "pageSize", 20))
	if err != nil {
		RespondError(c, err)
		return
	}
	c.JSON(http.StatusOK, res)
}

func (h *KnowledgeBaseHandler) Restore(c *gin.Context) {
	userID, id, ok := userAndKnowledgeBaseID(c)
	if !ok {
		return
	}
	if err := h.knowledgeBases.Restore(c.Request.Context(), userID, id); err != nil {
		RespondError(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}

func (h *KnowledgeBaseHandler) PermanentDelete(c *gin.Context) {
	userID, id, ok := userAndKnowledgeBaseID(c)
	if !ok {
		return
	}
	if err := h.knowledgeBases.PermanentDelete(c.Request.Context(), userID, id); err != nil {
		RespondError(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}

func (h *KnowledgeBaseHandler) EmptyRecycleBin(c *gin.Context) {
	userID, ok := currentUserIDOrError(c)
	if !ok {
		return
	}
	if err := h.knowledgeBases.EmptyRecycleBin(c.Request.Context(), userID); err != nil {
		RespondError(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}

func (h *KnowledgeBaseHandler) setFavorite(c *gin.Context, favorite bool) {
	userID, id, ok := userAndKnowledgeBaseID(c)
	if !ok {
		return
	}
	if err := h.knowledgeBases.SetFavorite(c.Request.Context(), userID, id, favorite); err != nil {
		RespondError(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}

func currentUserIDOrError(c *gin.Context) (uuid.UUID, bool) {
	userID, ok := middleware.CurrentUserID(c)
	if !ok {
		RespondError(c, apperror.Unauthorized())
		return uuid.Nil, false
	}
	return userID, true
}

func userAndKnowledgeBaseID(c *gin.Context) (uuid.UUID, uuid.UUID, bool) {
	userID, ok := currentUserIDOrError(c)
	if !ok {
		return uuid.Nil, uuid.Nil, false
	}

	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		RespondError(c, apperror.Validation(map[string]any{"id": "知识库 ID 不合法"}))
		return uuid.Nil, uuid.Nil, false
	}

	return userID, id, true
}

func parseKnowledgeBaseListQuery(c *gin.Context) (dto.KnowledgeBaseListQuery, bool) {
	query := dto.KnowledgeBaseListQuery{
		Q:          c.Query("q"),
		Visibility: c.Query("visibility"),
		Scope:      c.Query("scope"),
		Sort:       c.Query("sort"),
		Page:       queryInt(c, "page", 1),
		PageSize:   queryInt(c, "pageSize", 20),
	}
	if value := c.Query("categoryId"); value != "" {
		id, err := uuid.Parse(value)
		if err != nil {
			RespondError(c, apperror.Validation(map[string]any{"categoryId": "分类 ID 不合法"}))
			return query, false
		}
		query.CategoryID = &id
	}
	if value := strings.TrimSpace(c.Query("tagIds")); value != "" {
		parts := strings.Split(value, ",")
		query.TagIDs = make([]uuid.UUID, 0, len(parts))
		for _, part := range parts {
			id, err := uuid.Parse(strings.TrimSpace(part))
			if err != nil {
				RespondError(c, apperror.Validation(map[string]any{"tagIds": "标签 ID 不合法"}))
				return query, false
			}
			query.TagIDs = append(query.TagIDs, id)
		}
	}
	return query, true
}

func queryInt(c *gin.Context, name string, fallback int) int {
	value := c.Query(name)
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return fallback
	}
	return parsed
}
