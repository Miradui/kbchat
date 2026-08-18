package model

import (
	"time"

	"github.com/google/uuid"
	"github.com/pgvector/pgvector-go"
	"gorm.io/datatypes"
	"gorm.io/gorm"
)

type User struct {
	ID           uuid.UUID `gorm:"type:uuid;primaryKey" json:"id"`
	Username     string    `gorm:"size:64;uniqueIndex;not null" json:"username"`
	PasswordHash string    `gorm:"not null" json:"-"`
	DisplayName  string    `gorm:"size:128" json:"displayName"`
	AvatarURL    string    `json:"avatarUrl"`
	Role         string    `gorm:"size:32;default:user" json:"role"`
	CreatedAt    time.Time `json:"createdAt"`
	UpdatedAt    time.Time `json:"updatedAt"`
}

func (u *User) BeforeCreate(_ *gorm.DB) error {
	if u.ID == uuid.Nil {
		u.ID = uuid.New()
	}
	return nil
}

type KnowledgeBase struct {
	ID              uuid.UUID              `gorm:"type:uuid;primaryKey" json:"id"`
	Name            string                 `gorm:"size:128;not null" json:"name"`
	Description     string                 `json:"description"`
	OwnerID         uuid.UUID              `gorm:"type:uuid;not null;index" json:"ownerId"`
	Owner           User                   `gorm:"foreignKey:OwnerID" json:"-"`
	UpdatedByID     *uuid.UUID             `gorm:"type:uuid;index" json:"updatedById"`
	UpdatedBy       *User                  `gorm:"foreignKey:UpdatedByID" json:"-"`
	CategoryID      *uuid.UUID             `gorm:"type:uuid;index" json:"categoryId"`
	Category        *KnowledgeBaseCategory `gorm:"foreignKey:CategoryID" json:"-"`
	Visibility      string                 `gorm:"size:32;default:private;not null" json:"visibility"`
	RetrievalConfig datatypes.JSON         `gorm:"type:jsonb;default:'{\"vectorTopN\":30,\"rerankTopK\":5,\"scoreThreshold\":0.3,\"enableRerank\":true}'" json:"retrievalConfig"`
	CreatedAt       time.Time              `json:"createdAt"`
	UpdatedAt       time.Time              `json:"updatedAt"`
	DeletedAt       gorm.DeletedAt         `gorm:"index" json:"-"`
}

type KnowledgeBaseCategory struct {
	ID        uuid.UUID              `gorm:"type:uuid;primaryKey" json:"id"`
	OwnerID   uuid.UUID              `gorm:"type:uuid;not null;index" json:"ownerId"`
	Owner     User                   `gorm:"foreignKey:OwnerID" json:"-"`
	ParentID  *uuid.UUID             `gorm:"type:uuid;index" json:"parentId"`
	Parent    *KnowledgeBaseCategory `gorm:"foreignKey:ParentID" json:"-"`
	Name      string                 `gorm:"size:128;not null" json:"name"`
	SortOrder int                    `json:"sortOrder"`
	CreatedAt time.Time              `json:"createdAt"`
	UpdatedAt time.Time              `json:"updatedAt"`
}

type KnowledgeBaseTag struct {
	ID        uuid.UUID `gorm:"type:uuid;primaryKey" json:"id"`
	OwnerID   uuid.UUID `gorm:"type:uuid;not null;index" json:"ownerId"`
	Owner     User      `gorm:"foreignKey:OwnerID" json:"-"`
	Name      string    `gorm:"size:64;not null" json:"name"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

type KnowledgeBaseTagBinding struct {
	KnowledgeBaseID uuid.UUID        `gorm:"type:uuid;primaryKey" json:"knowledgeBaseId"`
	KnowledgeBase   KnowledgeBase    `gorm:"foreignKey:KnowledgeBaseID" json:"-"`
	TagID           uuid.UUID        `gorm:"type:uuid;primaryKey" json:"tagId"`
	Tag             KnowledgeBaseTag `gorm:"foreignKey:TagID" json:"-"`
	CreatedAt       time.Time        `json:"createdAt"`
}

type KnowledgeBaseMember struct {
	KnowledgeBaseID uuid.UUID     `gorm:"type:uuid;primaryKey" json:"knowledgeBaseId"`
	KnowledgeBase   KnowledgeBase `gorm:"foreignKey:KnowledgeBaseID" json:"-"`
	UserID          uuid.UUID     `gorm:"type:uuid;primaryKey" json:"userId"`
	User            User          `gorm:"foreignKey:UserID" json:"-"`
	Role            string        `gorm:"size:32;not null" json:"role"`
	CreatedAt       time.Time     `json:"createdAt"`
	UpdatedAt       time.Time     `json:"updatedAt"`
}

type KnowledgeBaseFavorite struct {
	UserID          uuid.UUID     `gorm:"type:uuid;primaryKey" json:"userId"`
	User            User          `gorm:"foreignKey:UserID" json:"-"`
	KnowledgeBaseID uuid.UUID     `gorm:"type:uuid;primaryKey" json:"knowledgeBaseId"`
	KnowledgeBase   KnowledgeBase `gorm:"foreignKey:KnowledgeBaseID" json:"-"`
	CreatedAt       time.Time     `json:"createdAt"`
}

type KnowledgeBaseViewEvent struct {
	ID              uuid.UUID     `gorm:"type:uuid;primaryKey" json:"id"`
	UserID          uuid.UUID     `gorm:"type:uuid;not null;index" json:"userId"`
	User            User          `gorm:"foreignKey:UserID" json:"-"`
	KnowledgeBaseID uuid.UUID     `gorm:"type:uuid;not null;index" json:"knowledgeBaseId"`
	KnowledgeBase   KnowledgeBase `gorm:"foreignKey:KnowledgeBaseID" json:"-"`
	ViewedAt        time.Time     `gorm:"not null;index" json:"viewedAt"`
}

type KnowledgeBaseWorkspacePreference struct {
	UserID              uuid.UUID      `gorm:"type:uuid;primaryKey" json:"userId"`
	User                User           `gorm:"foreignKey:UserID" json:"-"`
	ViewMode            string         `gorm:"size:32;default:table;not null" json:"viewMode"`
	Scope               string         `gorm:"size:32;default:all;not null" json:"scope"`
	Sort                string         `gorm:"size:32;default:updatedAt_desc;not null" json:"sort"`
	Visibility          string         `gorm:"size:32;default:all;not null" json:"visibility"`
	ExpandedCategoryIDs datatypes.JSON `gorm:"type:jsonb;default:'[]'" json:"expandedCategoryIds"`
	CreatedAt           time.Time      `json:"createdAt"`
	UpdatedAt           time.Time      `json:"updatedAt"`
}

type Document struct {
	ID              uuid.UUID      `gorm:"type:uuid;primaryKey" json:"id"`
	KnowledgeBaseID uuid.UUID      `gorm:"type:uuid;not null;index" json:"knowledgeBaseId"`
	KnowledgeBase   KnowledgeBase  `gorm:"foreignKey:KnowledgeBaseID" json:"-"`
	UploaderID      uuid.UUID      `gorm:"type:uuid;not null;index" json:"uploaderId"`
	Uploader        User           `gorm:"foreignKey:UploaderID" json:"-"`
	Filename        string         `gorm:"size:255;not null" json:"filename"`
	FileType        string         `gorm:"size:32" json:"fileType"`
	FileSize        int64          `json:"fileSize"`
	StoragePath     string         `gorm:"not null" json:"storagePath"`
	Status          string         `gorm:"size:32;default:uploaded" json:"status"`
	ErrorMessage    string         `json:"errorMessage"`
	CreatedAt       time.Time      `json:"createdAt"`
	UpdatedAt       time.Time      `json:"updatedAt"`
	DeletedAt       gorm.DeletedAt `gorm:"index" json:"-"`
}

func (d *Document) BeforeCreate(_ *gorm.DB) error {
	if d.ID == uuid.Nil {
		d.ID = uuid.New()
	}
	return nil
}

type DocumentJob struct {
	ID           uuid.UUID  `gorm:"type:uuid;primaryKey" json:"id"`
	DocumentID   uuid.UUID  `gorm:"type:uuid;not null;index" json:"documentId"`
	Document     Document   `gorm:"foreignKey:DocumentID" json:"-"`
	JobType      string     `gorm:"size:64;not null" json:"jobType"`
	Status       string     `gorm:"size:32;default:pending" json:"status"`
	RetryCount   int        `json:"retryCount"`
	ErrorMessage string     `json:"errorMessage"`
	LockedAt     *time.Time `json:"lockedAt"`
	CreatedAt    time.Time  `json:"createdAt"`
	UpdatedAt    time.Time  `json:"updatedAt"`
}

// StorageCleanupJob is a durable outbox entry created in the same transaction
// that permanently deletes a document. It keeps the object location available
// until storage deletion succeeds.
type StorageCleanupJob struct {
	ID            uuid.UUID  `gorm:"type:uuid;primaryKey" json:"id"`
	StoragePath   string     `gorm:"not null;uniqueIndex" json:"storagePath"`
	RetryCount    int        `json:"retryCount"`
	NextAttemptAt *time.Time `gorm:"index" json:"nextAttemptAt"`
	LockedAt      *time.Time `gorm:"index" json:"lockedAt"`
	LeaseToken    *uuid.UUID `gorm:"type:uuid;index" json:"leaseToken"`
	LastError     string     `json:"lastError"`
	CreatedAt     time.Time  `json:"createdAt"`
	UpdatedAt     time.Time  `json:"updatedAt"`
}

type DocumentChunk struct {
	ID              uuid.UUID       `gorm:"type:uuid;primaryKey" json:"id"`
	DocumentID      uuid.UUID       `gorm:"type:uuid;not null;index" json:"documentId"`
	Document        Document        `gorm:"foreignKey:DocumentID" json:"-"`
	KnowledgeBaseID uuid.UUID       `gorm:"type:uuid;not null;index" json:"knowledgeBaseId"`
	KnowledgeBase   KnowledgeBase   `gorm:"foreignKey:KnowledgeBaseID" json:"-"`
	ChunkIndex      int             `gorm:"not null" json:"chunkIndex"`
	Content         string          `gorm:"not null" json:"content"`
	TokenCount      int             `json:"tokenCount"`
	PageNumber      *int            `json:"pageNumber"`
	Metadata        datatypes.JSON  `gorm:"type:jsonb" json:"metadata"`
	Embedding       pgvector.Vector `gorm:"type:vector(1536)" json:"-"`
	CreatedAt       time.Time       `json:"createdAt"`
}

type ChatSession struct {
	ID              uuid.UUID      `gorm:"type:uuid;primaryKey" json:"id"`
	UserID          uuid.UUID      `gorm:"type:uuid;not null;index" json:"userId"`
	User            User           `gorm:"foreignKey:UserID" json:"-"`
	KnowledgeBaseID uuid.UUID      `gorm:"type:uuid;not null;index" json:"knowledgeBaseId"`
	KnowledgeBase   KnowledgeBase  `gorm:"foreignKey:KnowledgeBaseID" json:"-"`
	Title           string         `gorm:"size:255" json:"title"`
	CreatedAt       time.Time      `json:"createdAt"`
	UpdatedAt       time.Time      `json:"updatedAt"`
	ArchivedAt      *time.Time     `gorm:"index" json:"archivedAt"`
	DeletedAt       gorm.DeletedAt `gorm:"index" json:"-"`
}

func (s *ChatSession) BeforeCreate(_ *gorm.DB) error {
	if s.ID == uuid.Nil {
		s.ID = uuid.New()
	}
	return nil
}

type ChatMessage struct {
	ID                uuid.UUID      `gorm:"type:uuid;primaryKey" json:"id"`
	SessionID         uuid.UUID      `gorm:"type:uuid;not null;index;uniqueIndex:idx_chat_messages_session_client_role,where:client_request_id IS NOT NULL AND (role = 'user' OR role = 'assistant')" json:"sessionId"`
	Session           ChatSession    `gorm:"foreignKey:SessionID" json:"-"`
	ClientRequestID   *uuid.UUID     `gorm:"type:uuid;uniqueIndex:idx_chat_messages_session_client_role,where:client_request_id IS NOT NULL AND (role = 'user' OR role = 'assistant')" json:"clientRequestId"`
	Role              string         `gorm:"size:32;not null;uniqueIndex:idx_chat_messages_session_client_role,where:client_request_id IS NOT NULL AND (role = 'user' OR role = 'assistant')" json:"role"`
	Content           string         `gorm:"not null" json:"content"`
	Citations         datatypes.JSON `gorm:"type:jsonb" json:"citations"`
	RerankFallback    datatypes.JSON `gorm:"type:jsonb" json:"rerankFallback"`
	FeedbackRating    *string        `gorm:"size:16" json:"feedbackRating"`
	FeedbackUpdatedAt *time.Time     `json:"feedbackUpdatedAt"`
	CreatedAt         time.Time      `json:"createdAt"`
}

func (m *ChatMessage) BeforeCreate(_ *gorm.DB) error {
	if m.ID == uuid.Nil {
		m.ID = uuid.New()
	}
	return nil
}

func (c *DocumentChunk) BeforeCreate(_ *gorm.DB) error {
	if c.ID == uuid.Nil {
		c.ID = uuid.New()
	}
	return nil
}

func (j *DocumentJob) BeforeCreate(_ *gorm.DB) error {
	if j.ID == uuid.Nil {
		j.ID = uuid.New()
	}
	return nil
}

func (j *StorageCleanupJob) BeforeCreate(_ *gorm.DB) error {
	if j.ID == uuid.Nil {
		j.ID = uuid.New()
	}
	return nil
}

func (kb *KnowledgeBase) BeforeCreate(_ *gorm.DB) error {
	if kb.ID == uuid.Nil {
		kb.ID = uuid.New()
	}
	if kb.Visibility == "" {
		kb.Visibility = "private"
	}
	if len(kb.RetrievalConfig) == 0 {
		kb.RetrievalConfig = datatypes.JSON([]byte(`{"vectorTopN":30,"rerankTopK":5,"scoreThreshold":0.3,"enableRerank":true}`))
	}
	if kb.UpdatedByID == nil && kb.OwnerID != uuid.Nil {
		kb.UpdatedByID = &kb.OwnerID
	}
	return nil
}

func (c *KnowledgeBaseCategory) BeforeCreate(_ *gorm.DB) error {
	if c.ID == uuid.Nil {
		c.ID = uuid.New()
	}
	return nil
}

func (t *KnowledgeBaseTag) BeforeCreate(_ *gorm.DB) error {
	if t.ID == uuid.Nil {
		t.ID = uuid.New()
	}
	return nil
}

func (e *KnowledgeBaseViewEvent) BeforeCreate(_ *gorm.DB) error {
	if e.ID == uuid.Nil {
		e.ID = uuid.New()
	}
	if e.ViewedAt.IsZero() {
		e.ViewedAt = time.Now()
	}
	return nil
}

func (p *KnowledgeBaseWorkspacePreference) BeforeCreate(_ *gorm.DB) error {
	if p.ViewMode == "" {
		p.ViewMode = "table"
	}
	if p.Scope == "" {
		p.Scope = "all"
	}
	if p.Sort == "" {
		p.Sort = "updatedAt_desc"
	}
	if p.Visibility == "" {
		p.Visibility = "all"
	}
	if len(p.ExpandedCategoryIDs) == 0 {
		p.ExpandedCategoryIDs = datatypes.JSON([]byte("[]"))
	}
	return nil
}

// Activity is one entry in the workspace timeline.
//
// ResourceName and KnowledgeBaseName are denormalised deliberately: an entry has
// to stay readable after its resource is permanently deleted, which is exactly
// when the delete event matters most. For the same reason there is no foreign
// key to the resource tables.
type Activity struct {
	ID                uuid.UUID  `gorm:"type:uuid;primaryKey" json:"id"`
	UserID            uuid.UUID  `gorm:"type:uuid;not null;index" json:"userId"`
	User              User       `gorm:"foreignKey:UserID" json:"-"`
	Action            string     `gorm:"size:64;not null" json:"action"`
	ResourceType      string     `gorm:"size:32;not null" json:"resourceType"`
	ResourceID        uuid.UUID  `gorm:"type:uuid;not null" json:"resourceId"`
	ResourceName      string     `gorm:"size:255" json:"resourceName"`
	KnowledgeBaseID   *uuid.UUID `gorm:"type:uuid;index" json:"knowledgeBaseId"`
	KnowledgeBaseName string     `gorm:"size:128" json:"knowledgeBaseName"`
	CreatedAt         time.Time  `json:"createdAt"`
}

func (a *Activity) BeforeCreate(_ *gorm.DB) error {
	if a.ID == uuid.Nil {
		a.ID = uuid.New()
	}
	if a.CreatedAt.IsZero() {
		a.CreatedAt = time.Now()
	}
	return nil
}
