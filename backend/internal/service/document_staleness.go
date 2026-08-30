package service

import (
	"time"

	"kbchat/backend/internal/model"
)

// staleAfterDays is the configured threshold, or 0 when the flag is off.
func (s *DocumentService) staleAfterDays() int {
	if s.cfg.StaleDocumentAfterDays < 0 {
		return 0
	}
	return s.cfg.StaleDocumentAfterDays
}

// isStaleDocument reports whether a document has gone longer than the threshold
// without an update.
//
// Only completed documents can be stale. A failed or still-processing document
// already has a status the user is acting on, and adding "possibly out of date" to
// it would bury the thing that actually needs attention.
//
// Superseded documents are excluded too: they have been replaced, which is a more
// specific statement than being old.
//
// Measured from UpdatedAt rather than CreatedAt so a reprocess or an edit counts
// as attention -- a document someone has just revisited is not stale, whatever its
// upload date.
func isStaleDocument(document *model.Document, staleAfterDays int, now time.Time) bool {
	if staleAfterDays <= 0 {
		return false
	}
	if document.Status != "completed" || document.SupersededByID != nil {
		return false
	}
	if document.UpdatedAt.IsZero() {
		return false
	}
	threshold := time.Duration(staleAfterDays) * 24 * time.Hour
	return now.Sub(document.UpdatedAt) > threshold
}
