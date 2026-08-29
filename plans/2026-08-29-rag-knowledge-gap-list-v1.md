# RAG Knowledge Gap List

## Objective

Deliver the third and final item of the roadmap phase "P1 RAG 质量运营闭环"
(`docs/15-product-improvement-roadmap.md:50`): the knowledge gap list. The overview and
negative-feedback workbench already ship; this closes the phase.

Delivering it requires persisting two values the chat pipeline already computes but throws
away — the classified intent and the canonical retrieval query. That same gap is why the
existing `withoutCitationsCount` metric does not match the definition the roadmap states
for it, so this plan corrects that metric as part of the work rather than building a new
list on top of a known-wrong number.

Scope stays inside the existing `handler -> service -> repository` boundary, GORM-only data
access, camelCase API fields, snake_case columns, and the
`knowledge_bases.owner_id` ownership rule. No new provider calls and no change to how
answers are generated.

## Current Evidence

- `intent` and `standaloneQuery` are computed per answer and used for routing and retrieval,
  then discarded — neither reaches the database:
  `backend/internal/service/chat_service.go:1053`,
  `backend/internal/service/chat_service.go:1086`.
- `chat_messages` stores citations, rerank fallback and feedback, but has no intent and no
  retrieval query column: `backend/internal/model/models.go:203`.
- `withoutCitationsCount` counts every assistant answer with empty citations:
  `backend/internal/repository/chat_repository.go:388`. Conversation-intent answers are
  deliberately given `citations := []dto.CitationResponse{}`
  (`backend/internal/service/chat_service.go:1059`), so they inflate this count. The roadmap
  defines the metric as "citations 为空的**知识型**回答占比"
  (`docs/15-product-improvement-roadmap.md:100`), which the current query cannot express.
- For `knowledge_base` intent, empty citations and "insufficient basis" are the same
  condition: citations derive from `searchRes.Items`
  (`backend/internal/service/chat_service.go:1098`), and the fixed refusal string is used
  exactly when that slice is empty (`backend/internal/service/chat_service.go:1105`).
  Today that refusal is only identifiable by matching its Chinese text, which breaks
  silently if the wording changes.
- The send path sets `ClientRequestID` on the assistant message
  (`backend/internal/service/chat_service.go:785`); regenerate leaves it nil
  (`backend/internal/service/chat_service.go:880`). This is a reliable discriminator for
  excluding regenerations from a user-rephrasing signal.
- `chatQualityScope` is the single ownership/period boundary for quality queries and already
  excludes soft-deleted sessions and knowledge bases:
  `backend/internal/repository/chat_repository.go:455`.
- Existing quality queries reuse one `base()` closure for both count and page so filters
  cannot drift between them: `backend/internal/repository/chat_repository.go:402`.
- Tests run on in-memory SQLite via `AutoMigrate`, and partial indexes from SQL migrations
  must be recreated explicitly to be covered at all:
  `backend/internal/service/chat_service_test.go:622`,
  `backend/internal/service/chat_service_test.go:636`.
- `pg_trgm` is not used anywhere in the repository, so similarity matching has to be
  portable across PostgreSQL and the SQLite test database.
- Neither existing quality endpoint appears in `docs/04-api-design.md`, so the roadmap
  acceptance criterion "指标口径写入 API 文档"
  (`docs/15-product-improvement-roadmap.md:57`) is currently unmet for the shipped
  endpoints too.

## Design Decisions

**Two gap categories in P1, not three.** The roadmap lists 无引用, 依据不足 and 连续改写.
For `knowledge_base` intent the first two are provably the same condition (see evidence
above), so this plan ships `no_citations` and `repeated_rewrite` and says so explicitly in
the docs. The genuinely distinct third case is "model refused despite having citations",
which the roadmap itself schedules for P2 ("区分'知识库没有依据''检索失败'和'模型拒答'",
`docs/15-product-improvement-roadmap.md:76`). Inventing a third bucket that duplicates the
first would make the list look more informative than it is.

**Derive groundedness, do not store it.** `grounded` would be fully determined by
`intent` plus citation emptiness, so a column for it is redundant state that can drift from
its source. It is computed at query time instead.

**Exact match on a normalized canonical query, not fuzzy similarity.** The model's
`standaloneQuery` is already a canonicalization step, so distinct phrasings of one question
frequently collapse to the same rewrite. Exact matching on a normalized form of it is
deterministic, portable to SQLite, and cheap to group in SQL. It will miss rephrasings the
model rewrites differently — trigram similarity would catch more, but needs `pg_trgm` and
would leave the clustering logic untestable in the SQLite suite. The API shape below can
absorb a fuzzy implementation later without a contract change.

**Historical rows stay NULL and are excluded, not counted as zero.** Answers written before
the migration have no intent, so they cannot be classified. They are excluded from
intent-scoped metrics and surfaced as their own count so the UI can disclose the blind spot
instead of reporting a number that quietly understates.

## Implementation Plan

- [ ] 1. Add migration `018_chat_message_intent_and_retrieval_query.sql`. Add
  `chat_messages.intent VARCHAR(32)` with a CHECK constraint allowing NULL, `'conversation'`
  or `'knowledge_base'`; `retrieval_query TEXT`; and `retrieval_query_norm TEXT`. Add a
  partial index on `(session_id, retrieval_query_norm)` where
  `role = 'assistant' AND retrieval_query_norm IS NOT NULL` to serve the rewrite grouping.
  All three columns are nullable with no backfill: pre-existing answers are genuinely
  unclassifiable and must not be guessed. Rationale: schema is owned by SQL migrations per
  `AGENTS.md`, and `docs/12-handoff.md:206` requires the migration to lead and the GORM model
  to follow. Affected areas: `backend/migrations/`.

- [ ] 2. Extend the `ChatMessage` GORM model with the three fields, matching the migration's
  nullability (`*string` for all three so NULL stays distinguishable from empty string).
  Rationale: GORM is ORM-only here and must not AutoMigrate a different shape than the SQL
  migration defines (`docs/12-handoff.md:207`). Affected areas:
  `backend/internal/model/models.go`.

- [ ] 3. Add a normalization helper for the canonical query and unit test it directly. Lowercase,
  strip Unicode punctuation and collapse whitespace, returning empty for input that
  normalizes away entirely. Keep it in one place so the write path and any future backfill
  cannot disagree. Rationale: grouping correctness depends entirely on this function, and it
  is the cheapest thing in the plan to test exhaustively. Affected areas:
  `backend/internal/service/chat_service.go` plus tests.

- [ ] 4. Carry intent and the retrieval query on `generatedChatAnswer` and persist them at the
  single shared write point. `generateAnswerWithHooks` already knows both; add them to the
  struct and write them in `buildChatMessagePair`
  (`backend/internal/service/chat_service.go:772`), which both send paths share. Set
  `retrieval_query`/`retrieval_query_norm` only for `knowledge_base` intent, leaving them NULL
  for `conversation`. Rationale: `docs/12-handoff.md:450` records that the single generation
  path and the single persistence helper are what keep the citation rule from drifting; new
  per-answer state belongs in the same place for the same reason. Affected areas:
  `backend/internal/service/chat_service.go`.

- [ ] 5. Persist the same fields on the regenerate path. `RegenerateMessage` builds its assistant
  message inline (`backend/internal/service/chat_service.go:880`), so it must set intent and
  retrieval query too, or intent-scoped metrics would undercount every regenerated answer.
  It must keep `ClientRequestID` nil so regenerations stay excluded from rewrite clustering.
  Rationale: the metric denominator has to cover all persisted answers even though the
  rewrite signal deliberately does not. Affected areas:
  `backend/internal/service/chat_service.go`.

- [ ] 6. Correct `withoutCitationsCount` and make the denominator explicit. Restrict it to
  `intent = 'knowledge_base'`, and add `knowledgeAnswerCount` (knowledge-intent answers in
  period) and `unclassifiedAnswerCount` (NULL intent) to the overview so the ratio is
  interpretable and the pre-migration blind spot is visible rather than absorbed. This
  lowers the reported number for existing data; it is a correction, and tasks 12 and 13
  record it as a compatibility change. Rationale: the roadmap's own metric definition
  (`docs/15-product-improvement-roadmap.md:100`) cannot be computed without intent, and the
  gap list would otherwise inherit the same wrong denominator. Affected areas:
  `backend/internal/repository/chat_repository.go`, `backend/internal/dto/chat.go`,
  `backend/internal/service/chat_service.go`.

- [ ] 7. Add repository aggregations for both gap categories, reusing `chatQualityScope`
  verbatim for ownership and period. `no_citations`: knowledge-intent answers with empty
  citations, one row per answer, newest first. `repeated_rewrite`:
  `GROUP BY chat_sessions.id, chat_messages.retrieval_query_norm HAVING COUNT(*) >= 2`,
  restricted to `client_request_id IS NOT NULL` and non-null `retrieval_query_norm`,
  returning occurrence count, ungrounded occurrence count, and first/last seen timestamps.
  Follow the existing single-`base()`-closure pattern
  (`backend/internal/repository/chat_repository.go:402`) so count and page cannot diverge.
  Use a deterministic tiebreaker in every ordering so pagination is stable. Rationale: reusing
  the existing scope is what keeps the new endpoint inside the same ownership boundary as the
  shipped ones; the `HAVING` form avoids window functions that SQLite and PostgreSQL support
  unevenly. Affected areas: `backend/internal/repository/chat_repository.go`.

- [ ] 8. Add the service method and DTOs. `GET /api/v1/chat/quality/knowledge-gaps` taking
  `period`, `knowledgeBaseId`, `type` (`no_citations` | `repeated_rewrite` | `all`), `page`,
  `pageSize`. Reuse `normalizePeriod`, `periodStart`, `validateQualityKnowledgeBase` and the
  same page-size clamping the existing quality list uses
  (`backend/internal/service/chat_service.go:445`). Each item carries knowledge base, session,
  question, category, occurrence and ungrounded counts, first/last seen, and the IDs needed to
  jump to the session and the cited documents. For `all`, return both categories with stable
  ordering rather than interleaving by relevance. Rationale: matching the existing quality
  endpoints' validation and clamping keeps one behaviour for operators to learn, and the
  roadmap requires jumping from a gap item back to the source
  (`docs/15-product-improvement-roadmap.md:52`). Affected areas:
  `backend/internal/dto/chat.go`, `backend/internal/service/chat_service.go`.

- [ ] 9. Wire the handler and route next to the two existing quality routes
  (`backend/internal/router/router.go:201`), parsing and validating query params the same way
  `ListNegativeFeedback` does (`backend/internal/handler/chat_handler.go:278`), and rejecting
  an unknown `type` as a validation error rather than silently falling back to `all`.
  Rationale: silent coercion of a bad filter makes an operator trust a list that is not what
  they asked for. Affected areas: `backend/internal/handler/chat_handler.go`,
  `backend/internal/router/router.go`.

- [ ] 10. Add backend tests. Normalization table tests; intent and retrieval query persisted on
  both send paths and on regenerate; `no_citations` excludes conversation-intent answers;
  `repeated_rewrite` excludes regenerations (nil `client_request_id`) and honours the
  `>= 2` threshold; NULL-intent legacy rows excluded from intent-scoped metrics but counted in
  `unclassifiedAnswerCount`; corrected `withoutCitationsCount` no longer counts conversation
  answers; owner scoping across another user's session, a soft-deleted knowledge base and a
  soft-deleted session; pagination stability across pages including a tie on the sort key;
  unknown `type` rejected. Recreate migration 018's partial index in the SQLite helper
  alongside the existing idempotency index (`backend/internal/service/chat_service_test.go:636`),
  since AutoMigrate will not reproduce its `WHERE` clause. Rationale: the ownership boundary
  and the regeneration exclusion are the two places where a plausible-looking query would be
  wrong in a way no user would notice. Affected areas:
  `backend/internal/service/`, `backend/internal/repository/`, `backend/internal/handler/`,
  `backend/internal/router/` tests.

- [ ] 11. Add the frontend gap section. Types in `frontend/src/types/api.ts`, client function in
  `frontend/src/api/resources.ts` next to the existing two
  (`frontend/src/api/resources.ts:643`), and a third section on
  `frontend/src/pages/Quality/QualityPage.tsx` with a category filter, URL-driven paging to
  match the project's existing convention, per-category empty states, and links into the
  source session and cited documents. Show occurrence and ungrounded counts for rewrite
  clusters, and disclose `unclassifiedAnswerCount` where the corrected metric is displayed.
  Rationale: extending the existing Quality page keeps this off the navigation surface, the
  same reasoning used for the retrieval debug panel
  (`plans/2026-07-02-rerank-observability-chat-enhancements-v1.md:41`). Affected areas:
  `frontend/src/types/api.ts`, `frontend/src/api/resources.ts`,
  `frontend/src/pages/Quality/QualityPage.tsx`, `frontend/src/styles/pages/quality.css`.

- [ ] 12. Add frontend tests: gap list render per category, category filter, empty states,
  jump links, and the unclassified-count disclosure. Rationale: `QualityPage.test.tsx` already
  covers the two shipped sections; the third should not be the untested one. Affected areas:
  `frontend/src/pages/Quality/QualityPage.test.tsx`, `frontend/src/api/resources.gaps.test.ts`.

- [ ] 13. Document all three quality endpoints in `docs/04-api-design.md`, including the two
  already shipped, with the exact definition of every metric, the two gap categories and why
  the roadmap's third is deferred, the NULL-intent exclusion rule, and the
  `withoutCitationsCount` correction called out as a compatibility change. Rationale: the
  roadmap acceptance criterion requires metric definitions in the API doc
  (`docs/15-product-improvement-roadmap.md:57`), and it is currently unmet for the shipped
  endpoints; a corrected metric with no written definition just moves the ambiguity. Affected
  areas: `docs/04-api-design.md`, `docs/09-error-codes.md` if a new validation code is needed.

- [ ] 14. Update `docs/12-handoff.md` and `docs/15-product-improvement-roadmap.md`. Record the
  new migration and columns, the single write point for intent, the regeneration-exclusion
  rationale, the metric correction and its effect on existing data, and the exact-match
  limitation. Mark the roadmap deliverable complete and note the third category as P2.
  Rationale: this project treats docs as contracts, and `AGENTS.md` requires updating them
  when public API, schema, defaults or RAG behaviour change. Affected areas: `docs/`.

- [ ] 15. Verify. Backend `go vet ./...`, `go test -count=1 ./...`, and
  `go test -count=1 -race ./internal/repository ./internal/service` for the new aggregation
  and write paths. Frontend `npm test` and `npm run build`. Report what was not covered: the
  migration is not applied against the real PostgreSQL database in this environment, so the
  CHECK constraint and partial index are exercised only against SQLite unless
  `go run ./cmd/migrate` is run against the real instance. Rationale: the SQLite suite cannot
  substitute for real PostgreSQL DDL, and the same caveat is already recorded for the row-lock
  tests (`docs/12-handoff.md:551`). Affected areas: none.

## Verification Criteria

- `go vet ./...` clean; `go test -count=1 ./...` passes; `-race` passes on
  `./internal/repository ./internal/service`.
- `npm test` and `npm run build` pass, route-chunk check still finds 9 chunks.
- `withoutCitationsCount` counts only `intent = 'knowledge_base'` answers; a conversation-intent
  answer with empty citations does not appear in it or in the `no_citations` gap list.
- A regenerated answer never contributes to a `repeated_rewrite` cluster, but is counted in
  `knowledgeAnswerCount`.
- A rewrite cluster requires at least 2 send-path answers sharing a normalized retrieval query
  in one session, and reports occurrence count, ungrounded count and first/last seen.
- Pre-migration answers appear only in `unclassifiedAnswerCount`, never in intent-scoped
  metrics or either gap category.
- Every gap query returns nothing for another user's sessions, soft-deleted knowledge bases, or
  soft-deleted sessions.
- Repeated requests for the same page return the same items, including when the sort key ties.
- An unknown `type` returns a validation error rather than defaulting to `all`.
- `docs/04-api-design.md` documents all three quality endpoints with metric definitions, the
  two shipped ones included.
