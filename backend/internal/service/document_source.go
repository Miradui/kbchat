package service

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"github.com/google/uuid"
	"io"
	"kbchat/backend/internal/access"
	"kbchat/backend/internal/apperror"
	"kbchat/backend/internal/dto"
	"strings"
	"unicode"
	"unicode/utf8"
)

// A source can be reopened for hashing and saving without buffering a multipart upload.
type documentSource struct {
	Filename string
	Size     int64
	Open     func() (io.ReadCloser, error)
}

func hashDocumentSource(source documentSource) (string, error) {
	reader, err := source.Open()
	if err != nil {
		return "", err
	}
	defer reader.Close()
	digest := sha256.New()
	if _, err := io.Copy(digest, reader); err != nil {
		return "", err
	}
	return hex.EncodeToString(digest.Sum(nil)), nil
}

func (s *DocumentService) saveDocumentSource(ctx context.Context, location string, source documentSource) error {
	reader, err := source.Open()
	if err != nil {
		return err
	}
	defer reader.Close()
	return s.storage.SaveKnowledgeBaseObject(ctx, location, reader, source.Size)
}

func (s *DocumentService) CreateText(ctx context.Context, actorID, kbID uuid.UUID, req dto.TextDocumentRequest) (*dto.DocumentResponse, error) {
	if _, err := s.authorizeKnowledgeBase(ctx, actorID, kbID, access.CapContentWrite); err != nil {
		return nil, err
	}
	title := strings.TrimSpace(req.Title)
	if title == "" || utf8.RuneCountInString(title) > 200 {
		return nil, apperror.Validation(map[string]any{"title": "标题须为 1–200 个字符"})
	}
	if strings.TrimSpace(req.Content) == "" {
		return nil, apperror.Validation(map[string]any{"content": "正文不能为空"})
	}
	if int64(len(req.Content)) > int64(s.cfg.MaxUploadSizeMB)*1024*1024 {
		return nil, apperror.Validation(map[string]any{"content": "正文大小超过上传限制"})
	}
	format := req.Format
	if format == "" {
		format = "md"
	}
	if format != "md" && format != "txt" {
		return nil, apperror.Validation(map[string]any{"format": "格式必须为 md 或 txt"})
	}
	title = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || strings.ContainsRune(`/\<>:"|?*`, r) {
			return '_'
		}
		return r
	}, title)
	source := documentSource{Filename: title + "." + format, Size: int64(len(req.Content)), Open: func() (io.ReadCloser, error) { return io.NopCloser(strings.NewReader(req.Content)), nil }}
	return s.uploadSource(ctx, actorID, kbID, source, DocumentUploadOptions{AllowDuplicate: req.AllowDuplicate})
}
