package splitter

import (
	"fmt"
	"strings"
	"testing"

	"rag/backend/internal/document/parser"
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

func TestSplitDocumentTreatsPlainTextSyntaxAsLiteralContent(t *testing.T) {
	document := parser.ParsedDocument{
		FileType: "txt",
		Segments: []parser.Segment{{
			Content: "# literal heading\n- literal list\nvalue | is | literal",
		}},
	}

	chunks := New(100, 10).SplitDocument(document)

	if len(chunks) != 1 {
		t.Fatalf("expected one plain-text chunk, got %#v", chunks)
	}
	for _, literal := range []string{"# literal heading", "- literal list", "value | is | literal"} {
		if !strings.Contains(chunks[0].Content, literal) {
			t.Fatalf("expected literal syntax %q to remain in %q", literal, chunks[0].Content)
		}
	}
	if chunks[0].Metadata["structureType"] != "paragraph" {
		t.Fatalf("expected TXT paragraph structure, got %#v", chunks[0].Metadata)
	}
	if path, ok := chunks[0].Metadata["headingPath"].([]string); !ok || len(path) != 0 {
		t.Fatalf("expected TXT heading path to stay empty, got %#v", chunks[0].Metadata["headingPath"])
	}
	if chunks[0].Metadata["fileType"] != "txt" {
		t.Fatalf("expected TXT file type metadata, got %#v", chunks[0].Metadata)
	}
}

func TestSplitDocumentPreservesPDFPageBoundariesAndIndexes(t *testing.T) {
	pageOne := 1
	pageThree := 3
	document := parser.ParsedDocument{
		FileType: "pdf",
		Segments: []parser.Segment{
			{Content: "# literal PDF line\nalpha page content", PageNumber: &pageOne},
			{Content: "beta page content", PageNumber: &pageThree},
		},
	}

	chunks := New(100, 20).SplitDocument(document)

	if len(chunks) != 2 {
		t.Fatalf("expected one chunk per PDF page, got %#v", chunks)
	}
	for index, chunk := range chunks {
		if chunk.Index != index {
			t.Fatalf("expected stable global index %d, got %d", index, chunk.Index)
		}
		if chunk.PageNumber == nil {
			t.Fatalf("expected PDF page number on chunk %#v", chunk)
		}
		if chunk.Metadata["fileType"] != "pdf" || chunk.Metadata["structureType"] != "paragraph" {
			t.Fatalf("expected plain PDF metadata, got %#v", chunk.Metadata)
		}
		if chunk.Metadata["pageNumber"] != *chunk.PageNumber {
			t.Fatalf("expected metadata page number to match chunk at %d, got %#v", index, chunk)
		}
	}
	if *chunks[0].PageNumber != 1 || *chunks[1].PageNumber != 3 {
		t.Fatalf("expected physical page numbers 1 and 3, got %#v", chunks)
	}
	if !strings.Contains(chunks[0].Content, "# literal PDF line") {
		t.Fatalf("expected PDF syntax to stay literal, got %q", chunks[0].Content)
	}
	if strings.Contains(chunks[1].Content, "alpha page content") {
		t.Fatalf("expected overlap not to cross PDF pages, got %q", chunks[1].Content)
	}
}

func TestSplitDocumentKeepsOversizePDFChunksWithinTheirPage(t *testing.T) {
	pageOne := 1
	pageTwo := 2
	words := make([]string, 0, 45)
	for i := 0; i < 45; i++ {
		words = append(words, fmt.Sprintf("word%02d", i))
	}
	document := parser.ParsedDocument{
		FileType: "pdf",
		Segments: []parser.Segment{
			{Content: strings.Join(words, " "), PageNumber: &pageOne},
			{Content: "second page", PageNumber: &pageTwo},
		},
	}

	chunks := New(10, 2).SplitDocument(document)

	if len(chunks) < 3 {
		t.Fatalf("expected the first page to split, got %#v", chunks)
	}
	lastIndex := len(chunks) - 1
	for index, chunk := range chunks {
		if chunk.Index != index || chunk.TokenCount > 10 {
			t.Fatalf("unexpected chunk budget/index at %d: %#v", index, chunk)
		}
		if chunk.PageNumber == nil {
			t.Fatalf("expected page number at %d", index)
		}
		expectedPage := 1
		if index == lastIndex {
			expectedPage = 2
		}
		if *chunk.PageNumber != expectedPage || chunk.Metadata["pageNumber"] != expectedPage {
			t.Fatalf("expected chunk %d to remain on page %d, got %#v", index, expectedPage, chunk)
		}
	}
	if *chunks[len(chunks)-1].PageNumber != 2 || chunks[len(chunks)-1].Content != "second page" {
		t.Fatalf("expected final chunk to belong only to page 2, got %#v", chunks[len(chunks)-1])
	}
}

func TestSplitDocumentKeepsMergedChunkStartAtZero(t *testing.T) {
	text := "alpha beta\n\ngamma delta"
	document := parser.ParsedDocument{
		FileType: "txt",
		Segments: []parser.Segment{{Content: text}},
	}

	chunks := New(100, 10).SplitDocument(document)

	if len(chunks) != 1 {
		t.Fatalf("expected merged plain-text chunk, got %#v", chunks)
	}
	if chunks[0].Metadata["startOffset"] != 0 || chunks[0].Metadata["endOffset"] != len(text) {
		t.Fatalf("expected merged source range [0,%d], got %#v", len(text), chunks[0].Metadata)
	}
}

func TestSplitDocumentMapsOversizePrimaryContentToNormalizedSegment(t *testing.T) {
	tests := []struct {
		name string
		text string
	}{
		{name: "ascii", text: "zero one two three four five six seven eight nine ten eleven"},
		{name: "utf8", text: "甲乙 丙丁 戊己 庚辛 壬癸 子丑 寅卯 辰巳"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			chunks := New(6, 2).SplitDocument(parser.ParsedDocument{
				FileType: "txt",
				Segments: []parser.Segment{{Content: tt.text}},
			})
			if len(chunks) < 2 {
				t.Fatalf("expected oversized text to split, got %#v", chunks)
			}

			previousEnd := 0
			for index, chunk := range chunks {
				start, startOK := chunk.Metadata["startOffset"].(int)
				end, endOK := chunk.Metadata["endOffset"].(int)
				if !startOK || !endOK || start < previousEnd || end <= start || end > len(tt.text) {
					t.Fatalf("invalid primary source range at %d: %#v", index, chunk.Metadata)
				}
				primary := tt.text[start:end]
				if !strings.HasSuffix(chunk.Content, primary) {
					t.Fatalf("expected chunk %d to end with source range %q, got %q", index, primary, chunk.Content)
				}
				previousEnd = end
			}
		})
	}
}
