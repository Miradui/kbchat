package service

import (
	"context"

	"github.com/google/uuid"

	"kbchat/backend/internal/apperror"
	"kbchat/backend/internal/dto"
	"kbchat/backend/internal/model"
	"kbchat/backend/internal/repository"
)

// Activity actions. These strings are part of the public API: the frontend maps
// them to timeline copy, so treat them as a closed set.
const (
	ActivityKnowledgeBaseCreated  = "knowledgeBase.created"
	ActivityKnowledgeBaseDeleted  = "knowledgeBase.deleted"
	ActivityKnowledgeBaseRestored = "knowledgeBase.restored"
	ActivityDocumentUploaded      = "document.uploaded"
	ActivityDocumentDeleted       = "document.deleted"
	ActivityDocumentRestored      = "document.restored"
	ActivityDocumentMoved         = "document.moved"
	ActivityDocumentCancelled     = "document.cancelled"
	ActivityMemberAdded           = "member.added"
	ActivityMemberRoleChanged     = "member.roleChanged"
	ActivityMemberRemoved         = "member.removed"
	ActivityChatSessionDeleted    = "chatSession.deleted"
	ActivityChatSessionRestored   = "chatSession.restored"
)

// MaxActivityLimit bounds GET /activities; the default is 20.
const MaxActivityLimit = 100

// ActivityRecorder is how the other services append to the timeline.
//
// Recording is best effort and never fails the operation that triggered it: the
// feed is a convenience surface, not an audit log, and losing an entry is far
// less harmful than failing a delete the user already confirmed. A nil recorder
// disables recording entirely, which keeps it optional in tests.
type ActivityRecorder struct {
	activities *repository.ActivityRepository
}

func NewActivityRecorder(activities *repository.ActivityRepository) *ActivityRecorder {
	return &ActivityRecorder{activities: activities}
}

type ActivityEntry struct {
	Action            string
	ResourceType      string
	ResourceID        uuid.UUID
	ResourceName      string
	KnowledgeBaseID   *uuid.UUID
	KnowledgeBaseName string
}

func (r *ActivityRecorder) Record(ctx context.Context, userID uuid.UUID, entry ActivityEntry) {
	if r == nil || r.activities == nil {
		return
	}
	// Deliberately ignoring the error: see the type comment.
	_ = r.activities.Create(ctx, &model.Activity{
		UserID:            userID,
		Action:            entry.Action,
		ResourceType:      entry.ResourceType,
		ResourceID:        entry.ResourceID,
		ResourceName:      entry.ResourceName,
		KnowledgeBaseID:   entry.KnowledgeBaseID,
		KnowledgeBaseName: entry.KnowledgeBaseName,
	})
}

type ActivityService struct {
	activities *repository.ActivityRepository
}

func NewActivityService(activities *repository.ActivityRepository) *ActivityService {
	return &ActivityService{activities: activities}
}

func (s *ActivityService) List(ctx context.Context, userID uuid.UUID, limit int) (*dto.ActivityListResponse, error) {
	if limit <= 0 {
		limit = 20
	}
	if limit > MaxActivityLimit {
		limit = MaxActivityLimit
	}

	items, err := s.activities.ListByUser(ctx, userID, limit)
	if err != nil {
		return nil, apperror.Internal(err)
	}
	res := &dto.ActivityListResponse{Items: make([]dto.ActivityResponse, 0, len(items))}
	for i := range items {
		knowledgeBaseID := ""
		if items[i].KnowledgeBaseID != nil {
			knowledgeBaseID = items[i].KnowledgeBaseID.String()
		}
		res.Items = append(res.Items, dto.ActivityResponse{
			ID:                items[i].ID.String(),
			Action:            items[i].Action,
			ResourceType:      items[i].ResourceType,
			ResourceID:        items[i].ResourceID.String(),
			ResourceName:      items[i].ResourceName,
			KnowledgeBaseID:   knowledgeBaseID,
			KnowledgeBaseName: items[i].KnowledgeBaseName,
			CreatedAt:         items[i].CreatedAt,
		})
	}
	return res, nil
}
