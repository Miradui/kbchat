package storage

import (
	"context"
	"errors"
	"github.com/google/uuid"
	"os"
	"strings"
	"testing"
)

func TestLocalSaveKnowledgeBaseObject(t *testing.T) {
	s := NewLocalStorage(t.TempDir())
	location := s.NewKnowledgeBaseFileLocation(uuid.New(), "note.md")
	text := "# 中文\nbody"
	if err := s.SaveKnowledgeBaseObject(context.Background(), location, strings.NewReader(text), int64(len(text))); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(location)
	if err != nil || string(data) != text {
		t.Fatalf("%q %v", data, err)
	}
	if err := s.SaveKnowledgeBaseObject(context.Background(), location, strings.NewReader("too long"), 2); err == nil {
		t.Fatal("expected size mismatch")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := s.SaveKnowledgeBaseObject(ctx, location, strings.NewReader(text), int64(len(text))); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancel: %v", err)
	}
}
