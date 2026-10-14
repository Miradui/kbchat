package parser

import (
	"context"
	"fmt"
	"os"
	"unicode/utf8"

	"kbchat/backend/internal/document/tableconfig"
)

type ParseOptions struct {
	TableImport   *tableconfig.Options
	OnPDFProgress func(*PDFTextSummary) error
}

// Optional extension keeps simple parser fixtures compatible while refusing to
// silently ignore a document's persisted import configuration.
func ParseWithOptions(ctx context.Context, p Parser, path, fileType string, options ParseOptions) (ParsedDocument, error) {
	if configurable, ok := p.(interface {
		ParseDocumentWithOptions(context.Context, string, string, ParseOptions) (ParsedDocument, error)
	}); ok {
		return configurable.ParseDocumentWithOptions(ctx, path, fileType, options)
	}
	if options.TableImport != nil {
		return ParsedDocument{}, tableconfig.ErrInvalid
	}
	return p.ParseDocument(path, fileType)
}

func (p *DefaultParser) ParseDocumentWithOptions(ctx context.Context, path, fileType string, options ParseOptions) (ParsedDocument, error) {
	if err := ctx.Err(); err != nil {
		return ParsedDocument{}, err
	}
	fileType = normalizeFileType(fileType)
	if fileType != "xlsx" && fileType != "csv" {
		if options.TableImport != nil {
			return ParsedDocument{}, tableconfig.ErrInvalid
		}
		if fileType == "pdf" {
			return p.parsePDF(ctx, path, options.OnPDFProgress)
		}
		return p.ParseDocument(path, fileType)
	}
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
	return p.ParseBytesWithOptions(ctx, content, fileType, options)
}

func (p *DefaultParser) ParseBytesWithOptions(ctx context.Context, content []byte, fileType string, options ParseOptions) (ParsedDocument, error) {
	fileType = normalizeFileType(fileType)
	if fileType != "csv" && fileType != "xlsx" {
		if options.TableImport != nil {
			return ParsedDocument{}, tableconfig.ErrInvalid
		}
		return p.ParseBytes(content, fileType)
	}
	settings, err := tableconfig.Normalize(fileType, options.TableImport)
	if err != nil {
		return ParsedDocument{}, err
	}
	c := &tableCollector{ctx: ctx, options: settings, document: ParsedDocument{FileType: fileType, Segments: []Segment{}}}
	if err := c.read(content, fileType); err != nil {
		return ParsedDocument{}, err
	}
	return c.document, nil
}

type TableInspection struct {
	Sheets []TableSheetInspection `json:"sheets"`
}
type TableSheetInspection struct {
	Name               string           `json:"name"`
	SuggestedHeaderRow int              `json:"suggestedHeaderRow"`
	ColumnCount        int              `json:"columnCount"`
	LastRow            int              `json:"lastRow"`
	Rows               []TableSampleRow `json:"rows"`
	Truncated          bool             `json:"truncated"`
	bytes              int
}
type TableSampleRow struct {
	RowStart int      `json:"rowStart"`
	RowEnd   int      `json:"rowEnd"`
	Values   []string `json:"values"`
}

// Inspection never writes objects, documents, tasks or model requests. Samples
// are bounded independently from the full input so a wide sheet stays usable.
func InspectTable(ctx context.Context, content []byte, fileType string) (*TableInspection, error) {
	if fileType != "xlsx" && fileType != "csv" {
		return nil, tableconfig.ErrInvalid
	}
	inspection := &TableInspection{Sheets: []TableSheetInspection{}}
	c := &tableCollector{ctx: ctx, inspection: inspection}
	if err := c.read(content, fileType); err != nil {
		return nil, err
	}
	return inspection, nil
}

func (c *tableCollector) selection(sheet string) (*tableconfig.Sheet, bool) {
	if c.options == nil {
		return nil, true
	}
	for i := range c.options.Sheets {
		if c.options.Sheets[i].Name == sheet {
			return &c.options.Sheets[i], true
		}
	}
	return nil, false
}

type tableSheetReader struct {
	collector  *tableCollector
	name       string
	options    *tableconfig.Sheet
	headers    []string
	headerRow  int
	maxColumns int
	sample     *TableSheetInspection
}

func (c *tableCollector) startSheet(name string) *tableSheetReader {
	options, _ := c.selection(name)
	s := &tableSheetReader{collector: c, name: name, options: options}
	if c.inspection != nil {
		s.sample = &TableSheetInspection{Name: name, Rows: []TableSampleRow{}}
	}
	return s
}

func (s *tableSheetReader) consume(start, end int, values []string) error {
	if s.collector.ctx != nil {
		if err := s.collector.ctx.Err(); err != nil {
			return err
		}
	}
	if len(values) > MaxTableColumns || end > MaxTableSourceRow {
		return ErrTableLimit
	}
	for _, v := range values {
		if utf8.RuneCountInString(v) > 32767 {
			return ErrTableLimit
		}
	}
	if s.sample != nil {
		s.sample.LastRow = end
		s.sample.ColumnCount = max(s.sample.ColumnCount, len(values))
		if hasTableValues(values) {
			if s.sample.SuggestedHeaderRow == 0 {
				s.sample.SuggestedHeaderRow = start
			}
			if len(s.sample.Rows) < 20 && s.sample.bytes < 64*1024 {
				cells := make([]string, len(values))
				for i, value := range values {
					runes := []rune(value)
					if len(runes) > 80 {
						cells[i] = string(runes[:80]) + "…"
						s.sample.Truncated = true
					} else {
						cells[i] = value
					}
					if s.sample.bytes+len(cells[i]) > 64*1024 {
						cells[i] = "…"
						s.sample.Truncated = true
					}
					s.sample.bytes += len(cells[i])
				}
				s.sample.Rows = append(s.sample.Rows, TableSampleRow{RowStart: start, RowEnd: end, Values: cells})
			} else {
				s.sample.Truncated = true
			}
		}
		return nil
	}
	requestedHeader := 0
	if s.options != nil {
		requestedHeader = s.options.HeaderRow
	}
	if s.headerRow == 0 {
		if requestedHeader > 0 {
			if start < requestedHeader && end >= requestedHeader {
				return fmt.Errorf("表头须指向完整记录的首行: %w", tableconfig.ErrInvalid)
			}
			if start < requestedHeader {
				return nil
			}
			if start != requestedHeader || !hasTableValues(values) {
				return fmt.Errorf("指定表头行为空或不存在: %w", tableconfig.ErrInvalid)
			}
		} else if !hasTableValues(values) {
			return nil
		}
		s.headerRow, s.headers = start, append([]string(nil), values...)
		s.maxColumns = len(values)
		return nil
	}
	s.maxColumns = max(s.maxColumns, len(values))
	return s.collector.add(s.name, start, end, s.headerRow, s.headers, values)
}

func (s *tableSheetReader) finish() error {
	if s.sample != nil {
		s.collector.inspection.Sheets = append(s.collector.inspection.Sheets, *s.sample)
		return nil
	}
	if s.options != nil {
		if s.options.HeaderRow > 0 && s.headerRow == 0 {
			return fmt.Errorf("指定表头行不存在: %w", tableconfig.ErrInvalid)
		}
		for _, column := range s.options.Columns {
			if column > s.maxColumns {
				return fmt.Errorf("所选列不存在: %w", tableconfig.ErrInvalid)
			}
		}
	}
	return nil
}
