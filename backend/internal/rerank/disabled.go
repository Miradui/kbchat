package rerank

import (
	"context"
	"fmt"
)

type DisabledProvider struct{}

func NewDisabledProvider() *DisabledProvider {
	return &DisabledProvider{}
}

func (p *DisabledProvider) Rerank(_ context.Context, _ string, _ []Document) ([]Result, error) {
	return nil, fmt.Errorf("rerank is disabled")
}
