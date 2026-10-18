package dto

type EvaluationScope struct {
	SourceSessionID  string                 `json:"sourceSessionId"`
	ScopeMode        string                 `json:"scopeMode"`
	KnowledgeBaseIDs []string               `json:"knowledgeBaseIds"`
	Documents        []ChatDocumentResponse `json:"documents,omitempty"`
}
