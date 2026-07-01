# Structure Aware Recursive Chunking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace flat rune-window document splitting with structure-aware recursive token splitting while preserving the existing MVP defaults.

**Architecture:** The splitter remains the single owner of chunk boundaries. It extracts lightweight document structure from markdown-style headings, paragraphs, lists, tables, and code blocks, then recursively packs blocks under the configured chunk token limit with overlap. The processor persists splitter metadata into `document_chunks.metadata` without changing the schema.

**Tech Stack:** Go standard library, existing Gin/GORM backend, existing `document_chunks.metadata` JSONB field.

---

### Task 1: Splitter Tests

**Files:**
- Create: `backend/internal/document/splitter/splitter_test.go`

- [ ] Add a test that verifies markdown headings are preserved as `headingPath` metadata and prefixed into chunk content.
- [ ] Add a test that verifies recursive splitting prefers paragraph boundaries before hard token/rune boundaries.
- [ ] Add a test that verifies chunk indexes stay stable and token counts never exceed the configured chunk size by more than the heading prefix overhead.

Run: `cd backend; go test ./internal/document/splitter`
Expected: tests fail before implementation because the current splitter has no metadata and collapses all structure into one line.

### Task 2: Structure-Aware Splitter

**Files:**
- Modify: `backend/internal/document/splitter/splitter.go`

- [ ] Add `Metadata map[string]any` to `Chunk`.
- [ ] Normalize line endings without flattening all whitespace.
- [ ] Parse markdown headings into a heading stack.
- [ ] Group content into blocks: paragraphs, list runs, table runs, fenced code blocks, and blank-line boundaries.
- [ ] Pack blocks into chunks using existing `chunkSize` and `chunkOverlap`.
- [ ] For oversize blocks, recursively split by paragraph, sentence punctuation, whitespace, then rune fallback.
- [ ] Prefix chunk content with its current heading path for better embedding context.

Run: `cd backend; go test ./internal/document/splitter`
Expected: splitter package passes.

### Task 3: Processor Metadata Persistence

**Files:**
- Modify: `backend/internal/document/processor/processor.go`

- [ ] Merge splitter metadata into the JSONB metadata persisted for each chunk.
- [ ] Preserve the existing `"source": "document_processor"` marker.

Run: `cd backend; go test ./...`
Expected: all backend tests pass.

### Task 4: RAG Documentation

**Files:**
- Modify: `docs/05-rag-pipeline.md`

- [ ] Update the chunking section to describe structure-aware recursive token splitting.
- [ ] Document `headingPath`, `structureType`, and offset metadata as implementation details.

Run: `cd backend; go test ./...`
Expected: all backend tests pass after doc update.

### Self Review

- The plan keeps MVP defaults `chunkSize=800` and `chunkOverlap=120`.
- No database migration is required because metadata uses the existing JSONB field.
- Scope stays limited to chunking behavior and documentation.
