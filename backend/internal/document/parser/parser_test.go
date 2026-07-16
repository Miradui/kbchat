package parser

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseDocumentPreservesTextFormatAndLiteralSyntax(t *testing.T) {
	tests := []struct {
		name     string
		fileType string
		content  string
	}{
		{name: "plain text", fileType: "TXT", content: "\ufeff# literal heading\n- literal list"},
		{name: "markdown", fileType: "md", content: "# Real heading\n\n| a | b |"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "document."+tt.fileType)
			if err := os.WriteFile(path, []byte(tt.content), 0o600); err != nil {
				t.Fatalf("write fixture: %v", err)
			}

			document, err := NewDefaultParser().ParseDocument(path, tt.fileType)
			if err != nil {
				t.Fatalf("parse document: %v", err)
			}
			if document.FileType != normalizeFileType(tt.fileType) {
				t.Fatalf("expected normalized file type, got %q", document.FileType)
			}
			if len(document.Segments) != 1 {
				t.Fatalf("expected one text segment, got %#v", document.Segments)
			}
			if document.Segments[0].PageNumber != nil {
				t.Fatalf("expected text segment without page number, got %#v", document.Segments[0].PageNumber)
			}
			expected := strings.TrimPrefix(tt.content, "\ufeff")
			if document.Segments[0].Content != expected {
				t.Fatalf("expected syntax to be preserved, got %q", document.Segments[0].Content)
			}
		})
	}
}

func TestParseDocumentRejectsInvalidUTF8Text(t *testing.T) {
	for _, fileType := range []string{"txt", "md"} {
		t.Run(fileType, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "invalid."+fileType)
			if err := os.WriteFile(path, []byte{0xff, 0xfe, 'x'}, 0o600); err != nil {
				t.Fatalf("write invalid UTF-8 fixture: %v", err)
			}

			_, err := NewDefaultParser().ParseDocument(path, fileType)
			if err == nil || !strings.Contains(err.Error(), "valid UTF-8") {
				t.Fatalf("expected explicit UTF-8 parse error, got %v", err)
			}
		})
	}
}

func TestCollectPDFSegmentsPreservesPhysicalPageNumbers(t *testing.T) {
	pages := map[int]string{
		1: " first page ",
		2: "  \n\t ",
		3: "# literal PDF text",
	}

	segments, err := collectPDFSegments(3, func(pageNumber int) (string, error) {
		return pages[pageNumber], nil
	})
	if err != nil {
		t.Fatalf("collect PDF segments: %v", err)
	}
	if len(segments) != 2 {
		t.Fatalf("expected two non-empty page segments, got %#v", segments)
	}
	if segments[0].PageNumber == nil || *segments[0].PageNumber != 1 || segments[0].Content != "first page" {
		t.Fatalf("unexpected first page segment: %#v", segments[0])
	}
	if segments[1].PageNumber == nil || *segments[1].PageNumber != 3 || segments[1].Content != "# literal PDF text" {
		t.Fatalf("expected blank page to be skipped without renumbering, got %#v", segments[1])
	}
}

func TestCollectPDFSegmentsReportsTheFailingPage(t *testing.T) {
	_, err := collectPDFSegments(4, func(pageNumber int) (string, error) {
		if pageNumber == 3 {
			return "", errors.New("decode failed")
		}
		return "content", nil
	})
	if err == nil || err.Error() != "parse pdf page 3: decode failed" {
		t.Fatalf("expected page-specific error, got %v", err)
	}
}

func TestCollectPDFSegmentsRejectsInvalidUTF8(t *testing.T) {
	_, err := collectPDFSegments(2, func(pageNumber int) (string, error) {
		if pageNumber == 2 {
			return string([]byte{0xff}), nil
		}
		return "content", nil
	})
	if err == nil || err.Error() != "parse pdf page 2: content is not valid UTF-8" {
		t.Fatalf("expected page-specific UTF-8 error, got %v", err)
	}
}
