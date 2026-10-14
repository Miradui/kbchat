package service

import (
	"context"
	"github.com/google/uuid"
	"kbchat/backend/internal/access"
	"kbchat/backend/internal/apperror"
	"kbchat/backend/internal/document/parser"
	"kbchat/backend/internal/document/tableconfig"
	"kbchat/backend/internal/dto"
	"kbchat/backend/internal/model"
	"net/http"
	"strings"
)

const maxCompareLines = 2000

func documentVersion(d model.Document) dto.DocumentVersion {
	v := dto.DocumentVersion{ID: d.ID.String(), Filename: d.Filename, Status: d.Status, CreatedAt: d.CreatedAt}
	if d.SupersededByID != nil {
		id := d.SupersededByID.String()
		v.SupersededByID = &id
	}
	return v
}
func (s *DocumentService) Versions(ctx context.Context, actorID, documentID uuid.UUID) (*dto.DocumentVersionsResponse, error) {
	d, err := s.authorizeDocument(ctx, actorID, documentID, access.CapDocumentRead)
	if err != nil {
		return nil, err
	}
	items, err := s.documents.VersionChain(ctx, d.KnowledgeBaseID, d.ID)
	if err != nil {
		return nil, apperror.Internal(err)
	}
	if len(items) > 100 {
		return nil, apperror.New(http.StatusBadRequest, "DOCUMENT_VERSION_LIMIT", "版本链超过 100 个，请缩小文档版本范围")
	}
	res := &dto.DocumentVersionsResponse{Items: []dto.DocumentVersion{}}
	for _, item := range items {
		res.Items = append(res.Items, documentVersion(item))
	}
	return res, nil
}
func (s *DocumentService) Compare(ctx context.Context, actorID, baseID, headID uuid.UUID) (*dto.DocumentCompareResponse, error) {
	head, err := s.authorizeDocument(ctx, actorID, headID, access.CapDocumentRead)
	if err != nil {
		return nil, err
	}
	base, err := s.authorizeDocument(ctx, actorID, baseID, access.CapDocumentRead)
	if err != nil {
		return nil, err
	}
	if base.KnowledgeBaseID != head.KnowledgeBaseID {
		return nil, apperror.Validation(map[string]any{"baseId": "只能比较同一文档版本链"})
	}
	versions, err := s.Versions(ctx, actorID, headID)
	if err != nil {
		return nil, err
	}
	found := false
	for _, v := range versions.Items {
		if v.ID == baseID.String() {
			found = true
		}
	}
	if !found {
		return nil, apperror.Validation(map[string]any{"baseId": "只能比较同一文档版本链"})
	}
	before, err := s.comparableText(ctx, *base)
	if err != nil {
		return nil, err
	}
	after := before
	if baseID != headID {
		after, err = s.comparableText(ctx, *head)
		if err != nil {
			return nil, err
		}
	}
	lines, added, removed, err := diffDocumentLines(ctx, before, after)
	if err != nil {
		return nil, err
	}
	// Recheck after object reads, which can take long enough for membership to change.
	if _, err = s.authorizeDocument(ctx, actorID, baseID, access.CapDocumentRead); err != nil {
		return nil, err
	}
	if _, err = s.authorizeDocument(ctx, actorID, headID, access.CapDocumentRead); err != nil {
		return nil, err
	}
	return &dto.DocumentCompareResponse{Base: documentVersion(*base), Head: documentVersion(*head), Lines: lines, AddedLines: added, RemovedLines: removed}, nil
}
func (s *DocumentService) comparableText(ctx context.Context, d model.Document) ([]string, error) {
	if d.Status != "completed" {
		return nil, apperror.New(http.StatusConflict, "DOCUMENT_COMPARE_NOT_READY", "请先完成两个版本的文档处理；失败版本可重新处理后再比较")
	}
	info, err := s.storage.Stat(ctx, d.StoragePath)
	if err != nil {
		return nil, documentStorageError(err)
	}
	if info.Size > 50*1024*1024 {
		return nil, compareTooLarge()
	}
	path, cleanup, err := s.storage.Materialize(ctx, d.StoragePath)
	if err != nil {
		return nil, documentStorageError(err)
	}
	defer cleanup()
	settings, err := tableconfig.Decode(d.TableImport)
	if err != nil {
		return nil, tableImportError(err)
	}
	parsed, err := parser.ParseWithOptions(ctx, parser.NewDefaultParser(), path, d.FileType, parser.ParseOptions{TableImport: settings})
	if err != nil {
		return nil, apperror.New(http.StatusBadRequest, "DOCUMENT_COMPARE_PARSE_FAILED", "无法提取文档文本，请检查文件或重新处理")
	}
	var text strings.Builder
	for _, segment := range parsed.Segments {
		if text.Len()+len(segment.Content)+1 > maxPreviewTextBytes {
			return nil, compareTooLarge()
		}
		if text.Len() > 0 {
			text.WriteByte('\n')
		}
		text.WriteString(segment.Content)
	}
	content := strings.ReplaceAll(text.String(), "\r\n", "\n")
	if strings.TrimSpace(content) == "" {
		return nil, apperror.New(http.StatusBadRequest, "DOCUMENT_COMPARE_EMPTY", "文档未提取到文字，无法比较")
	}
	lines := strings.Split(strings.TrimSuffix(content, "\n"), "\n")
	if len(lines) > maxCompareLines {
		return nil, compareTooLarge()
	}
	return lines, nil
}
func compareTooLarge() error {
	return apperror.New(http.StatusBadRequest, "DOCUMENT_COMPARE_TOO_LARGE", "在线对比每个版本最多 1 MiB 解析文本、2000 行；请拆分文档后再比较")
}

// Bounded line LCS: at most 4M uint16 cells (8 MiB), independent of line length.
// Cancellation is checked while computing, and original text is never interpreted.
func diffDocumentLines(ctx context.Context, a, b []string) ([]dto.DocumentDiffLine, int, int, error) {
	if len(a) > maxCompareLines || len(b) > maxCompareLines {
		return nil, 0, 0, compareTooLarge()
	}
	width := len(b) + 1
	matrix := make([]uint16, (len(a)+1)*width)
	for i := len(a) - 1; i >= 0; i-- {
		if err := ctx.Err(); err != nil {
			return nil, 0, 0, err
		}
		for j := len(b) - 1; j >= 0; j-- {
			if a[i] == b[j] {
				matrix[i*width+j] = matrix[(i+1)*width+j+1] + 1
			} else {
				matrix[i*width+j] = max(matrix[(i+1)*width+j], matrix[i*width+j+1])
			}
		}
	}
	lines := make([]dto.DocumentDiffLine, 0, len(a)+len(b))
	added, removed := 0, 0
	for i, j := 0, 0; i < len(a) || j < len(b); {
		oldLine, newLine := i+1, j+1
		if i < len(a) && j < len(b) && a[i] == b[j] {
			lines = append(lines, dto.DocumentDiffLine{Kind: "equal", Content: a[i], BaseLine: &oldLine, HeadLine: &newLine})
			i++
			j++
		} else if i < len(a) && (j == len(b) || matrix[(i+1)*width+j] >= matrix[i*width+j+1]) {
			lines = append(lines, dto.DocumentDiffLine{Kind: "remove", Content: a[i], BaseLine: &oldLine})
			removed++
			i++
		} else {
			lines = append(lines, dto.DocumentDiffLine{Kind: "add", Content: b[j], HeadLine: &newLine})
			added++
			j++
		}
	}
	return lines, added, removed, nil
}
