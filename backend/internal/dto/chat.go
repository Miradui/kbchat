package dto

import (
	"time"

	"github.com/google/uuid"
)

type CreateChatSessionRequest struct {
	DocumentIDs      []string `json:"documentIds"`
	ScopeMode        string   `json:"scopeMode"`
	KnowledgeBaseID  string   `json:"knowledgeBaseId"`
	KnowledgeBaseIDs []string `json:"knowledgeBaseIds"`
	Title            string   `json:"title"`
}

type UpdateChatSessionRequest struct {
	Title string `json:"title" binding:"required"`
}

type ChatUsageQuery struct {
	KnowledgeBaseID *uuid.UUID
	From            time.Time
	To              time.Time
	GroupBy         string
}

type ChatUsageAggregate struct {
	GroupKey string `json:"groupKey"`
	// GroupLabel is the display name behind the key for knowledgeBase and user
	// grouping; empty otherwise.
	GroupLabel       string `json:"groupLabel"`
	PromptTokens     int64  `json:"promptTokens"`
	CompletionTokens int64  `json:"completionTokens"`
	TotalTokens      int64  `json:"totalTokens"`
	Calls            int64  `json:"calls"`
	// EstimatedCost is only set when MODEL_PRICING covers the model; for other
	// groupings it is set when every model in the group is priced.
	EstimatedCost *float64 `json:"estimatedCost"`
}

type ChatUsageResponse struct {
	From            time.Time            `json:"from"`
	To              time.Time            `json:"to"`
	GroupBy         string               `json:"groupBy"`
	Items           []ChatUsageAggregate `json:"items"`
	TotalPrompt     int64                `json:"totalPromptTokens"`
	TotalCompletion int64                `json:"totalCompletionTokens"`
	TotalTokens     int64                `json:"totalTokens"`
	// PricingConfigured tells the client whether cost columns are meaningful.
	PricingConfigured bool `json:"pricingConfigured"`
	// EstimatedCost is the priced total over every model with a configured
	// price; unpriced models are listed in UnpricedModels.
	EstimatedCost  *float64 `json:"estimatedCost"`
	UnpricedModels []string `json:"unpricedModels"`
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
	Documents           []ChatDocumentResponse      `json:"documents,omitempty"`
	BranchFromSessionID *string                     `json:"branchFromSessionId,omitempty"`
	BranchFromMessageID *string                     `json:"branchFromMessageId,omitempty"`
	ScopeMode           string                      `json:"scopeMode"`
	KnowledgeBaseIDs    []string                    `json:"knowledgeBaseIds"`
	KnowledgeBases      []ChatKnowledgeBaseResponse `json:"knowledgeBases"`
	ID                  string                      `json:"id"`
	KnowledgeBaseID     string                      `json:"knowledgeBaseId"`
	Title               string                      `json:"title"`
	CreatedAt           time.Time                   `json:"createdAt"`
	UpdatedAt           time.Time                   `json:"updatedAt"`
	ArchivedAt          *time.Time                  `json:"archivedAt"`
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
	TextSource        string       `json:"textSource,omitempty"`
	Table             *TableSource `json:"table,omitempty"`
	KnowledgeBaseID   string       `json:"knowledgeBaseId,omitempty"`
	KnowledgeBaseName string       `json:"knowledgeBaseName,omitempty"`
	DocumentID        string       `json:"documentId"`
	ChunkID           string       `json:"chunkId"`
	Filename          string       `json:"filename"`
	PageNumber        *int         `json:"pageNumber"`
	Content           string       `json:"content"`
	VectorScore       float64      `json:"vectorScore"`
	RerankScore       *float64     `json:"rerankScore"`
	// StartOffset and EndOffset carry the retrieval offsets (see
	// SearchResultResponse). Citations stored before they existed have neither.
	StartOffset *int `json:"startOffset,omitempty"`
	EndOffset   *int `json:"endOffset,omitempty"`
}

type ChatMessageResponse struct {
	Bookmark        *ChatBookmarkResponse        `json:"bookmark,omitempty"`
	ID              string                       `json:"id"`
	SessionID       string                       `json:"sessionId"`
	ClientRequestID *string                      `json:"clientRequestId"`
	Role            string                       `json:"role"`
	Content         string                       `json:"content"`
	Citations       []CitationResponse           `json:"citations"`
	Feedback        *ChatMessageFeedbackResponse `json:"feedback"`
	CreatedAt       time.Time                    `json:"createdAt"`
	// AnswerStatus distinguishes an answer from the three ways a question can go
	// unanswered: no_basis, retrieval_failed, model_refused. Null on user messages
	// and on assistant messages written before this was tracked -- the client must
	// treat null as "unknown" rather than as answered, or it will silently relabel
	// history.
	AnswerStatus *string `json:"answerStatus"`
}

type SetChatMessageFeedbackRequest struct {
	Rating string `json:"rating" binding:"required"`
	ChatFeedbackDetails
}

type ChatFeedbackDetails struct {
	Reason  string `json:"reason"`
	Comment string `json:"comment"`
}

type ChatMessageFeedbackResponse struct {
	ChatFeedbackDetails
	MessageID string    `json:"messageId"`
	Rating    string    `json:"rating"`
	UpdatedAt time.Time `json:"updatedAt"`
}

type ChatQualityOverviewQuery struct {
	Scope           string
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
	// KnowledgeAnswerCount is the denominator for WithoutCitationsCount, which
	// counts only knowledge-intent answers: a conversation answer has no sources
	// by design and is not a knowledge gap.
	KnowledgeAnswerCount  int64 `json:"knowledgeAnswerCount"`
	WithoutCitationsCount int64 `json:"withoutCitationsCount"`
	// UnclassifiedAnswerCount is answers stored before intent was tracked. They
	// are excluded from every intent-scoped number above and reported separately
	// so a client can disclose the blind spot instead of presenting a rate that
	// quietly understates it.
	UnclassifiedAnswerCount int64   `json:"unclassifiedAnswerCount"`
	FeedbackCoverage        float64 `json:"feedbackCoverage"`
	PositiveRate            float64 `json:"positiveRate"`
	WithoutCitationsRate    float64 `json:"withoutCitationsRate"`
}

type ChatQualityFeedbackQuery struct {
	Scope           string
	Period          string
	KnowledgeBaseID *uuid.UUID
	HasCitations    *bool
	Page            int
	PageSize        int
}

type ChatQualityFeedbackItemResponse struct {
	ChatFeedbackDetails
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

type ChatKnowledgeGapQuery struct {
	Scope           string
	Period          string
	KnowledgeBaseID *uuid.UUID
	Category        string
	Page            int
	PageSize        int
}

type ChatKnowledgeGapItemResponse struct {
	Category string `json:"category"`
	// MessageID is null for a repeated_rewrite cluster, which spans several
	// answers. Present for no_citations, where one row is one answer.
	MessageID         *string   `json:"messageId"`
	SessionID         string    `json:"sessionId"`
	SessionTitle      string    `json:"sessionTitle"`
	KnowledgeBaseID   string    `json:"knowledgeBaseId"`
	KnowledgeBaseName string    `json:"knowledgeBaseName"`
	Question          string    `json:"question"`
	RetrievalQuery    string    `json:"retrievalQuery"`
	OccurrenceCount   int64     `json:"occurrenceCount"`
	UngroundedCount   int64     `json:"ungroundedCount"`
	FirstSeenAt       time.Time `json:"firstSeenAt"`
	LastSeenAt        time.Time `json:"lastSeenAt"`
}

type ChatKnowledgeGapListResponse struct {
	Items    []ChatKnowledgeGapItemResponse `json:"items"`
	Total    int64                          `json:"total"`
	Page     int                            `json:"page"`
	PageSize int                            `json:"pageSize"`
	// Per-category totals stay available regardless of the requested category so a
	// client can label the filter without a second round trip.
	NoCitationsTotal int64 `json:"noCitationsTotal"`
	// RetrievalFailedTotal and ModelRefusedTotal only count turns recorded after
	// migration 019 added answer_status. Older rows have no status and stay in
	// NoCitationsTotal, so a zero here means "not observed yet", not "never happened".
	RetrievalFailedTotal int64 `json:"retrievalFailedTotal"`
	ModelRefusedTotal    int64 `json:"modelRefusedTotal"`
	RepeatedRewriteTotal int64 `json:"repeatedRewriteTotal"`
}

type ChatMessageListResponse struct {
	Items       []ChatMessageResponse `json:"items"`
	HasMore     bool                  `json:"hasMore,omitempty"`
	NextCursor  string                `json:"nextCursor,omitempty"`
	HasNewer    bool                  `json:"hasNewer,omitempty"`
	NewerCursor string                `json:"newerCursor,omitempty"`
	Revision    string                `json:"revision,omitempty"`
}

type ChatMessagePageQuery struct {
	Limit                                  int
	Before, After, Around, Since, Revision string
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
