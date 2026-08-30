package parser

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// The sentinel tests elsewhere construct the error they assert on, which proves
// ClassifyError reads a wrapped cause but not that the parser ever produces one.
// These drive real files through ParseDocument so the classification chain is
// tested end to end: a malformed file in, a specific code out.

func writeTempFile(t *testing.T, name string, content []byte) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(path, content, 0o600); err != nil {
		t.Fatalf("write %s: %v", name, err)
	}
	return path
}

func TestParseDocumentReportsCorruptFileForAMalformedPDF(t *testing.T) {
	// A real PDF header followed by nothing usable: the extension and magic bytes
	// say PDF, so this reaches the PDF reader and fails inside it. That is the case
	// a user actually hits -- a truncated upload, not a renamed text file.
	path := writeTempFile(t, "truncated.pdf", []byte("%PDF-1.7\n1 0 obj\n<< /Type /Catalog"))

	_, err := NewDefaultParser().ParseDocument(path, "pdf")
	if err == nil {
		t.Fatal("expected a truncated PDF to fail")
	}
	if !errors.Is(err, ErrCorruptFile) {
		t.Fatalf("error = %v, want it to wrap ErrCorruptFile", err)
	}
	// The encoding sentinel must not also match, or the user is told to fix the
	// text encoding of a file whose container is the problem.
	if errors.Is(err, ErrEncodingInvalid) {
		t.Fatalf("a corrupt container must not be reported as an encoding problem: %v", err)
	}
}

func TestParseDocumentReportsCorruptFileForAnEmptyPDF(t *testing.T) {
	path := writeTempFile(t, "empty.pdf", nil)

	_, err := NewDefaultParser().ParseDocument(path, "pdf")
	if err == nil {
		t.Fatal("expected an empty PDF to fail")
	}
	if !errors.Is(err, ErrCorruptFile) {
		t.Fatalf("error = %v, want it to wrap ErrCorruptFile", err)
	}
}

func TestParseDocumentReportsEncodingInvalidForRealInvalidUTF8(t *testing.T) {
	// 0xFF 0xFE is a UTF-16 BOM: the most likely way a user produces this is
	// saving a .txt as UTF-16 from a Windows editor.
	for _, fileType := range []string{"txt", "md", "csv"} {
		t.Run(fileType, func(t *testing.T) {
			path := writeTempFile(t, "utf16."+fileType, []byte{0xFF, 0xFE, 0x4E, 0x00, 0x2D, 0x00})

			_, err := NewDefaultParser().ParseDocument(path, fileType)
			if err == nil {
				t.Fatal("expected invalid UTF-8 to fail")
			}
			if !errors.Is(err, ErrEncodingInvalid) {
				t.Fatalf("error = %v, want it to wrap ErrEncodingInvalid", err)
			}
			if errors.Is(err, ErrCorruptFile) {
				t.Fatalf("an encoding problem must not be reported as a corrupt file: %v", err)
			}
		})
	}
}

func TestParseDocumentDoesNotFlagValidUTF8AsAnEncodingProblem(t *testing.T) {
	// The guard against a false positive on the encoding check: multi-byte text and
	// a UTF-8 BOM are both valid, and the BOM must be stripped rather than kept as
	// content, since it would otherwise land in the first chunk.
	path := writeTempFile(t, "valid.md", []byte("\ufeff# 退货政策\n三十天内可退货。"))

	document, err := NewDefaultParser().ParseDocument(path, "md")
	if err != nil {
		t.Fatalf("parse valid utf-8: %v", err)
	}
	if len(document.Segments) != 1 {
		t.Fatalf("segments = %d, want 1", len(document.Segments))
	}
	if got := document.Segments[0].Content; got != "# 退货政策\n三十天内可退货。" {
		t.Fatalf("content = %q, want the BOM stripped and the text intact", got)
	}
}
