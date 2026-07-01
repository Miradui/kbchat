package splitter

import (
	"fmt"
	"strings"
	"testing"
)

func TestSplitPreservesHeadingPathMetadataAndContentPrefix(t *testing.T) {
	text := strings.Join([]string{
		"# Product Guide",
		"",
		"Intro paragraph for the guide.",
		"",
		"## Permissions",
		"",
		"Only owners can delete a knowledge base.",
	}, "\n")

	chunks := New(30, 5).Split(text)

	if len(chunks) == 0 {
		t.Fatal("expected chunks")
	}

	var permissions Chunk
	for _, chunk := range chunks {
		if strings.Contains(chunk.Content, "Only owners can delete") {
			permissions = chunk
			break
		}
	}

	if permissions.Content == "" {
		t.Fatalf("expected chunk containing permissions paragraph, got %#v", chunks)
	}
	if !strings.HasPrefix(permissions.Content, "Product Guide > Permissions\n") {
		t.Fatalf("expected heading path prefix in content, got %q", permissions.Content)
	}

	headingPath, ok := permissions.Metadata["headingPath"].([]string)
	if !ok {
		t.Fatalf("expected headingPath metadata as []string, got %#v", permissions.Metadata["headingPath"])
	}
	if got := strings.Join(headingPath, " > "); got != "Product Guide > Permissions" {
		t.Fatalf("expected heading path Product Guide > Permissions, got %q", got)
	}
	if permissions.Metadata["structureType"] != "paragraph" {
		t.Fatalf("expected paragraph structure type, got %#v", permissions.Metadata["structureType"])
	}
}

func TestSplitPrefersParagraphBoundariesBeforeHardSplitting(t *testing.T) {
	text := strings.Join([]string{
		"# Release Notes",
		"",
		"Alpha beta gamma delta epsilon zeta.",
		"",
		"Eta theta iota kappa lambda mu.",
	}, "\n")

	chunks := New(10, 0).Split(text)

	if len(chunks) != 2 {
		t.Fatalf("expected 2 paragraph chunks, got %d: %#v", len(chunks), chunks)
	}
	for _, chunk := range chunks {
		if strings.Contains(chunk.Content, "zeta.\n\nEta") {
			t.Fatalf("expected paragraph boundary split, got combined chunk %q", chunk.Content)
		}
		if chunk.TokenCount > 10 {
			t.Fatalf("expected chunk token count <= 10, got %d for %q", chunk.TokenCount, chunk.Content)
		}
	}
}

func TestSplitStabilizesIndexesAndSplitsOversizeBlocks(t *testing.T) {
	var words []string
	for i := 0; i < 80; i++ {
		words = append(words, fmt.Sprintf("word%02d", i))
	}
	text := "# Long Section\n\n" + strings.Join(words, " ")

	chunks := New(20, 5).Split(text)

	if len(chunks) < 2 {
		t.Fatalf("expected oversized paragraph to split into multiple chunks, got %#v", chunks)
	}
	for i, chunk := range chunks {
		if chunk.Index != i {
			t.Fatalf("expected stable chunk index %d, got %d", i, chunk.Index)
		}
		if chunk.TokenCount > 20 {
			t.Fatalf("expected token count <= 20, got %d for %q", chunk.TokenCount, chunk.Content)
		}
		if got := chunk.Metadata["startOffset"]; got == nil {
			t.Fatalf("expected startOffset metadata for chunk %#v", chunk)
		}
		if got := chunk.Metadata["endOffset"]; got == nil {
			t.Fatalf("expected endOffset metadata for chunk %#v", chunk)
		}
	}
}

func TestSplitDropsOverlapBeforeTrimmingNewBlockContent(t *testing.T) {
	text := strings.Join([]string{
		"# Release Notes",
		"",
		"one two three four five six.",
		"",
		"seven eight nine ten eleven twelve.",
	}, "\n")

	chunks := New(8, 4).Split(text)

	if len(chunks) != 2 {
		t.Fatalf("expected 2 chunks, got %d: %#v", len(chunks), chunks)
	}
	if !strings.Contains(chunks[1].Content, "seven eight nine ten eleven twelve.") {
		t.Fatalf("expected second chunk to preserve new paragraph content, got %q", chunks[1].Content)
	}
	if strings.Contains(chunks[1].Content, "five six") {
		t.Fatalf("expected overlap to be dropped when it would trim new content, got %q", chunks[1].Content)
	}
}
