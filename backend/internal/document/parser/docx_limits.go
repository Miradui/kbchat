package parser

import (
	"encoding/xml"
	"fmt"
	"io"
	"strings"
)

const (
	docxMaxDepth      = 128
	docxMaxElements   = 200000
	docxMaxTextBytes  = 8 * 1024 * 1024
	docxMaxTableCells = 100000
)

// All DOCX parts share the same supported complexity limits. Enforce depth
// before recursive consumers see a token, including nested cells and controls.
type docxDecoder struct {
	*xml.Decoder
	depth, elements, textBytes int
}

func newDOCXDecoder(reader io.Reader) *docxDecoder {
	return &docxDecoder{Decoder: xml.NewDecoder(reader)}
}

func (d *docxDecoder) Token() (xml.Token, error) {
	token, err := d.Decoder.Token()
	if err != nil {
		return nil, err
	}
	switch value := token.(type) {
	case xml.StartElement:
		d.depth++
		d.elements++
	case xml.EndElement:
		d.depth--
	case xml.CharData:
		d.textBytes += len(value)
	}
	if d.depth > docxMaxDepth || d.elements > docxMaxElements || d.textBytes > docxMaxTextBytes {
		return nil, docxLimitError()
	}
	return token, nil
}

// Preserve the existing permanent failure contract for unsupported DOCX parts.
func docxLimitError() error {
	return fmt.Errorf("docx exceeds supported parsing limits: %w", ErrCorruptFile)
}

func writeDOCXText(out *strings.Builder, parts ...string) error {
	size := out.Len()
	for _, part := range parts {
		if len(part) > docxMaxTextBytes-size {
			return docxLimitError()
		}
		size += len(part)
	}
	for _, part := range parts {
		out.WriteString(part)
	}
	return nil
}
