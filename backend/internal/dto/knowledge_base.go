package dto

import (
	"time"

	"github.com/google/uuid"
)

type RetrievalConfig struct {
	VectorTopN     int     `json:"vectorTopN"`
	RerankTopK     int     `json:"rerankTopK"`
	ScoreThreshold float64 `json:"scoreThreshold"`
	EnableRerank   bool    `json:"enableRerank"`
}

type KnowledgeBaseRequest struct {
	Name            string           `json:"name" binding:"required"`
	Description     string           `json:"description"`
	CategoryID      *uuid.UUID       `json:"categoryId"`
	Visibility      string           `json:"visibility"`
	RetrievalConfig *RetrievalConfig `json:"retrievalConfig"`
	TagIDs          *[]uuid.UUID     `json:"tagIds,omitempty"`
}

type KnowledgeBaseResponse struct {
	ID                      string                     `json:"id"`
	Name                    string                     `json:"name"`
	Description             string                     `json:"description"`
	CategoryID              *string                    `json:"categoryId"`
	Visibility              string                     `json:"visibility"`
	RetrievalConfig         RetrievalConfig            `json:"retrievalConfig"`
	CreatedAt               time.Time                  `json:"createdAt"`
	UpdatedAt               time.Time                  `json:"updatedAt"`
	DocumentCount           int64                      `json:"documentCount,omitempty"`
	CompletedDocumentCount  *int64                     `json:"completedDocumentCount,omitempty"`
	ProcessingDocumentCount *int64                     `json:"processingDocumentCount,omitempty"`
	FailedDocumentCount     *int64                     `json:"failedDocumentCount,omitempty"`
	ViewCount               int64                      `json:"viewCount,omitempty"`
	QuestionCount           int64                      `json:"questionCount,omitempty"`
	IsFavorite              bool                       `json:"isFavorite"`
	LastViewedAt            *time.Time                 `json:"lastViewedAt,omitempty"`
	UpdatedBy               *UserSummary               `json:"updatedBy,omitempty"`
	Tags                    []KnowledgeBaseTagResponse `json:"tags,omitempty"`
	// EffectiveRole is the caller's own standing: viewer, editor, manager or owner.
	// Always present, so a client never has to infer permission from the absence of
	// a field.
	EffectiveRole string `json:"effectiveRole"`
	// Capabilities is what EffectiveRole permits, sent so the UI can hide actions it
	// would only get a 403 for. It is a convenience, not the boundary -- the server
	// checks every request regardless of what the client was told.
	Capabilities []string `json:"capabilities"`
}

type KnowledgeBaseListResponse struct {
	Items    []KnowledgeBaseResponse `json:"items"`
	Total    int64                   `json:"total"`
	Page     int                     `json:"page"`
	PageSize int                     `json:"pageSize"`
}

type UserSummary struct {
	ID          string `json:"id"`
	Username    string `json:"username"`
	DisplayName string `json:"displayName"`
	AvatarURL   string `json:"avatarUrl"`
}

type KnowledgeBaseListQuery struct {
	Q          string
	CategoryID *uuid.UUID
	TagIDs     []uuid.UUID
	Visibility string
	Scope      string
	Sort       string
	Page       int
	PageSize   int
}

type KnowledgeBaseCategoryRequest struct {
	Name      string     `json:"name" binding:"required"`
	ParentID  *uuid.UUID `json:"parentId"`
	SortOrder int        `json:"sortOrder"`
}

type KnowledgeBaseCategoryResponse struct {
	ID        uuid.UUID                       `json:"id"`
	ParentID  *uuid.UUID                      `json:"parentId"`
	Name      string                          `json:"name"`
	SortOrder int                             `json:"sortOrder"`
	Children  []KnowledgeBaseCategoryResponse `json:"children,omitempty"`
	CreatedAt time.Time                       `json:"createdAt"`
	UpdatedAt time.Time                       `json:"updatedAt"`
	// DirectCount counts knowledge bases filed directly under this category.
	// TotalCount adds every descendant category's direct count. Both are only
	// populated by the category tree endpoint; single-node create/update
	// responses leave them nil because a single node carries no subtree.
	DirectCount *int64 `json:"directCount,omitempty"`
	TotalCount  *int64 `json:"totalCount,omitempty"`
}

type KnowledgeBaseCategoryListResponse struct {
	Items []KnowledgeBaseCategoryResponse `json:"items"`
}

type KnowledgeBaseCategoryReorderItem struct {
	ID        uuid.UUID  `json:"id" binding:"required"`
	ParentID  *uuid.UUID `json:"parentId"`
	SortOrder int        `json:"sortOrder"`
}

type KnowledgeBaseCategoryReorderRequest struct {
	Items []KnowledgeBaseCategoryReorderItem `json:"items" binding:"required"`
}

type KnowledgeBaseTagRequest struct {
	Name string `json:"name" binding:"required"`
}

type KnowledgeBaseTagResponse struct {
	ID        uuid.UUID `json:"id"`
	Name      string    `json:"name"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
	// KnowledgeBaseCount is only populated by the tag list endpoint. Embedded tag
	// summaries on knowledge base payloads leave it nil.
	KnowledgeBaseCount *int64 `json:"knowledgeBaseCount,omitempty"`
}

type KnowledgeBaseTagListResponse struct {
	Items []KnowledgeBaseTagResponse `json:"items"`
}

type WorkspaceMetric struct {
	Value       int64    `json:"value"`
	ChangeRatio *float64 `json:"changeRatio"`
}

type RecycleBinItemResponse struct {
	ResourceType      string    `json:"resourceType"`
	ID                string    `json:"id"`
	Name              string    `json:"name"`
	KnowledgeBaseID   string    `json:"knowledgeBaseId,omitempty"`
	KnowledgeBaseName string    `json:"knowledgeBaseName,omitempty"`
	DeletedAt         time.Time `json:"deletedAt"`
}

type RecycleBinListResponse struct {
	Items    []RecycleBinItemResponse `json:"items"`
	Total    int64                    `json:"total"`
	Page     int                      `json:"page"`
	PageSize int                      `json:"pageSize"`
}

type KnowledgeBaseStatsResponse struct {
	Period         string          `json:"period"`
	KnowledgeBases WorkspaceMetric `json:"knowledgeBases"`
	Documents      WorkspaceMetric `json:"documents"`
	Views          WorkspaceMetric `json:"views"`
	Questions      WorkspaceMetric `json:"questions"`
}

// KnowledgeBaseDetailStatsResponse is the single knowledge base view of the same
// metrics. It deliberately omits knowledgeBases: a per-knowledge-base count of
// knowledge bases is always 0 or 1 and carries no trend.
type KnowledgeBaseDetailStatsResponse struct {
	KnowledgeBaseID string          `json:"knowledgeBaseId"`
	Period          string          `json:"period"`
	Documents       WorkspaceMetric `json:"documents"`
	Views           WorkspaceMetric `json:"views"`
	Questions       WorkspaceMetric `json:"questions"`
}

type KnowledgeBasePermissionUpdateRequest struct {
	Visibility string `json:"visibility"`
}

type KnowledgeBasePermissionResponse struct {
	KnowledgeBaseID string             `json:"knowledgeBaseId"`
	Visibility      string             `json:"visibility"`
	Owner           UserSummary        `json:"owner"`
	Managers        []PermissionMember `json:"managers"`
	Members         []PermissionMember `json:"members"`
}

type PermissionMember struct {
	ID          string `json:"id"`
	Username    string `json:"username"`
	DisplayName string `json:"displayName"`
	AvatarURL   string `json:"avatarUrl"`
	Role        string `json:"role"`
}

type KnowledgeBaseMemberRequest struct {
	UserID uuid.UUID `json:"userId" binding:"required"`
	Role   string    `json:"role" binding:"required"`
}

type KnowledgeBaseMemberRoleRequest struct {
	Role string `json:"role" binding:"required"`
}

type KnowledgeBaseBatchRequest struct {
	KnowledgeBaseIDs []uuid.UUID `json:"knowledgeBaseIds" binding:"required"`
}

type KnowledgeBaseBatchFavoriteRequest struct {
	KnowledgeBaseIDs []uuid.UUID `json:"knowledgeBaseIds" binding:"required"`
	Favorite         bool        `json:"favorite"`
}

type KnowledgeBaseBatchMoveCategoryRequest struct {
	KnowledgeBaseIDs []uuid.UUID `json:"knowledgeBaseIds" binding:"required"`
	CategoryID       *uuid.UUID  `json:"categoryId"`
}

// Batch tag modes accepted by POST /knowledge-bases/batch-tag.
const (
	KnowledgeBaseBatchTagModeAdd     = "add"
	KnowledgeBaseBatchTagModeRemove  = "remove"
	KnowledgeBaseBatchTagModeReplace = "replace"
)

type KnowledgeBaseBatchTagRequest struct {
	KnowledgeBaseIDs []uuid.UUID `json:"knowledgeBaseIds" binding:"required"`
	// TagIDs deliberately skips binding:"required": replace mode accepts an empty
	// list to clear every tag, and the required validator rejects empty slices.
	TagIDs []uuid.UUID `json:"tagIds"`
	Mode   string      `json:"mode"`
}

type KnowledgeBaseBatchResultResponse struct {
	ProcessedCount int `json:"processedCount"`
}

type KnowledgeBaseWorkspacePreferenceRequest struct {
	ViewMode            string      `json:"viewMode"`
	Scope               string      `json:"scope"`
	Sort                string      `json:"sort"`
	Visibility          string      `json:"visibility"`
	ExpandedCategoryIDs []uuid.UUID `json:"expandedCategoryIds"`
}

type KnowledgeBaseWorkspacePreferenceResponse struct {
	ViewMode            string   `json:"viewMode"`
	Scope               string   `json:"scope"`
	Sort                string   `json:"sort"`
	Visibility          string   `json:"visibility"`
	ExpandedCategoryIDs []string `json:"expandedCategoryIds"`
}
