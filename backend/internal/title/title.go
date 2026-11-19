package title

import "context"

type Message struct {
	Role    string
	Content string
}

type Provider interface {
	SummarizeTitle(ctx context.Context, messages []Message) (string, error)
}

type Usage struct {
	PromptTokens     int
	CompletionTokens int
	TotalTokens      int
	Model            string
	// Reported is true only when the upstream accounted for tokens; the zero
	// value means "not reported" and is persisted as NULL rather than as a real
	// zero. See chat.Usage.Reported.
	Reported bool
}
type UsageProvider interface {
	SummarizeTitleWithUsage(context.Context, []Message) (string, Usage, error)
}
