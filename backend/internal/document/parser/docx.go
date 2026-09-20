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
)

type docxStyle struct {
	level int
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
	level   int
	numID   string
	text    string
}

type docxCell struct {
	text     string
	gridSpan int
	vMerge   string
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
		styles = parsed
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
	content := renderDOCXBlocks(blocks, styles, numbering)
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
	reader, err := file.Open()
	if err != nil {
		return nil, fmt.Errorf("read docx part %s: %w: %w", file.Name, ErrCorruptFile, err)
	}
	return reader, nil
}

func parseDOCXStyles(file *zip.File) (map[string]docxStyle, error) {
	reader, err := openZipPart(file)
	if err != nil {
		return nil, err
	}
	defer reader.Close()

	styles := map[string]docxStyle{}
	decoder := xml.NewDecoder(reader)
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
		if style.level > 0 {
			styles[styleID] = style
		}
	}
}

func readStyleElement(decoder *xml.Decoder, start xml.StartElement, style *docxStyle) error {
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
	decoder := xml.NewDecoder(reader)
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

	decoder := xml.NewDecoder(reader)
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

func parseDOCXBody(decoder *xml.Decoder, start xml.StartElement) ([]docxBlock, error) {
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

func parseDOCXParagraph(decoder *xml.Decoder, start xml.StartElement) (docxParagraph, error) {
	paragraph := docxParagraph{}
	var text strings.Builder
	for {
		token, err := decoder.Token()
		if err != nil {
			return paragraph, fmt.Errorf("parse docx paragraph: %w: %w", ErrCorruptFile, err)
		}
		switch value := token.(type) {
		case xml.StartElement:
			switch value.Name.Local {
			case "pPr":
				if err := parseDOCXParagraphProperties(decoder, value, &paragraph); err != nil {
					return paragraph, err
				}
			case "r", "hyperlink", "ins", "moveTo", "smartTag":
				if err := appendDOCXInline(decoder, value, &text); err != nil {
					return paragraph, err
				}
			case "del", "moveFrom":
				if err := skipXML(decoder, value.Name); err != nil {
					return paragraph, err
				}
			default:
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

func parseDOCXParagraphProperties(decoder *xml.Decoder, start xml.StartElement, paragraph *docxParagraph) error {
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

func parseDOCXNumberingProperties(decoder *xml.Decoder, start xml.StartElement, paragraph *docxParagraph) error {
	for {
		token, err := decoder.Token()
		if err != nil {
			return fmt.Errorf("parse docx numbering properties: %w: %w", ErrCorruptFile, err)
		}
		switch value := token.(type) {
		case xml.StartElement:
			switch value.Name.Local {
			case "ilvl":
				paragraph.level, _ = strconv.Atoi(xmlAttr(value, "val"))
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

func appendDOCXInline(decoder *xml.Decoder, start xml.StartElement, text *strings.Builder) error {
	for {
		token, err := decoder.Token()
		if err != nil {
			return fmt.Errorf("parse docx run: %w: %w", ErrCorruptFile, err)
		}
		switch value := token.(type) {
		case xml.StartElement:
			switch value.Name.Local {
			case "r", "hyperlink", "ins", "moveTo", "smartTag":
				if err := appendDOCXInline(decoder, value, text); err != nil {
					return err
				}
			case "t", "instrText":
				content, decodeErr := readElementText(decoder, value)
				if decodeErr != nil {
					return decodeErr
				}
				if value.Name.Local == "t" {
					text.WriteString(content)
				}
			case "tab":
				text.WriteByte('\t')
				if err := skipXML(decoder, value.Name); err != nil {
					return err
				}
			case "br", "cr":
				text.WriteByte('\n')
				if err := skipXML(decoder, value.Name); err != nil {
					return err
				}
			case "del", "moveFrom", "drawing", "object", "pict", "oMath", "oMathPara":
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

func readElementText(decoder *xml.Decoder, start xml.StartElement) (string, error) {
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

func parseDOCXTable(decoder *xml.Decoder, start xml.StartElement) (docxTable, error) {
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

func parseDOCXTableRow(decoder *xml.Decoder, start xml.StartElement) ([]docxCell, error) {
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

func parseDOCXTableCell(decoder *xml.Decoder, start xml.StartElement) (docxCell, error) {
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

func parseDOCXCellProperties(decoder *xml.Decoder, start xml.StartElement, cell *docxCell) error {
	for {
		token, err := decoder.Token()
		if err != nil {
			return fmt.Errorf("parse docx cell properties: %w: %w", ErrCorruptFile, err)
		}
		switch value := token.(type) {
		case xml.StartElement:
			switch value.Name.Local {
			case "gridSpan":
				if parsed, parseErr := strconv.Atoi(xmlAttr(value, "val")); parseErr == nil && parsed > 0 {
					cell.gridSpan = parsed
				}
			case "vMerge":
				cell.vMerge = xmlAttr(value, "val")
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

func renderDOCXBlocks(blocks []docxBlock, styles map[string]docxStyle, numbering docxNumbering) string {
	parts := make([]string, 0, len(blocks))
	for _, block := range blocks {
		if block.paragraph != nil {
			paragraph := block.paragraph
			if strings.TrimSpace(paragraph.text) == "" {
				continue
			}
			if paragraph.numID != "" {
				marker := "1."
				if format := numbering.format(paragraph.numID, paragraph.level); format == "bullet" || format == "picture" {
					marker = "-"
				}
				parts = append(parts, strings.Repeat("  ", maxInt(paragraph.level, 0))+marker+" "+paragraph.text)
				continue
			}
			if style, ok := styles[paragraph.styleID]; ok && style.level > 0 && style.level <= 6 {
				parts = append(parts, strings.Repeat("#", style.level)+" "+paragraph.text)
			} else {
				parts = append(parts, paragraph.text)
			}
			continue
		}
		if block.table != nil {
			if table := renderDOCXTable(block.table); table != "" {
				parts = append(parts, table)
			}
		}
	}
	return strings.TrimSpace(strings.Join(parts, "\n\n"))
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

func renderDOCXTable(table *docxTable) string {
	if table == nil || len(table.rows) == 0 {
		return ""
	}
	width := 0
	rows := make([][]string, 0, len(table.rows))
	vertical := map[int]bool{}
	for _, sourceRow := range table.rows {
		row := make([]string, 0)
		column := 0
		for _, cell := range sourceRow {
			span := cell.gridSpan
			if span < 1 {
				span = 1
			}
			value := cell.text
			continuingVertical := vertical[column] && cell.vMerge != "restart"
			if continuingVertical || (cell.vMerge != "" && cell.vMerge != "restart") {
				value = ""
			}
			row = append(row, escapeDOCXTableCell(value))
			for offset := 1; offset < span; offset++ {
				row = append(row, "")
			}
			merged := continuingVertical || (cell.vMerge != "" && cell.vMerge != "restart")
			for offset := 0; offset < span; offset++ {
				vertical[column+offset] = merged
			}
			column += span
		}
		for len(row) < width {
			row = append(row, "")
		}
		if len(row) > width {
			width = len(row)
		}
		rows = append(rows, row)
	}
	if width == 0 {
		return ""
	}
	for index := range rows {
		for len(rows[index]) < width {
			rows[index] = append(rows[index], "")
		}
	}
	lines := make([]string, 0, len(rows)+1)
	lines = append(lines, markdownTableRow(rows[0]))
	header := make([]string, width)
	for index := range header {
		header[index] = "---"
	}
	lines = append(lines, markdownTableRow(header))
	for _, row := range rows[1:] {
		lines = append(lines, markdownTableRow(row))
	}
	return strings.Join(lines, "\n")
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

func skipXML(decoder *xml.Decoder, name xml.Name) error {
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

func maxInt(left, right int) int {
	if left > right {
		return left
	}
	return right
}
