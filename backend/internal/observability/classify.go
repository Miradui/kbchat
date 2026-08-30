package observability

import (
	"context"
	"errors"
	"net"
	"os"
	"syscall"
)

// Reason is a closed set of failure classes safe to return over the API.
//
// The roadmap requires that health checks never return keys, connection strings
// or raw provider errors (docs/15-product-improvement-roadmap.md:72). The
// dangerous case is not the obvious secret but the incidental one: a PostgreSQL
// driver error embeds the DSN including the password, a MinIO error embeds the
// endpoint, and a provider 401 body can echo a key prefix. Classify is therefore
// the only path from an error to the API layer, and it returns one of these
// constants and nothing else — the original error goes to the server log.
type Reason string

const (
	// ReasonNone means the probe or call succeeded.
	ReasonNone Reason = ""
	// ReasonTimeout means the operation exceeded its deadline or was cancelled.
	ReasonTimeout Reason = "timeout"
	// ReasonUnreachable means the network refused, reset, or could not resolve.
	ReasonUnreachable Reason = "unreachable"
	// ReasonAuthRejected means credentials were present but rejected.
	ReasonAuthRejected Reason = "auth_rejected"
	// ReasonNotConfigured means a required setting is missing, so nothing was tried.
	ReasonNotConfigured Reason = "not_configured"
	// ReasonNotFound means the target responded but the resource is absent, such
	// as a MinIO bucket that no longer exists.
	ReasonNotFound Reason = "not_found"
	// ReasonUnavailable is the catch-all. Anything not positively identified lands
	// here rather than leaking detail in an attempt to be more specific.
	ReasonUnavailable Reason = "unavailable"
)

// ErrNotConfigured marks a dependency that was deliberately not probed because
// it is not wired up. Callers wrap it so Classify can distinguish "operator has
// not configured this" from "configured and broken".
var ErrNotConfigured = errors.New("dependency is not configured")

// ErrNotFound marks a dependency that answered but is missing the resource the
// probe asked for.
var ErrNotFound = errors.New("dependency resource not found")

// unauthorized is satisfied by provider errors that know they were an auth
// failure. Provider packages can implement it without this package importing
// them, which keeps the dependency direction one-way.
type unauthorized interface {
	Unauthorized() bool
}

// statusCoder is satisfied by HTTP-derived errors that carry a status code.
type statusCoder interface {
	StatusCode() int
}

// Classify maps an error to a Reason. It reads only the error's type and
// sentinel identity, never its message, so no part of the input can reach the
// return value.
func Classify(err error) Reason {
	if err == nil {
		return ReasonNone
	}
	if errors.Is(err, ErrNotConfigured) {
		return ReasonNotConfigured
	}
	if errors.Is(err, ErrNotFound) || errors.Is(err, os.ErrNotExist) {
		return ReasonNotFound
	}
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) ||
		errors.Is(err, os.ErrDeadlineExceeded) {
		return ReasonTimeout
	}

	var authErr unauthorized
	if errors.As(err, &authErr) && authErr.Unauthorized() {
		return ReasonAuthRejected
	}
	var coder statusCoder
	if errors.As(err, &coder) {
		switch coder.StatusCode() {
		case 401, 403:
			return ReasonAuthRejected
		case 404:
			return ReasonNotFound
		}
	}

	// A timeout can also surface as a net.Error, which is how a stalled dial
	// reports itself rather than through context.
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return ReasonTimeout
	}
	if errors.Is(err, syscall.ECONNREFUSED) || errors.Is(err, syscall.ECONNRESET) ||
		errors.Is(err, syscall.EHOSTUNREACH) || errors.Is(err, syscall.ENETUNREACH) {
		return ReasonUnreachable
	}
	var dnsErr *net.DNSError
	if errors.As(err, &dnsErr) {
		return ReasonUnreachable
	}
	var opErr *net.OpError
	if errors.As(err, &opErr) {
		return ReasonUnreachable
	}

	return ReasonUnavailable
}
