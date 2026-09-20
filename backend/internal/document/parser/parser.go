package parser

import (
	"errors"
	"fmt"
	"os"
	"strings"
	"unicode/utf8"

	"github.com/ledongthuc/pdf"
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
	FileType string
	Segments []Segment
}

type Segment struct {
	Content    string
	PageNumber *int
}

type DefaultParser struct{}

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
		segments, err := parsePDFSegments(path)
		if err != nil {
			return ParsedDocument{}, err
		}
		return ParsedDocument{FileType: fileType, Segments: segments}, nil
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

func parsePDFSegments(path string) ([]Segment, error) {
	file, reader, err := pdf.Open(path)
	if err != nil {
		// A PDF that will not open is corrupt from the user's point of view even
		// when the underlying library calls it something else. os.Open failures
		// reach here too, but a missing local copy is already a storage error by
		// the time the processor asked for it.
		return nil, fmt.Errorf("open pdf: %w: %w", ErrCorruptFile, err)
	}
	defer file.Close()

	return collectPDFSegments(reader.NumPage(), func(pageNumber int) (string, error) {
		return readPDFPageText(reader.Page(pageNumber))
	})
}

func collectPDFSegments(pageCount int, readPage func(pageNumber int) (string, error)) ([]Segment, error) {
	segments := make([]Segment, 0, pageCount)
	for pageNumber := 1; pageNumber <= pageCount; pageNumber++ {
		content, err := readPage(pageNumber)
		if err != nil {
			return nil, fmt.Errorf("parse pdf page %d: %w: %w", pageNumber, ErrCorruptFile, err)
		}
		if !utf8.ValidString(content) {
			return nil, fmt.Errorf("parse pdf page %d: %w", pageNumber, ErrEncodingInvalid)
		}
		content = strings.TrimSpace(strings.TrimPrefix(content, "\ufeff"))
		if content == "" {
			continue
		}
		page := pageNumber
		segments = append(segments, Segment{Content: content, PageNumber: &page})
	}
	return segments, nil
}
