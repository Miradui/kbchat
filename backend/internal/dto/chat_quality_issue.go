package dto

import "time"

type ChatQualityIssueRequest struct {
	Question         string   `json:"question"`
	Status           string   `json:"status"`
	Note             string   `json:"note"`
	EvaluationCaseID string   `json:"evaluationCaseId"`
	EvaluationRunID  string   `json:"evaluationRunId"`
	DocumentIDs      []string `json:"documentIds"`
}
type ChatQualityIssueResponse struct {
	ChatQualityIssueRequest
	UpdatedAt *time.Time `json:"updatedAt"`
}
