package parser

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/ledongthuc/pdf"
	"kbchat/backend/internal/document/ocr"
)

// Sentinel causes, wrapped into the returned errors so a caller can tell why a
// document failed without matching on message text. The wrapped error still
// carries the detail (which page, which file type) for the server log.
var (
	// ErrEncodingInvalid means the bytes are not valid UTF-8. Distinct from a
	// corrupt file: the container was readable, the text inside was not.
	ErrEncodingInvalid = errors.New("content is not valid UTF-8")
	// ErrCorruptFile means the container itself could not be read -- a truncated
	// or malformed PDF/DOCX package, not a text encoding problem.
	ErrCorruptFile = errors.New("file could not be read")
)

type Parser interface {
	ParseDocument(path string, fileType string) (ParsedDocument, error)
}

type ParsedDocument struct {
	FileType       string
	Segments       []Segment
	PDFTextSummary *PDFTextSummary
}

// PagesWithoutText records an extraction result, not a diagnosis of scanned pages.
type PDFTextSummary struct {
	OCR              *PDFOCRSummary `json:"ocr,omitempty"`
	TotalPages       int            `json:"totalPages"`
	TextPages        int            `json:"textPages"`
	PagesWithoutText []int          `json:"pagesWithoutText"`
}

type Segment struct {
	TextSource string
	Content    string
	PageNumber *int
	Table      *TableRow
}

type DefaultParser struct {
	ocr         ocr.PageRecognizer
	ocrMaxPages int
	ocrTimeout  time.Duration
}

func NewDefaultParser() *DefaultParser {
	return &DefaultParser{}
}

func (p *DefaultParser) Parse(path string, fileType string) (string, error) {
	document, err := p.ParseDocument(path, fileType)
	if err != nil {
		return "", err
	}
	contents := make([]string, 0, len(document.Segments))
	for _, segment := range document.Segments {
		contents = append(contents, segment.Content)
	}
	return strings.Join(contents, "\n"), nil
}

func (p *DefaultParser) ParseDocument(path string, fileType string) (ParsedDocument, error) {
	fileType = normalizeFileType(fileType)
	switch fileType {
	case "csv", "xlsx":
		info, err := os.Stat(path)
		if err != nil {
			return ParsedDocument{}, err
		}
		if info.Size() > MaxTableInputBytes {
			return ParsedDocument{}, ErrTableLimit
		}
		content, err := os.ReadFile(path)
		if err != nil {
			return ParsedDocument{}, err
		}
		return parseTableBytes(content, fileType)
	case "txt", "md":
		content, err := os.ReadFile(path)
		if err != nil {
			return ParsedDocument{}, err
		}
		if !utf8.Valid(content) {
			return ParsedDocument{}, fmt.Errorf("parse %s: %w", fileType, ErrEncodingInvalid)
		}
		return ParsedDocument{
			FileType: fileType,
			Segments: []Segment{{Content: strings.TrimPrefix(string(content), "\ufeff")}},
		}, nil
	case "pdf":
		return p.parsePDF(context.Background(), path, nil)
	case "docx":
		document, err := parseDOCXPath(path)
		if err != nil {
			return ParsedDocument{}, err
		}
		return document, nil
	default:
		content, err := os.ReadFile(path)
		if err != nil {
			return ParsedDocument{}, err
		}
		if !utf8.Valid(content) {
			return ParsedDocument{}, fmt.Errorf("parse %s: %w", fileType, ErrEncodingInvalid)
		}
		return ParsedDocument{
			FileType: fileType,
			Segments: []Segment{{Content: strings.TrimPrefix(string(content), "\ufeff")}},
		}, nil
	}
}

// ParseBytes mirrors ParseDocument for callers that already have the object in
// memory (the preview endpoint is one such caller). Keeping DOCX decoding here
// avoids writing a second, subtly different parser just for previews.
func (p *DefaultParser) ParseBytes(content []byte, fileType string) (ParsedDocument, error) {
	fileType = normalizeFileType(fileType)
	if fileType == "csv" || fileType == "xlsx" {
		return parseTableBytes(content, fileType)
	}
	if fileType == "docx" {
		return ParseDOCXBytes(content)
	}
	if !utf8.Valid(content) {
		return ParsedDocument{}, fmt.Errorf("parse %s: %w", fileType, ErrEncodingInvalid)
	}
	return ParsedDocument{FileType: fileType, Segments: []Segment{{Content: strings.TrimPrefix(string(content), "\ufeff")}}}, nil
}

func normalizeFileType(fileType string) string {
	return strings.TrimPrefix(strings.ToLower(strings.TrimSpace(fileType)), ".")
}

func readPDFDocument(ctx context.Context, path string) (document ParsedDocument, parseErr error) {
	defer func() {
		if recover() != nil {
			document, parseErr = ParsedDocument{}, ErrCorruptFile
		}
	}()
	file, reader, err := pdf.Open(path)
	if err != nil {
		// A PDF that will not open is corrupt from the user's point of view even
		// when the underlying library calls it something else. os.Open failures
		// reach here too, but a missing local copy is already a storage error by
		// the time the processor asked for it.
		return ParsedDocument{}, fmt.Errorf("open pdf: %w: %w", ErrCorruptFile, err)
	}
	defer file.Close()

	return collectPDFDocument(reader.NumPage(), func(pageNumber int) (string, error) {
		if err := ctx.Err(); err != nil {
			return "", err
		}
		return readPDFPageText(reader.Page(pageNumber))
	})
}

func collectPDFDocument(pageCount int, readPage func(pageNumber int) (string, error)) (ParsedDocument, error) {
	if pageCount < 1 || pageCount > MaxPDFPages {
		return ParsedDocument{}, ErrPDFLimit
	}
	textBytes := 0
	segments := make([]Segment, 0, pageCount)
	summary := &PDFTextSummary{TotalPages: pageCount, PagesWithoutText: []int{}}
	for pageNumber := 1; pageNumber <= pageCount; pageNumber++ {
		content, err := readPage(pageNumber)
		if err != nil {
			return ParsedDocument{}, fmt.Errorf("parse pdf page %d: %w: %w", pageNumber, ErrCorruptFile, err)
		}
		if !utf8.ValidString(content) {
			return ParsedDocument{}, fmt.Errorf("parse pdf page %d: %w", pageNumber, ErrEncodingInvalid)
		}
		content = strings.TrimFunc(content, func(r rune) bool { return r == '\ufeff' || unicode.IsSpace(r) })
		textBytes += len(content)
		if textBytes > MaxPDFTextBytes {
			return ParsedDocument{}, ErrPDFLimit
		}
		if content == "" {
			summary.PagesWithoutText = append(summary.PagesWithoutText, pageNumber)
			continue
		}
		page := pageNumber
		segments = append(segments, Segment{Content: content, PageNumber: &page})
	}
	summary.TextPages = len(segments)
	return ParsedDocument{FileType: "pdf", Segments: segments, PDFTextSummary: summary}, nil
}
