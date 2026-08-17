package chat

import "context"

type Message struct {
	Role    string
	Content string
}

type Provider interface {
	Chat(ctx context.Context, messages []Message) (string, error)
}

// StreamingProvider is an optional capability on top of Provider.
//
// It is a separate interface rather than a wider Provider so that every existing
// implementation — and every test fake — keeps satisfying Provider unchanged.
// The chat service type-asserts for it and falls back to Provider.Chat when a
// provider cannot stream, so the streaming endpoint works either way; without a
// streaming provider the client simply receives the whole answer as one delta.
type StreamingProvider interface {
	Provider

	// ChatStream calls onDelta for each incremental piece of the answer and
	// returns the complete text. The returned string is authoritative: the
	// caller persists that, not a concatenation of the deltas, so a provider
	// that streams nothing still produces a correct message.
	//
	// A non-nil error from onDelta aborts the call and is returned as-is, which
	// is how a disconnected client stops generation.
	ChatStream(ctx context.Context, messages []Message, onDelta func(string) error) (string, error)
}
