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
)

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

func TestWorkerClassifiesTerminalFailuresButNotRetries(t *testing.T) {
	ctx := context.Background()
	store := newFakeDocumentStore()
	failing := &fakeProcessor{err: fmt.Errorf("parse md: %w", parser.ErrEncodingInvalid)}
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
	if store.lastErrorCode != processor.ErrorCodeEncodingInvalid {
		t.Fatalf("expected %q, got %q", processor.ErrorCodeEncodingInvalid, store.lastErrorCode)
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

type fakeDocumentStore struct {
	mu sync.Mutex

	jobs []*model.DocumentJob

	completedJobs   int
	failedJobs      int
	retryCalls      int
	recoverCalls    int
	claimCalls      int
	updatedStatuses int
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
	onRecover := s.onRecover
	s.mu.Unlock()

	if onRecover != nil {
		onRecover()
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
