package processor

import (
	"encoding/json"
	"strings"
	"testing"

	"rag/backend/internal/document/splitter"
)

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
