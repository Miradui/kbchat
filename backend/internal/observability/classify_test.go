package observability

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"strings"
	"syscall"
	"testing"
)

type fakeStatusError struct {
	message string
	status  int
}

func (e *fakeStatusError) Error() string   { return e.message }
func (e *fakeStatusError) StatusCode() int { return e.status }

type fakeAuthError struct {
	message string
}

func (e *fakeAuthError) Error() string      { return e.message }
func (e *fakeAuthError) Unauthorized() bool { return true }

func TestClassifyMapsErrorsToClosedReasonSet(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want Reason
	}{
		{name: "nil is success", err: nil, want: ReasonNone},
		{name: "not configured", err: fmt.Errorf("redis: %w", ErrNotConfigured), want: ReasonNotConfigured},
		{name: "not found sentinel", err: fmt.Errorf("bucket: %w", ErrNotFound), want: ReasonNotFound},
		{name: "missing file", err: fmt.Errorf("upload dir: %w", os.ErrNotExist), want: ReasonNotFound},
		{name: "deadline exceeded", err: fmt.Errorf("ping: %w", context.DeadlineExceeded), want: ReasonTimeout},
		{name: "cancelled", err: fmt.Errorf("ping: %w", context.Canceled), want: ReasonTimeout},
		{name: "http 401", err: &fakeStatusError{message: "unauthorized", status: 401}, want: ReasonAuthRejected},
		{name: "http 403", err: &fakeStatusError{message: "forbidden", status: 403}, want: ReasonAuthRejected},
		{name: "http 404", err: &fakeStatusError{message: "missing", status: 404}, want: ReasonNotFound},
		{name: "http 500 is not identified", err: &fakeStatusError{message: "boom", status: 500}, want: ReasonUnavailable},
		{name: "provider reports auth failure", err: &fakeAuthError{message: "bad key"}, want: ReasonAuthRejected},
		{name: "connection refused", err: fmt.Errorf("dial: %w", syscall.ECONNREFUSED), want: ReasonUnreachable},
		{name: "connection reset", err: fmt.Errorf("read: %w", syscall.ECONNRESET), want: ReasonUnreachable},
		{name: "dns failure", err: &net.DNSError{Err: "no such host", Name: "db.internal"}, want: ReasonUnreachable},
		{name: "op error", err: &net.OpError{Op: "dial", Net: "tcp", Err: errors.New("boom")}, want: ReasonUnreachable},
		{name: "unknown error", err: errors.New("something went wrong"), want: ReasonUnavailable},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if got := Classify(testCase.err); got != testCase.want {
				t.Fatalf("Classify() = %q, want %q", got, testCase.want)
			}
		})
	}
}

// TestClassifyNeverReturnsErrorContent is the guard for the roadmap constraint
// that health output must not carry keys, connection strings or raw provider
// errors. Real driver errors embed exactly these, so the test feeds them in
// deliberately and asserts nothing survives into the returned reason.
func TestClassifyNeverReturnsErrorContent(t *testing.T) {
	secrets := []string{
		"postgres://rag:supersecret@db.internal:5432/rag?sslmode=disable",
		"sk-test-abcdef0123456789",
		"MINIO_SECRET_KEY=hunter2",
		"db.internal:5432",
		"supersecret",
		"hunter2",
	}

	errs := []error{
		fmt.Errorf("dial tcp: %s: %w", "postgres://rag:supersecret@db.internal:5432/rag?sslmode=disable", syscall.ECONNREFUSED),
		&fakeStatusError{message: `{"error":{"message":"Incorrect API key provided: sk-test-abcdef0123456789"}}`, status: 401},
		errors.New("MINIO_SECRET_KEY=hunter2 rejected by db.internal:5432"),
		fmt.Errorf("timeout contacting db.internal:5432: %w", context.DeadlineExceeded),
	}

	for _, err := range errs {
		reason := string(Classify(err))
		for _, secret := range secrets {
			if strings.Contains(reason, secret) {
				t.Fatalf("reason %q leaked %q from error %q", reason, secret, err)
			}
		}
		if strings.Contains(err.Error(), reason) && reason != "" {
			// A reason that happens to be a substring of the error is fine only if
			// it is one of the closed-set constants, not text copied out.
			if !isKnownReason(Reason(reason)) {
				t.Fatalf("reason %q appears to be copied from the error", reason)
			}
		}
		if !isKnownReason(Reason(reason)) {
			t.Fatalf("reason %q is outside the closed set", reason)
		}
	}
}

func isKnownReason(reason Reason) bool {
	switch reason {
	case ReasonNone, ReasonTimeout, ReasonUnreachable, ReasonAuthRejected,
		ReasonNotConfigured, ReasonNotFound, ReasonUnavailable:
		return true
	}
	return false
}
