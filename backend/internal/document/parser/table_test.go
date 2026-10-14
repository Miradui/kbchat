package parser

import (
	"archive/zip"
	"bytes"
	"errors"
	"github.com/xuri/excelize/v2"
	"io"
	"strings"
	"testing"
)

func TestCSVKeepsHeadersSparseValuesAndPhysicalRows(t *testing.T) {
	input := "\ufeff名称,名称,,说明\n\n甲,乙,丙,\"包含,逗号\n第二行\"\n尾,值\n"
	doc, err := NewDefaultParser().ParseBytes([]byte(input), "csv")
	if err != nil {
		t.Fatal(err)
	}
	if len(doc.Segments) != 2 {
		t.Fatalf("rows: %+v", doc.Segments)
	}
	row := doc.Segments[0].Table
	if row.RowStart != 3 || row.RowEnd != 4 || row.HeaderRow != 1 || row.Headers[0] != "名称 [列 1]" || row.Headers[2] != "列 3" || row.Values[3] != "包含,逗号\n第二行" {
		t.Fatalf("row: %+v", row)
	}
	if doc.Segments[1].Table.RowStart != 5 || !strings.Contains(doc.Segments[1].Content, "名称 [列 2]：值") {
		t.Fatalf("ragged row: %+v", doc.Segments[1])
	}
	_, err = NewDefaultParser().ParseBytes([]byte{0xff}, "csv")
	if !errors.Is(err, ErrEncodingInvalid) {
		t.Fatal(err)
	}
	_, err = NewDefaultParser().ParseBytes([]byte("a,b\n\"broken"), "csv")
	if !errors.Is(err, ErrCorruptFile) {
		t.Fatal(err)
	}
}
func TestXLSXWorksheetsSparseCellsAndCachedFormulaOnly(t *testing.T) {
	book := excelize.NewFile()
	defer book.Close()
	book.SetSheetName("Sheet1", "销售")
	book.SetCellValue("销售", "A2", "产品")
	book.SetCellValue("销售", "C2", "金额")
	book.SetCellValue("销售", "A5", "设备")
	book.SetCellFormula("销售", "C5", "1+2")
	book.SetCellFormula("销售", "C6", "999+999")
	book.NewSheet("库存")
	book.SetCellValue("库存", "A1", "名称")
	book.SetCellValue("库存", "B1", "数量")
	book.SetCellValue("库存", "A3", "备件")
	book.SetCellValue("库存", "B3", 7)
	buf, err := book.WriteToBuffer()
	if err != nil {
		t.Fatal(err)
	}
	// Excelize deliberately does not calculate/cache formula values on save.
	data := rewriteXLSXPart(t, buf.Bytes(), "xl/worksheets/sheet1.xml", func(xml string) string { return strings.Replace(xml, `<f>1+2</f>`, `<f>1+2</f><v>3</v>`, 1) })
	doc, err := NewDefaultParser().ParseBytes(data, "xlsx")
	if err != nil {
		t.Fatal(err)
	}
	if len(doc.Segments) != 2 {
		t.Fatalf("cached/empty cells: %+v", doc.Segments)
	}
	first := doc.Segments[0]
	if first.Table.SheetName != "销售" || first.Table.RowStart != 5 || first.Table.HeaderRow != 2 || !strings.Contains(first.Content, "金额：3") {
		t.Fatalf("first: %+v", first)
	}
	if doc.Segments[1].Table.SheetName != "库存" || doc.Segments[1].Table.RowStart != 3 {
		t.Fatalf("second: %+v", doc.Segments[1])
	}
	for _, s := range doc.Segments {
		if strings.Contains(s.Content, "1998") || strings.Contains(s.Content, "999+999") {
			t.Fatal("executed/exposed formula")
		}
	}
	broken := rewriteXLSXPart(t, data, "xl/worksheets/sheet1.xml", func(xml string) string { return xml[:len(xml)/2] })
	_, err = NewDefaultParser().ParseBytes(broken, "xlsx")
	if !errors.Is(err, ErrCorruptFile) {
		t.Fatalf("truncated XML: %v", err)
	}
}
func rewriteXLSXPart(t *testing.T, data []byte, name string, change func(string) string) []byte {
	t.Helper()
	reader, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	writer := zip.NewWriter(&out)
	for _, entry := range reader.File {
		r, err := entry.Open()
		if err != nil {
			t.Fatal(err)
		}
		b, err := io.ReadAll(r)
		r.Close()
		if err != nil {
			t.Fatal(err)
		}
		if entry.Name == name {
			b = []byte(change(string(b)))
		}
		w, err := writer.Create(entry.Name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = w.Write(b); err != nil {
			t.Fatal(err)
		}
	}
	if err = writer.Close(); err != nil {
		t.Fatal(err)
	}
	return out.Bytes()
}
func TestTableLimitsDoNotPublishPartialRows(t *testing.T) {
	for _, input := range []string{strings.Repeat("h,", 256) + "extra\n1,2", "header\n" + strings.Repeat("x\n", MaxTableRows+1), "header\n" + strings.Repeat("字", 32768), "header\n" + strings.Repeat("\n", MaxTableSourceRow) + "value"} {
		doc, err := NewDefaultParser().ParseBytes([]byte(input), "csv")
		if !errors.Is(err, ErrTableLimit) || len(doc.Segments) != 0 {
			t.Fatalf("limit: %d %v", len(doc.Segments), err)
		}
	}
	doc, err := NewDefaultParser().ParseBytes([]byte("header\n\n"), "csv")
	if err != nil || len(doc.Segments) != 0 {
		t.Fatalf("empty table: %+v %v", doc, err)
	}
}
