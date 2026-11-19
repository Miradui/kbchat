package job

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"go.uber.org/zap"

	"kbchat/backend/internal/document/parser"
	"kbchat/backend/internal/document/processor"
	"kbchat/backend/internal/model"
	"kbchat/backend/internal/storage"
)

// A panic while processing untrusted input must fail that job, not kill the
// process or the claim loop. Without the recover in processSafely this test
// crashes the whole test binary, which is exactly what used to happen to the
// server on a crafted Markdown table.
func TestWorkerFailsJobAndKeepsClaimingWhenProcessorPanics(t *testing.T) {
	ctx := context.Background()
	store := newFakeDocumentStore()
	for i := 0; i < 2; i++ {
		store.jobs = append(store.jobs, &model.DocumentJob{
			ID:         uuid.New(),
			DocumentID: uuid.New(),
			Status:     "pending",
		})
	}
	worker := NewWorkerWithOptions(store, &panicOnceProcessor{}, zap.NewNop(), Options{
		Concurrency: 1,
		MaxRetries:  3,
		RetryDelay:  time.Minute,
	})

	worker.runOnce(ctx)

	if store.failedJobs != 1 {
		t.Fatalf("expected the panicking job to fail once, got %d", store.failedJobs)
	}
	if store.lastErrorCode != processor.ErrorCodeInternal {
		t.Fatalf("expected %q, got %q", processor.ErrorCodeInternal, store.lastErrorCode)
	}
	if store.completedJobs != 1 {
		t.Fatalf("expected the claim loop to continue and complete the next job, got %d completions", store.completedJobs)
	}
	if store.retryCalls != 0 {
		t.Fatalf("expected a panic to be terminal, got %d retries", store.retryCalls)
	}
}

func TestWorkerRetriesFailedJobBeforeMarkingDocumentFailed(t *testing.T) {
	ctx := context.Background()
	store := newFakeDocumentStore()
	job := &model.DocumentJob{
		ID:         uuid.New(),
		DocumentID: uuid.New(),
		Status:     "running",
		RetryCount: 0,
	}
	processor := &fakeProcessor{err: errors.New("temporary embedding failure")}
	worker := NewWorkerWithOptions(store, processor, zap.NewNop(), Options{
		Concurrency: 1,
		MaxRetries:  2,
		RetryDelay:  time.Minute,
	})

	worker.process(ctx, job)

	if store.retryCalls != 1 {
		t.Fatalf("expected one retry call, got %d", store.retryCalls)
	}
	if store.failedJobs != 0 {
		t.Fatalf("expected job to remain retryable, got %d failed calls", store.failedJobs)
	}
	if store.updatedStatuses != 0 {
		t.Fatalf("expected document status to stay non-failed before retry budget is exhausted")
	}
	if store.lastRetryCount != 1 {
		t.Fatalf("expected retry count 1, got %d", store.lastRetryCount)
	}
	if store.lastRetryAt.Before(time.Now().Add(30 * time.Second)) {
		t.Fatalf("expected retry to be scheduled in the future, got %s", store.lastRetryAt)
	}
}

func TestWorkerFailsJobAfterRetryBudgetIsExhausted(t *testing.T) {
	ctx := context.Background()
	store := newFakeDocumentStore()
	job := &model.DocumentJob{
		ID:         uuid.New(),
		DocumentID: uuid.New(),
		Status:     "running",
		RetryCount: 2,
	}
	processor := &fakeProcessor{err: errors.New("pdf parser failed")}
	worker := NewWorkerWithOptions(store, processor, zap.NewNop(), Options{
		Concurrency: 1,
		MaxRetries:  2,
		RetryDelay:  time.Minute,
	})

	worker.process(ctx, job)

	if store.retryCalls != 0 {
		t.Fatalf("expected no retry after budget exhausted, got %d", store.retryCalls)
	}
	if store.failedJobs != 1 {
		t.Fatalf("expected one failed job call, got %d", store.failedJobs)
	}
	if store.updatedStatuses != 0 {
		t.Fatalf("expected atomic job finalization to own document status, got %d direct updates", store.updatedStatuses)
	}
	if store.lastError != "pdf parser failed" {
		t.Fatalf("expected error message to be stored, got %q", store.lastError)
	}
}

func TestWorkerProcessesJobsConcurrently(t *testing.T) {
	ctx := context.Background()
	store := newFakeDocumentStore()
	for i := 0; i < 4; i++ {
		store.jobs = append(store.jobs, &model.DocumentJob{
			ID:         uuid.New(),
			DocumentID: uuid.New(),
			Status:     "pending",
		})
	}
	processor := newConcurrentProcessor()
	worker := NewWorkerWithOptions(store, processor, zap.NewNop(), Options{
		Concurrency: 2,
		MaxRetries:  1,
		RetryDelay:  time.Minute,
	})

	worker.runOnce(ctx)

	if processor.maxActive != 2 {
		t.Fatalf("expected max active processors 2, got %d", processor.maxActive)
	}
	if store.completedJobs != 4 {
		t.Fatalf("expected 4 completed jobs, got %d", store.completedJobs)
	}
}

func TestWorkerClassifiesOnlyTerminalFailures(t *testing.T) {
	ctx := context.Background()
	store := newFakeDocumentStore()
	failing := &fakeProcessor{err: fmt.Errorf("embed batch: %w", processor.ErrEmbeddingFailed)}
	worker := NewWorkerWithOptions(store, failing, zap.NewNop(), Options{
		Concurrency: 1,
		MaxRetries:  1,
		RetryDelay:  time.Minute,
	})

	// A retry is still in progress, so nothing is classified yet: stamping a
	// reason now would show the user a verdict for work the server is redoing.
	worker.process(ctx, &model.DocumentJob{ID: uuid.New(), DocumentID: uuid.New(), Status: "running"})
	if store.retryCalls != 1 {
		t.Fatalf("expected one retry, got %d", store.retryCalls)
	}
	if store.lastErrorCode != "" {
		t.Fatalf("expected no classification on a retry, got %q", store.lastErrorCode)
	}

	worker.process(ctx, &model.DocumentJob{ID: uuid.New(), DocumentID: uuid.New(), Status: "running", RetryCount: 1})
	if store.failedJobs != 1 {
		t.Fatalf("expected one terminal failure, got %d", store.failedJobs)
	}
	if store.lastErrorCode != processor.ErrorCodeEmbeddingFailed {
		t.Fatalf("expected %q, got %q", processor.ErrorCodeEmbeddingFailed, store.lastErrorCode)
	}
}

// A file that is not UTF-8, is corrupt, has no text layer, or whose object is
// gone fails the same way every time. Retrying only delays the verdict by the
// whole retry budget, so these fail on the first attempt.
func TestWorkerFailsPermanentErrorsWithoutRetrying(t *testing.T) {
	cases := []struct {
		name string
		err  error
		code string
	}{
		{"encoding", fmt.Errorf("parse md: %w", parser.ErrEncodingInvalid), processor.ErrorCodeEncodingInvalid},
		{"corrupt", fmt.Errorf("parse pdf: %w", parser.ErrCorruptFile), processor.ErrorCodeCorruptFile},
		{"empty", processor.ErrEmptyContent, processor.ErrorCodeEmptyContent},
		{"missing object", fmt.Errorf("%w: %w", processor.ErrStorageFailed, storage.ErrNotFound), processor.ErrorCodeStorageFailed},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			store := newFakeDocumentStore()
			worker := NewWorkerWithOptions(store, &fakeProcessor{err: tc.err}, zap.NewNop(), Options{
				Concurrency: 1,
				MaxRetries:  3,
				RetryDelay:  time.Minute,
			})
			worker.process(context.Background(), &model.DocumentJob{ID: uuid.New(), DocumentID: uuid.New(), Status: "running"})
			if store.retryCalls != 0 {
				t.Fatalf("expected no retry, got %d", store.retryCalls)
			}
			if store.failedJobs != 1 || store.lastErrorCode != tc.code {
				t.Fatalf("expected one failure with %q, got %d failures with %q", tc.code, store.failedJobs, store.lastErrorCode)
			}
		})
	}

	// A storage read that failed for any other reason may succeed next time.
	store := newFakeDocumentStore()
	worker := NewWorkerWithOptions(store, &fakeProcessor{err: fmt.Errorf("%w: connection reset", processor.ErrStorageFailed)}, zap.NewNop(), Options{
		Concurrency: 1,
		MaxRetries:  3,
		RetryDelay:  time.Minute,
	})
	worker.process(context.Background(), &model.DocumentJob{ID: uuid.New(), DocumentID: uuid.New(), Status: "running"})
	if store.retryCalls != 1 || store.failedJobs != 0 {
		t.Fatalf("expected a transient storage failure to retry, got %d retries and %d failures", store.retryCalls, store.failedJobs)
	}
}

func TestWorkerRecoversInterruptedJobsBeforeClaiming(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	store := newFakeDocumentStore()
	store.onRecover = cancel
	worker := NewWorkerWithOptions(store, &fakeProcessor{}, zap.NewNop(), Options{
		Interval:    time.Millisecond,
		Concurrency: 1,
	})

	worker.Start(ctx)

	if store.recoverCalls != 1 {
		t.Fatalf("expected interrupted jobs to be recovered once, got %d", store.recoverCalls)
	}
	if store.claimCalls != 0 {
		t.Fatalf("expected recovery to happen before claiming, got %d claim calls", store.claimCalls)
	}
}

// A transient recovery failure used to end Start: HTTP kept answering and uploads
// kept returning 201, but no goroutine ever claimed a job again, so every document
// stayed pending with one ERROR line to explain it.
func TestWorkerRetriesRecoveryInsteadOfStopping(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	store := newFakeDocumentStore()
	store.recoverFailures = 2
	store.jobs = append(store.jobs, &model.DocumentJob{
		ID:         uuid.New(),
		DocumentID: uuid.New(),
		Status:     "pending",
	})
	worker := NewWorkerWithOptions(store, &fakeProcessor{}, zap.NewNop(), Options{
		Interval:    time.Millisecond,
		Concurrency: 1,
		MaxRetries:  1,
		RetryDelay:  5 * time.Millisecond,
	})

	go worker.Start(ctx)

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		store.mu.Lock()
		recovered, completed := store.recoverCalls, store.completedJobs
		store.mu.Unlock()
		if recovered >= 3 && completed == 1 {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("worker never recovered and claimed a job after transient recovery failures")
}

type fakeDocumentStore struct {
	mu sync.Mutex

	jobs []*model.DocumentJob

	completedJobs   int
	failedJobs      int
	retryCalls      int
	recoverCalls    int
	claimCalls      int
	updatedStatuses int
	// recoverFailures makes the next N recovery attempts fail, for the retry path.
	recoverFailures int
	lastRetryCount  int
	lastRetryAt     time.Time
	lastStatus      string
	lastError       string
	lastErrorCode   string
	onRecover       func()
}

func newFakeDocumentStore() *fakeDocumentStore {
	return &fakeDocumentStore{}
}

func (s *fakeDocumentStore) ClaimPendingJob(ctx context.Context) (*model.DocumentJob, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.claimCalls++
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if len(s.jobs) == 0 {
		return nil, nil
	}
	job := s.jobs[0]
	s.jobs = s.jobs[1:]
	job.Status = "running"
	return job, nil
}

func (s *fakeDocumentStore) RecoverRunningJobs(context.Context) error {
	s.mu.Lock()
	s.recoverCalls++
	failing := s.recoverFailures > 0
	if failing {
		s.recoverFailures--
	}
	onRecover := s.onRecover
	s.mu.Unlock()

	if onRecover != nil {
		onRecover()
	}
	if failing {
		return errors.New("database is starting up")
	}
	return nil
}

func (s *fakeDocumentStore) UpdateStatus(_ context.Context, _ uuid.UUID, status string, errorMessage string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.updatedStatuses++
	s.lastStatus = status
	s.lastError = errorMessage
	return nil
}

func (s *fakeDocumentStore) CompleteJob(_ context.Context, _ uuid.UUID) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.completedJobs++
	return nil
}

func (s *fakeDocumentStore) FailJob(_ context.Context, _ uuid.UUID, message string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.failedJobs++
	s.lastError = message
	return nil
}

func (s *fakeDocumentStore) FailJobWithCode(_ context.Context, _ uuid.UUID, message, errorCode string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.failedJobs++
	s.lastError = message
	s.lastErrorCode = errorCode
	return nil
}

func (s *fakeDocumentStore) RetryJob(_ context.Context, _ uuid.UUID, retryCount int, retryAt time.Time, message string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.retryCalls++
	s.lastRetryCount = retryCount
	s.lastRetryAt = retryAt
	s.lastError = message
	return nil
}

type fakeProcessor struct {
	err error
}

func (p *fakeProcessor) Process(context.Context, *model.DocumentJob) error {
	return p.err
}

// panicOnceProcessor panics on its first call and succeeds afterwards, so one
// runOnce proves both that the panic is contained and that the claim loop
// continues with the next job.
type panicOnceProcessor struct {
	mu    sync.Mutex
	calls int
}

func (p *panicOnceProcessor) Process(context.Context, *model.DocumentJob) error {
	p.mu.Lock()
	p.calls++
	call := p.calls
	p.mu.Unlock()
	if call == 1 {
		panic("slice bounds out of range [1:0]")
	}
	return nil
}

type concurrentProcessor struct {
	mu        sync.Mutex
	active    int
	maxActive int
}

func newConcurrentProcessor() *concurrentProcessor {
	return &concurrentProcessor{}
}

func (p *concurrentProcessor) Process(context.Context, *model.DocumentJob) error {
	p.mu.Lock()
	p.active++
	if p.active > p.maxActive {
		p.maxActive = p.active
	}
	p.mu.Unlock()

	time.Sleep(20 * time.Millisecond)

	p.mu.Lock()
	p.active--
	p.mu.Unlock()
	return nil
}
