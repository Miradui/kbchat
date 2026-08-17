package dto

import (
	"time"

	"github.com/google/uuid"
)

type CreateChatSessionRequest struct {
	KnowledgeBaseID string `json:"knowledgeBaseId" binding:"required"`
	Title           string `json:"title"`
}

type UpdateChatSessionRequest struct {
	Title string `json:"title" binding:"required"`
}

// ChatSessionListQuery drives GET /api/v1/chat/sessions. Archived defaults to
// false so the rail keeps showing active sessions when no filter is sent.
type ChatSessionListQuery struct {
	KnowledgeBaseID *uuid.UUID
	Archived        bool
	Q               string
	Page            int
	PageSize        int
}

type ChatSessionResponse struct {
	ID              string     `json:"id"`
	KnowledgeBaseID string     `json:"knowledgeBaseId"`
	Title           string     `json:"title"`
	CreatedAt       time.Time  `json:"createdAt"`
	UpdatedAt       time.Time  `json:"updatedAt"`
	ArchivedAt      *time.Time `json:"archivedAt"`
	// The three fields below are only populated by the session list endpoint.
	// Single-session responses (create/get/update/archive/unarchive) omit them
	// because they do not join the knowledge base or aggregate messages.
	KnowledgeBaseName  string `json:"knowledgeBaseName,omitempty"`
	MessageCount       *int64 `json:"messageCount,omitempty"`
	LastMessagePreview string `json:"lastMessagePreview,omitempty"`
}

type ChatSessionListResponse struct {
	Items    []ChatSessionResponse `json:"items"`
	Total    int64                 `json:"total"`
	Page     int                   `json:"page"`
	PageSize int                   `json:"pageSize"`
}

type SendChatMessageRequest struct {
	Content         string `json:"content" binding:"required"`
	ClientRequestID string `json:"clientRequestId" binding:"required,uuid"`
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
	ID              string                       `json:"id"`
	SessionID       string                       `json:"sessionId"`
	ClientRequestID *string                      `json:"clientRequestId"`
	Role            string                       `json:"role"`
	Content         string                       `json:"content"`
	Citations       []CitationResponse           `json:"citations"`
	Feedback        *ChatMessageFeedbackResponse `json:"feedback"`
	CreatedAt       time.Time                    `json:"createdAt"`
}

type SetChatMessageFeedbackRequest struct {
	Rating string `json:"rating" binding:"required"`
}

type ChatMessageFeedbackResponse struct {
	MessageID string    `json:"messageId"`
	Rating    string    `json:"rating"`
	UpdatedAt time.Time `json:"updatedAt"`
}

type ChatMessageListResponse struct {
	Items []ChatMessageResponse `json:"items"`
}

type SendChatMessageResponse struct {
	ClientRequestID  string                  `json:"clientRequestId"`
	UserMessage      ChatMessageResponse     `json:"userMessage"`
	AssistantMessage ChatMessageResponse     `json:"assistantMessage"`
	Answer           string                  `json:"answer"`
	Citations        []CitationResponse      `json:"citations"`
	RerankFallback   *RerankFallbackResponse `json:"rerankFallback"`
}

type RegenerateChatMessageResponse struct {
	Message        ChatMessageResponse     `json:"message"`
	RerankFallback *RerankFallbackResponse `json:"rerankFallback"`
}
