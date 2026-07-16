# Rerank, Observability, Retrieval Debug, and Chat Enhancements

## Objective

Implement the next product-quality layer for the RAG project: a real OpenAI-compatible Rerank Provider with explicit failure behavior, document processing progress and job observability, a retrieval debug panel for inspecting vector and rerank stages, and practical chat UX improvements such as answer copy, retry/regenerate, citation navigation, and session search.

This plan assumes the MVP baseline remains unchanged: no multi-tenancy, SSO, complex RBAC, audit logs, object storage, or docx parsing. The work should preserve existing `handler -> service -> repository` boundaries and keep public API fields camelCase.

## Current Evidence

- Router currently wires `rerank.NewDisabledProvider()` unconditionally, so a real provider is not used even when `RERANK_ENABLED` is true: `backend/internal/router/router.go:42`, `backend/internal/router/router.go:43`, `backend/internal/router/router.go:52`.
- Retrieval already supports an injected reranker, wraps rerank errors as `RERANK_FAILED`, maps rerank scores by chunk ID, sorts by rerank score, and truncates to topK: `backend/internal/retrieval/service.go:17`, `backend/internal/retrieval/service.go:76`, `backend/internal/retrieval/service.go:101`, `backend/internal/retrieval/service.go:130`.
- Rerank currently defines only the provider interface and disabled implementation: `backend/internal/rerank/provider.go:3`, `backend/internal/rerank/provider.go:12`, `backend/internal/rerank/disabled.go:8`, `backend/internal/rerank/disabled.go:12`.
- Document responses expose status and error message but no job-level progress, retry count, next retry time, or task metadata: `backend/internal/dto/document.go:9`, `backend/internal/dto/document.go:21`, `backend/internal/dto/document.go:35`.
- Document upload and reprocess create `document_jobs`, and worker reliability was recently moved into job processing, so progress should join through document jobs rather than inventing a separate progress table: `backend/internal/service/document_service.go:72`, `backend/internal/service/document_service.go:237`.
- Knowledge-base detail already has a semantic search test panel, but it only renders final result items and scores, not vector candidates, rerank ordering, threshold filtering, or prompt inclusion: `frontend/src/pages/KnowledgeBase/KnowledgeBaseDetailPage.tsx:471`, `frontend/src/pages/KnowledgeBase/KnowledgeBaseDetailPage.tsx:478`.
- Chat page already supports session title editing, archive, delete, sending, and citation display, but lacks copy, retry/regenerate, citation navigation, and session search: `frontend/src/pages/Chat/ChatPage.tsx:371`, `frontend/src/pages/Chat/ChatPage.tsx:438`, `frontend/src/pages/Chat/ChatPage.tsx:453`.

## Implementation Plan

- [ ] 1. Define the Rerank provider contract details and failure strategy in docs and config. Update environment docs to add the exact rerank provider request assumptions, timeout expectations, and a new explicit failure mode setting. Rationale: the current retrieval layer already returns `RERANK_FAILED`, but product behavior must decide whether failures are strict or degrade to vector ordering before implementation touches runtime behavior. Affected areas: `docs/05-rag-pipeline.md`, `docs/08-env-config.md`, `docs/12-handoff.md`, `backend/internal/config/config.go`.

- [ ] 2. Add backend tests for strict rerank failure and fallback behavior before implementation. Cover that strict mode returns `RERANK_FAILED`, fallback mode keeps vector candidates with null rerank scores or clear fallback metadata, and successful rerank still returns topK sorted by rerank score. Rationale: `backend/internal/retrieval/service.go:76` is the central policy point and must not regress citation correctness. Affected areas: `backend/internal/retrieval` tests and existing service fakes.

- [ ] 3. Implement a real OpenAI-compatible Rerank Provider. Add a provider package that reads `RERANK_BASE_URL`, `RERANK_API_KEY`, and `RERANK_MODEL`, submits the query and candidate chunk contents, validates model output, and returns stable chunk IDs with scores. Rationale: router currently injects disabled rerank at `backend/internal/router/router.go:43`, while the existing interface at `backend/internal/rerank/provider.go:12` is intentionally small enough to support a concrete provider. Affected areas: `backend/internal/provider/rerank`, `backend/internal/rerank`, `backend/internal/config`.

- [ ] 4. Wire the Rerank Provider into router construction. Select the real provider when `RERANK_ENABLED=true`; use the disabled provider only when config explicitly disables rerank. Rationale: the current unconditional disabled provider makes the `RERANK_ENABLED` config misleading and blocks MVP Milestone 6. Affected areas: `backend/internal/router/router.go`, `backend/internal/config/config.go`.

- [ ] 5. Implement configurable Rerank failure policy in retrieval. Keep strict mode as the default MVP-correct path, and optionally support fallback mode that records a debug/fallback reason while preserving vector-ordered candidates. Rationale: `docs/05-rag-pipeline.md` requires `RERANK_FAILED` unless a documented degradation strategy exists; this task makes that strategy explicit and measurable. Affected areas: `backend/internal/retrieval/service.go`, `backend/internal/apperror`, API docs.

- [ ] 6. Extend retrieval API responses with optional debug metadata gated by request/query options. Add fields that distinguish vector candidates, reranked candidates, final prompt candidates, threshold filtering, and fallback status without changing default lightweight responses. Rationale: the frontend debug panel should not require separate ad hoc endpoints or expose debug payloads to normal chat responses by default. Affected areas: `docs/04-api-design.md`, `backend/internal/dto/search.go`, `backend/internal/handler/search_handler.go`, `backend/internal/retrieval/service.go`.

- [ ] 7. Add backend tests for retrieval debug payloads. Verify debug mode includes vector stage, rerank stage, final stage, and score threshold effects; verify non-debug mode remains backward-compatible. Rationale: the existing semantic search response is user-facing, and debug fields must remain opt-in. Affected areas: retrieval and handler tests.

- [ ] 8. Extend document job observability in repository and DTOs. Add repository methods to fetch the latest job per document and expose job status, retry count, max retries, next retry time, locked/running time, last job error, and coarse stage progress in document detail/list responses. Rationale: `backend/internal/dto/document.go:9` currently stops at document-level status, while `document_jobs` already stores retry and locking state. Affected areas: `backend/internal/repository/document_repository.go`, `backend/internal/dto/document.go`, `backend/internal/service/document_service.go`.

- [ ] 9. Add backend tests for document progress fields. Cover uploaded pending jobs, running jobs, retry-scheduled jobs, completed jobs, and exhausted failed jobs. Rationale: observability must match worker behavior and avoid confusing users with stale retry data. Affected areas: document service tests and repository-backed SQLite fixtures.

- [ ] 10. Update frontend document types and document pages to show processing observability. Add progress/status details to document lists and the detail drawer: retry count, next retry time, job status, current phase, and last task error. Rationale: users currently see only document status and error message, so worker retry improvements remain invisible. Affected areas: `frontend/src/types/api.ts`, `frontend/src/pages/Documents/DocumentsPage.tsx`, `frontend/src/pages/Documents/DocumentsLandingPage.tsx`, `frontend/src/pages/Documents/DocumentDetailDrawer.tsx`.

- [ ] 11. Build the retrieval debug panel in the knowledge-base detail page. Add a debug toggle to the existing semantic search panel, render vector candidates before rerank, reranked/final chunks after rerank, threshold filtering, and fallback/strict failure messages. Rationale: `frontend/src/pages/KnowledgeBase/KnowledgeBaseDetailPage.tsx:471` already has the right location; expanding it avoids adding another navigation surface. Affected areas: `frontend/src/api/resources.ts`, `frontend/src/types/api.ts`, `frontend/src/pages/KnowledgeBase/KnowledgeBaseDetailPage.tsx`, `frontend/src/styles.css`.

- [ ] 12. Add chat copy and citation navigation. Provide copy buttons on assistant answers and citation cards; citation cards should link to document detail/preview with enough context to locate the cited chunk. Rationale: citations are already displayed at `frontend/src/pages/Chat/ChatPage.tsx:453`, but users cannot act on them beyond reading. Affected areas: chat page, document drawer route/state, shared API types.

- [ ] 13. Add chat retry/regenerate behavior. Define whether retry resends the last user message, deletes or supersedes the previous assistant answer, and how citations are stored. Implement the backend endpoint if needed, then add frontend controls and loading states. Rationale: current send flow at `frontend/src/pages/Chat/ChatPage.tsx:438` only supports forward progress; retry needs server-side consistency so stored messages and citations remain auditable. Affected areas: chat API docs, `backend/internal/service/chat_service.go`, `backend/internal/handler/chat_handler.go`, `frontend/src/pages/Chat/ChatPage.tsx`.

- [ ] 14. Add chat session search/filtering. Filter sessions by title on the client first, and only add backend query support if session counts make client filtering insufficient. Rationale: current session list renders all visible sessions for the selected knowledge base at `frontend/src/pages/Chat/ChatPage.tsx:341`; client-side filtering is the smallest useful step. Affected areas: `frontend/src/pages/Chat/ChatPage.tsx`, possibly `docs/04-api-design.md` if backend query support is added.

- [ ] 15. Update API, RAG, frontend, and handoff docs after public behavior changes. Document new rerank provider behavior, failure policy, debug response fields, document progress fields, and chat retry/copy/citation navigation UX. Rationale: this project uses docs as implementation contracts, and public schema/default changes must stay aligned. Affected areas: `docs/04-api-design.md`, `docs/05-rag-pipeline.md`, `docs/08-env-config.md`, `docs/10-frontend-spec.md`, `docs/12-handoff.md`.

- [ ] 16. Run verification and smoke tests. Run backend unit tests, frontend build, and one manual or scripted smoke path covering upload, worker progress, search debug, rerank success/failure, chat answer, citation display, copy, and retry. Rationale: these features cross backend providers, worker state, API DTOs, and frontend interaction, so isolated tests are not enough.

## Verification Criteria

- Backend `go test ./...` passes, including new retrieval, rerank, document progress, and chat retry tests.
- Frontend `npm run build` passes with updated API types.
- With `RERANK_ENABLED=true`, backend uses the real rerank provider instead of the disabled provider.
- Strict rerank failure returns a `RERANK_FAILED` error and does not fabricate rerank scores.
- Fallback rerank mode, if enabled, returns vector-ordered results with explicit fallback metadata and does not claim rerank success.
- Search debug mode exposes vector candidates, reranked candidates, final prompt candidates, score threshold effects, and fallback/error status.
- Document list/detail responses include job observability fields for pending, running, retry-scheduled, completed, and failed jobs.
- Frontend document views show retry count, next retry time, job status, and last job error without breaking existing empty/loading states.
- Knowledge-base debug panel allows comparing vector and rerank stages for the same query.
- Chat users can copy answers/citations, retry or regenerate the latest answer, navigate from citation to document/chunk context, and filter sessions by title.
- API docs and handoff docs match implemented fields and defaults.

## Potential Risks and Mitigations

1. **Rerank provider response formats differ across vendors.**
   Mitigation: keep the first provider OpenAI-compatible but isolate response parsing in `backend/internal/provider/rerank`; add tests for the selected provider shape and document assumptions in `.env.example`.

2. **Fallback rerank mode could weaken citation guarantees.**
   Mitigation: make fallback explicit in response debug metadata and logs; keep strict mode as the default if product correctness is more important than availability.

3. **Debug payloads could become too large.**
   Mitigation: gate debug fields behind an explicit request flag and cap debug stages to configured `vectorTopN` and `rerankTopK`.

4. **Document progress may expose stale job state.**
   Mitigation: always derive progress from the latest job for the document and clear retry/locked fields on complete/final failure.

5. **Chat retry can create confusing message history.**
   Mitigation: define one storage rule before implementation: either append a new assistant answer linked to the same user message or create a new user/assistant pair; reflect the choice in API docs and UI labels.

6. **Citation navigation needs document drawer state across pages.**
   Mitigation: start with route/query state that opens document detail and highlights or searches the chunk; avoid a large routing refactor.

## Alternative Approaches

1. **Separate debug endpoint instead of debug fields on search.**
   Trade-off: cleaner public search response, but duplicates retrieval orchestration and may drift from actual chat/search behavior.

2. **Always fallback on rerank failure.**
   Trade-off: better availability, but weaker correctness and contradicts the current RAG spec unless fallback is clearly documented.

3. **Expose job observability through a dedicated `/documents/:id/jobs` endpoint.**
   Trade-off: cleaner separation and history support, but frontend needs extra requests; embedding latest job progress in document responses is simpler for MVP.

4. **Backend session search instead of client-side filtering.**
   Trade-off: scales better for many sessions, but adds API surface before there is evidence client filtering is insufficient.

## Assumptions

- Rerank will use an OpenAI-compatible HTTP API shape selected by the current environment variables.
- Strict rerank failure remains the default policy unless the product owner explicitly prefers availability-first fallback.
- Document progress only needs latest-job observability for now, not a full job history timeline.
- Chat retry/regenerate should preserve auditability of stored messages and citations, even though complex audit logs remain out of MVP.
