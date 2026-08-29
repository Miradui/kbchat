package processor

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/pgvector/pgvector-go"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"

	"kbchat/backend/internal/document/parser"
	"kbchat/backend/internal/document/splitter"
	"kbchat/backend/internal/model"
	"kbchat/backend/internal/repository"
	"kbchat/backend/internal/storage"
)

type structuredParser struct {
	document parser.ParsedDocument
}

type pathRecordingParser struct {
	path string
}

func (p *pathRecordingParser) ParseDocument(path string, fileType string) (parser.ParsedDocument, error) {
	p.path = path
	return parser.ParsedDocument{FileType: fileType, Segments: []parser.Segment{{Content: "remote content"}}}, nil
}

type materializingStorage struct {
	requestedLocation string
	materializedPath  string
	cleaned           bool
}

func (*materializingStorage) NewKnowledgeBaseFileLocation(uuid.UUID, string) string {
	return ""
}

func (*materializingStorage) SaveKnowledgeBaseFile(context.Context, string, *multipart.FileHeader) error {
	return errors.New("not implemented")
}

func (*materializingStorage) Delete(context.Context, string) error {
	return errors.New("not implemented")
}

func (*materializingStorage) Open(context.Context, string) (io.ReadCloser, storage.ObjectInfo, error) {
	return nil, storage.ObjectInfo{}, errors.New("not implemented")
}

func (*materializingStorage) Read(context.Context, string) ([]byte, error) {
	return nil, errors.New("not implemented")
}

func (*materializingStorage) Stat(context.Context, string) (storage.ObjectInfo, error) {
	return storage.ObjectInfo{}, errors.New("not implemented")
}

func (s *materializingStorage) Materialize(_ context.Context, location string) (string, func(), error) {
	s.requestedLocation = location
	temporary, err := os.CreateTemp("", "processor-materialized-*")
	if err != nil {
		return "", nil, err
	}
	if err := temporary.Close(); err != nil {
		return "", nil, err
	}
	s.materializedPath = temporary.Name()
	return temporary.Name(), func() {
		s.cleaned = true
		_ = os.Remove(temporary.Name())
	}, nil
}

func TestProcessMaterializesRemoteObjectAndCleansTemporaryFile(t *testing.T) {
	fixture := newProcessorTestFixture(t, "txt")
	location := "minio://rag-documents/object.txt"
	if err := fixture.db.Model(&model.Document{}).Where("id = ?", fixture.document.ID).Update("storage_path", location).Error; err != nil {
		t.Fatalf("update storage path: %v", err)
	}
	fileStorage := &materializingStorage{}
	parser := &pathRecordingParser{}
	processor := NewWithStorage(
		fixture.documents,
		fixture.chunks,
		parser,
		splitter.New(splitter.DefaultChunkSize, splitter.DefaultChunkOverlap),
		cardinalityEmbedder{},
		fileStorage,
	)

	if err := processor.Process(context.Background(), &fixture.job); err != nil {
		t.Fatalf("process remote document: %v", err)
	}
	if fileStorage.requestedLocation != location || parser.path != fileStorage.materializedPath {
		t.Fatalf("expected parser to receive materialized path, location=%q parserPath=%q materializedPath=%q", fileStorage.requestedLocation, parser.path, fileStorage.materializedPath)
	}
	if !fileStorage.cleaned {
		t.Fatal("expected materialized file cleanup")
	}
	if _, err := os.Stat(fileStorage.materializedPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("expected temporary file to be removed, got %v", err)
	}
}

func (p structuredParser) ParseDocument(_ string, _ string) (parser.ParsedDocument, error) {
	return p.document, nil
}

type cardinalityEmbedder struct {
	delta int
}

func (e cardinalityEmbedder) EmbedTexts(_ context.Context, texts []string) ([][]float32, error) {
	count := len(texts) + e.delta
	if count < 0 {
		count = 0
	}
	vectors := make([][]float32, count)
	for index := range vectors {
		vectors[index] = []float32{float32(index + 1)}
	}
	return vectors, nil
}

type lateMismatchEmbedder struct {
	delta int
	calls int
}

type blockingBatchEmbedder struct {
	firstStarted chan struct{}
	releaseFirst chan struct{}
	once         sync.Once
	mu           sync.Mutex
	calls        int
}

func newBlockingBatchEmbedder() *blockingBatchEmbedder {
	return &blockingBatchEmbedder{
		firstStarted: make(chan struct{}),
		releaseFirst: make(chan struct{}),
	}
}

func (e *blockingBatchEmbedder) EmbedTexts(ctx context.Context, texts []string) ([][]float32, error) {
	e.mu.Lock()
	e.calls++
	call := e.calls
	e.mu.Unlock()

	if call == 1 {
		e.once.Do(func() { close(e.firstStarted) })
		select {
		case <-e.releaseFirst:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	return embeddingVectors(texts), nil
}

func (e *blockingBatchEmbedder) callCount() int {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.calls
}

type cancellingEmbedder struct {
	cancel func() error
	err    error
	calls  int
}

func (e *cancellingEmbedder) EmbedTexts(_ context.Context, texts []string) ([][]float32, error) {
	e.calls++
	if e.calls == 1 {
		e.err = e.cancel()
	}
	return embeddingVectors(texts), nil
}

func embeddingVectors(texts []string) [][]float32 {
	vectors := make([][]float32, len(texts))
	for index := range vectors {
		vectors[index] = []float32{float32(index + 1)}
	}
	return vectors
}

func (e *lateMismatchEmbedder) EmbedTexts(_ context.Context, texts []string) ([][]float32, error) {
	e.calls++
	count := len(texts)
	if e.calls == 2 {
		count += e.delta
	}
	if count < 0 {
		count = 0
	}
	vectors := make([][]float32, count)
	for index := range vectors {
		vectors[index] = []float32{float32(index + 1)}
	}
	return vectors, nil
}

type processorTestFixture struct {
	db        *gorm.DB
	documents *repository.DocumentRepository
	chunks    *repository.ChunkRepository
	document  model.Document
	job       model.DocumentJob
}

func TestBuildChunkMetadataMergesSplitterMetadata(t *testing.T) {
	metadataBytes, err := buildChunkMetadata(splitter.Chunk{
		Metadata: map[string]any{
			"source":        "splitter",
			"headingPath":   []string{"Product Guide", "Permissions"},
			"structureType": "paragraph",
			"startOffset":   42,
			"endOffset":     128,
		},
	})
	if err != nil {
		t.Fatalf("build chunk metadata: %v", err)
	}

	var metadata map[string]any
	if err := json.Unmarshal(metadataBytes, &metadata); err != nil {
		t.Fatalf("unmarshal metadata: %v", err)
	}

	if metadata["source"] != "document_processor" {
		t.Fatalf("expected document processor source to be preserved, got %#v", metadata["source"])
	}
	if metadata["structureType"] != "paragraph" {
		t.Fatalf("expected structure type metadata, got %#v", metadata["structureType"])
	}

	headingPath, ok := metadata["headingPath"].([]any)
	if !ok {
		t.Fatalf("expected heading path array metadata, got %#v", metadata["headingPath"])
	}
	if len(headingPath) != 2 || headingPath[0] != "Product Guide" || headingPath[1] != "Permissions" {
		t.Fatalf("unexpected heading path metadata: %#v", headingPath)
	}
	if metadata["startOffset"] == nil || metadata["endOffset"] == nil {
		t.Fatalf("expected offset metadata, got %#v", metadata)
	}
}

func TestValidateEmbeddingCountRejectsProviderCardinalityMismatch(t *testing.T) {
	tests := []struct {
		name     string
		expected int
		actual   int
		wantErr  bool
	}{
		{name: "matching vectors", expected: 2, actual: 2, wantErr: false},
		{name: "missing vector", expected: 2, actual: 1, wantErr: true},
		{name: "extra vector", expected: 1, actual: 2, wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validateEmbeddingCount(tt.expected, tt.actual)
			if !tt.wantErr {
				if err != nil {
					t.Fatalf("expected matching batch to pass, got %v", err)
				}
				return
			}
			if err == nil {
				t.Fatal("expected embedding cardinality mismatch error")
			}
			if !strings.Contains(err.Error(), "embedding provider returned") {
				t.Fatalf("expected actionable provider error, got %q", err)
			}
		})
	}
}

func TestProcessPersistsStructuredPDFPages(t *testing.T) {
	pageOne := 1
	pageThree := 3
	parsed := parser.ParsedDocument{
		FileType: "pdf",
		Segments: []parser.Segment{
			{Content: "first physical page", PageNumber: &pageOne},
			{Content: "third physical page", PageNumber: &pageThree},
		},
	}
	fixture := newProcessorTestFixture(t, "pdf")
	processor := New(
		fixture.documents,
		fixture.chunks,
		structuredParser{document: parsed},
		splitter.New(100, 10),
		cardinalityEmbedder{},
	)

	if err := processor.Process(context.Background(), &fixture.job); err != nil {
		t.Fatalf("process PDF: %v", err)
	}

	chunks, err := fixture.chunks.ListByDocument(context.Background(), fixture.document.ID)
	if err != nil {
		t.Fatalf("list PDF chunks: %v", err)
	}
	if len(chunks) != 2 {
		t.Fatalf("expected one stored chunk per non-empty PDF page, got %#v", chunks)
	}
	for index, expectedPage := range []int{1, 3} {
		chunk := chunks[index]
		if chunk.PageNumber == nil || *chunk.PageNumber != expectedPage {
			t.Fatalf("expected physical page %d at chunk %d, got %#v", expectedPage, index, chunk)
		}
		metadata := decodeChunkMetadata(t, chunk.Metadata)
		if metadata["fileType"] != "pdf" || metadata["pageNumber"] != float64(expectedPage) {
			t.Fatalf("expected stored PDF metadata for page %d, got %#v", expectedPage, metadata)
		}
	}
}

func TestProcessPublishesTerminalStatusWithChunks(t *testing.T) {
	fixture := newProcessorTestFixture(t, "txt")
	processor := New(
		fixture.documents,
		fixture.chunks,
		structuredParser{document: parser.ParsedDocument{
			FileType: "txt",
			Segments: []parser.Segment{{Content: "content"}},
		}},
		splitter.New(100, 10),
		cardinalityEmbedder{},
	)

	if err := processor.Process(context.Background(), &fixture.job); err != nil {
		t.Fatalf("process document: %v", err)
	}
	document, err := fixture.documents.FindByID(context.Background(), fixture.document.ID)
	if err != nil || document == nil {
		t.Fatalf("reload document: document=%#v err=%v", document, err)
	}
	if document.Status != "completed" {
		t.Fatalf("expected document completion to publish with chunks, got %q", document.Status)
	}
	var job model.DocumentJob
	if err := fixture.db.First(&job, "id = ?", fixture.job.ID).Error; err != nil {
		t.Fatalf("reload job: %v", err)
	}
	if job.Status != "completed" {
		t.Fatalf("expected job completion to publish with chunks, got %q", job.Status)
	}
}

func TestProcessSelectsSplitterStrategyFromParsedFileType(t *testing.T) {
	tests := []struct {
		name               string
		fileType           string
		content            string
		wantHeadingPathLen int
		wantLiteral        string
	}{
		{
			name:        "plain text keeps markdown syntax literal",
			fileType:    "txt",
			content:     "# literal heading\n- literal list\nvalue | is | literal",
			wantLiteral: "# literal heading",
		},
		{
			name:               "markdown preserves heading structure",
			fileType:           "md",
			content:            "# Product Guide\nbody text",
			wantHeadingPathLen: 1,
			wantLiteral:        "Product Guide\nbody text",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			fixture := newProcessorTestFixture(t, tt.fileType)
			parsed := parser.ParsedDocument{
				FileType: tt.fileType,
				Segments: []parser.Segment{{Content: tt.content}},
			}
			processor := New(
				fixture.documents,
				fixture.chunks,
				structuredParser{document: parsed},
				splitter.New(100, 10),
				cardinalityEmbedder{},
			)

			if err := processor.Process(context.Background(), &fixture.job); err != nil {
				t.Fatalf("process %s: %v", tt.fileType, err)
			}
			chunks, err := fixture.chunks.ListByDocument(context.Background(), fixture.document.ID)
			if err != nil || len(chunks) != 1 {
				t.Fatalf("expected one stored %s chunk, chunks=%#v err=%v", tt.fileType, chunks, err)
			}
			if !strings.Contains(chunks[0].Content, tt.wantLiteral) {
				t.Fatalf("expected %q in stored %s content %q", tt.wantLiteral, tt.fileType, chunks[0].Content)
			}
			metadata := decodeChunkMetadata(t, chunks[0].Metadata)
			if metadata["fileType"] != tt.fileType {
				t.Fatalf("expected %s metadata, got %#v", tt.fileType, metadata)
			}
			headingPathLength := 0
			if headingPath := metadata["headingPath"]; headingPath != nil {
				values, ok := headingPath.([]any)
				if !ok {
					t.Fatalf("expected heading path array or null, got %#v", headingPath)
				}
				headingPathLength = len(values)
			}
			if headingPathLength != tt.wantHeadingPathLen {
				t.Fatalf("expected heading path length %d, got %#v", tt.wantHeadingPathLen, metadata["headingPath"])
			}
		})
	}
}

func TestProcessDoesNotWriteEmbeddingCardinalityMismatch(t *testing.T) {
	for _, delta := range []int{-1, 1} {
		t.Run(fmt.Sprintf("delta_%d", delta), func(t *testing.T) {
			fixture := newProcessorTestFixture(t, "txt")
			parsed := parser.ParsedDocument{
				FileType: "txt",
				Segments: []parser.Segment{{Content: "alpha beta"}},
			}
			processor := New(
				fixture.documents,
				fixture.chunks,
				structuredParser{document: parsed},
				splitter.New(100, 10),
				cardinalityEmbedder{delta: delta},
			)

			err := processor.Process(context.Background(), &fixture.job)
			if err == nil || !strings.Contains(err.Error(), "embedding provider returned") {
				t.Fatalf("expected cardinality mismatch error, got %v", err)
			}
			chunks, listErr := fixture.chunks.ListByDocument(context.Background(), fixture.document.ID)
			if listErr != nil {
				t.Fatalf("list chunks after mismatch: %v", listErr)
			}
			if len(chunks) != 0 {
				t.Fatalf("expected mismatched embedding batch not to be stored, got %#v", chunks)
			}
		})
	}
}

func TestProcessPreservesExistingChunksWhenLaterEmbeddingBatchMismatches(t *testing.T) {
	for _, delta := range []int{-1, 1} {
		t.Run(fmt.Sprintf("delta_%d", delta), func(t *testing.T) {
			fixture := newProcessorTestFixture(t, "txt")
			ctx := context.Background()
			existing := model.DocumentChunk{
				DocumentID:      fixture.document.ID,
				KnowledgeBaseID: fixture.document.KnowledgeBaseID,
				ChunkIndex:      0,
				Content:         "existing complete index",
				Embedding:       pgvector.NewVector([]float32{1}),
			}
			if err := fixture.chunks.CreateBatch(ctx, []model.DocumentChunk{existing}); err != nil {
				t.Fatalf("seed existing chunk: %v", err)
			}

			segments := make([]parser.Segment, embeddingBatchSize+1)
			for index := range segments {
				segments[index] = parser.Segment{Content: fmt.Sprintf("new segment %02d", index)}
			}
			embedder := &lateMismatchEmbedder{delta: delta}
			processor := New(
				fixture.documents,
				fixture.chunks,
				structuredParser{document: parser.ParsedDocument{FileType: "txt", Segments: segments}},
				splitter.New(100, 10),
				embedder,
			)

			err := processor.Process(ctx, &fixture.job)
			if err == nil || !strings.Contains(err.Error(), "embedding provider returned") {
				t.Fatalf("expected later cardinality mismatch, got %v", err)
			}
			if embedder.calls != 2 {
				t.Fatalf("expected mismatch on second embedding batch, got %d calls", embedder.calls)
			}
			var storedJob model.DocumentJob
			if queryErr := fixture.db.First(&storedJob, "id = ?", fixture.job.ID).Error; queryErr != nil {
				t.Fatalf("read progress after first completed batch: %v", queryErr)
			}
			if storedJob.Progress <= 50 || storedJob.Progress >= 100 {
				t.Fatalf("expected persisted intermediate embedding progress, got %d", storedJob.Progress)
			}
			chunks, listErr := fixture.chunks.ListByDocument(ctx, fixture.document.ID)
			if listErr != nil {
				t.Fatalf("list chunks after later mismatch: %v", listErr)
			}
			if len(chunks) != 1 || chunks[0].Content != existing.Content {
				t.Fatalf("expected existing complete index to remain untouched, got %#v", chunks)
			}
		})
	}
}

func TestProcessStopsRemainingEmbeddingBatchesAfterConcurrentCancel(t *testing.T) {
	fixture := newProcessorTestFixture(t, "txt")
	ctx := context.Background()
	existing := seedExistingProcessorChunk(t, fixture, "existing complete index")

	segments := make([]parser.Segment, embeddingBatchSize+1)
	for index := range segments {
		segments[index] = parser.Segment{Content: fmt.Sprintf("new segment %02d", index)}
	}
	embedder := newBlockingBatchEmbedder()
	processor := New(
		fixture.documents,
		fixture.chunks,
		structuredParser{document: parser.ParsedDocument{FileType: "txt", Segments: segments}},
		splitter.New(100, 10),
		embedder,
	)

	result := make(chan error, 1)
	go func() {
		result <- processor.Process(ctx, &fixture.job)
	}()

	select {
	case <-embedder.firstStarted:
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for the first embedding batch")
	}
	if _, err := fixture.documents.CancelActiveJob(ctx, fixture.document.ID, fixture.document.UploaderID); err != nil {
		t.Fatalf("cancel active job: %v", err)
	}
	close(embedder.releaseFirst)

	var processErr error
	select {
	case processErr = <-result:
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for processor cancellation")
	}
	if !errors.Is(processErr, repository.ErrDocumentJobCancelled) {
		t.Fatalf("expected ErrDocumentJobCancelled, got %v", processErr)
	}
	if embedder.callCount() != 1 {
		t.Fatalf("expected cancellation to stop remaining embedding batches, got %d calls", embedder.callCount())
	}
	assertCancelledProcessorState(t, fixture, existing)
}

func TestProcessDoesNotPublishWhenCancelCommitsImmediatelyBeforePublish(t *testing.T) {
	fixture := newProcessorTestFixture(t, "txt")
	ctx := context.Background()
	existing := seedExistingProcessorChunk(t, fixture, "existing complete index")

	embedder := &cancellingEmbedder{cancel: func() error {
		_, err := fixture.documents.CancelActiveJob(ctx, fixture.document.ID, fixture.document.UploaderID)
		return err
	}}
	processor := New(
		fixture.documents,
		fixture.chunks,
		structuredParser{document: parser.ParsedDocument{
			FileType: "txt",
			Segments: []parser.Segment{{Content: "replacement content"}},
		}},
		splitter.New(100, 10),
		embedder,
	)

	err := processor.Process(ctx, &fixture.job)
	if embedder.err != nil {
		t.Fatalf("cancel immediately before publish: %v", embedder.err)
	}
	if !errors.Is(err, repository.ErrDocumentJobCancelled) {
		t.Fatalf("expected publish to reject the cancelled job, got %v", err)
	}
	assertCancelledProcessorState(t, fixture, existing)
}

func TestProcessPublishesChunksAndCompletesJobBeforeCancelCanWin(t *testing.T) {
	fixture := newProcessorTestFixture(t, "txt")
	processor := New(
		fixture.documents,
		fixture.chunks,
		structuredParser{document: parser.ParsedDocument{
			FileType: "txt",
			Segments: []parser.Segment{{Content: "published content"}},
		}},
		splitter.New(100, 10),
		cardinalityEmbedder{},
	)

	if err := processor.Process(context.Background(), &fixture.job); err != nil {
		t.Fatalf("process document: %v", err)
	}

	var document model.Document
	if err := fixture.db.First(&document, "id = ?", fixture.document.ID).Error; err != nil {
		t.Fatalf("reload published document: %v", err)
	}
	var job model.DocumentJob
	if err := fixture.db.First(&job, "id = ?", fixture.job.ID).Error; err != nil {
		t.Fatalf("reload published job: %v", err)
	}
	if document.Status != "completed" || job.Status != "completed" {
		t.Fatalf("expected chunks and terminal state to publish atomically, document=%q job=%q", document.Status, job.Status)
	}
	if _, err := fixture.documents.CancelActiveJob(
		context.Background(), fixture.document.ID, fixture.document.UploaderID,
	); !errors.Is(err, repository.ErrDocumentJobNotCancellable) {
		t.Fatalf("expected completed publish to beat a later cancel, got %v", err)
	}
}

func seedExistingProcessorChunk(t *testing.T, fixture processorTestFixture, content string) model.DocumentChunk {
	t.Helper()
	chunks := []model.DocumentChunk{{
		DocumentID:      fixture.document.ID,
		KnowledgeBaseID: fixture.document.KnowledgeBaseID,
		ChunkIndex:      0,
		Content:         content,
		Embedding:       pgvector.NewVector([]float32{1}),
	}}
	if err := fixture.chunks.CreateBatch(context.Background(), chunks); err != nil {
		t.Fatalf("seed existing chunk: %v", err)
	}
	return chunks[0]
}

func assertCancelledProcessorState(t *testing.T, fixture processorTestFixture, existing model.DocumentChunk) {
	t.Helper()
	stored, err := fixture.chunks.ListByDocument(context.Background(), fixture.document.ID)
	if err != nil {
		t.Fatalf("list chunks after cancellation: %v", err)
	}
	if len(stored) != 1 || stored[0].ID != existing.ID || stored[0].Content != existing.Content {
		t.Fatalf("expected the original chunks to remain untouched, got %#v", stored)
	}

	var job model.DocumentJob
	if err := fixture.db.First(&job, "id = ?", fixture.job.ID).Error; err != nil {
		t.Fatalf("reload cancelled job: %v", err)
	}
	if job.Status != "cancelled" || job.ErrorMessage != repository.DocumentJobCancelledMessage {
		t.Fatalf("expected cancelled job state, got %#v", job)
	}
	var document model.Document
	if err := fixture.db.First(&document, "id = ?", fixture.document.ID).Error; err != nil {
		t.Fatalf("reload cancelled document: %v", err)
	}
	if document.Status != "failed" || document.ErrorMessage != repository.DocumentJobCancelledMessage {
		t.Fatalf("expected cancelled document state, got %#v", document)
	}
}

func newProcessorTestFixture(t *testing.T, fileType string) processorTestFixture {
	t.Helper()

	dsn := fmt.Sprintf("file:%s?mode=memory&cache=shared", uuid.NewString())
	db, err := gorm.Open(sqlite.Open(dsn), &gorm.Config{})
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatalf("get sqlite connection: %v", err)
	}
	sqlDB.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = sqlDB.Close() })

	if err := db.AutoMigrate(
		&model.User{},
		&model.KnowledgeBase{},
		&model.Document{},
		&model.DocumentJob{},
		&model.DocumentChunk{},
	); err != nil {
		t.Fatalf("auto migrate processor fixture: %v", err)
	}

	user := model.User{Username: "processor-" + uuid.NewString(), PasswordHash: "hash"}
	if err := db.Create(&user).Error; err != nil {
		t.Fatalf("create processor user: %v", err)
	}
	knowledgeBase := model.KnowledgeBase{Name: "Processor Test", OwnerID: user.ID}
	if err := db.Create(&knowledgeBase).Error; err != nil {
		t.Fatalf("create processor knowledge base: %v", err)
	}
	document := model.Document{
		KnowledgeBaseID: knowledgeBase.ID,
		UploaderID:      user.ID,
		Filename:        "fixture." + fileType,
		FileType:        fileType,
		StoragePath:     "unused-by-structured-parser",
		Status:          "uploaded",
	}
	if err := db.Create(&document).Error; err != nil {
		t.Fatalf("create processor document: %v", err)
	}
	// The processor writes stage updates through the job that claimed the work,
	// so the fixture needs a real running job rather than a zero value.
	job := model.DocumentJob{
		DocumentID: document.ID,
		JobType:    "process_document",
		Status:     "running",
	}
	if err := db.Create(&job).Error; err != nil {
		t.Fatalf("create processor job: %v", err)
	}

	return processorTestFixture{
		db:        db,
		documents: repository.NewDocumentRepository(db),
		chunks:    repository.NewChunkRepository(db),
		document:  document,
		job:       job,
	}
}

func decodeChunkMetadata(t *testing.T, raw []byte) map[string]any {
	t.Helper()
	var metadata map[string]any
	if err := json.Unmarshal(raw, &metadata); err != nil {
		t.Fatalf("decode chunk metadata: %v", err)
	}
	return metadata
}
