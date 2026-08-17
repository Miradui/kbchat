package dto

import "time"

// ActivityResponse is one workspace timeline entry.
//
// resourceName and knowledgeBaseName are stored with the event rather than
// resolved at read time, so an entry still reads correctly after its resource is
// permanently deleted — which is exactly when a delete entry matters.
type ActivityResponse struct {
	ID                string    `json:"id"`
	Action            string    `json:"action"`
	ResourceType      string    `json:"resourceType"`
	ResourceID        string    `json:"resourceId"`
	ResourceName      string    `json:"resourceName"`
	KnowledgeBaseID   string    `json:"knowledgeBaseId,omitempty"`
	KnowledgeBaseName string    `json:"knowledgeBaseName,omitempty"`
	CreatedAt         time.Time `json:"createdAt"`
}

type ActivityListResponse struct {
	Items []ActivityResponse `json:"items"`
}
