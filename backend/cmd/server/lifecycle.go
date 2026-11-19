package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"sync"
	"time"
)

// Leave five seconds before the deployment unit's 30-second stop deadline.
const shutdownTimeout = 25 * time.Second

func serve(ctx context.Context, server *http.Server, listener net.Listener, stopWorkers context.CancelFunc, workers *sync.WaitGroup) error {
	serving := make(chan error, 1)
	go func() { serving <- server.Serve(listener) }()
	var serveErr error
	select {
	case <-ctx.Done():
	case serveErr = <-serving:
		if errors.Is(serveErr, http.ErrServerClosed) {
			serveErr = nil
		}
	}
	shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()
	return errors.Join(serveErr, shutdown(shutdownCtx, server, stopWorkers, workers))
}

// HTTP requests drain with their original contexts; workers stop claiming and
// cancel their current work. Dependencies remain open until both have exited or
// the shutdown deadline expires. Close cancels any HTTP requests still active.
func shutdown(ctx context.Context, server *http.Server, stopWorkers context.CancelFunc, workers *sync.WaitGroup) error {
	stopWorkers()
	workersDone := make(chan struct{})
	go func() { workers.Wait(); close(workersDone) }()
	httpErr := server.Shutdown(ctx)
	if httpErr != nil {
		httpErr = errors.Join(httpErr, server.Close())
	}
	select {
	case <-workersDone:
		return httpErr
	case <-ctx.Done():
		return errors.Join(httpErr, fmt.Errorf("wait for background workers: %w", ctx.Err()))
	}
}
