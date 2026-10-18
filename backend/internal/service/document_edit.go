package service

import (
	"context"
	"github.com/google/uuid"
	"io"
	"kbchat/backend/internal/access"
	"kbchat/backend/internal/apperror"
	"kbchat/backend/internal/dto"
	"strings"
	"unicode/utf8"
)

const MaxEditableTextBytes = 1024 * 1024

type EditableDocumentText struct {
	DocumentID string `json:"documentId"`
	Filename   string `json:"filename"`
	Content    string `json:"content"`
	MaxBytes   int    `json:"maxBytes"`
}
type SaveDocumentTextRequest struct {
	RequestID string `json:"requestId"`
	Content   string `json:"content"`
}

func (s *DocumentService) EditableText(ctx context.Context, actor, id uuid.UUID) (*EditableDocumentText, error) {
	doc, err := s.authorizeDocument(ctx, actor, id, access.CapContentWrite)
	if err != nil {
		return nil, err
	}
	if doc.FileType != "txt" && doc.FileType != "md" && doc.FileType != "markdown" {
		return nil, apperror.Validation(map[string]any{"documentId": "仅支持 TXT 和 Markdown 在线编辑"})
	}
	info, err := s.storage.Stat(ctx, doc.StoragePath)
	if err != nil {
		return nil, documentStorageError(err)
	}
	if info.Size > MaxEditableTextBytes {
		return nil, apperror.New(400, "DOCUMENT_EDIT_TOO_LARGE", "在线编辑支持最多 1 MiB 文本，请下载后修改并替换")
	}
	content, err := s.storage.Read(ctx, doc.StoragePath)
	if err != nil {
		return nil, documentStorageError(err)
	}
	if len(content) > MaxEditableTextBytes || !utf8.Valid(content) {
		return nil, apperror.Validation(map[string]any{"content": "文档不是可编辑的 UTF-8 文本或超出大小限制"})
	}
	if _, err := s.authorizeDocument(ctx, actor, id, access.CapContentWrite); err != nil {
		return nil, err
	}
	return &EditableDocumentText{DocumentID: id.String(), Filename: doc.Filename, Content: string(content), MaxBytes: MaxEditableTextBytes}, nil
}
func (s *DocumentService) SaveTextRevision(ctx context.Context, actor, id uuid.UUID, req SaveDocumentTextRequest) (*dto.DocumentResponse, error) {
	requestID, err := uuid.Parse(req.RequestID)
	if err != nil || requestID == uuid.Nil {
		return nil, apperror.Validation(map[string]any{"requestId": "请提供有效的保存请求 ID"})
	}
	if strings.TrimSpace(req.Content) == "" || !utf8.ValidString(req.Content) || len(req.Content) > MaxEditableTextBytes {
		return nil, apperror.Validation(map[string]any{"content": "正文须为非空 UTF-8 文本，最多 1 MiB"})
	}
	original, err := s.EditableText(ctx, actor, id)
	if err != nil {
		return nil, err
	}
	doc, err := s.authorizeDocument(ctx, actor, id, access.CapContentWrite)
	if err != nil {
		return nil, err
	}
	if original.Content == req.Content && doc.SupersededByID == nil {
		return s.Get(ctx, actor, id)
	}
	source := documentSource{Filename: original.Filename, Size: int64(len(req.Content)), Open: func() (io.ReadCloser, error) { return io.NopCloser(strings.NewReader(req.Content)), nil }}
	return s.uploadSource(ctx, actor, doc.KnowledgeBaseID, source, DocumentUploadOptions{RequestID: req.RequestID, SourcePath: doc.SourcePath, replaces: &id})
}
