package service

import (
	"context"
	"errors"
	"io"
	"mime/multipart"
	"net/http"

	"github.com/google/uuid"

	"kbchat/backend/internal/access"
	"kbchat/backend/internal/apperror"
	"kbchat/backend/internal/document/parser"
	"kbchat/backend/internal/document/tableconfig"
)

func readTableSource(source documentSource) ([]byte, error) {
	if source.Size > parser.MaxTableInputBytes {
		return nil, parser.ErrTableLimit
	}
	r, err := source.Open()
	if err != nil {
		return nil, err
	}
	defer r.Close()
	b, err := io.ReadAll(io.LimitReader(r, parser.MaxTableInputBytes+1))
	if len(b) > parser.MaxTableInputBytes {
		return nil, parser.ErrTableLimit
	}
	return b, err
}

func tableImportError(err error) error {
	if errors.Is(err, tableconfig.ErrInvalid) {
		return apperror.New(http.StatusBadRequest, "DOCUMENT_TABLE_IMPORT_INVALID", "表格导入设置无效，请检查工作表、表头行和列选择")
	}
	if errors.Is(err, parser.ErrTableLimit) {
		return apperror.New(http.StatusBadRequest, "DOCUMENT_TABLE_TOO_LARGE", "表格超过解析上限，请缩小工作表或列范围、拆分后导入")
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return err
	}
	return apperror.New(http.StatusBadRequest, "DOCUMENT_PREVIEW_FAILED", "无法解析表格，请使用 UTF-8 CSV 或未加密的 XLSX")
}

func (s *DocumentService) InspectTable(ctx context.Context, actorID, kbID uuid.UUID, file *multipart.FileHeader) (*parser.TableInspection, error) {
	if _, err := s.authorizeKnowledgeBase(ctx, actorID, kbID, access.CapContentWrite); err != nil {
		return nil, err
	}
	if err := s.validateFile(file); err != nil {
		return nil, err
	}
	fileType := fileTypeOf(file.Filename)
	if fileType != "xlsx" && fileType != "csv" {
		return nil, tableImportError(tableconfig.ErrInvalid)
	}
	content, err := readTableSource(documentSource{Size: file.Size, Open: func() (io.ReadCloser, error) { return file.Open() }})
	if err != nil {
		return nil, tableImportError(err)
	}
	result, err := parser.InspectTable(ctx, content, fileType)
	if err != nil {
		return nil, tableImportError(err)
	}
	if _, err := s.authorizeKnowledgeBase(ctx, actorID, kbID, access.CapContentWrite); err != nil {
		return nil, err
	}
	return result, nil
}
