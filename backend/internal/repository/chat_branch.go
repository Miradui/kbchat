package repository

import (
	"context"
	"errors"
	"github.com/google/uuid"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"kbchat/backend/internal/model"
	"time"
)

var ErrChatBranchTooLarge = errors.New("chat branch history exceeds limit")
var ErrChatBranchRequestConflict = errors.New("chat branch request id already used")
var ErrChatBranchTargetInvalid = errors.New("chat branch target is not an answer")

// Serialize with message edits and dependency registration using the source row.
// The copied transcript, source link and inherited scope commit atomically.
func (r *ChatRepository) CreateBranch(ctx context.Context, userID, sourceID, messageID, requestID uuid.UUID, title string, roles []string) (uuid.UUID, error) {
	var result uuid.UUID
	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var source model.ChatSession
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("id = ? AND user_id = ?", sourceID, userID).First(&source).Error; err != nil {
			return err
		}
		accessible := func() error {
			var n int64
			err := tx.Model(&model.ChatSession{}).Joins("JOIN knowledge_bases ON knowledge_bases.id = chat_sessions.knowledge_base_id").
				Where("chat_sessions.id = ? AND chat_sessions.user_id = ? AND knowledge_bases.deleted_at IS NULL", sourceID, userID).
				Where(reachableKnowledgeBaseCondition(tx, userID, roles)).Where(reachableChatLinks(userID, roles)).Count(&n).Error
			if err != nil {
				return err
			}
			if n != 1 {
				return gorm.ErrRecordNotFound
			}
			return nil
		}
		if err := accessible(); err != nil {
			return err
		}
		existing := func() (bool, error) {
			var prior model.ChatSession
			err := tx.Unscoped().Where("branch_request_id = ?", requestID).First(&prior).Error
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return false, nil
			}
			if err != nil {
				return false, err
			}
			if prior.UserID != userID || prior.DeletedAt.Valid || prior.BranchFromSessionID == nil || *prior.BranchFromSessionID != sourceID || prior.BranchFromMessageID == nil || *prior.BranchFromMessageID != messageID {
				return false, ErrChatBranchRequestConflict
			}
			result = prior.ID
			return true, nil
		}
		if found, err := existing(); found || err != nil {
			return err
		}
		var target model.ChatMessage
		if err := tx.Where("id = ? AND session_id = ?", messageID, sourceID).First(&target).Error; err != nil {
			return err
		}
		if target.Role != "assistant" {
			return ErrChatBranchTargetInvalid
		}
		var prefix []model.ChatMessage
		if err := tx.Where("session_id = ? AND (created_at < ? OR (created_at = ? AND id <= ?))", sourceID, target.CreatedAt, target.CreatedAt, messageID).
			Order("created_at ASC, id ASC").Limit(10001).Find(&prefix).Error; err != nil {
			return err
		}
		if len(prefix) > 10000 {
			return ErrChatBranchTooLarge
		}
		size := 0
		for _, m := range prefix {
			size += len(m.Content) + len(m.Citations) + len(m.RerankFallback)
			if size > 16*1024*1024 {
				return ErrChatBranchTooLarge
			}
		}
		if title == "" {
			title = source.Title
			run := []rune(title)
			if len(run) > 90 {
				title = string(run[:90])
			}
			title += " · 分支"
		}
		now := time.Now().UTC().Truncate(time.Microsecond)
		branch := model.ChatSession{DocumentScope: source.DocumentScope, ID: uuid.New(), UserID: userID, KnowledgeBaseID: source.KnowledgeBaseID, ScopeMode: source.ScopeMode, Title: title, CreatedAt: now, UpdatedAt: now,
			BranchFromSessionID: &sourceID, BranchFromMessageID: &messageID, BranchRequestID: &requestID}
		created := tx.Omit(clause.Associations).Clauses(clause.OnConflict{DoNothing: true}).Create(&branch)
		if created.Error != nil {
			return created.Error
		}
		if created.RowsAffected == 0 {
			_, err := existing()
			return err
		}
		var links []model.ChatSessionKnowledgeBase
		if err := tx.Where("session_id = ?", sourceID).Find(&links).Error; err != nil {
			return err
		}
		for i := range links {
			links[i].SessionID = branch.ID
		}
		if len(links) > 0 {
			if err := tx.Omit(clause.Associations).Create(&links).Error; err != nil {
				return err
			}
		}
		messages := make([]model.ChatMessage, 0, len(prefix))
		for i, m := range prefix {
			messages = append(messages, model.ChatMessage{ID: uuid.New(), SessionID: branch.ID, Role: m.Role, Content: m.Content, Citations: m.Citations, RerankFallback: m.RerankFallback,
				Intent: m.Intent, RetrievalQuery: m.RetrievalQuery, RetrievalQueryNorm: m.RetrievalQueryNorm, AnswerStatus: m.AnswerStatus,
				CreatedAt: now.Add(time.Duration(i-len(prefix)) * time.Microsecond)})
		}
		if err := tx.Omit(clause.Associations).CreateInBatches(messages, 100).Error; err != nil {
			return err
		}
		if err := accessible(); err != nil {
			return err
		}
		result = branch.ID
		return nil
	})
	return result, err
}
