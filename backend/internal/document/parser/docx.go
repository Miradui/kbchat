package parser

// This file intentionally implements only the small, text-oriented subset of
// OOXML that is useful to the knowledge base. A DOCX is a ZIP package; parsing
// the two XML parts here keeps the dependency surface small and, more
// importantly, makes the exact structure handed to the splitter predictable.

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"unicode/utf8"
)

const (
	docxDocumentPart  = "word/document.xml"
	docxStylesPart    = "word/styles.xml"
	docxNumberingPart = "word/numbering.xml"
	// docxMaxPartBytes bounds the decompressed size of a single XML part. The
	// upload limit only applies to the compressed package, and XML compresses
	// well enough that an unbounded part could exhaust memory.
	docxMaxPartBytes = 64 << 20
)

// ErrDOCXLegacyOrEncrypted marks an OLE compound file: either a legacy binary
// .doc or an OOXML package wrapped by Office encryption. Both are rejected with
// the same advice, because neither can be read without Word.
var ErrDOCXLegacyOrEncrypted = errors.New("file is a legacy .doc or an encrypted Word document")

// oleMagic is the compound file binary format signature.
var oleMagic = []byte{0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1}

type docxStyle struct {
	level   int
	basedOn string
}

type docxNumbering struct {
	// numId -> abstractNumId
	nums map[string]string
	// abstractNumId -> ilvl -> numFmt (bullet, decimal, ...)
	formats map[string]map[string]string
	// numId -> ilvl -> numFmt overrides supplied by a concrete list instance.
	overrides map[string]map[string]string
}

type docxParagraph struct {
	styleID string
	// outlineLevel is a direct w:outlineLvl on the paragraph (1-based), which
	// overrides the style's level when present.
	outlineLevel int
	level        int
	numID        string
	text         string
}

type docxCell struct {
	text     string
	gridSpan int
	// vMerge is "restart" for the top cell of a vertical merge and "continue"
	// for the cells below it; empty for unmerged cells.
	vMerge string
}

type docxTable struct {
	rows [][]docxCell
}

type docxBlock struct {
	paragraph *docxParagraph
	table     *docxTable
}

// ParseDOCXBytes parses a DOCX byte slice into the same Markdown-shaped text
// consumed by the existing splitter. It is exported for the text preview path;
// workers normally call DefaultParser.ParseDocument so files do not need to be
// held in memory longer than the storage materialization lifecycle.
func ParseDOCXBytes(data []byte) (ParsedDocument, error) {
	if bytes.HasPrefix(data, oleMagic) {
		return ParsedDocument{}, fmt.Errorf("open docx: %w: %w", ErrCorruptFile, ErrDOCXLegacyOrEncrypted)
	}
	reader, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return ParsedDocument{}, fmt.Errorf("open docx: %w: %w", ErrCorruptFile, err)
	}
	return parseDOCXZip(reader)
}

func parseDOCXPath(path string) (ParsedDocument, error) {
	file, err := os.Open(path)
	if err != nil {
		return ParsedDocument{}, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return ParsedDocument{}, err
	}
	header := make([]byte, len(oleMagic))
	if n, readErr := io.ReadFull(file, header); readErr == nil && n == len(oleMagic) && bytes.Equal(header, oleMagic) {
		return ParsedDocument{}, fmt.Errorf("open docx: %w: %w", ErrCorruptFile, ErrDOCXLegacyOrEncrypted)
	}
	reader, err := zip.NewReader(file, info.Size())
	if err != nil {
		return ParsedDocument{}, fmt.Errorf("open docx: %w: %w", ErrCorruptFile, err)
	}
	return parseDOCXZip(reader)
}

func parseDOCXZip(packageReader *zip.Reader) (ParsedDocument, error) {
	styles := map[string]docxStyle{}
	if file := zipPart(packageReader, docxStylesPart); file != nil {
		parsed, parseErr := parseDOCXStyles(file)
		if parseErr != nil {
			return ParsedDocument{}, parseErr
		}
		styles = resolveStyleLevels(parsed)
	}

	numbering := docxNumbering{
		nums:      map[string]string{},
		formats:   map[string]map[string]string{},
		overrides: map[string]map[string]string{},
	}
	if file := zipPart(packageReader, docxNumberingPart); file != nil {
		parsed, parseErr := parseDOCXNumbering(file)
		if parseErr != nil {
			return ParsedDocument{}, parseErr
		}
		numbering = parsed
	}

	document := zipPart(packageReader, docxDocumentPart)
	if document == nil {
		return ParsedDocument{}, fmt.Errorf("docx missing %s: %w", docxDocumentPart, ErrCorruptFile)
	}
	blocks, err := parseDOCXDocument(document)
	if err != nil {
		return ParsedDocument{}, err
	}
	content, err := renderDOCXBlocks(blocks, styles, numbering)
	if err != nil {
		return ParsedDocument{}, err
	}
	if !utf8.ValidString(content) {
		return ParsedDocument{}, fmt.Errorf("parse docx: %w", ErrEncodingInvalid)
	}
	return ParsedDocument{FileType: "docx", Segments: []Segment{{Content: content}}}, nil
}

func zipPart(reader *zip.Reader, name string) *zip.File {
	for _, file := range reader.File {
		if file.Name == name {
			return file
		}
	}
	return nil
}

func openZipPart(file *zip.File) (io.ReadCloser, error) {
	if file.UncompressedSize64 > docxMaxPartBytes {
		return nil, fmt.Errorf("read docx part %s: %w: declared size %d exceeds %d bytes", file.Name, ErrCorruptFile, file.UncompressedSize64, docxMaxPartBytes)
	}
	reader, err := file.Open()
	if err != nil {
		return nil, fmt.Errorf("read docx part %s: %w: %w", file.Name, ErrCorruptFile, err)
	}
	// The declared size is untrusted; the bounded reader enforces the limit on
	// the bytes actually produced.
	return &boundedPartReader{name: file.Name, reader: reader, remaining: docxMaxPartBytes}, nil
}

type boundedPartReader struct {
	name      string
	reader    io.ReadCloser
	remaining int64
}

func (r *boundedPartReader) Read(p []byte) (int, error) {
	if r.remaining <= 0 {
		return 0, fmt.Errorf("read docx part %s: %w: exceeds %d bytes", r.name, ErrCorruptFile, docxMaxPartBytes)
	}
	if int64(len(p)) > r.remaining {
		p = p[:r.remaining]
	}
	n, err := r.reader.Read(p)
	r.remaining -= int64(n)
	return n, err
}

func (r *boundedPartReader) Close() error {
	return r.reader.Close()
}

func parseDOCXStyles(file *zip.File) (map[string]docxStyle, error) {
	reader, err := openZipPart(file)
	if err != nil {
		return nil, err
	}
	defer reader.Close()

	styles := map[string]docxStyle{}
	decoder := newDOCXDecoder(reader)
	for {
		token, err := decoder.Token()
		if errors.Is(err, io.EOF) {
			return styles, nil
		}
		if err != nil {
			return nil, fmt.Errorf("parse docx styles: %w: %w", ErrCorruptFile, err)
		}
		start, ok := token.(xml.StartElement)
		if !ok || start.Name.Local != "style" {
			continue
		}
		styleID := xmlAttr(start, "styleId")
		if styleID == "" {
			if err := skipXML(decoder, start.Name); err != nil {
				return nil, err
			}
			continue
		}
		style := docxStyle{}
		if err := readStyleElement(decoder, start, &style); err != nil {
			return nil, err
		}
		if style.level > 0 || style.basedOn != "" {
			styles[styleID] = style
		}
	}
}

// resolveStyleLevels propagates heading levels down w:basedOn chains so a
// custom style derived from Heading 2 without its own outlineLvl still renders
// as a level-2 heading. Cache every visited node, including non-headings: a
// node visited in the current walk denotes a cycle, while completed walks reuse
// their result. Each edge is followed at most once, without recursive calls.
func resolveStyleLevels(styles map[string]docxStyle) map[string]docxStyle {
	resolved := make(map[string]docxStyle, len(styles))
	path := make([]string, 0)
	for id := range styles {
		current := id
		level := 0
		path = path[:0]
		for {
			if result, seen := resolved[current]; seen {
				level = result.level
				break
			}
			style, ok := styles[current]
			if !ok {
				break
			}
			resolved[current] = docxStyle{}
			path = append(path, current)
			if style.level > 0 {
				level = style.level
				break
			}
			if style.basedOn == "" {
				break
			}
			current = style.basedOn
		}
		for _, visited := range path {
			resolved[visited] = docxStyle{level: level}
		}
	}
	return resolved
}

func readStyleElement(decoder *docxDecoder, start xml.StartElement, style *docxStyle) error {
	styleID := xmlAttr(start, "styleId")
	levelFromID := headingLevel(styleID)
	for {
		token, err := decoder.Token()
		if err != nil {
			return fmt.Errorf("parse docx style %s: %w: %w", styleID, ErrCorruptFile, err)
		}
		switch value := token.(type) {
		case xml.StartElement:
			switch value.Name.Local {
			case "outlineLvl":
				if raw := xmlAttr(value, "val"); raw != "" {
					if parsed, parseErr := strconv.Atoi(raw); parseErr == nil && parsed >= 0 && parsed < 6 {
						style.level = parsed + 1
					}
				}
			case "name":
				if level := headingLevel(xmlAttr(value, "val")); level > 0 && style.level == 0 {
					style.level = level
				}
			case "basedOn":
				style.basedOn = xmlAttr(value, "val")
			default:
				// Keep walking nested style properties: outlineLvl normally lives
				// under w:pPr, not directly under w:style.
			}
		case xml.EndElement:
			if value.Name.Local == start.Name.Local {
				if style.level == 0 {
					style.level = levelFromID
				}
				return nil
			}
		}
	}
}

func parseDOCXNumbering(file *zip.File) (docxNumbering, error) {
	reader, err := openZipPart(file)
	if err != nil {
		return docxNumbering{}, err
	}
	defer reader.Close()

	result := docxNumbering{
		nums:      map[string]string{},
		formats:   map[string]map[string]string{},
		overrides: map[string]map[string]string{},
	}
	decoder := newDOCXDecoder(reader)
	var abstractID string
	var numID string
	var currentLevel string
	for {
		token, err := decoder.Token()
		if errors.Is(err, io.EOF) {
			return result, nil
		}
		if err != nil {
			return result, fmt.Errorf("parse docx numbering: %w: %w", ErrCorruptFile, err)
		}
		switch value := token.(type) {
		case xml.StartElement:
			switch value.Name.Local {
			case "abstractNum":
				abstractID = xmlAttr(value, "abstractNumId")
			case "num":
				numID = xmlAttr(value, "numId")
			case "lvl":
				currentLevel = xmlAttr(value, "ilvl")
			case "lvlOverride":
				currentLevel = xmlAttr(value, "ilvl")
			case "abstractNumId":
				if numID != "" {
					result.nums[numID] = xmlAttr(value, "val")
				}
			case "numFmt":
				if abstractID != "" && currentLevel != "" {
					if result.formats[abstractID] == nil {
						result.formats[abstractID] = map[string]string{}
					}
					result.formats[abstractID][currentLevel] = xmlAttr(value, "val")
				} else if numID != "" && currentLevel != "" {
					if result.overrides[numID] == nil {
						result.overrides[numID] = map[string]string{}
					}
					result.overrides[numID][currentLevel] = xmlAttr(value, "val")
				}
			default:
				// The numbering part is optional and unsupported numbering details do
				// not affect text extraction, so only skip elements that can contain
				// nested content when they are known to be irrelevant.
			}
		case xml.EndElement:
			switch value.Name.Local {
			case "abstractNum":
				abstractID, currentLevel = "", ""
			case "num":
				numID = ""
			case "lvl":
				currentLevel = ""
			case "lvlOverride":
				currentLevel = ""
			}
		}
	}
}

func parseDOCXDocument(file *zip.File) ([]docxBlock, error) {
	reader, err := openZipPart(file)
	if err != nil {
		return nil, err
	}
	defer reader.Close()

	decoder := newDOCXDecoder(reader)
	blocks := make([]docxBlock, 0)
	foundBody := false
	for {
		token, err := decoder.Token()
		if errors.Is(err, io.EOF) {
			if foundBody {
				return blocks, nil
			}
			return nil, fmt.Errorf("docx missing body: %w", ErrCorruptFile)
		}
		if err != nil {
			return nil, fmt.Errorf("parse docx document: %w: %w", ErrCorruptFile, err)
		}
		start, ok := token.(xml.StartElement)
		if !ok || start.Name.Local != "body" || foundBody {
			continue
		}
		bodyBlocks, err := parseDOCXBody(decoder, start)
		if err != nil {
			return nil, err
		}
		blocks = bodyBlocks
		foundBody = true
	}
}

func parseDOCXBody(decoder *docxDecoder, start xml.StartElement) ([]docxBlock, error) {
	blocks := make([]docxBlock, 0)
	for {
		token, err := decoder.Token()
		if err != nil {
			return nil, fmt.Errorf("parse docx body: %w: %w", ErrCorruptFile, err)
		}
		switch value := token.(type) {
		case xml.StartElement:
			switch value.Name.Local {
			case "p":
				paragraph, parseErr := parseDOCXParagraph(decoder, value)
				if parseErr != nil {
					return nil, parseErr
				}
				blocks = append(blocks, docxBlock{paragraph: &paragraph})
			case "tbl":
				table, parseErr := parseDOCXTable(decoder, value)
				if parseErr != nil {
					return nil, parseErr
				}
				blocks = append(blocks, docxBlock{table: &table})
			case "sdt", "sdtContent", "customXml", "ins", "moveTo":
				// Block-level content controls (cover pages, tables of contents,
				// form fields) and custom XML wrappers hold ordinary paragraphs
				// and tables; descend rather than drop their text.
				nested, parseErr := parseDOCXBody(decoder, value)
				if parseErr != nil {
					return nil, parseErr
				}
				blocks = append(blocks, nested...)
			case "sdtPr", "sdtEndPr", "del", "moveFrom":
				if err := skipXML(decoder, value.Name); err != nil {
					return nil, err
				}
			default:
				if err := skipXML(decoder, value.Name); err != nil {
					return nil, err
				}
			}
		case xml.EndElement:
			if value.Name.Local == start.Name.Local {
				return blocks, nil
			}
		}
	}
}

// docxInlineContainers are elements whose children are runs or further inline
// containers. Text inside them belongs to the enclosing paragraph.
var docxInlineContainers = map[string]bool{
	"r": true, "hyperlink": true, "ins": true, "moveTo": true, "smartTag": true,
	"sdt": true, "sdtContent": true, "fldSimple": true, "customXml": true, "dir": true, "bdo": true,
}

func parseDOCXParagraph(decoder *docxDecoder, start xml.StartElement) (docxParagraph, error) {
	paragraph := docxParagraph{}
	var text strings.Builder
	for {
		token, err := decoder.Token()
		if err != nil {
			return paragraph, fmt.Errorf("parse docx paragraph: %w: %w", ErrCorruptFile, err)
		}
		switch value := token.(type) {
		case xml.StartElement:
			switch {
			case value.Name.Local == "pPr":
				if err := parseDOCXParagraphProperties(decoder, value, &paragraph); err != nil {
					return paragraph, err
				}
			case docxInlineContainers[value.Name.Local]:
				if err := appendDOCXInline(decoder, value, &text); err != nil {
					return paragraph, err
				}
			default:
				// Deleted revisions, drawings, math and anything unknown are
				// skipped as a subtree.
				if err := skipXML(decoder, value.Name); err != nil {
					return paragraph, err
				}
			}
		case xml.EndElement:
			if value.Name.Local == start.Name.Local {
				paragraph.text = strings.TrimSpace(text.String())
				return paragraph, nil
			}
		}
	}
}

func parseDOCXParagraphProperties(decoder *docxDecoder, start xml.StartElement, paragraph *docxParagraph) error {
	for {
		token, err := decoder.Token()
		if err != nil {
			return fmt.Errorf("parse docx paragraph properties: %w: %w", ErrCorruptFile, err)
		}
		switch value := token.(type) {
		case xml.StartElement:
			switch value.Name.Local {
			case "pStyle":
				paragraph.styleID = xmlAttr(value, "val")
			case "numPr":
				if err := parseDOCXNumberingProperties(decoder, value, paragraph); err != nil {
					return err
				}
			case "outlineLvl":
				if parsed, parseErr := strconv.Atoi(xmlAttr(value, "val")); parseErr == nil && parsed >= 0 && parsed < 6 {
					paragraph.outlineLevel = parsed + 1
				}
				if err := skipXML(decoder, value.Name); err != nil {
					return err
				}
			default:
				if err := skipXML(decoder, value.Name); err != nil {
					return err
				}
			}
		case xml.EndElement:
			if value.Name.Local == start.Name.Local {
				return nil
			}
		}
	}
}

func parseDOCXNumberingProperties(decoder *docxDecoder, start xml.StartElement, paragraph *docxParagraph) error {
	for {
		token, err := decoder.Token()
		if err != nil {
			return fmt.Errorf("parse docx numbering properties: %w: %w", ErrCorruptFile, err)
		}
		switch value := token.(type) {
		case xml.StartElement:
			switch value.Name.Local {
			case "ilvl":
				level, parseErr := strconv.Atoi(xmlAttr(value, "val"))
				if parseErr != nil || level < 0 || level > 8 {
					return docxLimitError()
				}
				paragraph.level = level
			case "numId":
				paragraph.numID = xmlAttr(value, "val")
			default:
				if err := skipXML(decoder, value.Name); err != nil {
					return err
				}
			}
		case xml.EndElement:
			if value.Name.Local == start.Name.Local {
				return nil
			}
		}
	}
}

func appendDOCXInline(decoder *docxDecoder, start xml.StartElement, text *strings.Builder) error {
	for {
		token, err := decoder.Token()
		if err != nil {
			return fmt.Errorf("parse docx run: %w: %w", ErrCorruptFile, err)
		}
		switch value := token.(type) {
		case xml.StartElement:
			switch {
			case docxInlineContainers[value.Name.Local]:
				if err := appendDOCXInline(decoder, value, text); err != nil {
					return err
				}
			case value.Name.Local == "t" || value.Name.Local == "instrText":
				content, decodeErr := readElementText(decoder, value)
				if decodeErr != nil {
					return decodeErr
				}
				if value.Name.Local == "t" {
					text.WriteString(content)
				}
			case value.Name.Local == "tab":
				text.WriteByte('\t')
				if err := skipXML(decoder, value.Name); err != nil {
					return err
				}
			case value.Name.Local == "br" || value.Name.Local == "cr":
				text.WriteByte('\n')
				if err := skipXML(decoder, value.Name); err != nil {
					return err
				}
			case value.Name.Local == "sym":
				// Symbol runs carry a font-specific code point; keep a placeholder
				// so adjacent words do not fuse.
				text.WriteByte(' ')
				if err := skipXML(decoder, value.Name); err != nil {
					return err
				}
			default:
				// sdtPr, rPr, del, moveFrom, drawing, object, pict, oMath, footnote
				// references and unknown elements contribute no body text.
				if err := skipXML(decoder, value.Name); err != nil {
					return err
				}
			}
		case xml.EndElement:
			if value.Name.Local == start.Name.Local {
				return nil
			}
		}
	}
}

func readElementText(decoder *docxDecoder, start xml.StartElement) (string, error) {
	var text strings.Builder
	for {
		token, err := decoder.Token()
		if err != nil {
			return "", fmt.Errorf("read docx text: %w: %w", ErrCorruptFile, err)
		}
		switch value := token.(type) {
		case xml.CharData:
			text.Write([]byte(value))
		case xml.EndElement:
			if value.Name.Local == start.Name.Local {
				return text.String(), nil
			}
		}
	}
}

func parseDOCXTable(decoder *docxDecoder, start xml.StartElement) (docxTable, error) {
	table := docxTable{}
	for {
		token, err := decoder.Token()
		if err != nil {
			return table, fmt.Errorf("parse docx table: %w: %w", ErrCorruptFile, err)
		}
		switch value := token.(type) {
		case xml.StartElement:
			if value.Name.Local == "tr" {
				row, parseErr := parseDOCXTableRow(decoder, value)
				if parseErr != nil {
					return table, parseErr
				}
				table.rows = append(table.rows, row)
			} else if err := skipXML(decoder, value.Name); err != nil {
				return table, err
			}
		case xml.EndElement:
			if value.Name.Local == start.Name.Local {
				return table, nil
			}
		}
	}
}

func parseDOCXTableRow(decoder *docxDecoder, start xml.StartElement) ([]docxCell, error) {
	row := make([]docxCell, 0)
	for {
		token, err := decoder.Token()
		if err != nil {
			return nil, fmt.Errorf("parse docx table row: %w: %w", ErrCorruptFile, err)
		}
		switch value := token.(type) {
		case xml.StartElement:
			if value.Name.Local == "tc" {
				cell, parseErr := parseDOCXTableCell(decoder, value)
				if parseErr != nil {
					return nil, parseErr
				}
				row = append(row, cell)
			} else if err := skipXML(decoder, value.Name); err != nil {
				return nil, err
			}
		case xml.EndElement:
			if value.Name.Local == start.Name.Local {
				return row, nil
			}
		}
	}
}

func parseDOCXTableCell(decoder *docxDecoder, start xml.StartElement) (docxCell, error) {
	cell := docxCell{gridSpan: 1}
	var paragraphs []string
	for {
		token, err := decoder.Token()
		if err != nil {
			return cell, fmt.Errorf("parse docx table cell: %w: %w", ErrCorruptFile, err)
		}
		switch value := token.(type) {
		case xml.StartElement:
			switch value.Name.Local {
			case "tcPr":
				if err := parseDOCXCellProperties(decoder, value, &cell); err != nil {
					return cell, err
				}
			case "p":
				paragraph, parseErr := parseDOCXParagraph(decoder, value)
				if parseErr != nil {
					return cell, parseErr
				}
				if paragraph.text != "" {
					paragraphs = append(paragraphs, paragraph.text)
				}
			case "tbl":
				// A nested table cannot be represented inside a GFM cell, so its
				// cell text is flattened into the enclosing cell.
				nested, parseErr := parseDOCXTable(decoder, value)
				if parseErr != nil {
					return cell, parseErr
				}
				for _, row := range nested.rows {
					for _, nestedCell := range row {
						if nestedCell.text != "" {
							paragraphs = append(paragraphs, nestedCell.text)
						}
					}
				}
			case "sdt", "sdtContent", "customXml", "ins", "moveTo":
				// Content controls inside a cell hold ordinary paragraphs.
				nested, parseErr := parseDOCXBody(decoder, value)
				if parseErr != nil {
					return cell, parseErr
				}
				for _, block := range nested {
					if block.paragraph != nil && block.paragraph.text != "" {
						paragraphs = append(paragraphs, block.paragraph.text)
					}
					if block.table != nil {
						for _, row := range block.table.rows {
							for _, nestedCell := range row {
								if nestedCell.text != "" {
									paragraphs = append(paragraphs, nestedCell.text)
								}
							}
						}
					}
				}
			default:
				if err := skipXML(decoder, value.Name); err != nil {
					return cell, err
				}
			}
		case xml.EndElement:
			if value.Name.Local == start.Name.Local {
				cell.text = strings.Join(paragraphs, " ")
				return cell, nil
			}
		}
	}
}

func parseDOCXCellProperties(decoder *docxDecoder, start xml.StartElement, cell *docxCell) error {
	for {
		token, err := decoder.Token()
		if err != nil {
			return fmt.Errorf("parse docx cell properties: %w: %w", ErrCorruptFile, err)
		}
		switch value := token.(type) {
		case xml.StartElement:
			switch value.Name.Local {
			case "gridSpan":
				span, parseErr := strconv.Atoi(xmlAttr(value, "val"))
				if parseErr != nil || span < 1 || span > MaxTableColumns {
					return docxLimitError()
				}
				cell.gridSpan = span
				if err := skipXML(decoder, value.Name); err != nil {
					return err
				}
			case "vMerge":
				// Word omits w:val on continuation cells; the attribute is only
				// written as "restart" on the top cell of the merge.
				if mode := xmlAttr(value, "val"); mode == "restart" {
					cell.vMerge = "restart"
				} else {
					cell.vMerge = "continue"
				}
				if err := skipXML(decoder, value.Name); err != nil {
					return err
				}
			default:
				if err := skipXML(decoder, value.Name); err != nil {
					return err
				}
			}
		case xml.EndElement:
			if value.Name.Local == start.Name.Local {
				return nil
			}
		}
	}
}

func renderDOCXBlocks(blocks []docxBlock, styles map[string]docxStyle, numbering docxNumbering) (string, error) {
	var out strings.Builder
	previousList := false
	for _, block := range blocks {
		var prefix, text string
		list := false
		if block.paragraph != nil {
			paragraph := block.paragraph
			if strings.TrimSpace(paragraph.text) == "" {
				continue
			}
			level := paragraph.outlineLevel
			if level == 0 {
				if style, ok := styles[paragraph.styleID]; ok {
					level = style.level
				}
			}
			// A heading with list numbering ("1. Overview" styled Heading 1) is
			// still a heading: the numbering is presentation, the style is
			// structure.
			if level > 0 && level <= 6 {
				prefix = strings.Repeat("#", level) + " "
			} else if paragraph.numID != "" && paragraph.numID != "0" {
				// numId 0 means numbering removed. List depth was validated on input.
				marker := "1."
				if format := numbering.format(paragraph.numID, paragraph.level); format == "bullet" || format == "picture" {
					marker = "-"
				}
				prefix = strings.Repeat("  ", paragraph.level) + marker + " "
				list = true
			}
			text = paragraph.text
		} else if block.table != nil {
			var err error
			text, err = renderDOCXTable(block.table)
			if err != nil {
				return "", err
			}
		}
		if text == "" {
			continue
		}
		separator := ""
		if out.Len() > 0 {
			separator = "\n\n"
			if list && previousList {
				separator = "\n"
			}
		}
		if err := writeDOCXText(&out, separator, prefix, text); err != nil {
			return "", err
		}
		previousList = list
	}
	return strings.TrimSpace(out.String()), nil
}

func (n docxNumbering) format(numID string, level int) string {
	if levels := n.overrides[numID]; levels != nil {
		if value := levels[strconv.Itoa(level)]; value != "" {
			return value
		}
	}
	abstractID := n.nums[numID]
	levels := n.formats[abstractID]
	if levels == nil {
		return "decimal"
	}
	if value := levels[strconv.Itoa(level)]; value != "" {
		return value
	}
	return levels["0"]
}

func renderDOCXTable(table *docxTable) (string, error) {
	if table == nil || len(table.rows) == 0 {
		return "", nil
	}
	// Measure before expanding spans or padding ragged rows to a rectangle.
	width := 0
	for _, sourceRow := range table.rows {
		columns := 0
		for _, cell := range sourceRow {
			columns += cell.gridSpan
			if columns > MaxTableColumns {
				return "", docxLimitError()
			}
		}
		if columns > width {
			width = columns
		}
	}
	if width == 0 {
		return "", nil
	}
	if len(table.rows) > docxMaxTableCells/width {
		return "", docxLimitError()
	}
	var out strings.Builder
	row := make([]string, width)
	for index, sourceRow := range table.rows {
		clear(row)
		column := 0
		for _, cell := range sourceRow {
			// A vertically merged region keeps only its top-left value.
			if cell.vMerge != "continue" {
				row[column] = escapeDOCXTableCell(cell.text)
			}
			column += cell.gridSpan
		}
		separator := ""
		if index > 0 {
			separator = "\n"
		}
		if err := writeDOCXText(&out, separator, markdownTableRow(row)); err != nil {
			return "", err
		}
		if index == 0 {
			for i := range row {
				row[i] = "---"
			}
			if err := writeDOCXText(&out, "\n", markdownTableRow(row)); err != nil {
				return "", err
			}
		}
	}
	return out.String(), nil
}

func markdownTableRow(cells []string) string {
	return "| " + strings.Join(cells, " | ") + " |"
}

func escapeDOCXTableCell(value string) string {
	value = strings.ReplaceAll(value, "|", "\\|")
	return strings.Join(strings.Fields(value), " ")
}

func headingLevel(value string) int {
	normalized := strings.ToLower(strings.TrimSpace(value))
	for index := 1; index <= 6; index++ {
		if normalized == fmt.Sprintf("heading%d", index) || normalized == fmt.Sprintf("heading %d", index) {
			return index
		}
	}
	return 0
}

func xmlAttr(element xml.StartElement, local string) string {
	for _, attr := range element.Attr {
		if attr.Name.Local == local {
			return attr.Value
		}
	}
	return ""
}

func skipXML(decoder *docxDecoder, name xml.Name) error {
	depth := 1
	for depth > 0 {
		token, err := decoder.Token()
		if err != nil {
			return fmt.Errorf("parse docx XML: %w: %w", ErrCorruptFile, err)
		}
		switch token.(type) {
		case xml.StartElement:
			depth++
		case xml.EndElement:
			depth--
		}
	}
	return nil
}
