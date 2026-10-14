package dto

import (
	"time"

	"github.com/google/uuid"
)

type ChatMessageSearchQuery struct {
	Q         string
	SessionID *uuid.UUID
	Page      int
	PageSize  int
}

// Excerpt is plain text split around the first literal match, never HTML.
type ChatSearchExcerpt struct {
	Before string `json:"before"`
	Match  string `json:"match"`
	After  string `json:"after"`
}

type ChatMessageSearchItem struct {
	MessageID    string            `json:"messageId"`
	SessionID    string            `json:"sessionId"`
	SessionTitle string            `json:"sessionTitle"`
	ArchivedAt   *time.Time        `json:"archivedAt"`
	Role         string            `json:"role"`
	CreatedAt    time.Time         `json:"createdAt"`
	Excerpt      ChatSearchExcerpt `json:"excerpt"`
}

type ChatMessageSearchResponse struct {
	Items    []ChatMessageSearchItem `json:"items"`
	Total    int64                   `json:"total"`
	Page     int                     `json:"page"`
	PageSize int                     `json:"pageSize"`
}
