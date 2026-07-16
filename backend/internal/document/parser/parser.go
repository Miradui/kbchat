package parser

import (
	"fmt"
	"os"
	"strings"
	"unicode/utf8"

	"github.com/ledongthuc/pdf"
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
			return ParsedDocument{}, fmt.Errorf("parse %s: content is not valid UTF-8", fileType)
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
	default:
		content, err := os.ReadFile(path)
		if err != nil {
			return ParsedDocument{}, err
		}
		if !utf8.Valid(content) {
			return ParsedDocument{}, fmt.Errorf("parse %s: content is not valid UTF-8", fileType)
		}
		return ParsedDocument{
			FileType: fileType,
			Segments: []Segment{{Content: strings.TrimPrefix(string(content), "\ufeff")}},
		}, nil
	}
}

func normalizeFileType(fileType string) string {
	return strings.TrimPrefix(strings.ToLower(strings.TrimSpace(fileType)), ".")
}

func parsePDFSegments(path string) ([]Segment, error) {
	file, reader, err := pdf.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()

	fonts := make(map[string]*pdf.Font)
	return collectPDFSegments(reader.NumPage(), func(pageNumber int) (string, error) {
		page := reader.Page(pageNumber)
		for _, name := range page.Fonts() {
			if _, exists := fonts[name]; !exists {
				font := page.Font(name)
				fonts[name] = &font
			}
		}
		return page.GetPlainText(fonts)
	})
}

func collectPDFSegments(pageCount int, readPage func(pageNumber int) (string, error)) ([]Segment, error) {
	segments := make([]Segment, 0, pageCount)
	for pageNumber := 1; pageNumber <= pageCount; pageNumber++ {
		content, err := readPage(pageNumber)
		if err != nil {
			return nil, fmt.Errorf("parse pdf page %d: %w", pageNumber, err)
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
