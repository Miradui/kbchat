package parser

import (
	"encoding/json"
	"errors"
	"strings"
)

const MaxPDFSnapshotBytes = 16 * 1024 * 1024

type pdfSnapshot struct {
	Version    int               `json:"version"`
	TotalPages int               `json:"totalPages"`
	Pages      []pdfSnapshotPage `json:"pages"`
}
type pdfSnapshotPage struct {
	PageNumber int    `json:"pageNumber"`
	Content    string `json:"content"`
	TextSource string `json:"textSource,omitempty"`
}

// Only a successfully published PDF gets a snapshot. Comparisons read it instead
// of re-running an OCR engine whose installation or results may have changed.
func EncodePDFSnapshot(document ParsedDocument) ([]byte, error) {
	if document.FileType != "pdf" || document.PDFTextSummary == nil {
		return nil, nil
	}
	snapshot := pdfSnapshot{Version: 1, TotalPages: document.PDFTextSummary.TotalPages, Pages: []pdfSnapshotPage{}}
	for _, segment := range document.Segments {
		if segment.PageNumber == nil {
			return nil, errors.New("PDF snapshot page missing")
		}
		snapshot.Pages = append(snapshot.Pages, pdfSnapshotPage{PageNumber: *segment.PageNumber, Content: segment.Content, TextSource: segment.TextSource})
	}
	content, err := json.Marshal(snapshot)
	if err != nil {
		return nil, err
	}
	if len(content) > MaxPDFSnapshotBytes {
		return nil, ErrPDFLimit
	}
	return content, nil
}

func DecodePDFSnapshot(content []byte) (ParsedDocument, error) {
	var snapshot pdfSnapshot
	if len(content) > MaxPDFSnapshotBytes || json.Unmarshal(content, &snapshot) != nil || snapshot.Version != 1 || snapshot.TotalPages < 1 || snapshot.TotalPages > MaxPDFPages {
		return ParsedDocument{}, errors.New("invalid PDF snapshot")
	}
	document := ParsedDocument{FileType: "pdf", PDFTextSummary: &PDFTextSummary{TotalPages: snapshot.TotalPages, PagesWithoutText: []int{}}}
	nativePages := map[int]bool{}
	ocrPages := []int{}
	ocrPageSet := map[int]bool{}
	previous, textBytes := 0, 0
	for _, page := range snapshot.Pages {
		textBytes += len(page.Content)
		if page.PageNumber <= previous || page.PageNumber > snapshot.TotalPages || strings.TrimSpace(page.Content) == "" || (page.TextSource != "" && page.TextSource != "ocr" && page.TextSource != "ocr_corrected") || textBytes > MaxPDFTextBytes {
			return ParsedDocument{}, errors.New("invalid PDF snapshot page")
		}
		pageNumber := page.PageNumber
		document.Segments = append(document.Segments, Segment{Content: page.Content, PageNumber: &pageNumber, TextSource: page.TextSource})
		if page.TextSource == "" {
			nativePages[pageNumber] = true
		} else {
			ocrPages = append(ocrPages, pageNumber)
			ocrPageSet[pageNumber] = true
		}
		previous = pageNumber
	}
	// An OCR page carries text, so it counts toward TextPages and must not be
	// listed as a page without text. The decode used to do neither, and the
	// detail endpoint then rejected the summary as self-contradictory and
	// dropped the whole OCR block -- which is what a corrected document hits on
	// every re-process, because the correction baseline is decoded here.
	document.PDFTextSummary.TextPages = len(nativePages) + len(ocrPages)
	neededOCR := 0
	for page := 1; page <= snapshot.TotalPages; page++ {
		if nativePages[page] {
			continue
		}
		neededOCR++
		if !ocrPageSet[page] {
			document.PDFTextSummary.PagesWithoutText = append(document.PDFTextSummary.PagesWithoutText, page)
		}
	}
	if len(ocrPages) > 0 {
		// Every page that needed OCR was attempted before the document was
		// published, so neededOCR is also the completed count; a page whose
		// recognition returned nothing stays in PagesWithoutText above and is
		// simply absent from Pages.
		document.PDFTextSummary.OCR = &PDFOCRSummary{Status: "completed", Pages: ocrPages, CompletedPages: neededOCR, TotalPages: neededOCR}
	}
	return document, nil
}
