package main

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"sync"
	"testing"
	"time"
)

func TestServerShutdownDrainsHTTPAndWaitsForWorkers(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	entered, releaseRequest := make(chan struct{}), make(chan struct{})
	var requestOnce sync.Once
	releaseHTTP := func() { requestOnce.Do(func() { close(releaseRequest) }) }
	t.Cleanup(releaseHTTP)
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(entered)
		<-releaseRequest
		_, _ = io.WriteString(w, "complete answer")
	})}
	t.Cleanup(func() { _ = server.Close() })
	workerCtx, stopWorkers := context.WithCancel(context.Background())
	t.Cleanup(stopWorkers)
	workerCancelled, releaseWorker := make(chan struct{}), make(chan struct{})
	var workerOnce sync.Once
	releaseBackground := func() { workerOnce.Do(func() { close(releaseWorker) }) }
	t.Cleanup(releaseBackground)
	var workers sync.WaitGroup
	workers.Go(func() { <-workerCtx.Done(); close(workerCancelled); <-releaseWorker })
	ctx, stop := context.WithCancel(context.Background())
	t.Cleanup(stop)
	finished := make(chan error, 1)
	go func() { finished <- serve(ctx, server, listener, stopWorkers, &workers) }()
	response := make(chan error, 1)
	go func() {
		client := &http.Client{Timeout: 5 * time.Second}
		res, err := client.Get("http://" + listener.Addr().String())
		if err != nil {
			response <- err
			return
		}
		defer res.Body.Close()
		body, err := io.ReadAll(res.Body)
		if err == nil && string(body) != "complete answer" {
			err = errors.New("active HTTP response was truncated")
		}
		response <- err
	}()
	waitSignal(t, entered)
	stop()
	waitSignal(t, workerCancelled)
	select {
	case err := <-finished:
		t.Fatalf("shutdown returned before active work completed: %v", err)
	default:
	}
	releaseHTTP()
	select {
	case err := <-response:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("HTTP response did not drain")
	}
	select {
	case err := <-finished:
		t.Fatalf("shutdown returned before worker exited: %v", err)
	default:
	}
	releaseBackground()
	select {
	case err := <-finished:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("server did not stop")
	}
}

func TestShutdownDeadlineCancelsActiveHTTP(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	entered, cancelled := make(chan struct{}), make(chan struct{})
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(entered)
		<-r.Context().Done()
		close(cancelled)
	})}
	t.Cleanup(func() { _ = server.Close() })
	serving := make(chan error, 1)
	go func() { serving <- server.Serve(listener) }()
	requestDone := make(chan struct{})
	go func() {
		defer close(requestDone)
		client := &http.Client{Timeout: 5 * time.Second}
		res, err := client.Get("http://" + listener.Addr().String())
		if err == nil {
			_ = res.Body.Close()
		}
	}()
	waitSignal(t, entered)
	workerCtx, stopWorkers := context.WithCancel(context.Background())
	defer stopWorkers()
	var workers sync.WaitGroup
	workers.Go(func() { <-workerCtx.Done() })
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	if err := shutdown(ctx, server, stopWorkers, &workers); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected deadline error, got %v", err)
	}
	waitSignal(t, cancelled)
	waitSignal(t, requestDone)
	select {
	case err := <-serving:
		if !errors.Is(err, http.ErrServerClosed) {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("listener remained open")
	}
}

func waitSignal(t *testing.T, signal <-chan struct{}) {
	t.Helper()
	select {
	case <-signal:
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for lifecycle event")
	}
}
