package processor

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/pgvector/pgvector-go"

	"go.opentelemetry.io/otel/attribute"
	"kbchat/backend/internal/document/lexer"
	"kbchat/backend/internal/document/parser"
	"kbchat/backend/internal/document/splitter"
	"kbchat/backend/internal/document/tableconfig"
	"kbchat/backend/internal/embedding"
	"kbchat/backend/internal/model"
	"kbchat/backend/internal/observability"
	"kbchat/backend/internal/repository"
	"kbchat/backend/internal/storage"
)

const embeddingBatchSize = 16

// ErrEmptyContent means parsing succeeded but produced nothing to index. It is a
// separate cause from a corrupt file because the advice differs: a scanned PDF
// with no text layer is not damaged, it just needs OCR before it is useful.
var ErrEmptyContent = errors.New("document contains no extractable text")

// ErrEmbeddingFailed wraps any failure from the embedding provider. The document
// is fine in this case -- the fix is to retry once the provider recovers, which is
// different advice from anything wrong with the file.
var ErrEmbeddingFailed = errors.New("embedding failed")

// ErrStorageFailed means the stored object could not be fetched, so nothing was
// ever parsed. The document's content is not implicated.
var ErrStorageFailed = errors.New("storage read failed")

const (
	parsingProgress  = 10
	chunkingProgress = 30
	embeddingStart   = 50
	embeddingEnd     = 95
)

type Processor struct {
	metrics            *observability.Recorder
	documents          *repository.DocumentRepository
	chunks             *repository.ChunkRepository
	parser             parser.Parser
	splitter           *splitter.Splitter
	embedder           embedding.Provider
	storage            storage.Storage
	embeddingModel     string
	embeddingDimension int
}

func (p *Processor) SetRecorder(recorder *observability.Recorder) { p.metrics = recorder }

// SetEmbeddingIdentity is configured before the worker starts, never per job.
func (p *Processor) SetEmbeddingIdentity(model string, dimension int) {
	p.embeddingModel, p.embeddingDimension = model, dimension
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
		storageCtx, storageSpan := observability.Start(ctx, "document.storage_read")
		localPath, cleanup, err = p.storage.Materialize(storageCtx, document.StoragePath)
		observability.Finish(storageSpan, err)
		if err != nil {
			// The object could not be fetched, so nothing was parsed: this is a
			// storage problem, not a problem with the document's content.
			return fmt.Errorf("%w: %w", ErrStorageFailed, err)
		}
	}
	defer cleanup()
	settings, err := tableconfig.Decode(document.TableImport)
	if err != nil {
		return err
	}
	parseCtx, parseSpan := observability.Start(ctx, "document.parse", attribute.String("document.file_type", document.FileType))
	parsedDocument, parseErr := p.parseDocument(parseCtx, document, job, localPath, settings)
	observability.Finish(parseSpan, parseErr)
	if err := ctx.Err(); err != nil {
		return err
	}

	if document.FileType == "pdf" && parsedDocument.PDFTextSummary != nil {
		summary, err := json.Marshal(parsedDocument.PDFTextSummary)
		if err != nil {
			return err
		}
		if err := p.documents.SavePDFTextSummary(ctx, document.ID, job.ID, summary); err != nil {
			return err
		}
	}
	if parseErr != nil {
		return parseErr
	}
	if err := p.documents.UpdateStatus(ctx, document.ID, job.ID, "chunking", chunkingProgress, ""); err != nil {
		return err
	}
	_, chunkSpan := observability.Start(ctx, "document.chunk")
	parts := p.splitter.SplitDocument(parsedDocument)
	chunkSpan.SetAttributes(attribute.Int("document.chunk_count", len(parts)))
	chunkSpan.End()
	if len(parts) == 0 {
		return ErrEmptyContent
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

		embeddingStartedAt := time.Now()
		embeddings, err := p.embedder.EmbedTexts(ctx, texts)
		p.metrics.RecordProviderResult(ctx, observability.ProviderEmbedding, err)
		p.metrics.ObserveSince(ctx, observability.MetricEmbedding, embeddingStartedAt)
		if err != nil {
			// Marked here rather than sniffed later: this is the only place that
			// knows the failure came from the embedding provider, and the provider
			// errors themselves are plain fmt.Errorf values.
			if ctxErr := ctx.Err(); ctxErr != nil {
				return err
			}
			return fmt.Errorf("%w: %w", ErrEmbeddingFailed, err)
		}
		if err := validateEmbeddingCount(len(texts), len(embeddings)); err != nil {
			return fmt.Errorf("%w: %w", ErrEmbeddingFailed, err)
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := p.documents.EnsureJobRunning(ctx, document.ID, job.ID); err != nil {
			return err
		}

		for i, vector := range embeddings {
			if p.embeddingDimension > 0 && len(vector) != p.embeddingDimension {
				return fmt.Errorf("%w: vector dimension %d, expected %d", ErrEmbeddingFailed, len(vector), p.embeddingDimension)
			}
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
				SearchVector:    model.SearchVector(lexer.TSVector(lexer.Tokenize(part.Content))),
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
	publication := repository.PublicationOptions{}
	if p.embeddingModel != "" && p.embeddingDimension > 0 {
		publication.Embedding = &repository.EmbeddingIdentity{Model: p.embeddingModel, Dimension: p.embeddingDimension}
	}
	publication.PDFTextSnapshot, err = parser.EncodePDFSnapshot(parsedDocument)
	if err != nil {
		return err
	}
	publishCtx, publishSpan := observability.Start(ctx, "document.publish", attribute.Int("document.chunk_count", len(rows)))
	publishErr := p.chunks.PublishByDocument(publishCtx, document.ID, job.ID, rows, publication)
	observability.Finish(publishSpan, publishErr)
	if err := publishErr; err != nil {
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
