package service

import (
	"archive/zip"
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/google/uuid"

	"kbchat/backend/internal/apperror"
	"kbchat/backend/internal/config"
	"kbchat/backend/internal/dto"
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

func TestValidateFileRequiresDOCXZipSignature(t *testing.T) {
	service := &DocumentService{cfg: config.Config{MaxUploadSizeMB: 1}}
	for _, content := range []string{"not a zip"} {
		file := createUploadFile(t, "document.docx", content)
		err := service.validateFile(file)
		var appErr *apperror.Error
		if !errors.As(err, &appErr) || appErr.Code != "DOCUMENT_TYPE_UNSUPPORTED" {
			t.Fatalf("expected DOCX magic validation error for %q, got %v", content, err)
		}
	}
	if err := service.validateFile(createUploadFile(t, "document.docx", "PK\x03\x04zip payload")); err != nil {
		t.Fatalf("expected ZIP magic to pass upload signature validation, got %v", err)
	}

	path := filepath.Join(t.TempDir(), "valid.docx")
	output, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	archive := zip.NewWriter(output)
	entry, err := archive.Create("word/document.xml")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := entry.Write([]byte("<w:document xmlns:w=\"urn:test\"><w:body/></w:document>")); err != nil {
		t.Fatal(err)
	}
	if err := archive.Close(); err != nil {
		t.Fatal(err)
	}
	if err := output.Close(); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	file := createUploadFile(t, "valid.docx", string(data))
	if err := service.validateFile(file); err != nil {
		t.Fatalf("expected valid DOCX ZIP signature to pass, got %v", err)
	}
}

func TestValidateFileExplainsLegacyDocAndEncryptedWordFiles(t *testing.T) {
	service := &DocumentService{cfg: config.Config{MaxUploadSizeMB: 1}}
	ole := string([]byte{0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1}) + "compound"
	cases := []struct {
		name   string
		file   string
		body   string
		reason string
	}{
		{name: "legacy extension", file: "old.doc", body: ole, reason: "legacy_doc"},
		{name: "renamed or encrypted", file: "renamed.docx", body: ole, reason: "legacy_or_encrypted"},
	}
	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			err := service.validateFile(createUploadFile(t, tt.file, tt.body))
			var appErr *apperror.Error
			if !errors.As(err, &appErr) || appErr.Code != "DOCUMENT_TYPE_UNSUPPORTED" {
				t.Fatalf("expected DOCUMENT_TYPE_UNSUPPORTED, got %v", err)
			}
			if appErr.Details["reason"] != tt.reason {
				t.Fatalf("expected reason %q, got %#v", tt.reason, appErr.Details)
			}
			if appErr.Message == "unsupported document type" {
				t.Fatalf("expected an explicit message, got %q", appErr.Message)
			}
		})
	}
}
