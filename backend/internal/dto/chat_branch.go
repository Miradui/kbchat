package dto

type CreateChatBranchRequest struct {
	MessageID       string `json:"messageId" binding:"required"`
	ClientRequestID string `json:"clientRequestId" binding:"required"`
	Title           string `json:"title"`
}
