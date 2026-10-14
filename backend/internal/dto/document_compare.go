package dto

import "time"

type DocumentVersion struct {
	ID             string    `json:"id"`
	Filename       string    `json:"filename"`
	Status         string    `json:"status"`
	CreatedAt      time.Time `json:"createdAt"`
	SupersededByID *string   `json:"supersededById"`
}
type DocumentVersionsResponse struct {
	Items []DocumentVersion `json:"items"`
}
type DocumentDiffLine struct {
	Kind     string `json:"kind"`
	Content  string `json:"content"`
	BaseLine *int   `json:"baseLine"`
	HeadLine *int   `json:"headLine"`
}
type DocumentCompareResponse struct {
	Base         DocumentVersion    `json:"base"`
	Head         DocumentVersion    `json:"head"`
	AddedLines   int                `json:"addedLines"`
	RemovedLines int                `json:"removedLines"`
	Lines        []DocumentDiffLine `json:"lines"`
}
