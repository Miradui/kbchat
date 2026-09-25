package splitter

import (
	"fmt"
	"strings"
	"testing"

	"kbchat/backend/internal/document/parser"
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

func TestSplitPreservesTrailingHeadingWithoutBody(t *testing.T) {
	text := "# Product Guide\n\nIntro paragraph.\n\n## Appendix"

	chunks := New(30, 0).Split(text)

	var appendix Chunk
	for _, chunk := range chunks {
		if chunk.Content == "Product Guide > Appendix" {
			appendix = chunk
			break
		}
	}
	if appendix.Content == "" {
		t.Fatalf("expected trailing heading to remain searchable, got %#v", chunks)
	}
	if appendix.Metadata["structureType"] != "heading" {
		t.Fatalf("expected heading structure metadata, got %#v", appendix.Metadata)
	}
}

func TestSplitPreservesEmptyHeadingBeforeSibling(t *testing.T) {
	text := "# Empty Section\n\n# Filled Section\n\nBody."

	chunks := New(30, 0).Split(text)

	if len(chunks) != 2 || chunks[0].Content != "Empty Section" || chunks[1].Content != "Filled Section\nBody." {
		t.Fatalf("expected empty sibling heading and following content, got %#v", chunks)
	}
}

func TestSplitPreservesEmptyHeadingUnderTinyBudget(t *testing.T) {
	text := "# abcdefgh"
	chunks := New(1, 0).Split(text)

	var content strings.Builder
	previousEnd := 2
	for index, chunk := range chunks {
		if chunk.Content == "" || chunk.TokenCount > 1 {
			t.Fatalf("expected non-empty heading chunks within budget, got %#v", chunks)
		}
		if chunk.Metadata["structureType"] != "heading" {
			t.Fatalf("expected heading structure metadata, got %#v", chunk.Metadata)
		}
		start, startOK := chunk.Metadata["startOffset"].(int)
		end, endOK := chunk.Metadata["endOffset"].(int)
		if !startOK || !endOK || start != previousEnd || end <= start || end > len(text) {
			t.Fatalf("expected monotonic heading source range at %d, got %#v", index, chunk.Metadata)
		}
		if text[start:end] != chunk.Content {
			t.Fatalf("expected heading chunk %q to map to its source range %q", chunk.Content, text[start:end])
		}
		previousEnd = end
		content.WriteString(chunk.Content)
	}
	if content.String() != "abcdefgh" {
		t.Fatalf("expected complete heading content, got %q from %#v", content.String(), chunks)
	}
}

func TestSplitPreservesNestedLeafHeadingUnderTinyBudget(t *testing.T) {
	text := "# A\n## B"
	chunks := New(1, 0).Split(text)

	var foundLeaf bool
	for _, chunk := range chunks {
		path, ok := chunk.Metadata["headingPath"].([]string)
		if !ok || strings.Join(path, " > ") != "A > B" {
			continue
		}
		start, startOK := chunk.Metadata["startOffset"].(int)
		end, endOK := chunk.Metadata["endOffset"].(int)
		if !startOK || !endOK || start < 0 || end <= start || end > len(text) || text[start:end] != chunk.Content {
			t.Fatalf("expected nested leaf fragment to map to its title source, got %#v", chunk)
		}
		if chunk.Content == "B" {
			foundLeaf = true
		}
	}
	if !foundLeaf {
		t.Fatalf("expected nested leaf heading to remain searchable, got %#v", chunks)
	}
}

func TestSplitPreservesLiteralTrailingHashesInHeading(t *testing.T) {
	text := "# foo###"
	chunks := New(1, 0).Split(text)
	var content strings.Builder

	for index, chunk := range chunks {
		start, startOK := chunk.Metadata["startOffset"].(int)
		end, endOK := chunk.Metadata["endOffset"].(int)
		if !startOK || !endOK || start < 2 || end <= start || end > len(text) {
			t.Fatalf("expected heading source range at %d, got %#v", index, chunk.Metadata)
		}
		if text[start:end] != chunk.Content {
			t.Fatalf("expected heading chunk %q to map to source %q", chunk.Content, text[start:end])
		}
		content.WriteString(chunk.Content)
	}
	if content.String() != "foo###" {
		t.Fatalf("expected literal trailing hashes to remain searchable, got %q from %#v", content.String(), chunks)
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

	chunks := New(15, 0).Split(text)

	if len(chunks) != 2 {
		t.Fatalf("expected 2 paragraph chunks, got %d: %#v", len(chunks), chunks)
	}
	for _, chunk := range chunks {
		if strings.Contains(chunk.Content, "zeta.\n\nEta") {
			t.Fatalf("expected paragraph boundary split, got combined chunk %q", chunk.Content)
		}
		if chunk.TokenCount > 15 {
			t.Fatalf("expected chunk token count <= 15, got %d for %q", chunk.TokenCount, chunk.Content)
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

	chunks := New(14, 4).Split(text)

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

func TestSplitDoesNotCarryParagraphOverlapAcrossHeadingPath(t *testing.T) {
	text := "# A\n\none two three four\n\n# B\n\nfive six"

	chunks := New(6, 2).Split(text)

	if len(chunks) != 2 {
		t.Fatalf("expected one chunk per heading, got %#v", chunks)
	}
	if strings.Contains(chunks[1].Content, "three four") {
		t.Fatalf("expected B section not to include A overlap, got %q", chunks[1].Content)
	}
	if chunks[1].Content != "B\nfive six" {
		t.Fatalf("expected B heading and body to remain intact, got %q", chunks[1].Content)
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

func TestSplitPreservesFencesOnOversizeMarkdownCodeBlocks(t *testing.T) {
	lines := []string{"```go"}
	for index := 0; index < 12; index++ {
		lines = append(lines, fmt.Sprintf("call%02d()", index))
	}
	lines = append(lines, "```")

	chunks := New(6, 2).Split(strings.Join(lines, "\n"))

	if len(chunks) < 2 {
		t.Fatalf("expected oversized code block to split, got %#v", chunks)
	}
	for index, chunk := range chunks {
		if chunk.Metadata["structureType"] != "code" || chunk.TokenCount > 6 {
			t.Fatalf("unexpected code metadata or budget at %d: %#v", index, chunk)
		}
		if !strings.HasPrefix(chunk.Content, "```go\n") || !strings.HasSuffix(chunk.Content, "\n```") {
			t.Fatalf("expected balanced code fences at %d, got %q", index, chunk.Content)
		}
	}
}

func TestSplitOversizeFencedCodePreservesBlankLines(t *testing.T) {
	const body = "a\n\nb"
	text := "```\n" + body + "\n```"
	chunks := New(3, 0).Split(text)

	if len(chunks) < 2 {
		t.Fatalf("expected oversized code block to split, got %#v", chunks)
	}
	sourceParts := make([]string, 0, len(chunks))
	for index, chunk := range chunks {
		if chunk.Metadata["structureType"] != "code" || chunk.TokenCount > 3 {
			t.Fatalf("unexpected code chunk %d: %#v", index, chunk)
		}
		start, startOK := chunk.Metadata["startOffset"].(int)
		end, endOK := chunk.Metadata["endOffset"].(int)
		if !startOK || !endOK || start < 0 || end <= start || end > len(text) {
			t.Fatalf("invalid code source range at %d: %#v", index, chunk.Metadata)
		}
		part := text[start:end]
		if !strings.Contains(chunk.Content, part) {
			t.Fatalf("expected chunk %d to contain source part %q, got %q", index, part, chunk.Content)
		}
		sourceParts = append(sourceParts, part)
	}
	if got := strings.Join(sourceParts, ""); got != body {
		t.Fatalf("expected code body %q, got %q from %#v", body, got, chunks)
	}
}

func TestSplitFencedCodeTinyBudgetKeepsBodyWithoutUnbalancedFences(t *testing.T) {
	text := "```\na\n```"
	chunks := New(1, 0).Split(text)

	if len(chunks) != 1 {
		t.Fatalf("expected one body-only code chunk, got %#v", chunks)
	}
	chunk := chunks[0]
	if chunk.Content != "a" || chunk.TokenCount > 1 || chunk.Metadata["structureType"] != "code" {
		t.Fatalf("expected body-only code chunk within budget, got %#v", chunk)
	}
	if chunk.Metadata["startOffset"] != 4 || chunk.Metadata["endOffset"] != 5 {
		t.Fatalf("expected body-only source offsets, got %#v", chunk.Metadata)
	}
}

func TestSplitFencedCodeDropsBlocksWithoutSearchableBodyAtEveryBudget(t *testing.T) {
	tests := []struct {
		name string
		text string
	}{
		{name: "empty body", text: "```\n```"},
		{name: "blank body", text: "```\n\n```"},
		{name: "whitespace body with tilde info", text: "~~~text\n \t\n~~~"},
	}

	for _, tt := range tests {
		for _, chunkSize := range []int{1, 2, 100} {
			t.Run(fmt.Sprintf("%s/budget_%d", tt.name, chunkSize), func(t *testing.T) {
				chunks := New(chunkSize, 0).Split(tt.text)

				if len(chunks) != 0 {
					t.Fatalf("expected no chunks for fenced code without searchable body, got %#v", chunks)
				}
			})
		}
	}
}

func TestSplitEmptyFencedCodeDoesNotHidePrecedingHeading(t *testing.T) {
	text := "# H\n```\n```"
	for _, chunkSize := range []int{1, 100} {
		t.Run(fmt.Sprintf("budget_%d", chunkSize), func(t *testing.T) {
			chunks := New(chunkSize, 0).Split(text)

			if len(chunks) != 1 || chunks[0].Content != "H" {
				t.Fatalf("expected the preceding heading to remain searchable, got %#v", chunks)
			}
			if chunks[0].Metadata["structureType"] != "heading" {
				t.Fatalf("expected heading structure metadata, got %#v", chunks[0].Metadata)
			}
			if chunks[0].Metadata["startOffset"] != 2 || chunks[0].Metadata["endOffset"] != 3 {
				t.Fatalf("expected heading source offsets, got %#v", chunks[0].Metadata)
			}
		})
	}
}

func TestSplitRepeatsHeaderOnOversizeMarkdownTables(t *testing.T) {
	lines := []string{
		"| Name | Value |",
		"| --- | --- |",
	}
	for index := 0; index < 5; index++ {
		lines = append(lines, fmt.Sprintf("| item%02d | value%02d |", index, index))
	}
	header := strings.Join(lines[:2], "\n")

	chunks := New(16, 2).Split(strings.Join(lines, "\n"))

	if len(chunks) < 2 {
		t.Fatalf("expected oversized table to split, got %#v", chunks)
	}
	for index, chunk := range chunks {
		if chunk.Metadata["structureType"] != "table" || chunk.TokenCount > 16 {
			t.Fatalf("unexpected table metadata or budget at %d: %#v", index, chunk)
		}
		if !strings.HasPrefix(chunk.Content, header+"\n") {
			t.Fatalf("expected table header on chunk %d, got %q", index, chunk.Content)
		}
	}
}

func TestSplitKeepsOversizeMarkdownListItemsOnWholeLines(t *testing.T) {
	lines := make([]string, 0, 6)
	for index := 0; index < 6; index++ {
		lines = append(lines, fmt.Sprintf("- item%02d alpha beta", index))
	}

	chunks := New(6, 2).Split(strings.Join(lines, "\n"))

	if len(chunks) < 2 {
		t.Fatalf("expected oversized list to split, got %#v", chunks)
	}
	for index, chunk := range chunks {
		if chunk.Metadata["structureType"] != "list" || chunk.TokenCount > 6 {
			t.Fatalf("unexpected list metadata or budget at %d: %#v", index, chunk)
		}
		for _, line := range strings.Split(chunk.Content, "\n") {
			if !strings.HasPrefix(line, "- ") {
				t.Fatalf("expected complete list item line in chunk %d, got %q", index, chunk.Content)
			}
		}
	}
}

func TestSplitPreservesNestedMarkdownListIndentation(t *testing.T) {
	chunks := New(100, 0).Split("- parent\n  - child")

	if len(chunks) != 1 {
		t.Fatalf("expected one list chunk, got %#v", chunks)
	}
	if chunks[0].Content != "- parent\n  - child" {
		t.Fatalf("expected nested list indentation to remain intact, got %q", chunks[0].Content)
	}
}

func TestSplitMarkdownListKeepsIndentedContinuationInListBlock(t *testing.T) {
	text := "- first line\n  continuation text"
	chunks := New(100, 10).Split(text)

	if len(chunks) != 1 {
		t.Fatalf("expected one list chunk, got %#v", chunks)
	}
	if chunks[0].Metadata["structureType"] != "list" || chunks[0].Content != text {
		t.Fatalf("expected indented continuation to remain list content, got %#v", chunks[0])
	}
}

func TestSplitRecognizesParenthesizedOrderedMarkdownList(t *testing.T) {
	text := "1) alpha\n2) beta"
	chunks := New(100, 0).Split(text)

	if len(chunks) != 1 {
		t.Fatalf("expected one ordered list chunk, got %#v", chunks)
	}
	if chunks[0].Metadata["structureType"] != "list" || chunks[0].Content != text {
		t.Fatalf("expected parenthesized markers to remain list content, got %#v", chunks[0])
	}
}

func TestSplitDoesNotRecognizeParenthesizedOrderedTextWithoutSpaceAsList(t *testing.T) {
	text := "1)item"
	chunks := New(100, 0).Split(text)

	if len(chunks) != 1 || chunks[0].Metadata["structureType"] != "paragraph" || chunks[0].Content != text {
		t.Fatalf("expected missing marker space to remain paragraph content, got %#v", chunks)
	}
}

func TestSplitOversizeListContinuationRepeatsIndent(t *testing.T) {
	text := "- x\n  alpha beta gamma delta"
	chunks := New(3, 0).Split(text)

	if len(chunks) < 3 {
		t.Fatalf("expected oversized continuation to split, got %#v", chunks)
	}
	for index, chunk := range chunks[1:] {
		if chunk.Metadata["structureType"] != "list" || chunk.TokenCount > 3 {
			t.Fatalf("unexpected continuation chunk %d: %#v", index, chunk)
		}
		if !strings.HasPrefix(chunk.Content, "  ") {
			t.Fatalf("expected repeated continuation indent at %d, got %q", index, chunk.Content)
		}
	}
	if chunks[1].Metadata["startOffset"] != len("- x\n") {
		t.Fatalf("expected first continuation offset to include indentation, got %#v", chunks[1].Metadata)
	}
}

func TestSplitRepeatsIndentedMarkerForOversizeNestedMarkdownListItem(t *testing.T) {
	body := "alpha beta gamma delta epsilon zeta eta theta"
	chunks := New(6, 0).Split("- parent\n  - " + body)

	if len(chunks) < 2 {
		t.Fatalf("expected nested list item to split, got %#v", chunks)
	}
	parts := make([]string, 0, len(chunks))
	for index, chunk := range chunks {
		if chunk.TokenCount > 6 || chunk.Metadata["structureType"] != "list" {
			t.Fatalf("unexpected nested list chunk %d: %#v", index, chunk)
		}
		for _, line := range strings.Split(chunk.Content, "\n") {
			if line == "- parent" {
				continue
			}
			if !strings.HasPrefix(line, "  - ") {
				t.Fatalf("expected nested marker on continuation at %d, got %q", index, chunk.Content)
			}
			parts = append(parts, strings.TrimPrefix(line, "  - "))
		}
	}
	if strings.Join(strings.Fields(strings.Join(parts, " ")), " ") != body {
		t.Fatalf("expected nested item body %q, got %#v", body, chunks)
	}
}

func TestSplitDoesNotClassifyPipeRichProseAsTable(t *testing.T) {
	chunks := New(30, 0).Split("This | is | prose\nAnother | prose | line")

	if len(chunks) != 1 || chunks[0].Metadata["structureType"] != "paragraph" {
		t.Fatalf("expected pipe-rich prose to remain paragraph, got %#v", chunks)
	}
}

func TestSplitRecognizesTwoColumnTableWithoutOuterPipes(t *testing.T) {
	text := "A | B\n--- | ---\n1 | 2"
	chunks := New(30, 0).Split(text)

	if len(chunks) != 1 || chunks[0].Metadata["structureType"] != "table" {
		t.Fatalf("expected two-column GFM table, got %#v", chunks)
	}
}

func TestSplitRepeatsTwoColumnHeaderWithoutOuterPipes(t *testing.T) {
	text := strings.Join([]string{
		"Name | Value",
		"--- | ---",
		"alpha | " + strings.Repeat("x", 40),
		"beta | " + strings.Repeat("y", 40),
	}, "\n")
	header := "Name | Value\n--- | ---"

	chunks := New(12, 0).Split(text)

	if len(chunks) < 2 {
		t.Fatalf("expected oversized two-column table to split, got %#v", chunks)
	}
	for index, chunk := range chunks {
		if chunk.Metadata["structureType"] != "table" || !strings.HasPrefix(chunk.Content, header+"\n") {
			t.Fatalf("expected repeated two-column header at %d, got %#v", index, chunk)
		}
	}
}

func TestSplitDoesNotCarryStructuredOverlapIntoParagraphs(t *testing.T) {
	text := "- alpha beta gamma\n\nplain paragraph content"

	chunks := New(7, 2).Split(text)

	if len(chunks) != 2 {
		t.Fatalf("expected separate list and paragraph chunks, got %#v", chunks)
	}
	if strings.Contains(chunks[1].Content, "gamma") || !strings.Contains(chunks[1].Content, "plain paragraph content") {
		t.Fatalf("expected paragraph without list overlap, got %q", chunks[1].Content)
	}
}

func TestSplitRequiresPlainClosingCodeFence(t *testing.T) {
	text := strings.Join([]string{
		"```go",
		"first()",
		"```javascript",
		"still_code()",
		"```",
	}, "\n")

	chunks := New(20, 0).Split(text)

	if len(chunks) != 1 || chunks[0].Metadata["structureType"] != "code" {
		t.Fatalf("expected one complete code block, got %#v", chunks)
	}
	if !strings.Contains(chunks[0].Content, "```javascript\nstill_code()") {
		t.Fatalf("expected info-string-like line to remain code content, got %q", chunks[0].Content)
	}
}

func TestSplitDoesNotCloseFenceIndentedFourSpaces(t *testing.T) {
	text := strings.Join([]string{
		"```",
		"x",
		"    ```",
		"after",
		"```",
	}, "\n")

	chunks := New(40, 0).Split(text)

	if len(chunks) != 1 || chunks[0].Metadata["structureType"] != "code" {
		t.Fatalf("expected one code block, got %#v", chunks)
	}
	if !strings.Contains(chunks[0].Content, "    ```\nafter") {
		t.Fatalf("expected four-space fence to remain code content, got %q", chunks[0].Content)
	}
}

func TestSplitLimitsFenceIndentToThreeSpaces(t *testing.T) {
	valid := New(20, 0).Split("   ```\ncode\n   ```")
	if len(valid) != 1 || valid[0].Metadata["structureType"] != "code" {
		t.Fatalf("expected three-space fence to be code, got %#v", valid)
	}

	invalid := New(20, 0).Split("prefix\n\n    ```\ntext\n    ```")
	for _, chunk := range invalid {
		if chunk.Metadata["structureType"] == "code" {
			t.Fatalf("expected four-space opening fence not to be fenced code, got %#v", invalid)
		}
	}
}

func TestSplitLimitsHeadingIndentToThreeSpaces(t *testing.T) {
	valid := New(20, 0).Split("   # visible")
	if len(valid) != 1 || valid[0].Metadata["structureType"] != "heading" || valid[0].Content != "visible" {
		t.Fatalf("expected three-space heading to remain structured, got %#v", valid)
	}

	text := "    # hidden"
	invalid := New(20, 0).Split(text)
	if len(invalid) != 1 || invalid[0].Metadata["structureType"] != "paragraph" || invalid[0].Content != text {
		t.Fatalf("expected four-space heading syntax to remain literal, got %#v", invalid)
	}
	if invalid[0].Metadata["startOffset"] != 0 || invalid[0].Metadata["endOffset"] != len(text) {
		t.Fatalf("expected literal heading offsets, got %#v", invalid[0].Metadata)
	}
}

func TestSplitLimitsTopLevelListIndentAndPreservesNestedIndent(t *testing.T) {
	valid := New(20, 0).Split("   - visible")
	if len(valid) != 1 || valid[0].Metadata["structureType"] != "list" || valid[0].Content != "   - visible" {
		t.Fatalf("expected three-space list to remain structured, got %#v", valid)
	}

	literal := "    - hidden"
	invalid := New(20, 0).Split(literal)
	if len(invalid) != 1 || invalid[0].Metadata["structureType"] != "paragraph" || invalid[0].Content != literal {
		t.Fatalf("expected standalone four-space list syntax to remain literal, got %#v", invalid)
	}

	nested := New(20, 0).Split("- parent\n    - child")
	if len(nested) != 1 || nested[0].Metadata["structureType"] != "list" || nested[0].Content != "- parent\n    - child" {
		t.Fatalf("expected nested list indentation to remain structured, got %#v", nested)
	}
}

func TestSplitLimitsTableIndentToThreeSpaces(t *testing.T) {
	validText := "   a|b\n   ---|---\n   x|y"
	valid := New(30, 0).Split(validText)
	if len(valid) != 1 || valid[0].Metadata["structureType"] != "table" || valid[0].Content != validText {
		t.Fatalf("expected three-space table to remain structured, got %#v", valid)
	}

	literal := "    a|b\n    ---|---\n    x|y"
	invalid := New(30, 0).Split(literal)
	if len(invalid) != 1 || invalid[0].Metadata["structureType"] != "paragraph" || invalid[0].Content != literal {
		t.Fatalf("expected four-space table syntax to remain literal, got %#v", invalid)
	}
}

func TestSplitPreservesLeadingIndentationBeforeFenceParsing(t *testing.T) {
	text := "    ```\ntext\n    ```"
	chunks := New(20, 0).Split(text)

	for _, chunk := range chunks {
		if chunk.Metadata["structureType"] == "code" {
			t.Fatalf("expected document-leading four-space fence not to become fenced code, got %#v", chunks)
		}
	}
	if len(chunks) != 1 || chunks[0].Content != text {
		t.Fatalf("expected paragraph content to preserve leading indentation, got %#v", chunks)
	}
	if chunks[0].Metadata["startOffset"] != 0 || chunks[0].Metadata["endOffset"] != len(text) {
		t.Fatalf("expected original paragraph offsets, got %#v", chunks[0].Metadata)
	}
}

func TestSplitPreservesLeadingIndentationForFirstListItem(t *testing.T) {
	text := "  - child"
	chunks := New(20, 0).Split(text)

	if len(chunks) != 1 || chunks[0].Content != text {
		t.Fatalf("expected list content to preserve leading indentation, got %#v", chunks)
	}
	if chunks[0].Metadata["structureType"] != "list" {
		t.Fatalf("expected list structure metadata, got %#v", chunks[0].Metadata)
	}
	if chunks[0].Metadata["startOffset"] != 0 || chunks[0].Metadata["endOffset"] != len(text) {
		t.Fatalf("expected original list offsets, got %#v", chunks[0].Metadata)
	}
}

func TestSplitTrimsTrailingWhitespaceFromSourceOffset(t *testing.T) {
	text := "x   "
	chunks := New(20, 0).Split(text)

	if len(chunks) != 1 || chunks[0].Content != "x" {
		t.Fatalf("expected trailing whitespace to be cleaned from content, got %#v", chunks)
	}
	if chunks[0].Metadata["startOffset"] != 0 || chunks[0].Metadata["endOffset"] != 1 {
		t.Fatalf("expected cleaned source range [0,1], got %#v", chunks[0].Metadata)
	}
}

func TestSplitRejectsBacktickFenceInfoContainingBacktick(t *testing.T) {
	text := "``` go`bad\nbody\n```"
	chunks := New(30, 0).Split(text)

	for _, chunk := range chunks {
		if strings.Contains(chunk.Content, "go`bad") && chunk.Metadata["structureType"] == "code" {
			t.Fatalf("expected invalid backtick info string to remain paragraph content, got %#v", chunks)
		}
	}
}

func TestSplitAllowsBacktickInTildeFenceInfo(t *testing.T) {
	chunks := New(30, 0).Split("~~~ go`ok\nbody\n~~~")

	if len(chunks) != 1 || chunks[0].Metadata["structureType"] != "code" {
		t.Fatalf("expected tilde fence info to allow backticks, got %#v", chunks)
	}
}

func TestSplitKeepsBodyWhenHeadingPrefixExceedsBudget(t *testing.T) {
	chunks := New(4, 0).Split("# one two three four five\nbody")

	if len(chunks) != 1 {
		t.Fatalf("expected one body chunk, got %#v", chunks)
	}
	if !strings.Contains(chunks[0].Content, "body") || chunks[0].TokenCount > 4 {
		t.Fatalf("expected body to take priority over oversized heading prefix, got %#v", chunks[0])
	}
}

func TestSplitRepeatsMarkerForSingleOversizeMarkdownListItem(t *testing.T) {
	tests := []struct {
		name   string
		marker string
	}{
		{name: "unordered", marker: "- "},
		{name: "ordered", marker: "1. "},
		{name: "ordered parenthesized", marker: "12) "},
	}
	body := "alpha beta gamma delta epsilon zeta eta theta"

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			chunks := New(6, 2).Split(tt.marker + body)
			if len(chunks) < 2 {
				t.Fatalf("expected oversized list item to split, got %#v", chunks)
			}
			parts := make([]string, 0, len(chunks))
			for index, chunk := range chunks {
				if chunk.TokenCount > 6 || chunk.Metadata["structureType"] != "list" {
					t.Fatalf("unexpected list chunk %d: %#v", index, chunk)
				}
				if !strings.HasPrefix(chunk.Content, tt.marker) {
					t.Fatalf("expected marker %q on chunk %d, got %q", tt.marker, index, chunk.Content)
				}
				parts = append(parts, strings.TrimPrefix(chunk.Content, tt.marker))
			}
			if strings.Join(strings.Fields(strings.Join(parts, " ")), " ") != body {
				t.Fatalf("expected list body order to remain %q, got %#v", body, chunks)
			}
		})
	}
}

func TestSplitRepeatsParenthesizedMarkerWithoutExpandingSourceOffsets(t *testing.T) {
	marker := "12) "
	body := "alpha beta gamma delta epsilon zeta eta theta"
	chunks := New(6, 0).Split(marker + body)
	if len(chunks) < 2 {
		t.Fatalf("expected oversized parenthesized list item to split, got %#v", chunks)
	}

	previousEnd := 0
	for index, chunk := range chunks {
		if chunk.Index != index || chunk.TokenCount > 6 || chunk.Metadata["structureType"] != "list" {
			t.Fatalf("unexpected parenthesized list chunk %d: %#v", index, chunk)
		}
		if !strings.HasPrefix(chunk.Content, marker) {
			t.Fatalf("expected marker %q on chunk %d, got %q", marker, index, chunk.Content)
		}
		start, startOK := chunk.Metadata["startOffset"].(int)
		end, endOK := chunk.Metadata["endOffset"].(int)
		if !startOK || !endOK || start < previousEnd || end <= start {
			t.Fatalf("expected monotonic source offsets on chunk %d, got %#v", index, chunk.Metadata)
		}
		previousEnd = end
	}
}

func TestSplitKeepsColumnsForSingleOversizeMarkdownTableRow(t *testing.T) {
	header := "| Name | Value |\n| --- | --- |"
	rowValues := "alpha beta gamma delta epsilon zeta eta theta stable"
	text := header + "\n| alpha beta gamma delta epsilon zeta eta theta | stable |"

	chunks := New(18, 2).Split(text)

	if len(chunks) < 2 {
		t.Fatalf("expected oversized table row to split, got %#v", chunks)
	}
	values := make([]string, 0)
	for index, chunk := range chunks {
		if chunk.TokenCount > 18 || chunk.Metadata["structureType"] != "table" {
			t.Fatalf("unexpected table chunk %d: %#v", index, chunk)
		}
		if !strings.HasPrefix(chunk.Content, header+"\n") {
			t.Fatalf("expected repeated table header at %d, got %q", index, chunk.Content)
		}
		lines := strings.Split(chunk.Content, "\n")
		if len(lines) != 3 || strings.Count(lines[2], "|") != 3 {
			t.Fatalf("expected a two-column table row at %d, got %q", index, chunk.Content)
		}
		values = append(values, strings.Fields(strings.ReplaceAll(lines[2], "|", " "))...)
	}
	if strings.Join(values, " ") != rowValues {
		t.Fatalf("expected table cell order %q, got %q", rowValues, strings.Join(values, " "))
	}
}

func TestSplitKeepsEscapedPipeInsideOversizeMarkdownTableCell(t *testing.T) {
	header := "| A | B |\n| --- | --- |"
	text := header + "\n| alpha \\| beta gamma delta epsilon zeta eta theta | stable |"

	chunks := New(18, 0).Split(text)

	if len(chunks) < 2 {
		t.Fatalf("expected oversized table row to split, got %#v", chunks)
	}
	foundEscapedPipe := false
	for index, chunk := range chunks {
		lines := strings.Split(chunk.Content, "\n")
		if len(lines) != 3 || countMarkdownTableDelimiters(lines[2]) != 3 {
			t.Fatalf("expected a two-column table row at %d, got %q", index, chunk.Content)
		}
		if strings.Contains(lines[2], "\\|") {
			foundEscapedPipe = true
		}
	}
	if !foundEscapedPipe {
		t.Fatalf("expected escaped pipe to remain inside its source cell, got %#v", chunks)
	}
}

func TestSplitKeepsEscapedPipeAtomicAtMinimumTableCellBudget(t *testing.T) {
	header := "| A | B |\n| --- | --- |"
	text := header + "\n| aaa\\|bbb | x |"

	chunks := New(14, 0).Split(text)

	if len(chunks) < 2 {
		t.Fatalf("expected oversized table cell to split, got %#v", chunks)
	}
	foundEscapedPipe := false
	for index, chunk := range chunks {
		if chunk.TokenCount > 14 {
			t.Fatalf("expected token budget at %d, got %#v", index, chunk)
		}
		lines := strings.Split(chunk.Content, "\n")
		if len(lines) != 3 || countMarkdownTableDelimiters(lines[2]) != 3 {
			t.Fatalf("expected a two-column table row at %d, got %q", index, chunk.Content)
		}
		if strings.Contains(lines[2], "\\|") {
			foundEscapedPipe = true
		}
	}
	if !foundEscapedPipe {
		t.Fatalf("expected escaped pipe to remain atomic, got %#v", chunks)
	}
}

func TestSplitKeepsEscapedPipeAtomicWhenTableRowCannotBeRebuilt(t *testing.T) {
	text := "a|b\n---|---\nabc\\|def | x"
	escapedPipeOffset := strings.Index(text, "\\|") + 1
	chunks := New(4, 0).Split(text)

	if len(chunks) < 2 {
		t.Fatalf("expected extreme-budget table row to split, got %#v", chunks)
	}
	for index, chunk := range chunks {
		start, startOK := chunk.Metadata["startOffset"].(int)
		end, endOK := chunk.Metadata["endOffset"].(int)
		if !startOK || !endOK {
			t.Fatalf("expected source offsets at %d, got %#v", index, chunk.Metadata)
		}
		if start == escapedPipeOffset || end == escapedPipeOffset {
			t.Fatalf("expected escaped pipe to stay in one source span, got chunk %d %#v", index, chunk)
		}
	}
}

func TestSplitKeepsEscapedPipeAtomicWhenTableHeaderExceedsBudget(t *testing.T) {
	text := "a|b\n---|---\nabc\\|def | x"
	escapedPipeOffset := strings.Index(text, "\\|") + 1
	chunks := New(1, 0).Split(text)

	for index, chunk := range chunks {
		if chunk.TokenCount > 1 {
			t.Fatalf("expected token budget at %d, got %#v", index, chunk)
		}
		start, startOK := chunk.Metadata["startOffset"].(int)
		end, endOK := chunk.Metadata["endOffset"].(int)
		if !startOK || !endOK || start == escapedPipeOffset || end == escapedPipeOffset {
			t.Fatalf("expected escaped pipe to stay in one source span, got chunk %d %#v", index, chunk)
		}
	}
}

func TestSplitTreatsEscapedMarkdownPipesAsParagraphContent(t *testing.T) {
	chunks := New(100, 0).Split("alpha \\| beta \\| gamma")

	if len(chunks) != 1 {
		t.Fatalf("expected one paragraph chunk, got %#v", chunks)
	}
	if chunks[0].Metadata["structureType"] != "paragraph" {
		t.Fatalf("expected escaped pipes to remain paragraph content, got %#v", chunks[0])
	}
}

func TestSplitTreatsInlineCodePipesAsParagraphContent(t *testing.T) {
	chunks := New(100, 0).Split("alpha `a|b|c` omega")

	if len(chunks) != 1 {
		t.Fatalf("expected one paragraph chunk, got %#v", chunks)
	}
	if chunks[0].Metadata["structureType"] != "paragraph" {
		t.Fatalf("expected inline code pipes to remain paragraph content, got %#v", chunks[0])
	}
}

func TestSplitKeepsInlineCodePipesInsideOversizeMarkdownTableCell(t *testing.T) {
	header := "| A | B |\n| --- | --- |"
	text := header + "\n| alpha beta gamma `a|b|c` delta epsilon | stable |"

	chunks := New(18, 0).Split(text)

	if len(chunks) < 2 {
		t.Fatalf("expected oversized table row to split, got %#v", chunks)
	}
	foundCodeSpan := false
	for index, chunk := range chunks {
		lines := strings.Split(chunk.Content, "\n")
		if len(lines) != 3 || countMarkdownTableDelimiters(lines[2]) != 3 {
			t.Fatalf("expected a two-column table row at %d, got %q", index, chunk.Content)
		}
		if strings.Contains(lines[2], "`a|b|c`") {
			foundCodeSpan = true
		}
	}
	if !foundCodeSpan {
		t.Fatalf("expected inline code span to remain in one source cell, got %#v", chunks)
	}
}

func TestSplitKeepsInlineCodePipeProtectedAtMinimumTableCellBudget(t *testing.T) {
	tests := []struct {
		name     string
		codeSpan string
	}{
		{name: "single backtick", codeSpan: "`a|b`"},
		{name: "double backtick", codeSpan: "``a|b``"},
	}
	header := "| A | B |\n| --- | --- |"

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			chunks := New(14, 0).Split(header + "\n| " + tt.codeSpan + " | x |")
			if len(chunks) < 2 {
				t.Fatalf("expected oversized inline code cell to split, got %#v", chunks)
			}
			foundProtectedPipe := false
			protectedBody := strings.Builder{}
			for index, chunk := range chunks {
				if chunk.TokenCount > 14 {
					t.Fatalf("expected token budget at %d, got %#v", index, chunk)
				}
				lines := strings.Split(chunk.Content, "\n")
				if len(lines) != 3 || countMarkdownTableDelimiters(lines[2]) != 3 {
					t.Fatalf("expected a two-column table row at %d, got %q", index, chunk.Content)
				}
				if containsPipeInsideMatchedCodeSpan(lines[2]) {
					foundProtectedPipe = true
				}
				for _, body := range matchedCodeSpanBodies(lines[2]) {
					protectedBody.WriteString(body)
				}
			}
			if !foundProtectedPipe {
				t.Fatalf("expected code pipe to remain protected by a matching fence, got %#v", chunks)
			}
			if protectedBody.String() != "a|b" {
				t.Fatalf("expected inline code body to remain lossless, got %q from %#v", protectedBody.String(), chunks)
			}
		})
	}
}

func TestSplitKeepsInlineCodePipeProtectedWhenTableRowCannotBeRebuilt(t *testing.T) {
	chunks := New(4, 0).Split("a|b\n---|---\n`a|b` | x")
	protectedBody := strings.Builder{}

	for index, chunk := range chunks {
		if chunk.TokenCount > 4 {
			t.Fatalf("expected token budget at %d, got %#v", index, chunk)
		}
		lines := strings.Split(chunk.Content, "\n")
		if len(lines) < 3 {
			continue
		}
		for _, body := range matchedCodeSpanBodies(lines[len(lines)-1]) {
			protectedBody.WriteString(body)
		}
	}
	if protectedBody.String() != "a|b" {
		t.Fatalf("expected inline code pipe to remain protected and lossless, got %q from %#v", protectedBody.String(), chunks)
	}
}

func TestSplitKeepsInlineCodePipeProtectedWhenTableHeaderExceedsBudget(t *testing.T) {
	chunks := New(1, 0).Split("a|b\n---|---\n``x|y`` | q")
	protectedBody := strings.Builder{}

	for index, chunk := range chunks {
		if chunk.TokenCount > 1 {
			t.Fatalf("expected token budget at %d, got %#v", index, chunk)
		}
		for _, body := range matchedCodeSpanBodies(chunk.Content) {
			protectedBody.WriteString(body)
		}
	}
	if protectedBody.String() != "x|y" {
		t.Fatalf("expected inline code pipe to remain protected and lossless, got %q from %#v", protectedBody.String(), chunks)
	}
}

func countMarkdownTableDelimiters(line string) int {
	count := 0
	inCode := false
	for index := 0; index < len(line); index++ {
		if line[index] == '`' {
			inCode = !inCode
			continue
		}
		if line[index] != '|' {
			continue
		}
		backslashes := 0
		for previous := index - 1; previous >= 0 && line[previous] == '\\'; previous-- {
			backslashes++
		}
		if backslashes%2 == 0 && !inCode {
			count++
		}
	}
	return count
}

func containsPipeInsideMatchedCodeSpan(line string) bool {
	for _, body := range matchedCodeSpanBodies(line) {
		if strings.Contains(body, "|") {
			return true
		}
	}
	return false
}

func matchedCodeSpanBodies(line string) []string {
	bodies := make([]string, 0)
	for start := 0; start < len(line); start++ {
		if line[start] != '`' {
			continue
		}
		openingEnd := start
		for openingEnd < len(line) && line[openingEnd] == '`' {
			openingEnd++
		}
		fence := line[start:openingEnd]
		if closing := strings.Index(line[openingEnd:], fence); closing >= 0 {
			bodyEnd := openingEnd + closing
			bodies = append(bodies, line[openingEnd:bodyEnd])
			start = bodyEnd + len(fence) - 1
			continue
		}
		start = openingEnd - 1
	}
	return bodies
}

func TestSplitKeepsEdgeCellsForOversizeMarkdownTableWithoutOuterPipes(t *testing.T) {
	header := "Name | Detail | Status\n--- | --- | ---"
	rowValues := "alpha beta gamma delta epsilon zeta eta theta iota stable"
	text := header + "\nalpha | beta gamma delta epsilon zeta eta theta iota | stable"

	chunks := New(18, 2).Split(text)

	if len(chunks) < 2 {
		t.Fatalf("expected oversized table row to split, got %#v", chunks)
	}
	values := make([]string, 0)
	for index, chunk := range chunks {
		if chunk.TokenCount > 18 || !strings.HasPrefix(chunk.Content, header+"\n") {
			t.Fatalf("unexpected table chunk %d: %#v", index, chunk)
		}
		lines := strings.Split(chunk.Content, "\n")
		if len(lines) != 3 || strings.Count(lines[2], "|") != 4 {
			t.Fatalf("expected a three-column table row at %d, got %q", index, chunk.Content)
		}
		values = append(values, strings.Fields(strings.ReplaceAll(lines[2], "|", " "))...)
	}
	if strings.Join(values, " ") != rowValues {
		t.Fatalf("expected edge cells to remain %q, got %q", rowValues, strings.Join(values, " "))
	}
}

func TestSplitBoundsUnspacedASCIIAndEmojiByTokenBudget(t *testing.T) {
	tests := []struct {
		name string
		text string
	}{
		{name: "ascii", text: strings.Repeat("a", 200)},
		{name: "emoji", text: strings.Repeat("😀", 40)},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			chunks := New(4, 0).SplitDocument(parser.ParsedDocument{
				FileType: "txt",
				Segments: []parser.Segment{{Content: tt.text}},
			})
			if len(chunks) < 2 {
				t.Fatalf("expected unspaced content to split, got %#v", chunks)
			}
			parts := make([]string, 0, len(chunks))
			for index, chunk := range chunks {
				if chunk.TokenCount > 4 {
					t.Fatalf("expected token budget at %d, got %#v", index, chunk)
				}
				parts = append(parts, chunk.Content)
			}
			if strings.Join(parts, "") != tt.text {
				t.Fatalf("expected unspaced content to remain lossless, got %#v", chunks)
			}
		})
	}
}

func TestSplitOverlapsUnspacedTextWithinTokenBudget(t *testing.T) {
	tests := []struct {
		name string
		text string
	}{
		{name: "ascii", text: "abcdefghijklmnopqrstuvwxyz0123456789"},
		{name: "cjk", text: "甲乙丙丁戊己庚辛壬癸"},
		{name: "emoji", text: "😀😃😄😁😆😅😂🤣😊😇"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			chunks := New(4, 1).SplitDocument(parser.ParsedDocument{
				FileType: "txt",
				Segments: []parser.Segment{{Content: tt.text}},
			})
			if len(chunks) < 2 {
				t.Fatalf("expected multiple chunks, got %#v", chunks)
			}

			reconstructed := chunks[0].Content
			for index := 1; index < len(chunks); index++ {
				previousTail := tailByTokenBudget(chunks[index-1].Content, 1)
				overlapPrefix := previousTail + "\n\n"
				if previousTail == "" || !strings.HasPrefix(chunks[index].Content, overlapPrefix) {
					t.Fatalf("expected chunk %d to overlap %q, got %#v", index, previousTail, chunks)
				}
				if chunks[index].TokenCount > 4 {
					t.Fatalf("expected chunk %d within budget, got %#v", index, chunks[index])
				}
				reconstructed += strings.TrimPrefix(chunks[index].Content, overlapPrefix)
			}
			if reconstructed != tt.text {
				t.Fatalf("expected overlap-deduplicated text %q, got %q from %#v", tt.text, reconstructed, chunks)
			}
		})
	}
}

func TestSplitDocumentGivesDOCXTheSameStructureAsMarkdown(t *testing.T) {
	content := strings.Join([]string{
		"# 产品手册",
		"",
		"## 安装",
		"",
		"- 第一步",
		"  1. 第二步",
		"",
		"| 名称 | 状态 |",
		"| --- | --- |",
		"| 服务 | 正常 |",
	}, "\n")
	// A tiny budget keeps every block as its own chunk so structure types are
	// observable instead of being merged into one "mixed" chunk.
	markdown := New(24, 4).SplitDocument(parser.ParsedDocument{FileType: "md", Segments: []parser.Segment{{Content: content}}})
	docx := New(24, 4).SplitDocument(parser.ParsedDocument{FileType: "docx", Segments: []parser.Segment{{Content: content}}})

	if len(docx) == 0 || len(docx) != len(markdown) {
		t.Fatalf("expected docx chunks to mirror markdown chunks, md=%d docx=%d", len(markdown), len(docx))
	}
	for index := range docx {
		if docx[index].Content != markdown[index].Content {
			t.Fatalf("chunk %d content differs:\nmd:   %q\ndocx: %q", index, markdown[index].Content, docx[index].Content)
		}
		if docx[index].Metadata["structureType"] != markdown[index].Metadata["structureType"] {
			t.Fatalf("chunk %d structure differs: md=%v docx=%v", index, markdown[index].Metadata["structureType"], docx[index].Metadata["structureType"])
		}
		mdPath, _ := markdown[index].Metadata["headingPath"].([]string)
		docxPath, _ := docx[index].Metadata["headingPath"].([]string)
		if strings.Join(mdPath, ">") != strings.Join(docxPath, ">") {
			t.Fatalf("chunk %d heading path differs: md=%v docx=%v", index, mdPath, docxPath)
		}
		if docx[index].Metadata["fileType"] != "docx" {
			t.Fatalf("expected docx fileType metadata, got %#v", docx[index].Metadata)
		}
	}
	structures := map[string]bool{}
	for _, chunk := range docx {
		structures[chunk.Metadata["structureType"].(string)] = true
	}
	for _, want := range []string{"list", "table"} {
		if !structures[want] {
			t.Fatalf("expected a %s chunk from docx content, got %#v", want, structures)
		}
	}
}
