package dto

type TableSource struct {
	SheetName string `json:"sheetName"`
	RowStart  int    `json:"rowStart"`
	RowEnd    int    `json:"rowEnd"`
	HeaderRow int    `json:"headerRow"`
}
type TablePreviewRow struct {
	TableSource
	StartOffset int `json:"startOffset"`
	EndOffset   int `json:"endOffset"`
}
