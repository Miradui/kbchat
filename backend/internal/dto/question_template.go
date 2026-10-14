package dto

import "time"

type SaveQuestionTemplateRequest struct {
	Title string `json:"title"`
	Body  string `json:"body"`
}
type QuestionTemplateResponse struct {
	ID        string    `json:"id"`
	Title     string    `json:"title"`
	Body      string    `json:"body"`
	Variables []string  `json:"variables"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}
type QuestionTemplateListResponse struct {
	Items    []QuestionTemplateResponse `json:"items"`
	Total    int64                      `json:"total"`
	Page     int                        `json:"page"`
	PageSize int                        `json:"pageSize"`
}
