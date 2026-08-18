package service

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"

	"rag/backend/internal/apperror"
	"rag/backend/internal/config"
	"rag/backend/internal/dto"
)

func TestDocumentBatchOperationsReturnReadableEmptySelectionError(t *testing.T) {
	service := &DocumentService{}
	tests := []struct {
		name string
		run  func() error
	}{
		{name: "delete", run: func() error {
			_, err := service.BatchDelete(context.Background(), uuid.New(), dto.DocumentBatchRequest{})
			return err
		}},
		{name: "restore", run: func() error {
			_, err := service.BatchRestore(context.Background(), uuid.New(), dto.DocumentBatchRequest{})
			return err
		}},
		{name: "reprocess", run: func() error {
			_, err := service.BatchReprocess(context.Background(), uuid.New(), dto.DocumentBatchRequest{})
			return err
		}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var appErr *apperror.Error
			if err := tt.run(); !errors.As(err, &appErr) {
				t.Fatalf("expected application error, got %v", err)
			}
			if got := appErr.Details["documentIds"]; got != "文档 ID 不能为空" {
				t.Fatalf("expected readable validation detail, got %q", got)
			}
		})
	}
}

func TestValidateFileRejectsSpoofedPDFBeforeQueueing(t *testing.T) {
	service := &DocumentService{cfg: config.Config{MaxUploadSizeMB: 1}}
	file := createUploadFile(t, "spoofed.pdf", "this is not a PDF")

	err := service.validateFile(file)
	var appErr *apperror.Error
	if !errors.As(err, &appErr) {
		t.Fatalf("expected application error, got %v", err)
	}
	if appErr.Code != "DOCUMENT_TYPE_UNSUPPORTED" {
		t.Fatalf("expected DOCUMENT_TYPE_UNSUPPORTED, got %q", appErr.Code)
	}
}

func TestValidateFileAcceptsPDFSignature(t *testing.T) {
	service := &DocumentService{cfg: config.Config{MaxUploadSizeMB: 1}}
	file := createUploadFile(t, "document.pdf", "%PDF-1.7\n")

	if err := service.validateFile(file); err != nil {
		t.Fatalf("expected a PDF signature to pass upload validation: %v", err)
	}
}
