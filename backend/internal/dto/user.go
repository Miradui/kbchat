package dto

import "time"

type UserSearchResponse struct {
	Items []UserSummary `json:"items"`
}

type AdminUserResponse struct {
	OwnedKnowledgeBaseCount int64      `json:"ownedKnowledgeBaseCount"`
	ID                      string     `json:"id"`
	Username                string     `json:"username"`
	DisplayName             string     `json:"displayName"`
	AvatarURL               string     `json:"avatarUrl"`
	Role                    string     `json:"role"`
	Status                  string     `json:"status"`
	LastLoginAt             *time.Time `json:"lastLoginAt"`
	CreatedAt               time.Time  `json:"createdAt"`
}

type AdminUserListQuery struct {
	Q        string
	Status   string
	Role     string
	Page     int
	PageSize int
}

type AdminUserListResponse struct {
	Items    []AdminUserResponse `json:"items"`
	Total    int64               `json:"total"`
	Page     int                 `json:"page"`
	PageSize int                 `json:"pageSize"`
}

type AdminUserCreateRequest struct {
	Username    string `json:"username"`
	DisplayName string `json:"displayName"`
	Password    string `json:"password"`
}

type AdminUserUpdateRequest struct {
	DisplayName string `json:"displayName"`
	Status      string `json:"status"`
}

type AdminUserRoleRequest struct {
	Role string `json:"role" binding:"required"`
}

type AdminUserMutationResponse struct {
	User            AdminUserResponse `json:"user"`
	InitialPassword string            `json:"initialPassword,omitempty"`
}

type AdminUserResetPasswordResponse struct {
	User     AdminUserResponse `json:"user"`
	Password string            `json:"password"`
}

// AdminActivityResponse is one entry of the system administration log.
type AdminActivityResponse struct {
	ID           string            `json:"id"`
	Action       string            `json:"action"`
	ResourceType string            `json:"resourceType"`
	ResourceID   string            `json:"resourceId"`
	ResourceName string            `json:"resourceName"`
	Actor        AdminActivityUser `json:"actor"`
	CreatedAt    time.Time         `json:"createdAt"`
}

type AdminActivityUser struct {
	ID          string `json:"id"`
	Username    string `json:"username"`
	DisplayName string `json:"displayName"`
}

type AdminActivityListResponse struct {
	Items    []AdminActivityResponse `json:"items"`
	Total    int64                   `json:"total"`
	Page     int                     `json:"page"`
	PageSize int                     `json:"pageSize"`
}
