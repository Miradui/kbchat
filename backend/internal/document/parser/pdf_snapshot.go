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
	document := ParsedDocument{FileType: "pdf"}
	previous, textBytes := 0, 0
	for _, page := range snapshot.Pages {
		textBytes += len(page.Content)
		if page.PageNumber <= previous || page.PageNumber > snapshot.TotalPages || strings.TrimSpace(page.Content) == "" || (page.TextSource != "" && page.TextSource != "ocr") || textBytes > MaxPDFTextBytes {
			return ParsedDocument{}, errors.New("invalid PDF snapshot page")
		}
		pageNumber := page.PageNumber
		document.Segments = append(document.Segments, Segment{Content: page.Content, PageNumber: &pageNumber, TextSource: page.TextSource})
		previous = pageNumber
	}
	return document, nil
}
