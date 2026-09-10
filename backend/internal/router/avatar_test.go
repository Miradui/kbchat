package router

import (
	"bytes"
	"encoding/json"
	"image"
	"image/png"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"kbchat/backend/internal/auth"
	"kbchat/backend/internal/config"
	"kbchat/backend/internal/dto"
	"kbchat/backend/internal/logger"
	"kbchat/backend/internal/model"
	"kbchat/backend/internal/service"
)

func TestAvatarHTTPContractsAndAuthentication(t *testing.T) {
	cfg := config.Config{AppEnv: "test", JWTSecret: "avatar-router-test-secret-long-enough", JWTExpiresIn: "1h"}
	db := testDB(t)
	if err := db.AutoMigrate(&model.User{}, &model.UserAvatar{}); err != nil {
		t.Fatal(err)
	}
	owner := model.User{Username: "avatar-owner", PasswordHash: "existing-hash", DisplayName: "Owner"}
	other := model.User{Username: "avatar-other", PasswordHash: "other-hash"}
	for _, user := range []*model.User{&owner, &other} {
		if err := db.Create(user).Error; err != nil {
			t.Fatal(err)
		}
	}
	token, err := auth.GenerateToken(cfg, owner.ID)
	if err != nil {
		t.Fatal(err)
	}
	otherToken, err := auth.GenerateToken(cfg, other.ID)
	if err != nil {
		t.Fatal(err)
	}
	router := New(cfg, db, logger.New(cfg))
	request := func(method, path, authToken, contentType string, body io.Reader, etag string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, body)
		if authToken != "" {
			req.Header.Set("Authorization", "Bearer "+authToken)
		}
		req.Header.Set("Content-Type", contentType)
		req.Header.Set("If-None-Match", etag)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		return rec
	}
	upload := func(contents []byte, authToken string) *httptest.ResponseRecorder {
		var body bytes.Buffer
		writer := multipart.NewWriter(&body)
		part, err := writer.CreateFormFile("file", "avatar.png")
		if err != nil {
			t.Fatal(err)
		}
		if _, err = part.Write(contents); err != nil {
			t.Fatal(err)
		}
		if err = writer.Close(); err != nil {
			t.Fatal(err)
		}
		return request(http.MethodPost, "/api/v1/auth/me/avatar", authToken, writer.FormDataContentType(), &body, "")
	}
	var picture bytes.Buffer
	if err := png.Encode(&picture, image.NewNRGBA(image.Rect(0, 0, 20, 30))); err != nil {
		t.Fatal(err)
	}
	if got := upload(picture.Bytes(), ""); got.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated upload: %d", got.Code)
	}
	got := upload(picture.Bytes(), token)
	if got.Code != http.StatusOK {
		t.Fatalf("upload: %d %s", got.Code, got.Body.String())
	}
	var profile dto.UserResponse
	if err := json.Unmarshal(got.Body.Bytes(), &profile); err != nil {
		t.Fatal(err)
	}
	if profile.ID != owner.ID.String() || profile.DisplayName != owner.DisplayName || profile.AvatarURL == "" {
		t.Fatalf("unexpected profile: %#v", profile)
	}
	read := request(http.MethodGet, profile.AvatarURL, otherToken, "", nil, "")
	if read.Code != http.StatusOK || read.Header().Get("Content-Type") != "image/png" || read.Header().Get("X-Content-Type-Options") != "nosniff" || read.Header().Get("Cache-Control") != "private, no-cache" {
		t.Fatalf("image response: %d %v", read.Code, read.Header())
	}
	info, _, err := image.DecodeConfig(bytes.NewReader(read.Body.Bytes()))
	if err != nil || info.Width != service.AvatarSize || info.Height != service.AvatarSize {
		t.Fatalf("wrong image dimensions: %#v %v", info, err)
	}
	etag := read.Header().Get("ETag")
	if etag == "" {
		t.Fatal("missing ETag")
	}
	if got := request(http.MethodGet, profile.AvatarURL, token, "", nil, etag); got.Code != http.StatusNotModified || got.Body.Len() != 0 {
		t.Fatalf("conditional image read: %d", got.Code)
	}
	if got := request(http.MethodGet, profile.AvatarURL, "", "", nil, etag); got.Code != http.StatusUnauthorized {
		t.Fatalf("ETag bypassed authentication: %d", got.Code)
	}
	nameOnly := request(http.MethodPut, "/api/v1/auth/me", token, "application/json", strings.NewReader(`{"displayName":"Updated"}`), "")
	if nameOnly.Code != http.StatusOK || !strings.Contains(nameOnly.Body.String(), profile.AvatarURL) {
		t.Fatalf("name update lost avatar: %d %s", nameOnly.Code, nameOnly.Body.String())
	}
	if got := upload(bytes.Repeat([]byte{'x'}, service.MaxAvatarBytes+128*1024), token); got.Code != http.StatusBadRequest || !strings.Contains(got.Body.String(), "AVATAR_TOO_LARGE") {
		t.Fatalf("body size limit: %d %s", got.Code, got.Body.String())
	}
	if got := request(http.MethodDelete, "/api/v1/users/"+owner.ID.String()+"/avatar", otherToken, "", nil, ""); got.Code != http.StatusNotFound {
		t.Fatalf("another user's mutation route exists: %d", got.Code)
	}
	if got := request(http.MethodDelete, "/api/v1/auth/me/avatar", otherToken, "", nil, ""); got.Code != http.StatusOK {
		t.Fatalf("self removal: %d", got.Code)
	}
	if got := request(http.MethodGet, profile.AvatarURL, token, "", nil, ""); got.Code != http.StatusOK {
		t.Fatal("other user removed the owner's image")
	}
	if got := request(http.MethodDelete, "/api/v1/auth/me/avatar", "", "", nil, ""); got.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated removal: %d", got.Code)
	}
	if got := request(http.MethodDelete, "/api/v1/auth/me/avatar", token, "", nil, ""); got.Code != http.StatusOK {
		t.Fatalf("removal: %d", got.Code)
	}
	if got := request(http.MethodGet, profile.AvatarURL, token, "", nil, ""); got.Code != http.StatusNotFound {
		t.Fatalf("removed avatar remains readable: %d", got.Code)
	}
}
