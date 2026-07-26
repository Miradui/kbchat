package dto

type SearchRequest struct {
	Query        string `json:"query" binding:"required"`
	VectorTopN   int    `json:"vectorTopN"`
	RerankTopK   int    `json:"rerankTopK"`
	EnableRerank *bool  `json:"enableRerank"`
	Debug        bool   `json:"debug"`
}

type SearchResponse struct {
	Items          []SearchResultResponse  `json:"items"`
	RerankFallback *RerankFallbackResponse `json:"rerankFallback,omitempty"`
	Debug          *SearchDebugResponse    `json:"debug,omitempty"`
}

type RerankFallbackResponse struct {
	Used   bool   `json:"used"`
	Reason string `json:"reason"`
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

type SearchDebugResponse struct {
	Query          string                  `json:"query"`
	RewrittenQuery string                  `json:"rewrittenQuery,omitempty"`
	VectorStage    SearchDebugVectorStage  `json:"vectorStage"`
	RerankStage    SearchDebugRerankStage  `json:"rerankStage"`
	FinalStage     SearchDebugFinalStage   `json:"finalStage"`
	RerankFallback *RerankFallbackResponse `json:"rerankFallback"`
}

type SearchDebugVectorStage struct {
	Status string                  `json:"status"`
	Items  []SearchDebugVectorItem `json:"items"`
}

type SearchDebugVectorItem struct {
	ChunkID     string  `json:"chunkId"`
	DocumentID  string  `json:"documentId"`
	Filename    string  `json:"filename"`
	PageNumber  *int    `json:"pageNumber"`
	Content     string  `json:"content"`
	VectorScore float64 `json:"vectorScore"`
	Rank        int     `json:"rank"`
}

type SearchDebugRerankStage struct {
	Status string                    `json:"status"`
	Input  []SearchDebugRerankInput  `json:"input"`
	Output []SearchDebugRerankOutput `json:"output"`
}

type SearchDebugRerankInput struct {
	ChunkID string `json:"chunkId"`
	Rank    int    `json:"rank"`
}

type SearchDebugRerankOutput struct {
	ChunkID     string   `json:"chunkId"`
	RerankScore *float64 `json:"rerankScore"`
	Rank        int      `json:"rank"`
}

type SearchDebugFinalStage struct {
	Items []SearchDebugFinalItem `json:"items"`
}

type SearchDebugFinalItem struct {
	ChunkID     string   `json:"chunkId"`
	VectorScore float64  `json:"vectorScore"`
	RerankScore *float64 `json:"rerankScore"`
	Rank        int      `json:"rank"`
}

type GlobalSearchResponse struct {
	Items    []GlobalSearchResultResponse `json:"items"`
	Total    int64                        `json:"total"`
	Page     int                          `json:"page"`
	PageSize int                          `json:"pageSize"`
}

type GlobalSearchRequest struct {
	Query    string `form:"q"`
	Type     string `form:"type"`
	Page     int    `form:"page"`
	PageSize int    `form:"pageSize"`
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
