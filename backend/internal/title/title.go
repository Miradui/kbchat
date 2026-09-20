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
}
type UsageProvider interface {
	SummarizeTitleWithUsage(context.Context, []Message) (string, Usage, error)
}
