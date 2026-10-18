package service

import (
	"context"
	"github.com/google/uuid"
	"io"
	"kbchat/backend/internal/access"
	"kbchat/backend/internal/apperror"
	"kbchat/backend/internal/document/parser"
	"kbchat/backend/internal/dto"
	"strings"
	"unicode/utf8"
)

type PDFCorrectionPage struct {
	PageNumber int    `json:"pageNumber"`
	Content    string `json:"content"`
	TextSource string `json:"textSource,omitempty"`
}
type PDFCorrectionResponse struct {
	DocumentID string              `json:"documentId"`
	Revision   string              `json:"revision"`
	Pages      []PDFCorrectionPage `json:"pages"`
}
type SavePDFCorrectionRequest struct {
	RequestID string              `json:"requestId"`
	Revision  string              `json:"revision"`
	Pages     []PDFCorrectionPage `json:"pages"`
}

func (s *DocumentService) PDFCorrection(ctx context.Context, actor, id uuid.UUID) (*PDFCorrectionResponse, error) {
	doc, err := s.authorizeDocument(ctx, actor, id, access.CapContentWrite)
	if err != nil {
		return nil, err
	}
	if _, err := s.authorizeDocument(ctx, actor, id, access.CapDocumentDownload); err != nil {
		return nil, err
	}
	if doc.FileType != "pdf" {
		return nil, apperror.Validation(map[string]any{"documentId": "只能校对 PDF 的 OCR 文本"})
	}
	snapshot, err := s.documents.PDFSnapshot(ctx, id)
	if err != nil {
		return nil, apperror.Internal(err)
	}
	if len(snapshot) == 0 {
		return nil, apperror.New(409, "DOCUMENT_OCR_NOT_READY", "请先完成 OCR 处理，再打开校对")
	}
	parsed, err := parser.DecodePDFSnapshot(snapshot)
	if err != nil {
		return nil, apperror.Internal(err)
	}
	res := &PDFCorrectionResponse{DocumentID: id.String(), Revision: correctionFingerprint(snapshot), Pages: []PDFCorrectionPage{}}
	for _, segment := range parsed.Segments {
		if segment.TextSource == "ocr" || segment.TextSource == "ocr_corrected" {
			res.Pages = append(res.Pages, PDFCorrectionPage{PageNumber: *segment.PageNumber, Content: segment.Content, TextSource: segment.TextSource})
		}
	}
	if len(res.Pages) == 0 {
		return nil, apperror.New(409, "DOCUMENT_OCR_NOT_READY", "该文档没有可校对的 OCR 页面")
	}
	return res, nil
}
func (s *DocumentService) SavePDFCorrection(ctx context.Context, actor, id uuid.UUID, req SavePDFCorrectionRequest) (*dto.DocumentResponse, error) {
	requestID, err := uuid.Parse(req.RequestID)
	if err != nil || requestID == uuid.Nil {
		return nil, apperror.Validation(map[string]any{"requestId": "请提供有效的保存请求 ID"})
	}
	current, err := s.PDFCorrection(ctx, actor, id)
	if err != nil {
		return nil, err
	}
	if req.Revision != current.Revision {
		return nil, apperror.New(409, "DOCUMENT_EDIT_CONFLICT", "原始识别文本已重新处理，请重新打开校对并核对修改")
	}
	if len(req.Pages) == 0 || len(req.Pages) > len(current.Pages) {
		return nil, apperror.Validation(map[string]any{"pages": "请选择有效的 OCR 页面"})
	}
	allowed := map[int]bool{}
	for _, page := range current.Pages {
		allowed[page.PageNumber] = true
	}
	changes := map[int]string{}
	for _, page := range req.Pages {
		if !allowed[page.PageNumber] || strings.TrimSpace(page.Content) == "" || !utf8.ValidString(page.Content) || len(page.Content) > MaxEditableTextBytes {
			return nil, apperror.Validation(map[string]any{"pages": "每页须为非空 UTF-8 文本，最多 1 MiB，且只能修改已有 OCR 页"})
		}
		if _, exists := changes[page.PageNumber]; exists {
			return nil, apperror.Validation(map[string]any{"pages": "不能重复提交同一页"})
		}
		changes[page.PageNumber] = page.Content
	}
	snapshot, err := s.documents.PDFSnapshot(ctx, id)
	if err != nil {
		return nil, apperror.Internal(err)
	}
	if correctionFingerprint(snapshot) != req.Revision {
		return nil, apperror.New(409, "DOCUMENT_EDIT_CONFLICT", "原始识别文本已变化，请重新打开校对")
	}
	parsed, err := parser.DecodePDFSnapshot(snapshot)
	if err != nil {
		return nil, apperror.Internal(err)
	}
	for i := range parsed.Segments {
		segment := &parsed.Segments[i]
		if text, ok := changes[*segment.PageNumber]; ok {
			segment.Content = text
			segment.TextSource = "ocr_corrected"
		}
	}
	baseline, err := parser.EncodePDFSnapshot(parsed)
	if err != nil {
		return nil, apperror.Validation(map[string]any{"pages": "校对文本总大小超过限制"})
	}
	if _, err = parser.DecodePDFSnapshot(baseline); err != nil {
		return nil, apperror.Validation(map[string]any{"pages": "校对文本总大小超过 8 MiB"})
	}
	doc, err := s.authorizeDocument(ctx, actor, id, access.CapContentWrite)
	if err != nil {
		return nil, err
	}
	source := documentSource{Filename: doc.Filename, Size: doc.FileSize, Open: func() (io.ReadCloser, error) {
		reader, _, err := s.storage.Open(ctx, doc.StoragePath)
		return reader, err
	}}
	return s.uploadSource(ctx, actor, doc.KnowledgeBaseID, source, DocumentUploadOptions{RequestID: req.RequestID, SourcePath: doc.SourcePath, replaces: &id, pdfCorrection: baseline, pdfSourceRevision: req.Revision})
}
