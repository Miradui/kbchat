package processor

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/pgvector/pgvector-go"

	"kbchat/backend/internal/document/parser"
	"kbchat/backend/internal/document/splitter"
	"kbchat/backend/internal/embedding"
	"kbchat/backend/internal/model"
	"kbchat/backend/internal/repository"
	"kbchat/backend/internal/storage"
)

const embeddingBatchSize = 16

const (
	parsingProgress  = 10
	chunkingProgress = 30
	embeddingStart   = 50
	embeddingEnd     = 95
)

type Processor struct {
	documents *repository.DocumentRepository
	chunks    *repository.ChunkRepository
	parser    parser.Parser
	splitter  *splitter.Splitter
	embedder  embedding.Provider
	storage   storage.Storage
}

func New(
	documents *repository.DocumentRepository,
	chunks *repository.ChunkRepository,
	parser parser.Parser,
	splitter *splitter.Splitter,
	embedder embedding.Provider,
) *Processor {
	return newProcessor(documents, chunks, parser, splitter, embedder, nil)
}

func NewWithStorage(
	documents *repository.DocumentRepository,
	chunks *repository.ChunkRepository,
	parser parser.Parser,
	splitter *splitter.Splitter,
	embedder embedding.Provider,
	fileStorage storage.Storage,
) *Processor {
	return newProcessor(documents, chunks, parser, splitter, embedder, fileStorage)
}

func newProcessor(
	documents *repository.DocumentRepository,
	chunks *repository.ChunkRepository,
	parser parser.Parser,
	splitter *splitter.Splitter,
	embedder embedding.Provider,
	fileStorage storage.Storage,
) *Processor {
	return &Processor{
		documents: documents,
		chunks:    chunks,
		parser:    parser,
		splitter:  splitter,
		embedder:  embedder,
		storage:   fileStorage,
	}
}

func (p *Processor) Process(ctx context.Context, job *model.DocumentJob) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	document, err := p.documents.FindByID(ctx, job.DocumentID)
	if err != nil {
		return err
	}
	if document == nil {
		return fmt.Errorf("document %s not found", job.DocumentID)
	}

	if err := p.documents.UpdateStatus(ctx, document.ID, job.ID, "parsing", parsingProgress, ""); err != nil {
		return err
	}
	localPath := document.StoragePath
	cleanup := func() {}
	if p.storage != nil {
		localPath, cleanup, err = p.storage.Materialize(ctx, document.StoragePath)
		if err != nil {
			return err
		}
	}
	defer cleanup()
	parsedDocument, err := p.parser.ParseDocument(localPath, document.FileType)
	if err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}

	if err := p.documents.UpdateStatus(ctx, document.ID, job.ID, "chunking", chunkingProgress, ""); err != nil {
		return err
	}
	parts := p.splitter.SplitDocument(parsedDocument)
	if len(parts) == 0 {
		return fmt.Errorf("document contains no extractable text")
	}
	if err := ctx.Err(); err != nil {
		return err
	}

	if err := p.documents.UpdateStatus(ctx, document.ID, job.ID, "embedding", embeddingStart, ""); err != nil {
		return err
	}

	rows := make([]model.DocumentChunk, 0, len(parts))
	for start := 0; start < len(parts); start += embeddingBatchSize {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := p.documents.EnsureJobRunning(ctx, document.ID, job.ID); err != nil {
			return err
		}

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
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := p.documents.EnsureJobRunning(ctx, document.ID, job.ID); err != nil {
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
		progress := embeddingStart + (end*(embeddingEnd-embeddingStart))/len(parts)
		if err := p.documents.UpdateStatus(ctx, document.ID, job.ID, "embedding", progress, ""); err != nil {
			return err
		}

	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := p.chunks.PublishByDocument(ctx, document.ID, job.ID, rows); err != nil {
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
