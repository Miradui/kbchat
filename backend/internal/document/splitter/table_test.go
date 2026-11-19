package splitter

import (
	"kbchat/backend/internal/document/parser"
	"strings"
	"testing"
)

// A Markdown table row wider than the body budget is split cell by cell. When a
// cell holds two inline code spans separated only by whitespace, the segment
// between them is whitespace-only; the span splitter returns no spans for it,
// and the cell splitter used to index spans[1:] on that empty slice and panic
// inside the document worker goroutine, taking the whole process down.
func TestMarkdownTableWideRowWithWhitespaceBetweenInlineCodeDoesNotPanic(t *testing.T) {
	row := "| 设备 | `a` `b` " + strings.Repeat("描述文字", 200) + " |"
	document := "| 名称 | 用法 |\n| --- | --- |\n" + row + "\n"

	chunks := New(60, 10).Split(document)

	if len(chunks) == 0 {
		t.Fatal("expected the wide row to produce chunks")
	}
	joined := ""
	for _, chunk := range chunks {
		joined += chunk.Content
	}
	for _, want := range []string{"`a`", "`b`", "描述文字"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("expected split chunks to keep %q, got %q", want, joined)
		}
	}
}

func TestTableChunksRepeatLabelsAndNeverLoseRowProvenance(t *testing.T) {
	parsed, err := parser.NewDefaultParser().ParseBytes([]byte("名称,说明\n设备,"+strings.Repeat("描述文字", 150)+"\n备件,下一行"), "csv")
	if err != nil {
		t.Fatal(err)
	}
	chunks := New(100, 10).SplitDocument(parsed)
	if len(chunks) < 4 {
		t.Fatalf("expected split long cell: %d", len(chunks))
	}
	for _, chunk := range chunks {
		source := chunk.Metadata["table"].(map[string]any)
		row := source["rowStart"].(int)
		if row == 2 {
			if !strings.Contains(chunk.Content, "说明：") && !strings.Contains(chunk.Content, "名称：") {
				t.Fatalf("lost labels: %+v", chunk)
			}
		} else if row != 3 {
			t.Fatalf("wrong row: %+v", source)
		}
		if _, ok := chunk.Metadata["startOffset"]; ok {
			t.Fatal("row chunk has misleading text offsets")
		}
		if strings.Contains(chunk.Content, "设备") && strings.Contains(chunk.Content, "备件") {
			t.Fatal("crossed rows")
		}
	}
}
