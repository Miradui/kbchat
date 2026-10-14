package ocr

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"
)

func TestOCRCommandHelper(t *testing.T) {
	if os.Getenv("RAG_OCR_COMMAND_HELPER") != "1" {
		return
	}
	switch os.Args[len(os.Args)-1] {
	case "text":
		fmt.Print("中文 OCR text")
		os.Exit(0)
	case "large":
		fmt.Print(strings.Repeat("a", 1024*1024))
		os.Exit(0)
	case "stderr":
		fmt.Fprint(os.Stderr, strings.Repeat("a", 1024*1024))
		os.Exit(0)
	case "failed":
		fmt.Fprint(os.Stderr, "private native error")
		os.Exit(2)
	case "wait":
		time.Sleep(15 * time.Second)
		os.Exit(0)
	}
	os.Exit(3)
}

func TestCommandBoundsAndCancellation(t *testing.T) {
	t.Setenv("RAG_OCR_COMMAND_HELPER", "1")
	for _, test := range []struct {
		name string
		want error
	}{{"text", nil}, {"large", ErrLimit}, {"stderr", ErrLimit}, {"failed", ErrFailed}, {"wait", context.DeadlineExceeded}} {
		t.Run(test.name, func(t *testing.T) {
			timeout := 3 * time.Second
			if test.name == "wait" {
				timeout = 100 * time.Millisecond
			}
			ctx, cancel := context.WithTimeout(context.Background(), timeout)
			defer cancel()
			start := time.Now()
			output, err := run(ctx, os.Args[0], []string{"-test.run=^TestOCRCommandHelper$", "--", test.name}, 128)
			if !errors.Is(err, test.want) {
				t.Fatalf("error = %v, want %v", err, test.want)
			}
			if test.name == "text" && string(output) != "中文 OCR text" {
				t.Fatalf("unexpected text %q", output)
			}
			if err != nil && len(output) != 0 {
				t.Fatal("failure leaked native output")
			}
			if time.Since(start) > 4*time.Second {
				t.Fatal("subprocess did not stop within budget")
			}
		})
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := run(ctx, "not-installed", nil, 100); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	if _, err := run(context.Background(), "rag-ocr-not-installed", nil, 100); !errors.Is(err, ErrUnavailable) {
		t.Fatal(err)
	}
}

func TestPageTimeoutIsDistinctFromUserCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	page, stop := context.WithDeadline(ctx, time.Now().Add(-time.Second))
	defer stop()
	if err := pageError(ctx, page, "render", page.Err()); !errors.Is(err, ErrTimeout) || errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("wrong OCR timeout: %v", err)
	}
	cancel()
	if err := pageError(ctx, page, "render", page.Err()); !errors.Is(err, context.Canceled) {
		t.Fatalf("wrong cancel: %v", err)
	}
}
