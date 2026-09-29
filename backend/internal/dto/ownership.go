package dto

import "github.com/google/uuid"

type TransferOwnershipRequest struct {
	NewOwnerID                 uuid.UUID `json:"newOwnerId" binding:"required"`
	KeepPreviousOwnerAsManager bool      `json:"keepPreviousOwnerAsManager"`
}
type TransferOwnershipResponse struct {
	TransferredCount int `json:"transferredCount"`
}
