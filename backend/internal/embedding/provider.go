package embedding

import "context"

type Provider interface {
	EmbedTexts(ctx context.Context, texts []string) ([][]float32, error)
}
