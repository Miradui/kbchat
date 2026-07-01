package rerank

import "context"

type Document struct {
	ID      string
	Content string
}

type Result struct {
	ID    string
	Score float64
}

type Provider interface {
	Rerank(ctx context.Context, query string, documents []Document) ([]Result, error)
}
