package processor

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"kbchat/backend/internal/document/parser"
	"kbchat/backend/internal/repository"
	"kbchat/backend/internal/storage"
)

func TestClassifyErrorMapsKnownCauses(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want string
	}{
		{"nil", nil, ""},
		{"invalid utf8", fmt.Errorf("parse md: %w", parser.ErrEncodingInvalid), ErrorCodeEncodingInvalid},
		{"corrupt pdf", fmt.Errorf("open pdf: %w: %w", parser.ErrCorruptFile, errors.New("EOF")), ErrorCodeCorruptFile},
		{"no extractable text", ErrEmptyContent, ErrorCodeEmptyContent},
		{"storage read", fmt.Errorf("%w: %w", ErrStorageFailed, storage.ErrNotFound), ErrorCodeStorageFailed},
		{"storage not found alone", storage.ErrNotFound, ErrorCodeStorageFailed},
		{"embedding", fmt.Errorf("%w: %w", ErrEmbeddingFailed, errors.New("429 rate limited")), ErrorCodeEmbeddingFailed},
		{"context cancelled", context.Canceled, ErrorCodeCancelled},
		{"deadline", context.DeadlineExceeded, ErrorCodeCancelled},
		{"job cancelled", repository.ErrDocumentJobCancelled, ErrorCodeCancelled},
		{"unknown", errors.New("something nobody classified"), ErrorCodeInternal},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := ClassifyError(test.err); got != test.want {
				t.Fatalf("ClassifyError(%v) = %q, want %q", test.err, got, test.want)
			}
		})
	}
}

func TestClassifyErrorPrefersCancellationOverTheWrappedCause(t *testing.T) {
	// A cancel can surface as a wrapped provider failure. Reporting that as
	// "embedding failed" would send the user chasing a provider that was fine.
	err := fmt.Errorf("%w: %w", ErrEmbeddingFailed, context.Canceled)
	if got := ClassifyError(err); got != ErrorCodeCancelled {
		t.Fatalf("expected cancellation to win, got %q", got)
	}
}

func TestClassifyErrorNeverReturnsRawText(t *testing.T) {
	// The code is a closed set precisely so no provider or parser text can reach
	// the user through it.
	err := fmt.Errorf("%w: %w", ErrEmbeddingFailed, errors.New("api.vendor.internal: key sk-secret rejected"))
	code := ClassifyError(err)
	if code != ErrorCodeEmbeddingFailed {
		t.Fatalf("unexpected code %q", code)
	}
	for _, forbidden := range []string{"sk-secret", "api.vendor.internal", "rejected"} {
		if strings.Contains(code, forbidden) {
			t.Fatalf("code %q leaked %q", code, forbidden)
		}
	}
}
