package parser

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"unicode/utf8"

	"kbchat/backend/internal/config"
	"kbchat/backend/internal/document/ocr"
)

type PDFOCRSummary struct {
	Status         string `json:"status"`
	Pages          []int  `json:"pages"`
	CompletedPages int    `json:"completedPages"`
	TotalPages     int    `json:"totalPages"`
}

func NewConfiguredParser(cfg config.Config) *DefaultParser {
	p := NewDefaultParser()
	if cfg.PDFOCR.Enabled {
		p.ocr = ocr.NewLocal(ocr.Config{TesseractPath: cfg.PDFOCR.TesseractPath, PDFToPPMPath: cfg.PDFOCR.PDFToPPMPath,
			TessdataDir: cfg.PDFOCR.TessdataDir, Languages: cfg.PDFOCR.Languages, MaxImageSide: cfg.PDFOCR.MaxImageSide, PageTimeout: cfg.PDFOCR.PageTimeout})
		p.ocrMaxPages, p.ocrTimeout = cfg.PDFOCR.MaxPages, cfg.PDFOCR.Timeout
	}
	return p
}

func (p *DefaultParser) parsePDF(ctx context.Context, path string, progress func(*PDFTextSummary) error) (ParsedDocument, error) {
	document, err := readPDFDocument(ctx, path)
	if err != nil {
		return document, err
	}
	return p.recognizePDF(ctx, path, document, progress)
}

func (p *DefaultParser) recognizePDF(ctx context.Context, path string, document ParsedDocument, progress func(*PDFTextSummary) error) (ParsedDocument, error) {
	summary := document.PDFTextSummary
	if summary == nil || len(summary.PagesWithoutText) == 0 {
		return document, nil
	}
	missing := append([]int(nil), summary.PagesWithoutText...)
	summary.OCR = &PDFOCRSummary{Status: "disabled", TotalPages: len(missing), Pages: []int{}}
	if p.ocr == nil {
		return document, nil
	}
	if len(missing) > p.ocrMaxPages {
		summary.OCR.Status = "limit_exceeded"
		return document, ocr.ErrLimit
	}
	ocrCtx, cancel := context.WithTimeout(ctx, p.ocrTimeout)
	defer cancel()
	summary.OCR.Status = "running"
	if progress != nil {
		if err := progress(summary); err != nil {
			return document, err
		}
	}
	fail := func(err error) (ParsedDocument, error) {
		if ctx.Err() != nil {
			return document, ctx.Err()
		}
		if ocrCtx.Err() != nil {
			err = ocr.ErrTimeout
		}
		switch {
		case errors.Is(err, ocr.ErrUnavailable):
			summary.OCR.Status = "unavailable"
		case errors.Is(err, ocr.ErrTimeout):
			summary.OCR.Status = "timeout"
		case errors.Is(err, ocr.ErrLimit):
			summary.OCR.Status = "limit_exceeded"
		default:
			summary.OCR.Status = "failed"
		}
		return document, err
	}
	if ready, ok := p.ocr.(interface{ Ready(context.Context) error }); ok {
		if err := ready.Ready(ocrCtx); err != nil {
			return fail(err)
		}
	}
	textBytes := 0
	for _, segment := range document.Segments {
		textBytes += len(segment.Content)
	}
	for _, page := range missing {
		if err := ocrCtx.Err(); err != nil {
			return fail(err)
		}
		content, err := p.ocr.Recognize(ocrCtx, path, page)
		if err != nil {
			return fail(fmt.Errorf("pdf page %d: %w", page, err))
		}
		if err := ocrCtx.Err(); err != nil {
			return fail(err)
		}
		content = strings.TrimSpace(content)
		if !utf8.ValidString(content) {
			return fail(ocr.ErrFailed)
		}
		if len(content) > ocr.MaxPageTextBytes || textBytes+len(content) > MaxPDFTextBytes {
			return fail(ocr.ErrLimit)
		}
		textBytes += len(content)
		if content != "" {
			pageNumber := page
			document.Segments = append(document.Segments, Segment{Content: content, PageNumber: &pageNumber, TextSource: "ocr"})
			summary.OCR.Pages = append(summary.OCR.Pages, page)
			summary.TextPages++
			for i, empty := range summary.PagesWithoutText {
				if empty == page {
					summary.PagesWithoutText = append(summary.PagesWithoutText[:i], summary.PagesWithoutText[i+1:]...)
					break
				}
			}
		}
		summary.OCR.CompletedPages++
		if progress != nil {
			if err := progress(summary); err != nil {
				return document, err
			}
		}
	}
	summary.OCR.Status = "completed"
	sort.Slice(document.Segments, func(i, j int) bool { return *document.Segments[i].PageNumber < *document.Segments[j].PageNumber })
	return document, nil
}

// Limits include native pages so a tiny hostile PDF cannot allocate an
// unbounded page slice or snapshot before the OCR page budget is checked.
const (
	MaxPDFPages     = 500
	MaxPDFTextBytes = 8 * 1024 * 1024
)

var ErrPDFLimit = errors.New("PDF page or text limit exceeded")
