package parser

import (
	"bytes"
	"os"
	"strings"

	"github.com/ledongthuc/pdf"
)

type Parser interface {
	Parse(path string, fileType string) (string, error)
}

type DefaultParser struct{}

func NewDefaultParser() *DefaultParser {
	return &DefaultParser{}
}

func (p *DefaultParser) Parse(path string, fileType string) (string, error) {
	switch strings.ToLower(fileType) {
	case "txt", "md":
		content, err := os.ReadFile(path)
		if err != nil {
			return "", err
		}
		return strings.TrimPrefix(string(content), "\ufeff"), nil
	case "pdf":
		return parsePDF(path)
	default:
		content, err := os.ReadFile(path)
		if err != nil {
			return "", err
		}
		return string(content), nil
	}
}

func parsePDF(path string) (string, error) {
	file, reader, err := pdf.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()

	textReader, err := reader.GetPlainText()
	if err != nil {
		return "", err
	}

	var buf bytes.Buffer
	if _, err := buf.ReadFrom(textReader); err != nil {
		return "", err
	}
	return strings.TrimPrefix(buf.String(), "\ufeff"), nil
}
