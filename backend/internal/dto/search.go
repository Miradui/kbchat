package dto

type SearchRequest struct {
	Query          string   `json:"query" binding:"required"`
	VectorTopN     int      `json:"vectorTopN"`
	RerankTopK     int      `json:"rerankTopK"`
	EnableRerank   *bool    `json:"enableRerank"`
	EnableKeyword  *bool    `json:"enableKeyword"`
	ScoreThreshold *float64 `json:"scoreThreshold"`
	Debug          bool     `json:"debug"`
}

type SearchResponse struct {
	Items          []SearchResultResponse  `json:"items"`
	RerankFallback *RerankFallbackResponse `json:"rerankFallback"`
	Debug          *SearchDebugResponse    `json:"debug,omitempty"`
}

type RerankFallbackResponse struct {
	Used   bool   `json:"used"`
	Reason string `json:"reason"`
}

type SearchResultResponse struct {
	KnowledgeBaseID   string  `json:"knowledgeBaseId"`
	KnowledgeBaseName string  `json:"knowledgeBaseName"`
	ChunkID           string  `json:"chunkId"`
	DocumentID        string  `json:"documentId"`
	Filename          string  `json:"filename"`
	Content           string  `json:"content"`
	PageNumber        *int    `json:"pageNumber"`
	VectorScore       float64 `json:"vectorScore"`
	// KeywordScore is null when the keyword stage did not return the chunk
	// (or was disabled); VectorScore is 0 for a chunk only the keyword stage found.
	KeywordScore *float64 `json:"keywordScore"`
	RerankScore  *float64 `json:"rerankScore"`
	// StartOffset and EndOffset locate the chunk's own source text (without the
	// heading prefix or overlap) as UTF-8 byte offsets in the normalized
	// segment: BOM removed, CRLF and CR turned into LF. PDF offsets are within
	// the page. Null when the chunk carries no usable offsets.
	StartOffset *int `json:"startOffset"`
	EndOffset   *int `json:"endOffset"`
}

type SearchDebugResponse struct {
	Query          string                  `json:"query"`
	RewrittenQuery string                  `json:"rewrittenQuery,omitempty"`
	VectorStage    SearchDebugVectorStage  `json:"vectorStage"`
	KeywordStage   SearchDebugKeywordStage `json:"keywordStage"`
	FusionStage    SearchDebugFusionStage  `json:"fusionStage"`
	RerankStage    SearchDebugRerankStage  `json:"rerankStage"`
	FinalStage     SearchDebugFinalStage   `json:"finalStage"`
	RerankFallback *RerankFallbackResponse `json:"rerankFallback"`
}

// SearchDebugKeywordStage is the raw lexeme recall. Status is "completed",
// "disabled" or "failed"; a disabled or failed stage has no items. A failed
// stage means the query fell back to vector recall alone.
type SearchDebugKeywordStage struct {
	Status string                   `json:"status"`
	Items  []SearchDebugKeywordItem `json:"items"`
}

type SearchDebugKeywordItem struct {
	ChunkID      string  `json:"chunkId"`
	DocumentID   string  `json:"documentId"`
	Filename     string  `json:"filename"`
	PageNumber   *int    `json:"pageNumber"`
	Content      string  `json:"content"`
	KeywordScore float64 `json:"keywordScore"`
	Rank         int     `json:"rank"`
}

// SearchDebugFusionStage is the reciprocal-rank fusion of the vector and
// keyword stages, truncated to vectorTopN; this is what Rerank receives. Status
// is "completed" when both stages ran and "skipped" when keyword recall was
// disabled, in which case Items is the vector stage unchanged.
type SearchDebugFusionStage struct {
	Status string                  `json:"status"`
	Items  []SearchDebugFusionItem `json:"items"`
}

type SearchDebugFusionItem struct {
	ChunkID      string   `json:"chunkId"`
	PageNumber   *int     `json:"pageNumber"`
	VectorRank   *int     `json:"vectorRank"`
	KeywordRank  *int     `json:"keywordRank"`
	FusionScore  float64  `json:"fusionScore"`
	VectorScore  float64  `json:"vectorScore"`
	KeywordScore *float64 `json:"keywordScore"`
	Rank         int      `json:"rank"`
}

type SearchDebugVectorStage struct {
	Status string                  `json:"status"`
	Items  []SearchDebugVectorItem `json:"items"`
	// ExactFallback is true when the approximate index scan came back short and
	// the stage was rerun exhaustively; the items are the exact result.
	ExactFallback bool `json:"exactFallback,omitempty"`
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
	ChunkID    string `json:"chunkId"`
	PageNumber *int   `json:"pageNumber"`
	Rank       int    `json:"rank"`
}

type SearchDebugRerankOutput struct {
	ChunkID     string   `json:"chunkId"`
	PageNumber  *int     `json:"pageNumber"`
	RerankScore *float64 `json:"rerankScore"`
	Rank        int      `json:"rank"`
}

type SearchDebugFinalStage struct {
	Items []SearchDebugFinalItem `json:"items"`
}

type SearchDebugFinalItem struct {
	ChunkID      string   `json:"chunkId"`
	PageNumber   *int     `json:"pageNumber"`
	VectorScore  float64  `json:"vectorScore"`
	KeywordScore *float64 `json:"keywordScore"`
	FusionScore  *float64 `json:"fusionScore"`
	RerankScore  *float64 `json:"rerankScore"`
	Rank         int      `json:"rank"`
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
	Type              string            `json:"type"`
	ID                string            `json:"id"`
	KnowledgeBaseID   string            `json:"knowledgeBaseId"`
	KnowledgeBaseName string            `json:"knowledgeBaseName"`
	DocumentID        string            `json:"documentId,omitempty"`
	Filename          string            `json:"filename,omitempty"`
	Title             string            `json:"title"`
	Snippet           string            `json:"snippet"`
	Highlights        []SearchHighlight `json:"highlights"`
}

// SearchHighlight marks one match inside a result field.
//
// Start and End are **UTF-16 code unit** offsets, i.e. plain JavaScript string
// indices, so the frontend can slice with them directly. They are not UTF-8 byte
// offsets and not rune indices — with CJK text those three disagree, and picking
// the wrong one misaligns silently.
type SearchHighlight struct {
	Field string `json:"field"`
	Start int    `json:"start"`
	End   int    `json:"end"`
}

type SearchSuggestRequest struct {
	Query string `form:"q"`
	Limit int    `form:"limit"`
}

// SearchSuggestItem is title-level only: no chunk content is searched and no
// snippet is built, which is what makes suggest cheaper than a full search.
type SearchSuggestItem struct {
	Type              string `json:"type"`
	ID                string `json:"id"`
	KnowledgeBaseID   string `json:"knowledgeBaseId"`
	KnowledgeBaseName string `json:"knowledgeBaseName"`
	DocumentID        string `json:"documentId,omitempty"`
	Title             string `json:"title"`
}

type SearchSuggestResponse struct {
	Items []SearchSuggestItem `json:"items"`
}
