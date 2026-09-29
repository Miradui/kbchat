package handler

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"kbchat/backend/internal/apperror"
	"kbchat/backend/internal/dto"
	"kbchat/backend/internal/middleware"
	"kbchat/backend/internal/service"
)

type AdminUserHandler struct{ users *service.AdminUserService }

func NewAdminUserHandler(users *service.AdminUserService) *AdminUserHandler {
	return &AdminUserHandler{users: users}
}

func (h *AdminUserHandler) List(c *gin.Context) {
	res, err := h.users.List(c.Request.Context(), dto.AdminUserListQuery{
		Q: c.Query("q"), Status: c.Query("status"), Role: c.Query("role"),
		Page: queryInt(c, "page", 1), PageSize: queryInt(c, "pageSize", 20),
	})
	if err != nil {
		RespondError(c, err)
		return
	}
	c.JSON(http.StatusOK, res)
}

func (h *AdminUserHandler) ListActivities(c *gin.Context) {
	res, err := h.users.ListActivities(c.Request.Context(), queryInt(c, "page", 1), queryInt(c, "pageSize", 20))
	if err != nil {
		RespondError(c, err)
		return
	}
	c.JSON(http.StatusOK, res)
}

func (h *AdminUserHandler) Create(c *gin.Context) {
	actor, ok := middleware.CurrentUserID(c)
	if !ok {
		RespondError(c, apperror.Unauthorized())
		return
	}
	var req dto.AdminUserCreateRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		RespondError(c, apperror.Validation(map[string]any{"body": "请求参数不合法"}))
		return
	}
	res, err := h.users.Create(c.Request.Context(), actor, req)
	if err != nil {
		RespondError(c, err)
		return
	}
	c.JSON(http.StatusCreated, res)
}

func (h *AdminUserHandler) Update(c *gin.Context) {
	actor, target, ok := adminUserIDs(c)
	if !ok {
		return
	}
	var req dto.AdminUserUpdateRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		RespondError(c, apperror.Validation(map[string]any{"body": "请求参数不合法"}))
		return
	}
	res, err := h.users.Update(c.Request.Context(), actor, target, req)
	if err != nil {
		RespondError(c, err)
		return
	}
	c.JSON(http.StatusOK, res)
}

func (h *AdminUserHandler) ResetPassword(c *gin.Context) {
	actor, target, ok := adminUserIDs(c)
	if !ok {
		return
	}
	res, err := h.users.ResetPassword(c.Request.Context(), actor, target)
	if err != nil {
		RespondError(c, err)
		return
	}
	c.JSON(http.StatusOK, res)
}

func (h *AdminUserHandler) UpdateRole(c *gin.Context) {
	actor, target, ok := adminUserIDs(c)
	if !ok {
		return
	}
	var req dto.AdminUserRoleRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		RespondError(c, apperror.Validation(map[string]any{"body": "请求参数不合法"}))
		return
	}
	res, err := h.users.UpdateRole(c.Request.Context(), actor, target, req.Role)
	if err != nil {
		RespondError(c, err)
		return
	}
	c.JSON(http.StatusOK, res)
}

func adminUserIDs(c *gin.Context) (uuid.UUID, uuid.UUID, bool) {
	actor, ok := middleware.CurrentUserID(c)
	if !ok {
		RespondError(c, apperror.Unauthorized())
		return uuid.Nil, uuid.Nil, false
	}
	target, err := uuid.Parse(c.Param("id"))
	if err != nil {
		RespondError(c, apperror.Validation(map[string]any{"id": "用户 ID 不合法"}))
		return uuid.Nil, uuid.Nil, false
	}
	return actor, target, true
}
