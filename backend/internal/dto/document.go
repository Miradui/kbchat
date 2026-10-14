package dto

import (
	"io"
	"time"

	"github.com/google/uuid"
)

type DocumentResponse struct {
	SourcePath      string          `json:"sourcePath,omitempty"`
	PDFTextSummary  *PDFTextSummary `json:"pdfTextSummary"`
	ID              string          `json:"id"`
	KnowledgeBaseID string          `json:"knowledgeBaseId"`
	Filename        string          `json:"filename"`
	FileType        string          `json:"fileType"`
	FileSize        int64           `json:"fileSize"`
	Status          string          `json:"status"`
	ErrorMessage    *string         `json:"errorMessage"`
	JobStatus       string          `json:"jobStatus"`
	Progress        int             `json:"progress"`
	Stage           string          `json:"stage"`
	RetryCount      int             `json:"retryCount"`
	MaxRetries      int             `json:"maxRetries"`
	NextRetryAt     *time.Time      `json:"nextRetryAt"`
	CreatedAt       time.Time       `json:"createdAt"`
	UpdatedAt       time.Time       `json:"updatedAt"`

	// ErrorCode is a closed set (see model.DocumentErrorCode*) so the client can
	// give specific advice per failure. ErrorMessage stays the human sentence; the
	// raw parser or provider error is never either of them.
	ErrorCode string `json:"errorCode,omitempty"`
	// SupersededByID names the revision that replaced this document, and is what
	// tells the client this row is history rather than a live document.
	SupersededByID *string    `json:"supersededById"`
	SupersededAt   *time.Time `json:"supersededAt"`

	// IsStale is a display hint, not a judgement: the document has gone longer than
	// the configured threshold without an update. It never affects retrieval.
	IsStale bool `json:"isStale"`
	// StaleAfterDays echoes the threshold so the client can explain the flag
	// instead of asserting it. 0 means the flag is disabled server-side.
	StaleAfterDays int `json:"staleAfterDays"`
}

type PDFTextSummary struct {
	TotalPages       int   `json:"totalPages"`
	TextPages        int   `json:"textPages"`
	PagesWithoutText []int `json:"pagesWithoutText"`
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

type DocumentCountsQuery struct {
	Q               string
	KnowledgeBaseID *string
	FileType        string
}

type DocumentCountsResponse struct {
	Total      int64 `json:"total"`
	Completed  int64 `json:"completed"`
	Processing int64 `json:"processing"`
	Failed     int64 `json:"failed"`
}

type GlobalDocumentResponse struct {
	SourcePath        string     `json:"sourcePath,omitempty"`
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

	ErrorCode      string     `json:"errorCode,omitempty"`
	SupersededByID *string    `json:"supersededById"`
	SupersededAt   *time.Time `json:"supersededAt"`
	IsStale        bool       `json:"isStale"`
	StaleAfterDays int        `json:"staleAfterDays"`
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
	Total    int64           `json:"total"`
	Page     int             `json:"page"`
	PageSize int             `json:"pageSize"`
}

type ChunkListQuery struct {
	Page     int
	PageSize int
	Q        string
	ChunkID  *uuid.UUID
}

type DocumentDownloadResponse struct {
	Filename    string
	FileType    string
	ContentType string
	Size        int64
	Reader      io.ReadCloser
}

type DocumentPreviewResponse struct {
	TableRows   []TablePreviewRow `json:"tableRows,omitempty"`
	ID          string            `json:"id"`
	Filename    string            `json:"filename"`
	FileType    string            `json:"fileType"`
	ContentType string            `json:"contentType"`
	Kind        string            `json:"kind"`
	Content     string            `json:"content,omitempty"`
	DownloadURL string            `json:"downloadUrl"`
}

type DocumentBatchRequest struct {
	DocumentIDs []uuid.UUID `json:"documentIds" binding:"required"`
}

// DocumentUpdateRequest carries a rename, a move, or both. Both fields are
// optional; omitting one leaves that side untouched.
type DocumentUpdateRequest struct {
	Filename        string     `json:"filename"`
	KnowledgeBaseID *uuid.UUID `json:"knowledgeBaseId"`
}

type DocumentBatchResultResponse struct {
	ProcessedCount int `json:"processedCount"`
}
