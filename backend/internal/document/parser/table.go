package parser

import (
	"archive/zip"
	"bytes"
	"encoding/csv"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"strings"
	"unicode/utf8"

	"github.com/xuri/excelize/v2"
)

const (
	MaxTableInputBytes = 50 * 1024 * 1024
	MaxTableTextBytes  = 8 * 1024 * 1024
	MaxTableRows       = 10000
	MaxTableColumns    = 256
	MaxTableSheets     = 32
	MaxTableSourceRow  = 100000
)

var ErrTableLimit = errors.New("table exceeds parsing limits")

type TableRow struct {
	SheetName string
	RowStart  int
	RowEnd    int
	HeaderRow int
	Headers   []string
	Values    []string
}

func (r *TableRow) Prefix() string {
	label := "CSV"
	if r.SheetName != "" {
		label = "工作表「" + r.SheetName + "」"
	}
	row := fmt.Sprint(r.RowStart)
	if r.RowEnd > r.RowStart {
		row += fmt.Sprintf("–%d", r.RowEnd)
	}
	return fmt.Sprintf("%s · 第 %s 行（表头第 %d 行）", label, row, r.HeaderRow)
}
func (r *TableRow) Text() string {
	parts := []string{r.Prefix()}
	for i, value := range r.Values {
		if strings.TrimSpace(value) != "" {
			parts = append(parts, r.Headers[i]+"："+value)
		}
	}
	return strings.Join(parts, "\n")
}

type tableCollector struct {
	document ParsedDocument
	bytes    int
	rows     int
}

func (c *tableCollector) add(sheet string, start, end, headerRow int, headers, values []string) error {
	if len(values) > MaxTableColumns || len(headers) > MaxTableColumns {
		return ErrTableLimit
	}
	nonempty := false
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			nonempty = true
		}
		if utf8.RuneCountInString(value) > 32767 {
			return ErrTableLimit
		}
	}
	if !nonempty {
		return nil
	}
	if c.rows++; c.rows > MaxTableRows {
		return ErrTableLimit
	}
	labels := make([]string, len(values))
	counts := map[string]int{}
	for _, header := range headers {
		counts[normalizeCell(header)]++
	}
	for i := range values {
		label := ""
		if i < len(headers) {
			label = normalizeCell(headers[i])
		}
		if utf8.RuneCountInString(label) > 200 {
			return ErrTableLimit
		}
		if label == "" {
			label = fmt.Sprintf("列 %d", i+1)
		} else if counts[label] > 1 {
			label += fmt.Sprintf(" [列 %d]", i+1)
		}
		labels[i] = strings.ReplaceAll(label, "\n", " ")
		values[i] = normalizeCell(values[i])
	}
	row := &TableRow{SheetName: sheet, RowStart: start, RowEnd: end, HeaderRow: headerRow, Headers: labels, Values: append([]string(nil), values...)}
	content := row.Text()
	c.bytes += len(content)
	if c.bytes > MaxTableTextBytes {
		return ErrTableLimit
	}
	c.document.Segments = append(c.document.Segments, Segment{Content: content, Table: row})
	return nil
}
func normalizeCell(value string) string {
	return strings.ReplaceAll(strings.ReplaceAll(value, "\r\n", "\n"), "\r", "\n")
}
func hasTableValues(values []string) bool {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return true
		}
	}
	return false
}

func parseTableBytes(content []byte, fileType string) (ParsedDocument, error) {
	if len(content) > MaxTableInputBytes {
		return ParsedDocument{}, ErrTableLimit
	}
	collector := &tableCollector{document: ParsedDocument{FileType: fileType, Segments: []Segment{}}}
	var err error
	if fileType == "csv" {
		err = collector.csv(content)
	} else {
		err = collector.xlsx(content)
	}
	if err != nil {
		return ParsedDocument{}, err
	}
	return collector.document, nil
}
func (c *tableCollector) csv(content []byte) error {
	if !utf8.Valid(content) {
		return ErrEncodingInvalid
	}
	// Count physical lines, including blanks and quoted multiline values. The
	// same bound applies to XLSX row numbers and keeps source labels usable.
	lines := bytes.Count(content, []byte{'\n'})
	if len(content) > 0 && content[len(content)-1] != '\n' {
		lines++
	}
	if lines > MaxTableSourceRow {
		return ErrTableLimit
	}
	reader := csv.NewReader(strings.NewReader(strings.TrimPrefix(string(content), "\ufeff")))
	reader.FieldsPerRecord = -1
	var headers []string
	headerRow := 0
	for {
		values, err := reader.Read()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return fmt.Errorf("csv record: %w: %v", ErrCorruptFile, err)
		}
		if len(values) > MaxTableColumns {
			return ErrTableLimit
		}
		if !hasTableValues(values) {
			continue
		}
		start, _ := reader.FieldPos(0)
		last, _ := reader.FieldPos(len(values) - 1)
		end := last + strings.Count(values[len(values)-1], "\n")
		if headerRow == 0 {
			headers = values
			headerRow = start
			continue
		}
		if err = c.add("", start, end, headerRow, headers, values); err != nil {
			return err
		}
	}
}
func (c *tableCollector) xlsx(content []byte) error {
	archive, err := zip.NewReader(bytes.NewReader(content), int64(len(content)))
	if err != nil {
		return fmt.Errorf("xlsx package: %w", ErrCorruptFile)
	}
	if len(archive.File) > 2000 {
		return ErrTableLimit
	}
	var expanded uint64
	names := map[string]bool{}
	for _, entry := range archive.File {
		name := strings.ToLower(strings.ReplaceAll(entry.Name, `\`, "/"))
		if names[name] || strings.HasPrefix(name, "/") || strings.Contains(name, "../") || strings.Contains(name, ":") || entry.Flags&1 != 0 || strings.HasSuffix(name, "vbaproject.bin") {
			return fmt.Errorf("unsafe or unsupported xlsx package: %w", ErrCorruptFile)
		}
		names[name] = true
		if entry.UncompressedSize64 > 32*1024*1024 {
			return ErrTableLimit
		}
		expanded += entry.UncompressedSize64
		if expanded > 128*1024*1024 {
			return ErrTableLimit
		}
		if strings.HasSuffix(name, ".xml") || strings.HasSuffix(name, ".rels") {
			if err := validateTableXML(entry); err != nil {
				return err
			}
		}
	}
	if !names["xl/workbook.xml"] {
		return fmt.Errorf("missing workbook: %w", ErrCorruptFile)
	}
	book, err := excelize.OpenReader(bytes.NewReader(content), excelize.Options{UnzipSizeLimit: 128 * 1024 * 1024, UnzipXMLSizeLimit: 16 * 1024 * 1024})
	if err != nil {
		return fmt.Errorf("open xlsx: %w: %v", ErrCorruptFile, err)
	}
	defer book.Close()
	sheets := book.GetSheetList()
	if len(sheets) > MaxTableSheets {
		return ErrTableLimit
	}
	for _, sheet := range sheets {
		if utf8.RuneCountInString(sheet) > 100 {
			return ErrTableLimit
		}
		if err = c.sheet(book, sheet); err != nil {
			return err
		}
	}
	return nil
}

// Do not let the worksheet iterator silently accept truncated XML and publish a
// partial sheet. XML entities cannot open files or perform network requests.
func validateTableXML(entry *zip.File) error {
	r, err := entry.Open()
	if err != nil {
		return fmt.Errorf("xlsx XML: %w", ErrCorruptFile)
	}
	defer r.Close()
	decoder := xml.NewDecoder(io.LimitReader(r, 32*1024*1024+1))
	depth, tokens := 0, 0
	for {
		token, err := decoder.Token()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return fmt.Errorf("xlsx XML: %w: %v", ErrCorruptFile, err)
		}
		tokens++
		if tokens > 2000000 {
			return ErrTableLimit
		}
		switch token.(type) {
		case xml.StartElement:
			depth++
			if depth > 128 {
				return ErrTableLimit
			}
		case xml.EndElement:
			depth--
		}
	}
}
func (c *tableCollector) sheet(book *excelize.File, sheet string) error {
	rows, err := book.Rows(sheet)
	if err != nil {
		return fmt.Errorf("xlsx sheet: %w: %v", ErrCorruptFile, err)
	}
	defer rows.Close()
	var headers []string
	headerRow := 0
	rowNumber := 0
	for rows.Next() {
		rowNumber++
		if rowNumber > MaxTableSourceRow {
			return ErrTableLimit
		}
		// Reading only: excelize formats saved values, never calls CalcCellValue.
		values, err := rows.Columns()
		if err != nil {
			return fmt.Errorf("xlsx row: %w: %v", ErrCorruptFile, err)
		}
		if len(values) > MaxTableColumns {
			return ErrTableLimit
		}
		if !hasTableValues(values) {
			continue
		}
		if headerRow == 0 {
			headers = values
			headerRow = rowNumber
			continue
		}
		if err = c.add(sheet, rowNumber, rowNumber, headerRow, headers, values); err != nil {
			return err
		}
	}
	if err = rows.Error(); err != nil {
		return fmt.Errorf("xlsx rows: %w: %v", ErrCorruptFile, err)
	}
	return nil
}
