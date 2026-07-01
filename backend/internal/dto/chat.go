package dto

import "time"

type CreateChatSessionRequest struct {
	KnowledgeBaseID string `json:"knowledgeBaseId" binding:"required"`
	Title           string `json:"title"`
}

type UpdateChatSessionRequest struct {
	Title string `json:"title" binding:"required"`
}

type ChatSessionResponse struct {
	ID              string     `json:"id"`
	KnowledgeBaseID string     `json:"knowledgeBaseId"`
	Title           string     `json:"title"`
	CreatedAt       time.Time  `json:"createdAt"`
	UpdatedAt       time.Time  `json:"updatedAt"`
	ArchivedAt      *time.Time `json:"archivedAt,omitempty"`
}

type ChatSessionListResponse struct {
	Items []ChatSessionResponse `json:"items"`
}

type SendChatMessageRequest struct {
	Content string `json:"content" binding:"required"`
}

type CitationResponse struct {
	DocumentID  string   `json:"documentId"`
	ChunkID     string   `json:"chunkId"`
	Filename    string   `json:"filename"`
	PageNumber  *int     `json:"pageNumber"`
	Content     string   `json:"content"`
	VectorScore float64  `json:"vectorScore"`
	RerankScore *float64 `json:"rerankScore"`
}

type ChatMessageResponse struct {
	ID        string             `json:"id"`
	SessionID string             `json:"sessionId"`
	Role      string             `json:"role"`
	Content   string             `json:"content"`
	Citations []CitationResponse `json:"citations"`
	CreatedAt time.Time          `json:"createdAt"`
}

type ChatMessageListResponse struct {
	Items []ChatMessageResponse `json:"items"`
}

type SendChatMessageResponse struct {
	Answer    string             `json:"answer"`
	Citations []CitationResponse `json:"citations"`
}
