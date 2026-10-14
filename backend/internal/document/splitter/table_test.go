package splitter

import (
	"kbchat/backend/internal/document/parser"
	"strings"
	"testing"
)

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
