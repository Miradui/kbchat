package dto

import "time"

type EvaluationCaseRequest struct {
	Question         string   `json:"question"`
	ExpectedAnswer   string   `json:"expectedAnswer"`
	RequiredKeywords []string `json:"requiredKeywords"`
	RequireCitation  bool     `json:"requireCitation"`
}

type EvaluationCaseResponse struct {
	EvaluationCaseRequest
	ID              string    `json:"id"`
	KnowledgeBaseID string    `json:"knowledgeBaseId"`
	CreatedAt       time.Time `json:"createdAt"`
	UpdatedAt       time.Time `json:"updatedAt"`
}

type EvaluationRunRequest struct {
	ClientRequestID string          `json:"clientRequestId"`
	Name            string          `json:"name"`
	CaseIDs         []string        `json:"caseIds"`
	Config          RetrievalConfig `json:"config"`
}

type EvaluationResult struct {
	CaseID          string                  `json:"caseId"`
	Answer          string                  `json:"answer"`
	AnswerStatus    *string                 `json:"answerStatus"`
	Citations       []CitationResponse      `json:"citations"`
	RerankFallback  *RerankFallbackResponse `json:"rerankFallback"`
	DurationMS      int64                   `json:"durationMs"`
	RulePassed      *bool                   `json:"rulePassed"`
	MissingKeywords []string                `json:"missingKeywords"`
	ErrorCode       string                  `json:"errorCode"`
	ErrorMessage    string                  `json:"errorMessage"`
}

type EvaluationRuntime struct {
	// ChatModel is the model that actually answered: the knowledge base
	// override when one was configured, otherwise the global default.
	ChatModel       string `json:"chatModel"`
	EmbeddingModel  string `json:"embeddingModel"`
	RerankModel     string `json:"rerankModel"`
	EffectiveRerank bool   `json:"effectiveRerank"`
}

type EvaluationRunResponse struct {
	ID              string                   `json:"id"`
	KnowledgeBaseID string                   `json:"knowledgeBaseId"`
	ClientRequestID string                   `json:"clientRequestId"`
	Name            string                   `json:"name"`
	Status          string                   `json:"status"`
	Config          RetrievalConfig          `json:"config"`
	AnswerConfig    AnswerConfig             `json:"answerConfig"`
	Cases           []EvaluationCaseResponse `json:"cases,omitempty"`
	Results         []EvaluationResult       `json:"results,omitempty"`
	Runtime         EvaluationRuntime        `json:"runtime"`
	Total           int                      `json:"total"`
	CompletedCount  int                      `json:"completedCount"`
	ErrorMessage    string                   `json:"errorMessage"`
	CreatedAt       time.Time                `json:"createdAt"`
	StartedAt       *time.Time               `json:"startedAt"`
	FinishedAt      *time.Time               `json:"finishedAt"`
}
