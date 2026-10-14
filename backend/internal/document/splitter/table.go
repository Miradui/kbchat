package splitter

import (
	"kbchat/backend/internal/document/parser"
	"strings"
)

// Keep each row's provenance and column label on every fragment. Rows and
// worksheets never share a chunk, including when a single cell needs splitting.
func (s *Splitter) splitTableRow(fileType string, row *parser.TableRow) []Chunk {
	prefix := row.Prefix() + "\n"
	chunks := []Chunk{}
	parts := []string{}
	flush := func() {
		if len(parts) == 0 {
			return
		}
		content := prefix + strings.Join(parts, "\n")
		chunks = append(chunks, Chunk{Content: content, TokenCount: estimateTokens(content), Metadata: map[string]any{
			"fileType": fileType, "structureType": "table_row", "table": map[string]any{"sheetName": row.SheetName, "rowStart": row.RowStart, "rowEnd": row.RowEnd, "headerRow": row.HeaderRow},
		}})
		parts = nil
	}
	for i, value := range row.Values {
		if strings.TrimSpace(value) == "" {
			continue
		}
		label := row.Headers[i] + "："
		budget := max(8, s.chunkSize-estimateTokens(prefix+label)-2)
		for _, span := range splitTextToBudgetSpans(value, budget) {
			part := label + value[span.start:span.end]
			if len(parts) > 0 && estimateTokens(prefix+strings.Join(parts, "\n")+"\n"+part) > s.chunkSize {
				flush()
			}
			parts = append(parts, part)
		}
	}
	flush()
	return chunks
}
