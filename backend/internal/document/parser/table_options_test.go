package parser

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/xuri/excelize/v2"
	"kbchat/backend/internal/document/tableconfig"
)

func TestSelectedCSVColumnsKeepOriginalHeaderAndPhysicalRows(t *testing.T) {
	data := []byte("这是报表说明\n\n名称,私密列,名称,,描述\n甲,不应进入索引,乙,丙,\"一行\n二行\"\n")
	options := ParseOptions{TableImport: &tableconfig.Options{Sheets: []tableconfig.Sheet{{Name: "", HeaderRow: 3, Columns: []int{5, 4, 3}}}}}
	doc, err := NewDefaultParser().ParseBytesWithOptions(context.Background(), data, "csv", options)
	if err != nil || len(doc.Segments) != 1 {
		t.Fatalf("parse: %+v %v", doc, err)
	}
	row := doc.Segments[0].Table
	if row.HeaderRow != 3 || row.RowStart != 4 || row.RowEnd != 5 || !reflect.DeepEqual(row.Headers, []string{"名称 [列 3]", "列 4", "描述"}) {
		t.Fatalf("source or original columns changed: %+v", row)
	}
	for _, excluded := range []string{"报表说明", "不应进入索引", "甲"} {
		if strings.Contains(doc.Segments[0].Content, excluded) {
			t.Fatalf("excluded %q leaked", excluded)
		}
	}
	if !strings.Contains(doc.Segments[0].Content, "一行\n二行") {
		t.Fatal("multiline cell lost")
	}
}

func TestXLSXSelectionExcludesWorksheetsAndValidatesPhysicalHeader(t *testing.T) {
	book := excelize.NewFile()
	defer book.Close()
	book.SetCellValue("Sheet1", "A1", "忽略")
	book.SetCellValue("Sheet1", "A2", "不要入库")
	book.NewSheet("业务")
	book.SetCellValue("业务", "A1", "标题")
	book.SetCellValue("业务", "A3", "名称")
	book.SetCellValue("业务", "C3", "数量")
	book.SetCellValue("业务", "A7", "设备")
	book.SetCellValue("业务", "C7", 9)
	buffer, err := book.WriteToBuffer()
	if err != nil {
		t.Fatal(err)
	}
	parse := func(name string, header int, columns []int) (ParsedDocument, error) {
		return NewDefaultParser().ParseBytesWithOptions(context.Background(), buffer.Bytes(), "xlsx", ParseOptions{TableImport: &tableconfig.Options{Sheets: []tableconfig.Sheet{{Name: name, HeaderRow: header, Columns: columns}}}})
	}
	doc, err := parse("业务", 3, []int{3})
	if err != nil || len(doc.Segments) != 1 {
		t.Fatalf("selection: %+v %v", doc, err)
	}
	if doc.Segments[0].Table.RowStart != 7 || strings.Contains(doc.Segments[0].Content, "设备") || !strings.Contains(doc.Segments[0].Content, "数量：9") {
		t.Fatalf("wrong selection: %+v", doc.Segments)
	}
	for _, invalid := range []struct {
		name    string
		row     int
		columns []int
	}{{"missing", 0, nil}, {"业务", 2, nil}, {"业务", 99, nil}, {"业务", 3, []int{4}}, {"业务", 3, []int{}}, {"业务", 3, []int{1, 1}}} {
		_, err := parse(invalid.name, invalid.row, invalid.columns)
		if !errors.Is(err, tableconfig.ErrInvalid) {
			t.Fatalf("invalid settings accepted: %+v %v", invalid, err)
		}
	}
	preview, err := InspectTable(context.Background(), buffer.Bytes(), "xlsx")
	if err != nil || len(preview.Sheets) != 2 || preview.Sheets[1].LastRow != 7 || preview.Sheets[1].ColumnCount != 3 {
		t.Fatalf("inspection: %+v %v", preview, err)
	}
}

func TestCSVInspectionBoundsSamplesAndHonorsCancellation(t *testing.T) {
	data := []byte("名称,说明\n" + strings.Repeat("甲,"+strings.Repeat("中", 100)+"\n", 30))
	preview, err := InspectTable(context.Background(), data, "csv")
	if err != nil || len(preview.Sheets) != 1 || len(preview.Sheets[0].Rows) != 20 || !preview.Sheets[0].Truncated || preview.Sheets[0].LastRow != 31 {
		t.Fatalf("sample: %+v %v", preview, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := InspectTable(ctx, data, "csv"); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	_, err = NewDefaultParser().ParseBytesWithOptions(context.Background(), []byte("\"多行\n表头\",值\n甲,乙"), "csv", ParseOptions{TableImport: &tableconfig.Options{Sheets: []tableconfig.Sheet{{HeaderRow: 2}}}})
	if !errors.Is(err, tableconfig.ErrInvalid) {
		t.Fatalf("accepted middle of record as header: %v", err)
	}
}
