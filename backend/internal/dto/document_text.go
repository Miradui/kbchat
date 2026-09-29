package dto

type TextDocumentRequest struct {
	Title          string `json:"title"`
	Content        string `json:"content"`
	Format         string `json:"format"`
	AllowDuplicate bool   `json:"allowDuplicate"`
}
