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

// EditChatMessageRequest replaces a user turn and regenerates the assistant
// answer. The client request id makes retries safe when the response is lost.
type EditChatMessageRequest struct {
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

type ChatQualityOverviewQuery struct {
	Period          string
	KnowledgeBaseID *uuid.UUID
}

type ChatQualityOverviewResponse struct {
	Period                string    `json:"period"`
	StartAt               time.Time `json:"startAt"`
	EndAt                 time.Time `json:"endAt"`
	AnswerCount           int64     `json:"answerCount"`
	FeedbackCount         int64     `json:"feedbackCount"`
	PositiveFeedbackCount int64     `json:"positiveFeedbackCount"`
	NegativeFeedbackCount int64     `json:"negativeFeedbackCount"`
	WithoutCitationsCount int64     `json:"withoutCitationsCount"`
	FeedbackCoverage      float64   `json:"feedbackCoverage"`
	PositiveRate          float64   `json:"positiveRate"`
}

type ChatQualityFeedbackQuery struct {
	Period          string
	KnowledgeBaseID *uuid.UUID
	HasCitations    *bool
	Page            int
	PageSize        int
}

type ChatQualityFeedbackItemResponse struct {
	MessageID         string                  `json:"messageId"`
	SessionID         string                  `json:"sessionId"`
	SessionTitle      string                  `json:"sessionTitle"`
	KnowledgeBaseID   string                  `json:"knowledgeBaseId"`
	KnowledgeBaseName string                  `json:"knowledgeBaseName"`
	Question          string                  `json:"question"`
	Answer            string                  `json:"answer"`
	Citations         []CitationResponse      `json:"citations"`
	RerankFallback    *RerankFallbackResponse `json:"rerankFallback"`
	CreatedAt         time.Time               `json:"createdAt"`
	FeedbackUpdatedAt time.Time               `json:"feedbackUpdatedAt"`
}

type ChatQualityFeedbackListResponse struct {
	Items    []ChatQualityFeedbackItemResponse `json:"items"`
	Total    int64                             `json:"total"`
	Page     int                               `json:"page"`
	PageSize int                               `json:"pageSize"`
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
