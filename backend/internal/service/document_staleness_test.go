package service

import (
	"testing"
	"time"

	"github.com/google/uuid"

	"kbchat/backend/internal/model"
)

func TestIsStaleDocumentUsesTheThresholdAndStatus(t *testing.T) {
	now := time.Date(2026, 8, 30, 12, 0, 0, 0, time.UTC)
	replacement := uuid.New()

	tests := []struct {
		name           string
		document       model.Document
		staleAfterDays int
		want           bool
	}{
		{
			name:           "completed and older than the threshold",
			document:       model.Document{Status: "completed", UpdatedAt: now.AddDate(0, 0, -200)},
			staleAfterDays: 180,
			want:           true,
		},
		{
			name:           "completed and inside the threshold",
			document:       model.Document{Status: "completed", UpdatedAt: now.AddDate(0, 0, -100)},
			staleAfterDays: 180,
			want:           false,
		},
		{
			name:           "exactly at the threshold is not yet stale",
			document:       model.Document{Status: "completed", UpdatedAt: now.AddDate(0, 0, -180)},
			staleAfterDays: 180,
			want:           false,
		},
		{
			name:           "threshold of zero disables the flag",
			document:       model.Document{Status: "completed", UpdatedAt: now.AddDate(0, 0, -3650)},
			staleAfterDays: 0,
			want:           false,
		},
		{
			// A failed document already has a status the user is acting on; adding
			// "possibly out of date" would bury it.
			name:           "failed documents are not flagged",
			document:       model.Document{Status: "failed", UpdatedAt: now.AddDate(0, 0, -400)},
			staleAfterDays: 180,
			want:           false,
		},
		{
			name:           "still processing is not flagged",
			document:       model.Document{Status: "embedding", UpdatedAt: now.AddDate(0, 0, -400)},
			staleAfterDays: 180,
			want:           false,
		},
		{
			// Replaced is a more specific statement than old.
			name: "superseded documents are not flagged",
			document: model.Document{
				Status:         "completed",
				UpdatedAt:      now.AddDate(0, 0, -400),
				SupersededByID: &replacement,
			},
			staleAfterDays: 180,
			want:           false,
		},
		{
			name:           "zero timestamp is never stale",
			document:       model.Document{Status: "completed"},
			staleAfterDays: 180,
			want:           false,
		},
		{
			name:           "a future timestamp is never stale",
			document:       model.Document{Status: "completed", UpdatedAt: now.AddDate(0, 0, 10)},
			staleAfterDays: 180,
			want:           false,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			document := test.document
			if got := isStaleDocument(&document, test.staleAfterDays, now); got != test.want {
				t.Fatalf("isStaleDocument = %v, want %v", got, test.want)
			}
		})
	}
}

func TestStaleAfterDaysNormalizesNegativeConfiguration(t *testing.T) {
	// Validate() rejects a negative value, but the service must not depend on that
	// having run: reading it as "off" is the safe interpretation here.
	service := &DocumentService{}
	service.cfg.StaleDocumentAfterDays = -30
	if got := service.staleAfterDays(); got != 0 {
		t.Fatalf("expected a negative threshold to read as disabled, got %d", got)
	}
}
