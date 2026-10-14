package parser

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"kbchat/backend/internal/config"
)

// Opt-in local subprocess test; no database, model or external OCR service.
func TestRealPDFOCRScannedAndMixedPages(t *testing.T) {
	if os.Getenv("RAG_TEST_PDF_OCR") != "1" {
		t.Skip("set RAG_TEST_PDF_OCR=1 and executable/data paths to run real OCR")
	}
	path := func(name, fallback string) string {
		if v := os.Getenv(name); v != "" {
			return v
		}
		return fallback
	}
	cfg := config.Config{PDFOCR: config.PDFOCRConfig{Enabled: true, TesseractPath: path("RAG_TEST_OCR_TESSERACT", "tesseract"), PDFToPPMPath: path("RAG_TEST_OCR_PDFTOPPM", "pdftoppm"), TessdataDir: os.Getenv("RAG_TEST_OCR_TESSDATA"), Languages: "chi_sim+eng", MaxPages: 10, MaxImageSide: 3000, PageTimeout: 30 * time.Second, Timeout: 2 * time.Minute}}
	for _, test := range []struct {
		name             string
		textPages, total int
		ocrPages, blank  []int
	}{
		{"ocr-mixed.pdf", 3, 4, []int{2, 3}, []int{4}},
		{"ocr-scanned.pdf", 2, 2, []int{1, 2}, []int{}},
	} {
		t.Run(test.name, func(t *testing.T) {
			doc, err := NewConfiguredParser(cfg).ParseDocumentWithOptions(context.Background(), filepath.Join("testdata", test.name), "pdf", ParseOptions{})
			if err != nil {
				t.Fatal(err)
			}
			s := doc.PDFTextSummary
			if s.TotalPages != test.total || s.TextPages != test.textPages || !reflect.DeepEqual(s.OCR.Pages, test.ocrPages) || !reflect.DeepEqual(s.PagesWithoutText, test.blank) || s.OCR.Status != "completed" {
				t.Fatalf("summary %+v OCR %+v", s, s.OCR)
			}
			var text strings.Builder
			for _, segment := range doc.Segments {
				text.WriteString(segment.Content)
			}
			compact := strings.Join(strings.Fields(text.String()), "")
			if !strings.Contains(compact, "冷却系统") || !strings.Contains(compact, "OCR-2468") {
				t.Fatalf("missing known text in OCR result: %s", text.String())
			}
			if test.name == "ocr-mixed.pdf" && (doc.Segments[0].TextSource != "" || !strings.Contains(doc.Segments[0].Content, "Native text remains unchanged.")) {
				t.Fatal("native page was replaced")
			}
		})
	}
}
