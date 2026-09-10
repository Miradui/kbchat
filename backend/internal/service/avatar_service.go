package service

import (
	"bytes"
	"context"
	"image"
	_ "image/jpeg"
	"image/png"
	"io"
	"mime/multipart"
	"net/http"

	"github.com/google/uuid"
	"golang.org/x/image/draw"

	"kbchat/backend/internal/apperror"
	"kbchat/backend/internal/dto"
	"kbchat/backend/internal/model"
)

const (
	MaxAvatarBytes     = 2 * 1024 * 1024
	AvatarSize         = 256
	MaxAvatarDimension = 4096
)

func (s *AuthService) UploadAvatar(ctx context.Context, userID uuid.UUID, file *multipart.FileHeader) (*dto.UserResponse, error) {
	if _, err := s.Me(ctx, userID); err != nil {
		return nil, err
	}
	if file == nil {
		return nil, apperror.Validation(map[string]any{"file": "请选择头像图片"})
	}
	if file.Size > MaxAvatarBytes {
		return nil, avatarTooLarge()
	}
	source, err := file.Open()
	if err != nil {
		return nil, invalidAvatar()
	}
	defer source.Close()
	raw, err := io.ReadAll(io.LimitReader(source, MaxAvatarBytes+1))
	if err != nil {
		return nil, invalidAvatar()
	}
	if len(raw) > MaxAvatarBytes {
		return nil, avatarTooLarge()
	}
	info, format, err := image.DecodeConfig(bytes.NewReader(raw))
	if err != nil || (format != "png" && format != "jpeg") || info.Width <= 0 || info.Height <= 0 || info.Width > MaxAvatarDimension || info.Height > MaxAvatarDimension {
		return nil, invalidAvatar()
	}
	decoded, _, err := image.Decode(bytes.NewReader(raw))
	if err != nil {
		return nil, invalidAvatar()
	}
	bounds := decoded.Bounds()
	side := min(bounds.Dx(), bounds.Dy())
	x, y := bounds.Min.X+(bounds.Dx()-side)/2, bounds.Min.Y+(bounds.Dy()-side)/2
	thumbnail := image.NewNRGBA(image.Rect(0, 0, AvatarSize, AvatarSize))
	draw.CatmullRom.Scale(thumbnail, thumbnail.Bounds(), decoded, image.Rect(x, y, x+side, y+side), draw.Src, nil)
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, thumbnail); err != nil {
		return nil, apperror.Internal(err)
	}
	avatar := &model.UserAvatar{UserID: userID, Version: uuid.New(), Data: encoded.Bytes()}
	avatarURL := "/api/v1/users/" + userID.String() + "/avatar?v=" + avatar.Version.String()
	if err := s.users.ReplaceAvatar(ctx, userID, avatar, avatarURL); err != nil {
		return nil, apperror.Internal(err)
	}
	return s.Me(ctx, userID)
}

func (s *AuthService) RemoveAvatar(ctx context.Context, userID uuid.UUID) (*dto.UserResponse, error) {
	if _, err := s.Me(ctx, userID); err != nil {
		return nil, err
	}
	if err := s.users.ReplaceAvatar(ctx, userID, nil, ""); err != nil {
		return nil, apperror.Internal(err)
	}
	return s.Me(ctx, userID)
}

func (s *AuthService) GetAvatar(ctx context.Context, requesterID, userID uuid.UUID, version string) (*model.UserAvatar, error) {
	if _, err := s.Me(ctx, requesterID); err != nil {
		return nil, err
	}
	avatar, err := s.users.FindAvatar(ctx, userID)
	if err != nil {
		return nil, apperror.Internal(err)
	}
	if avatar == nil || (version != "" && version != avatar.Version.String()) {
		return nil, apperror.NotFound("AVATAR_NOT_FOUND", "头像不存在或已更新")
	}
	return avatar, nil
}

func avatarTooLarge() error {
	return apperror.New(http.StatusBadRequest, "AVATAR_TOO_LARGE", "头像图片不能超过 2 MB")
}
func invalidAvatar() error {
	return apperror.New(http.StatusBadRequest, "INVALID_AVATAR", "请选择有效的 PNG 或 JPG 图片，长宽均不能超过 4096 像素")
}
