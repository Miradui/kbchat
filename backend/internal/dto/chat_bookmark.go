package dto

import "time"

type PersonalListQuery struct {
	Q        string
	Page     int
	PageSize int
}
type SaveChatBookmarkRequest struct {
	Note string `json:"note"`
}
type ChatBookmarkResponse struct {
	MessageID string    `json:"messageId"`
	Note      string    `json:"note"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}
type ChatBookmarkItem struct {
	ChatMessageSearchItem
	Bookmark ChatBookmarkResponse `json:"bookmark"`
}
type ChatBookmarkListResponse struct {
	Items    []ChatBookmarkItem `json:"items"`
	Total    int64              `json:"total"`
	Page     int                `json:"page"`
	PageSize int                `json:"pageSize"`
}
