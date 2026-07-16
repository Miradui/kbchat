package dto

import (
	"time"

	"github.com/google/uuid"
)

type DocumentResponse struct {
	ID              string     `json:"id"`
	KnowledgeBaseID string     `json:"knowledgeBaseId"`
	Filename        string     `json:"filename"`
	FileType        string     `json:"fileType"`
	FileSize        int64      `json:"fileSize"`
	Status          string     `json:"status"`
	ErrorMessage    *string    `json:"errorMessage"`
	JobStatus       string     `json:"jobStatus"`
	Progress        int        `json:"progress"`
	Stage           string     `json:"stage"`
	RetryCount      int        `json:"retryCount"`
	MaxRetries      int        `json:"maxRetries"`
	NextRetryAt     *time.Time `json:"nextRetryAt"`
	CreatedAt       time.Time  `json:"createdAt"`
	UpdatedAt       time.Time  `json:"updatedAt"`
}

type DocumentListResponse struct {
	Items []DocumentResponse `json:"items"`
}

type GlobalDocumentListQuery struct {
	Q               string
	KnowledgeBaseID *string
	Status          string
	FileType        string
	Sort            string
	Page            int
	PageSize        int
}

type GlobalDocumentResponse struct {
	ID                string     `json:"id"`
	KnowledgeBaseID   string     `json:"knowledgeBaseId"`
	KnowledgeBaseName string     `json:"knowledgeBaseName"`
	Filename          string     `json:"filename"`
	FileType          string     `json:"fileType"`
	FileSize          int64      `json:"fileSize"`
	Status            string     `json:"status"`
	ErrorMessage      *string    `json:"errorMessage"`
	JobStatus         string     `json:"jobStatus"`
	Progress          int        `json:"progress"`
	Stage             string     `json:"stage"`
	RetryCount        int        `json:"retryCount"`
	MaxRetries        int        `json:"maxRetries"`
	NextRetryAt       *time.Time `json:"nextRetryAt"`
	CreatedAt         time.Time  `json:"createdAt"`
	UpdatedAt         time.Time  `json:"updatedAt"`
}

type GlobalDocumentListResponse struct {
	Items    []GlobalDocumentResponse `json:"items"`
	Total    int64                    `json:"total"`
	Page     int                      `json:"page"`
	PageSize int                      `json:"pageSize"`
}

type ChunkResponse struct {
	ID         string         `json:"id"`
	ChunkIndex int            `json:"chunkIndex"`
	Content    string         `json:"content"`
	TokenCount int            `json:"tokenCount"`
	PageNumber *int           `json:"pageNumber"`
	Metadata   map[string]any `json:"metadata"`
}

type ChunkListResponse struct {
	Items    []ChunkResponse `json:"items"`
	Total    int64           `json:"total,omitempty"`
	Page     int             `json:"page,omitempty"`
	PageSize int             `json:"pageSize,omitempty"`
}

type ChunkListQuery struct {
	Page     int
	PageSize int
	Q        string
}

type DocumentDownloadResponse struct {
	Filename    string
	FileType    string
	ContentType string
	Path        string
}

type DocumentPreviewResponse struct {
	ID          string `json:"id"`
	Filename    string `json:"filename"`
	FileType    string `json:"fileType"`
	ContentType string `json:"contentType"`
	Kind        string `json:"kind"`
	Content     string `json:"content,omitempty"`
	DownloadURL string `json:"downloadUrl"`
}

type DocumentBatchRequest struct {
	DocumentIDs []uuid.UUID `json:"documentIds" binding:"required"`
}

type DocumentBatchResultResponse struct {
	ProcessedCount int `json:"processedCount"`
}
