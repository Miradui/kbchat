package dto

// HomeSummaryResponse is the workspace landing page in one request.
//
// Each list is capped server side (see service.HomeSummaryItemLimit) and paired
// with the unfiltered total, so the page can show "5 of 42" without a second
// call and without guessing a pageSize.
type HomeSummaryResponse struct {
	Period string                     `json:"period"`
	Stats  KnowledgeBaseStatsResponse `json:"stats"`

	KnowledgeBases     []KnowledgeBaseResponse `json:"knowledgeBases"`
	KnowledgeBaseTotal int64                   `json:"knowledgeBaseTotal"`

	Documents               []GlobalDocumentResponse `json:"documents"`
	DocumentTotal           int64                    `json:"documentTotal"`
	ProcessingDocumentTotal int64                    `json:"processingDocumentTotal"`

	FailedDocuments     []GlobalDocumentResponse `json:"failedDocuments"`
	FailedDocumentTotal int64                    `json:"failedDocumentTotal"`

	Sessions     []ChatSessionResponse `json:"sessions"`
	SessionTotal int64                 `json:"sessionTotal"`
}
