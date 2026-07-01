package dto

type SearchRequest struct {
	Query        string `json:"query" binding:"required"`
	VectorTopN   int    `json:"vectorTopN"`
	RerankTopK   int    `json:"rerankTopK"`
	EnableRerank *bool  `json:"enableRerank"`
}

type SearchResponse struct {
	Items []SearchResultResponse `json:"items"`
}

type SearchResultResponse struct {
	ChunkID     string   `json:"chunkId"`
	DocumentID  string   `json:"documentId"`
	Filename    string   `json:"filename"`
	Content     string   `json:"content"`
	PageNumber  *int     `json:"pageNumber"`
	VectorScore float64  `json:"vectorScore"`
	RerankScore *float64 `json:"rerankScore"`
}

type GlobalSearchResponse struct {
	Items []GlobalSearchResultResponse `json:"items"`
}

type GlobalSearchResultResponse struct {
	Type              string `json:"type"`
	ID                string `json:"id"`
	KnowledgeBaseID   string `json:"knowledgeBaseId"`
	KnowledgeBaseName string `json:"knowledgeBaseName"`
	DocumentID        string `json:"documentId,omitempty"`
	Filename          string `json:"filename,omitempty"`
	Title             string `json:"title"`
	Snippet           string `json:"snippet"`
}
