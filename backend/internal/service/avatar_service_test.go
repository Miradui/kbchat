package service

import (
	"bytes"
	"context"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"kbchat/backend/internal/config"
	"kbchat/backend/internal/dto"
	"kbchat/backend/internal/model"
	"kbchat/backend/internal/repository"
)

func profileAvatarURL(value string) *string { return &value }

func avatarImage(t *testing.T, format string, width, height int) []byte {
	t.Helper()
	im := image.NewNRGBA(image.Rect(0, 0, width, height))
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			c := color.NRGBA{G: 180, A: 255}
			if x < (width-height)/2 || x >= (width+height)/2 {
				c = color.NRGBA{R: 240, A: 255}
			}
			im.SetNRGBA(x, y, c)
		}
	}
	var output bytes.Buffer
	var err error
	if format == "jpeg" {
		err = jpeg.Encode(&output, im, &jpeg.Options{Quality: 95})
	} else {
		err = png.Encode(&output, im)
	}
	if err != nil {
		t.Fatal(err)
	}
	return output.Bytes()
}

func TestAvatarUploadNormalizesAndReplacesOneThumbnail(t *testing.T) {
	ctx := context.Background()
	db := newAuthTestDB(t)
	svc := NewAuthService(config.Config{}, repository.NewUserRepository(db))
	user := createWorkspaceUser(t, db, "avatar-owner")
	other := createWorkspaceUser(t, db, "avatar-reader")
	var previous string
	for _, format := range []string{"png", "jpeg"} {
		uploaded, err := svc.UploadAvatar(ctx, user.ID, createUploadFile(t, "avatar."+format, string(avatarImage(t, format, 600, 300))))
		if err != nil {
			t.Fatal(err)
		}
		if uploaded.AvatarURL == previous || !strings.HasPrefix(uploaded.AvatarURL, "/api/v1/users/"+user.ID.String()+"/avatar?v=") {
			t.Fatalf("invalid versioned avatar URL %q", uploaded.AvatarURL)
		}
		avatar, err := svc.GetAvatar(ctx, other.ID, user.ID, "")
		if err != nil {
			t.Fatal(err)
		}
		decoded, format, err := image.Decode(bytes.NewReader(avatar.Data))
		if err != nil || format != "png" || decoded.Bounds() != image.Rect(0, 0, AvatarSize, AvatarSize) {
			t.Fatalf("invalid normalized image: %v %s %v", decoded, format, err)
		}
		// A centered square excludes both red side bands in the original.
		r, g, _, _ := decoded.At(16, 128).RGBA()
		if r > 2000 || g < 40000 {
			t.Fatal("avatar did not crop the center square")
		}
		var count int64
		if err := db.Model(&model.UserAvatar{}).Where("user_id = ?", user.ID).Count(&count).Error; err != nil || count != 1 {
			t.Fatalf("expected one thumbnail: %d, %v", count, err)
		}
		if previous != "" {
			_, err = svc.GetAvatar(ctx, user.ID, user.ID, strings.Split(previous, "?v=")[1])
			assertAppError(t, err, "AVATAR_NOT_FOUND")
		}
		previous = uploaded.AvatarURL
	}
	var stored model.User
	if err := db.First(&stored, "id = ?", user.ID).Error; err != nil {
		t.Fatal(err)
	}
	if stored.PasswordHash != user.PasswordHash || stored.DisplayName != user.DisplayName || stored.Username != user.Username || stored.Role != user.Role {
		t.Fatal("avatar replacement modified unrelated identity fields")
	}
	_, err := svc.GetAvatar(ctx, uuid.New(), user.ID, "")
	assertAppError(t, err, "UNAUTHORIZED")
	removed, err := svc.RemoveAvatar(ctx, user.ID)
	if err != nil || removed.AvatarURL != "" {
		t.Fatalf("remove avatar: %v %#v", err, removed)
	}
	_, err = svc.GetAvatar(ctx, other.ID, user.ID, "")
	assertAppError(t, err, "AVATAR_NOT_FOUND")
	if _, err = svc.RemoveAvatar(ctx, user.ID); err != nil {
		t.Fatalf("remove should be idempotent: %v", err)
	}
}

func TestInvalidAvatarUploadPreservesPreviousThumbnail(t *testing.T) {
	ctx := context.Background()
	db := newAuthTestDB(t)
	svc := NewAuthService(config.Config{}, repository.NewUserRepository(db))
	user := createWorkspaceUser(t, db, "avatar-validation")
	valid := avatarImage(t, "png", 16, 16)
	first, err := svc.UploadAvatar(ctx, user.ID, createUploadFile(t, "first.png", string(valid)))
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ name, contents, code string }{
		{"corrupt.png", "not an image", "INVALID_AVATAR"},
		{"truncated.png", string(valid[:len(valid)/2]), "INVALID_AVATAR"},
		{"oversize.png", strings.Repeat("x", MaxAvatarBytes+1), "AVATAR_TOO_LARGE"},
		{"wide.png", string(avatarImage(t, "png", MaxAvatarDimension+1, 1)), "INVALID_AVATAR"},
		{"empty.jpg", "", "INVALID_AVATAR"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := svc.UploadAvatar(ctx, user.ID, createUploadFile(t, tc.name, tc.contents))
			assertAppError(t, err, tc.code)
			got, err := svc.Me(ctx, user.ID)
			if err != nil || got.AvatarURL != first.AvatarURL {
				t.Fatalf("invalid upload changed the profile: %v", err)
			}
			if _, err := svc.GetAvatar(ctx, user.ID, user.ID, strings.Split(first.AvatarURL, "?v=")[1]); err != nil {
				t.Fatalf("invalid upload removed the image: %v", err)
			}
		})
	}
	_, err = svc.UploadAvatar(ctx, user.ID, nil)
	assertAppError(t, err, "VALIDATION_ERROR")
}

func TestProfileAvatarOmissionStaleURLAndExplicitRemoval(t *testing.T) {
	ctx := context.Background()
	db := newAuthTestDB(t)
	svc := NewAuthService(config.Config{}, repository.NewUserRepository(db))
	user := createWorkspaceUser(t, db, "avatar-profile")
	file := createUploadFile(t, "avatar.png", string(avatarImage(t, "png", 16, 16)))
	first, err := svc.UploadAvatar(ctx, user.ID, file)
	if err != nil {
		t.Fatal(err)
	}
	second, err := svc.UploadAvatar(ctx, user.ID, file)
	if err != nil {
		t.Fatal(err)
	}
	updated, err := svc.UpdateProfile(ctx, user.ID, dto.UpdateProfileRequest{DisplayName: "New name"})
	if err != nil || updated.AvatarURL != second.AvatarURL {
		t.Fatalf("name-only update must preserve avatar: %v", err)
	}
	_, err = svc.UpdateProfile(ctx, user.ID, dto.UpdateProfileRequest{DisplayName: "Stale name", AvatarURL: &first.AvatarURL})
	assertAppError(t, err, "AVATAR_CHANGED")
	updated, err = svc.Me(ctx, user.ID)
	if err != nil || updated.AvatarURL != second.AvatarURL || updated.DisplayName != "New name" {
		t.Fatalf("stale profile must roll back: %v %#v", err, updated)
	}
	_, err = svc.UpdateProfile(ctx, user.ID, dto.UpdateProfileRequest{DisplayName: "Invalid", AvatarURL: profileAvatarURL("/api/v1/users/" + user.ID.String() + "/avatar?v=invalid")})
	assertAppError(t, err, "VALIDATION_ERROR")
	if _, err := svc.UpdateProfile(ctx, user.ID, dto.UpdateProfileRequest{DisplayName: "New name", AvatarURL: &second.AvatarURL}); err != nil {
		t.Fatalf("current managed URL must be preserved: %v", err)
	}
	if _, err := svc.GetAvatar(ctx, user.ID, user.ID, ""); err != nil {
		t.Fatal(err)
	}
	for _, avatarURL := range []string{"https://example.com/a.png", ""} {
		if _, err := svc.UploadAvatar(ctx, user.ID, file); err != nil {
			t.Fatal(err)
		}
		updated, err = svc.UpdateProfile(ctx, user.ID, dto.UpdateProfileRequest{DisplayName: "New name", AvatarURL: &avatarURL})
		if err != nil || updated.AvatarURL != avatarURL {
			t.Fatalf("explicit legacy URL/clear: %v", err)
		}
		_, err = svc.GetAvatar(ctx, user.ID, user.ID, "")
		assertAppError(t, err, "AVATAR_NOT_FOUND")
	}
}

func TestProfileCannotOverwriteAConcurrentlyUploadedAvatar(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	db := newConcurrentAuthTestDB(t)
	svc := NewAuthService(config.Config{}, repository.NewUserRepository(db))
	user := createWorkspaceUser(t, db, "avatar-race")
	file := createUploadFile(t, "avatar.png", string(avatarImage(t, "png", 16, 16)))
	first, err := svc.UploadAvatar(ctx, user.ID, file)
	if err != nil {
		t.Fatal(err)
	}
	blocked, release := make(chan struct{}), make(chan struct{})
	defer close(release)
	if err := db.Callback().Update().Before("gorm:update").Register("test:pause_avatar_profile", func(tx *gorm.DB) {
		values, ok := tx.Statement.Dest.(map[string]any)
		if ok && values["display_name"] == "Stale profile" {
			close(blocked)
			select {
			case <-release:
			case <-ctx.Done():
			}
		}
	}); err != nil {
		t.Fatal(err)
	}
	defer db.Callback().Update().Remove("test:pause_avatar_profile")
	done := make(chan error, 1)
	go func() {
		_, err := svc.UpdateProfile(ctx, user.ID, dto.UpdateProfileRequest{DisplayName: "Stale profile", AvatarURL: &first.AvatarURL})
		done <- err
	}()
	select {
	case <-blocked:
	case <-ctx.Done():
		t.Fatal("profile did not pause")
	}
	second, err := svc.UploadAvatar(ctx, user.ID, file)
	if err != nil {
		t.Fatal(err)
	}
	release <- struct{}{}
	select {
	case err := <-done:
		assertAppError(t, err, "AVATAR_CHANGED")
	case <-ctx.Done():
		t.Fatal("profile did not finish")
	}
	avatar, err := svc.GetAvatar(ctx, user.ID, user.ID, strings.Split(second.AvatarURL, "?v=")[1])
	if err != nil || avatar == nil {
		t.Fatalf("concurrent upload was lost: %v", err)
	}
}
