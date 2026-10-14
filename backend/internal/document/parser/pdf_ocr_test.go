package parser

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"kbchat/backend/internal/document/ocr"
)

type pageRecognizerFunc func(context.Context, string, int) (string, error)

func (f pageRecognizerFunc) Recognize(ctx context.Context, path string, page int) (string, error) {
	return f(ctx, path, page)
}

func ocrInput(t *testing.T) ParsedDocument {
	t.Helper()
	doc, err := collectPDFDocument(4, func(page int) (string, error) {
		if page == 1 {
			return "native page", nil
		}
		return "", nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return doc
}

func TestOCRPreservesNativeTextPhysicalPagesAndBlankPages(t *testing.T) {
	var calls []int
	p := &DefaultParser{ocrMaxPages: 4, ocrTimeout: time.Second, ocr: pageRecognizerFunc(func(_ context.Context, _ string, page int) (string, error) {
		calls = append(calls, page)
		return map[int]string{2: "中文扫描页", 3: "English scanned page", 4: " \n\f"}[page], nil
	})}
	progress := []int{}
	doc, err := p.recognizePDF(context.Background(), "unused", ocrInput(t), func(s *PDFTextSummary) error { progress = append(progress, s.OCR.CompletedPages); return nil })
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(calls, []int{2, 3, 4}) || !reflect.DeepEqual(progress, []int{0, 1, 2, 3}) {
		t.Fatalf("calls %v progress %v", calls, progress)
	}
	if len(doc.Segments) != 3 || doc.Segments[0].Content != "native page" || doc.Segments[0].TextSource != "" {
		t.Fatal(doc.Segments)
	}
	for i := 1; i < 3; i++ {
		if *doc.Segments[i].PageNumber != i+1 || doc.Segments[i].TextSource != "ocr" {
			t.Fatal(doc.Segments)
		}
	}
	s := doc.PDFTextSummary
	if s.TextPages != 3 || !reflect.DeepEqual(s.PagesWithoutText, []int{4}) || !reflect.DeepEqual(s.OCR.Pages, []int{2, 3}) || s.OCR.Status != "completed" {
		t.Fatalf("summary %#v OCR %#v", s, s.OCR)
	}
	snapshot, err := EncodePDFSnapshot(doc)
	if err != nil {
		t.Fatal(err)
	}
	restored, err := DecodePDFSnapshot(snapshot)
	if err != nil || !reflect.DeepEqual(restored.Segments, doc.Segments) {
		t.Fatalf("snapshot failed %v: %#v", err, restored)
	}
}

func TestOCRFailureNeverLooksCompleteAndReportsProgress(t *testing.T) {
	for _, test := range []struct {
		err    error
		status string
	}{{ocr.ErrUnavailable, "unavailable"}, {ocr.ErrTimeout, "timeout"}, {ocr.ErrFailed, "failed"}, {ocr.ErrLimit, "limit_exceeded"}} {
		t.Run(test.status, func(t *testing.T) {
			p := &DefaultParser{ocrMaxPages: 4, ocrTimeout: time.Second, ocr: pageRecognizerFunc(func(_ context.Context, _ string, page int) (string, error) {
				if page == 2 {
					return "已识别", nil
				}
				return "", test.err
			})}
			doc, err := p.recognizePDF(context.Background(), "", ocrInput(t), nil)
			if !errors.Is(err, test.err) || doc.PDFTextSummary.OCR.Status != test.status || doc.PDFTextSummary.OCR.CompletedPages != 1 {
				t.Fatalf("%v %#v", err, doc.PDFTextSummary.OCR)
			}
			if !reflect.DeepEqual(doc.PDFTextSummary.PagesWithoutText, []int{3, 4}) {
				t.Fatal(doc.PDFTextSummary)
			}
		})
	}
}

func TestOCRLimitsDisabledAndTimeout(t *testing.T) {
	p := NewDefaultParser()
	doc, err := p.recognizePDF(context.Background(), "", ocrInput(t), nil)
	if err != nil || doc.PDFTextSummary.OCR.Status != "disabled" || len(doc.Segments) != 1 {
		t.Fatal(err, doc)
	}
	p.ocrMaxPages, p.ocrTimeout = 2, time.Second
	p.ocr = pageRecognizerFunc(func(context.Context, string, int) (string, error) {
		t.Fatal("must check pages before running OCR")
		return "", nil
	})
	_, err = p.recognizePDF(context.Background(), "", ocrInput(t), nil)
	if !errors.Is(err, ocr.ErrLimit) {
		t.Fatal(err)
	}
	p.ocrMaxPages, p.ocrTimeout = 4, 10*time.Millisecond
	p.ocr = pageRecognizerFunc(func(ctx context.Context, _ string, _ int) (string, error) { <-ctx.Done(); return "", ctx.Err() })
	doc, err = p.recognizePDF(context.Background(), "", ocrInput(t), nil)
	if !errors.Is(err, ocr.ErrTimeout) || errors.Is(err, context.DeadlineExceeded) || doc.PDFTextSummary.OCR.Status != "timeout" {
		t.Fatal(err, doc)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = p.recognizePDF(ctx, "", ocrInput(t), nil)
	if !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	p.ocr = pageRecognizerFunc(func(context.Context, string, int) (string, error) {
		return strings.Repeat("x", ocr.MaxPageTextBytes+1), nil
	})
	_, err = p.recognizePDF(context.Background(), "", ocrInput(t), nil)
	if !errors.Is(err, ocr.ErrLimit) {
		t.Fatal(err)
	}
}

func TestPDFNativeAndSnapshotLimits(t *testing.T) {
	if _, err := collectPDFDocument(MaxPDFPages+1, func(int) (string, error) { t.Fatal("unbounded PDF read"); return "", nil }); !errors.Is(err, ErrPDFLimit) {
		t.Fatal(err)
	}
	if _, err := collectPDFDocument(1, func(int) (string, error) { return strings.Repeat("x", MaxPDFTextBytes+1), nil }); !errors.Is(err, ErrPDFLimit) {
		t.Fatal(err)
	}
	for _, data := range []string{`null`, `{}`, `{"version":1,"totalPages":2,"pages":[{"pageNumber":3,"content":"x"}]}`, `{"version":1,"totalPages":2,"pages":[{"pageNumber":1,"content":"x"},{"pageNumber":1,"content":"y"}]}`} {
		if _, err := DecodePDFSnapshot([]byte(data)); err == nil {
			t.Fatalf("accepted invalid snapshot %s", data)
		}
	}
}
