package dto

import "time"

type UserSearchResponse struct {
	Items []UserSummary `json:"items"`
}

type AdminUserResponse struct {
	ID          string     `json:"id"`
	Username    string     `json:"username"`
	DisplayName string     `json:"displayName"`
	AvatarURL   string     `json:"avatarUrl"`
	Role        string     `json:"role"`
	Status      string     `json:"status"`
	LastLoginAt *time.Time `json:"lastLoginAt"`
	CreatedAt   time.Time  `json:"createdAt"`
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
