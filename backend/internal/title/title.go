package title

import "context"

type Message struct {
	Role    string
	Content string
}

type Provider interface {
	SummarizeTitle(ctx context.Context, messages []Message) (string, error)
}
