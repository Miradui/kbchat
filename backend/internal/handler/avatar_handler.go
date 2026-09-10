package handler

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"kbchat/backend/internal/apperror"
	"kbchat/backend/internal/middleware"
	"kbchat/backend/internal/service"
)

func (h *AuthHandler) UploadAvatar(c *gin.Context) {
	userID, ok := middleware.CurrentUserID(c)
	if !ok {
		RespondError(c, apperror.Unauthorized())
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, service.MaxAvatarBytes+64*1024)
	file, err := c.FormFile("file")
	if c.Request.MultipartForm != nil {
		defer c.Request.MultipartForm.RemoveAll()
	}
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			RespondError(c, apperror.New(http.StatusBadRequest, "AVATAR_TOO_LARGE", "头像图片不能超过 2 MB"))
		} else {
			RespondError(c, apperror.Validation(map[string]any{"file": "请选择不超过 2 MB 的 PNG 或 JPG 图片"}))
		}
		return
	}
	res, err := h.auth.UploadAvatar(c.Request.Context(), userID, file)
	if err != nil {
		RespondError(c, err)
		return
	}
	c.JSON(http.StatusOK, res)
}

func (h *AuthHandler) RemoveAvatar(c *gin.Context) {
	userID, ok := middleware.CurrentUserID(c)
	if !ok {
		RespondError(c, apperror.Unauthorized())
		return
	}
	res, err := h.auth.RemoveAvatar(c.Request.Context(), userID)
	if err != nil {
		RespondError(c, err)
		return
	}
	c.JSON(http.StatusOK, res)
}

func (h *AuthHandler) GetAvatar(c *gin.Context) {
	requesterID, ok := middleware.CurrentUserID(c)
	if !ok {
		RespondError(c, apperror.Unauthorized())
		return
	}
	userID, err := uuid.Parse(c.Param("id"))
	if err != nil {
		RespondError(c, apperror.NotFound("AVATAR_NOT_FOUND", "头像不存在"))
		return
	}
	avatar, err := h.auth.GetAvatar(c.Request.Context(), requesterID, userID, c.Query("v"))
	if err != nil {
		RespondError(c, err)
		return
	}
	etag := `"` + avatar.Version.String() + `"`
	c.Header("Cache-Control", "private, no-cache")
	c.Header("Vary", "Authorization")
	c.Header("ETag", etag)
	c.Header("X-Content-Type-Options", "nosniff")
	if c.GetHeader("If-None-Match") == etag {
		c.Status(http.StatusNotModified)
		return
	}
	c.Data(http.StatusOK, "image/png", avatar.Data)
}
