package processor

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/pgvector/pgvector-go"

	"rag/backend/internal/document/parser"
	"rag/backend/internal/document/splitter"
	"rag/backend/internal/embedding"
	"rag/backend/internal/model"
	"rag/backend/internal/repository"
)

const embeddingBatchSize = 16

type Processor struct {
	documents *repository.DocumentRepository
	chunks    *repository.ChunkRepository
	parser    parser.Parser
	splitter  *splitter.Splitter
	embedder  embedding.Provider
}

func New(
	documents *repository.DocumentRepository,
	chunks *repository.ChunkRepository,
	parser parser.Parser,
	splitter *splitter.Splitter,
	embedder embedding.Provider,
) *Processor {
	return &Processor{
		documents: documents,
		chunks:    chunks,
		parser:    parser,
		splitter:  splitter,
		embedder:  embedder,
	}
}

func (p *Processor) Process(ctx context.Context, job *model.DocumentJob) error {
	document, err := p.documents.FindByID(ctx, job.DocumentID)
	if err != nil {
		return err
	}
	if document == nil {
		return fmt.Errorf("document %s not found", job.DocumentID)
	}

	if err := p.documents.UpdateStatus(ctx, document.ID, "parsing", ""); err != nil {
		return err
	}
	parsedDocument, err := p.parser.ParseDocument(document.StoragePath, document.FileType)
	if err != nil {
		return err
	}

	if err := p.documents.UpdateStatus(ctx, document.ID, "chunking", ""); err != nil {
		return err
	}
	parts := p.splitter.SplitDocument(parsedDocument)
	if len(parts) == 0 {
		return fmt.Errorf("document contains no extractable text")
	}

	if err := p.documents.UpdateStatus(ctx, document.ID, "embedding", ""); err != nil {
		return err
	}

	rows := make([]model.DocumentChunk, 0, len(parts))
	for start := 0; start < len(parts); start += embeddingBatchSize {
		end := start + embeddingBatchSize
		if end > len(parts) {
			end = len(parts)
		}

		texts := make([]string, 0, end-start)
		for _, part := range parts[start:end] {
			texts = append(texts, part.Content)
		}

		embeddings, err := p.embedder.EmbedTexts(ctx, texts)
		if err != nil {
			return err
		}
		if err := validateEmbeddingCount(len(texts), len(embeddings)); err != nil {
			return err
		}

		for i, vector := range embeddings {
			part := parts[start+i]
			metadata, err := buildChunkMetadata(part)
			if err != nil {
				return err
			}
			rows = append(rows, model.DocumentChunk{
				DocumentID:      document.ID,
				KnowledgeBaseID: document.KnowledgeBaseID,
				ChunkIndex:      part.Index,
				Content:         part.Content,
				TokenCount:      part.TokenCount,
				PageNumber:      part.PageNumber,
				Metadata:        metadata,
				Embedding:       pgvector.NewVector(vector),
			})
		}

	}
	if err := p.chunks.ReplaceByDocument(ctx, document.ID, rows); err != nil {
		return err
	}
	return nil
}

func buildChunkMetadata(part splitter.Chunk) ([]byte, error) {
	metadata := make(map[string]any, len(part.Metadata)+1)
	for key, value := range part.Metadata {
		metadata[key] = value
	}
	metadata["source"] = "document_processor"
	return json.Marshal(metadata)
}

func validateEmbeddingCount(expected, actual int) error {
	if expected != actual {
		return fmt.Errorf("embedding provider returned %d vectors for %d texts", actual, expected)
	}
	return nil
}
