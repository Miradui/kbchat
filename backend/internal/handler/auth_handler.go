package handler

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"kbchat/backend/internal/apperror"
	"kbchat/backend/internal/dto"
	"kbchat/backend/internal/middleware"
	"kbchat/backend/internal/service"
)

type AuthHandler struct {
	auth *service.AuthService
}

func NewAuthHandler(auth *service.AuthService) *AuthHandler {
	return &AuthHandler{auth: auth}
}

func (h *AuthHandler) Login(c *gin.Context) {
	var req dto.LoginRequest
	if err := bindJSON(c, &req); err != nil {
		RespondError(c, apperror.Validation(map[string]any{"body": "请求参数不合法"}))
		return
	}

	res, err := h.auth.Login(c.Request.Context(), req)
	if err != nil {
		RespondError(c, err)
		return
	}

	c.JSON(http.StatusOK, res)
}

func (h *AuthHandler) Me(c *gin.Context) {
	userID, ok := middleware.CurrentUserID(c)
	if !ok {
		RespondError(c, apperror.Unauthorized())
		return
	}

	res, err := h.auth.Me(c.Request.Context(), userID)
	if err != nil {
		RespondError(c, err)
		return
	}

	c.JSON(http.StatusOK, res)
}

func (h *AuthHandler) Logout(c *gin.Context) {
	c.Status(http.StatusNoContent)
}

func (h *AuthHandler) UpdateProfile(c *gin.Context) {
	userID, ok := middleware.CurrentUserID(c)
	if !ok {
		RespondError(c, apperror.Unauthorized())
		return
	}

	var req dto.UpdateProfileRequest
	if err := bindJSON(c, &req); err != nil {
		RespondError(c, apperror.Validation(map[string]any{"body": "请求参数不合法"}))
		return
	}

	res, err := h.auth.UpdateProfile(c.Request.Context(), userID, req)
	if err != nil {
		RespondError(c, err)
		return
	}

	c.JSON(http.StatusOK, res)
}

func (h *AuthHandler) ChangePassword(c *gin.Context) {
	userID, ok := middleware.CurrentUserID(c)
	if !ok {
		RespondError(c, apperror.Unauthorized())
		return
	}

	var req dto.ChangePasswordRequest
	if err := bindJSON(c, &req); err != nil {
		RespondError(c, apperror.Validation(map[string]any{"body": "请求参数不合法"}))
		return
	}

	if err := h.auth.ChangePassword(c.Request.Context(), userID, req); err != nil {
		RespondError(c, err)
		return
	}

	c.Status(http.StatusNoContent)
}
