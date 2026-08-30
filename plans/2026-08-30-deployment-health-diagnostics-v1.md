# Deployment Health and Diagnostics

## Objective

Deliver the roadmap phase "P1 部署健康与诊断"
(`docs/15-product-improvement-roadmap.md:63`): identify a broken model provider, Redis,
MinIO, database or job queue before a user hits it.

Four deliverables, verbatim from the roadmap:

1. A diagnostics page showing database, Redis, MinIO and model provider availability.
2. pending/running/failed job counts, oldest queue time, recent failure rate.
3. Recorded retrieval duration, first-token latency, full generation duration, and provider
   fallback.
4. Health checks must not return keys, connection strings, or raw provider errors.

Scope stays inside `handler -> service -> repository`, GORM-only data access, camelCase API
fields and snake_case columns. No schema change: every number here is either already in
`document_jobs` or is a per-request timing that does not belong in a table.

## Current Evidence

- Both health endpoints are static and probe nothing:
  `backend/internal/router/router.go:100` and `backend/internal/router/router.go:108` return
  `{"status":"ok","env":cfg.AppEnv}` unconditionally. A server with a dead database answers
  `200 ok`.
- `cmd/doctor/main.go` already pings the database and Redis, but as a fatal-on-failure CLI:
  `log.Fatal` on the first failure, so it cannot report per-dependency status and cannot be
  reused by a handler.
- `storage.EnsureReady` (`backend/internal/storage/storage.go:38`) is an
  optional-interface probe that returns nil for backends that do not implement it. For MinIO
  it resolves to `ensureBucket` (`backend/internal/storage/minio.go:71`), which **creates**
  the bucket. That is correct at boot and wrong for a health endpoint.
- `internal/cache` exposes exactly `Open(cfg) *redis.Client` and `Ping(ctx, client) error`
  (`backend/internal/cache/redis.go`). The Redis client is created in
  `cmd/server/main.go:42` and never reaches the router.
- Provider interfaces have no health method: `Chat(ctx, []Message)`
  (`backend/internal/chat/provider.go:10`), `EmbedTexts(ctx, []string)`
  (`backend/internal/embedding/provider.go:5`), `Rerank(ctx, query, documents)`
  (`backend/internal/rerank/provider.go:15`).
- `model.DocumentJob` (`backend/internal/model/models.go:139`) carries `Status`,
  `RetryCount`, `ErrorMessage`, `LockedAt`, `CreatedAt`, `UpdatedAt`. Observed statuses are
  `pending`, `running`, `completed`, `failed`, `cancelled`
  (`backend/internal/repository/document_repository.go:431`, `:482`, `:895`, `:917`, `:240`).
  Everything deliverable 2 asks for is already there.
- `StorageCleanupJob` (`backend/internal/model/models.go:156`) is a second queue with its own
  `RetryCount`/`NextAttemptAt`/`LastError`, drained by a separate worker
  (`cmd/server/main.go:74`). A stuck cleanup queue is invisible today.
- There is no timing instrumentation anywhere: grep for `time.Since|latency|Duration` in
  `backend/internal/service/chat_service.go` and `backend/internal/retrieval/service.go`
  returns nothing. Deliverable 3 is greenfield.
- Rerank fallback is already computed and returned per request
  (`backend/internal/retrieval/service.go:109`) but never counted, so "how often are we
  degraded" is unanswerable.
- `SystemService`/`SystemHandler`/`dto/system.go` are the existing system-level read seam;
  `Capabilities()` is currently their only method.
- Every router test constructs the engine with `New(cfg, db, logger)`
  (`backend/internal/router/router_test.go:26` and 8 further call sites), and
  `NewWithStorage` has exactly one non-test caller (`cmd/server/main.go:80`).
- `frontend/src/pages/` has no diagnostics page. `QualityPage` is lazily loaded
  (`frontend/src/router/index.tsx:19`) but missing from `expectedRouteChunks`
  (`frontend/scripts/verify-route-chunks.mjs:9`), whose own docstring requires the two to
  stay in sync — a pre-existing gap from the previous phase.
- The JWT carries only `UserID` (`backend/internal/auth/token.go:13`), no role, and there is
  no role middleware. `model.User.Role` exists (`backend/internal/model/models.go:18`) but
  `cmd/seed/main.go:57` creates the only bootstrap user with `Role: "user"`.

## Design Decisions

**Probe reachability, do not synthesize provider traffic.** Database, Redis and object
storage get real probes: they are cheap, local, and idempotent. Chat/embedding/rerank
providers do not. A synthetic completion on every diagnostics load bills the user per page
view and lies about latency, and there is no unpriced ping in the OpenAI-compatible surface
the repo uses. Instead each provider reports **configuration completeness** (is a base URL,
key and model wired) plus **observed health from real traffic** (last success, last failure
class, recent failure count) collected by the same recorder that satisfies deliverable 3.
Observed health is strictly more truthful than a probe, because it reflects the calls users
actually make.

**A read-only storage probe, separate from the boot-time one.** `EnsureReady` creates the
bucket; reusing it would make an authenticated GET able to recreate a bucket an operator
deliberately removed. This plan adds `CheckHealth(ctx) error` alongside it, backed by
`BucketExists`, and leaves `EnsureReady` untouched for boot.

**Timings live in a bounded in-process recorder, not a table.** Retrieval duration,
first-token latency and generation duration are one to three values per chat request. A row
per value would add write amplification to the hot path and grow unbounded to serve a page
nobody reads most days. A fixed-size ring per metric gives count, p50, p95 and max at O(1)
memory. The cost is honest and must be documented: **numbers are per-process and reset on
restart**. Durability is covered by also emitting each timing to the existing zap logger,
which is where a real incident gets reconstructed from anyway.

**Error classification, never error text.** Deliverable 4 is a hard constraint, and the
dangerous part is not the obvious secret but the incidental one: a `pq` connection error
embeds the DSN including the password, a MinIO error embeds the endpoint, a provider 401
body can echo the key prefix. So the response carries a closed set of reason codes
(`timeout`, `unreachable`, `auth_rejected`, `not_configured`, `unavailable`) and **no error
string reaches the DTO at all** — the raw error goes to the server log only. This is
enforced by a test that fails a probe with an error containing a password, a DSN and an API
key, then asserts none of those substrings appear anywhere in the serialized response.

**Authenticated, not admin-gated, with the gap written down.** The roadmap says
"管理诊断页". There is no role check in the codebase, the JWT has no role claim, and the
only seeded user is `role: "user"` — so gating on `admin` today would lock every existing
deployment out of the page it just shipped, and adding a role claim plus a promotion path is
the substance of the P2 phase "权限与协作"
(`docs/15-product-improvement-roadmap.md:81`). The endpoint therefore sits behind
`AuthRequired` like every other protected route, and the sanitization above is what makes
that acceptable: the response is deliberately built to be safe for any authenticated
operator to read. Recorded as a known deviation in the roadmap and handoff, to be closed by
the P2 permission matrix.

**Redis is injected, not re-opened.** `cmd/server/main.go` already owns a client. The router
gains an optional-dependency struct rather than a changed `New` signature, so the nine
existing test call sites keep working and a nil client is reported as `not_configured`
instead of crashing.

## Implementation Plan

- [ ] 1. Add `internal/observability` with a bounded metrics recorder. A `Recorder` holding a
  fixed-size ring per named duration metric (`retrieval`, `chat_first_token`,
  `chat_generation`, `embedding`, `rerank`) plus counters for provider outcomes
  (`success`, `failure` by reason class) and for rerank fallback. Methods:
  `ObserveDuration(metric string, d time.Duration)`, `RecordProviderResult(provider string,
  err error)`, `RecordRerankFallback(reason string)`, and `Snapshot()` returning count, p50,
  p95, max per metric and per-provider observed health. All methods must be safe for
  concurrent use and must be no-ops on a nil receiver, so instrumentation can be added to
  call paths whose tests construct services without a recorder. Rationale: a nil-safe
  recorder is what lets deliverable 3 be threaded through the hot path without touching a
  single existing test constructor. Affected areas: `backend/internal/observability/`.

- [ ] 2. Add the error classifier and its leak test, in the same package. A
  `Classify(err error) Reason` mapping to the closed set `timeout`, `unreachable`,
  `auth_rejected`, `not_configured`, `unavailable`, plus `ReasonNone` for success. It matches
  on `context.DeadlineExceeded`, `context.Canceled`, `net.Error.Timeout()`, `syscall.ECONNREFUSED`,
  and HTTP 401/403 signals available from the provider error types; everything else is
  `unavailable`. It must never return any part of the input error. Test with errors whose text
  embeds `postgres://rag:supersecret@host/db`, `sk-test-abcdef` and
  `MINIO_SECRET_KEY=hunter2`, asserting the returned reason contains none of them.
  Rationale: this function is the single chokepoint deliverable 4 depends on, so it is tested
  in isolation before anything calls it. Affected areas:
  `backend/internal/observability/` plus tests.

- [ ] 3. Instrument retrieval. In `retrieval.Service`, wrap `EmbedTexts` with an `embedding`
  duration and provider result, wrap the rerank call with a `rerank` duration and provider
  result, record the whole `Search` as `retrieval` duration, and call
  `RecordRerankFallback(rerankFallbackProviderError)` where the fallback branch already sets
  `rerankStageStatus = "fallback"` (`backend/internal/retrieval/service.go:108`). The recorder
  arrives via a setter (`SetRecorder`) following the existing
  `SetActivityRecorder` precedent (`backend/internal/router/router.go:78`), so
  `NewService`'s signature and all its test callers stay unchanged. Rationale: reusing the
  established optional-collaborator pattern keeps this from becoming a constructor churn
  across every retrieval and chat test. Affected areas: `backend/internal/retrieval/service.go`.

- [ ] 4. Instrument chat generation. In `generateAnswerWithHooks`
  (`backend/internal/service/chat_service.go:1252`), time the full call as
  `chat_generation`, and record `chat_first_token` from the start of `complete` to the first
  `onDelta` invocation by wrapping the delta callback. Record the chat provider result around
  `complete` (`backend/internal/service/chat_service.go:1232`). First-token latency is only
  recorded when a delta actually arrives, so the non-streaming single-delta path
  (`backend/internal/service/chat_service.go:1244`) and the no-citations refusal
  (`:1321`) do not pollute the metric with values that are not model latency. Rationale:
  first-token latency is the number users perceive, and averaging a locally generated refusal
  string into it would make the metric look better exactly when retrieval is failing.
  Affected areas: `backend/internal/service/chat_service.go`.

- [ ] 5. Give the recorder an optional zap logger so timings are durable. No service currently
  takes a `*zap.Logger` (grep: zero matches in `internal/service` and `internal/retrieval`),
  and threading one into two services to write log lines would be a wide change for a narrow
  purpose. Instead the recorder gains `WithLogger`, wired once in the router, and exposes
  `RecordChatTiming(fields)` which writes a single structured line per chat request carrying
  retrieval, first-token and generation durations plus the fallback flag. Provider failures
  log at warn with the classified reason **and** the raw error — logs are server-side and are
  where an incident actually gets diagnosed; the sanitization constraint applies to the API
  response, not to the operator's own log. Rationale: the recorder is volatile by design, so
  without a durable trail this phase would ship observability that forgets everything on
  deploy; one summary line per request keeps that trail useful instead of drowning it in a
  line per sample. Affected areas: `backend/internal/observability/`,
  `backend/internal/service/chat_service.go`.

- [ ] 6. Add the read-only storage probe. `CheckHealth(ctx) error` on `MinIOStorage` using
  `BucketExists` (returning a distinct error when the bucket is absent), on `RoutedStorage`
  delegating to primary and remote, and a package-level
  `storage.CheckHealth(ctx, Storage) error` that mirrors `EnsureReady`'s optional-interface
  shape and returns nil for backends without the capability. `LocalStorage` implements it by
  stat-ing the upload directory. `EnsureReady` is not modified. Rationale: the boot probe
  creates buckets and must not be reachable from an HTTP handler. Affected areas:
  `backend/internal/storage/`.

- [ ] 7. Add the queue metrics repository query. On `DocumentRepository`, a
  `QueueStats(ctx, failureWindow time.Duration)` returning per-status counts for
  `pending`/`running`/`failed`/`completed`/`cancelled`, the oldest `pending` job's
  `created_at`, the oldest `running` job's `locked_at`, and failed/total counts within the
  window. On `StorageCleanupRepository`, a matching `QueueStats` returning backlog size,
  oldest `next_attempt_at`, and count with `retry_count > 0`. Both aggregate in SQL rather
  than loading rows. Rationale: deliverable 2 verbatim, plus the cleanup queue whose
  stalling is currently invisible; aggregating in SQL keeps the page O(1) regardless of
  history size. Affected areas: `backend/internal/repository/document_repository.go`,
  `backend/internal/repository/storage_cleanup_repository.go`.

- [ ] 8. Add diagnostics DTOs. `SystemDiagnosticsResponse` with `checkedAt`, `dependencies`
  (name, status `ok|degraded|down|not_configured`, `reason` from the closed set,
  `latencyMs`), `queues` (document and cleanup blocks from task 7, with
  `oldestPendingSeconds` and `recentFailureRate`), `providers` (name, `configured`,
  `model`, observed `lastSuccessAt`, `lastFailureAt`, `lastFailureReason`,
  `recentFailureCount`), and `latency` (per-metric count/p50/p95/max). No field may hold a
  URL, endpoint, DSN, key or raw error; provider blocks carry the model name only, not the
  base URL. Rationale: the DTO is the actual boundary deliverable 4 constrains, so the
  omissions are part of the contract, not an implementation detail. Affected areas:
  `backend/internal/dto/system.go`.

- [ ] 9. Extend `SystemService` with `Diagnostics(ctx)`. It runs the three dependency probes
  concurrently under a short per-probe timeout (2s, well below any client timeout), never
  propagates a probe error as a request failure — a dead dependency is a `200` with
  `status: "down"`, because the diagnostics page must still render when things are broken —
  classifies every probe error through task 2, logs the raw error, and composes queue
  metrics, provider config state and the recorder snapshot. Dependencies arrive as narrow
  interfaces (`pinger`, `storageChecker`, `queueStatter`) so the service is testable with
  fakes. A nil Redis client yields `not_configured`, not a panic. Rationale: an endpoint that
  500s when a dependency is down is useless precisely when it is needed. Affected areas:
  `backend/internal/service/system_service.go`.

- [ ] 10. Add a `Ping` on the database side of the repository layer. A small
  `SystemRepository` wrapping `db.WithContext(ctx)` → `sql.DB.PingContext`, so the service
  keeps taking a repository rather than a `*gorm.DB` and the layering rule holds.
  Rationale: `AGENTS.md` forbids services reaching for the DB handle directly; a health probe
  is not an exception. Affected areas: `backend/internal/repository/system_repository.go`.

- [ ] 11. Wire the handler, route and dependency injection. `GET /api/v1/system/diagnostics`
  next to `system/capabilities` (`backend/internal/router/router.go:125`). Add a
  `Dependencies{Storage storage.Storage; Redis *redis.Client; Recorder *observability.Recorder}`
  struct and a `NewWithDependencies` constructor; `New` and `NewWithStorage` delegate to it so
  all nine existing test call sites are untouched. `cmd/server/main.go` passes its existing
  Redis client and a recorder it also hands to nothing else. Additionally upgrade
  `/healthz` and `/api/v1/healthz`: keep them unauthenticated and keep the existing
  `{status, env}` shape for liveness, but have the versioned one report `status: "degraded"`
  with a `dependencies` summary of names and statuses only — no reasons, no latencies, since
  it is unauthenticated. Rationale: an unauthenticated endpoint that reports which dependency
  is down is a reconnaissance aid, but one that always says `ok` is a lie that defeats every
  orchestrator health gate. Affected areas: `backend/internal/handler/system_handler.go`,
  `backend/internal/router/router.go`, `backend/cmd/server/main.go`.

- [ ] 12. Add backend tests. Recorder concurrency (parallel `ObserveDuration` under `-race`),
  percentile correctness on a known distribution, ring eviction past capacity, nil-receiver
  no-op; classifier leak test from task 2; service tests with fakes for all-healthy, database
  down, Redis nil, storage down and provider never-called, asserting HTTP 200 in every case;
  a serialization test asserting the full response body contains none of the configured
  secrets from a config populated with fake keys, a DSN and a MinIO secret; queue stats
  against seeded jobs covering oldest-pending, oldest-running-locked and window-bounded
  failure rate; route tests for auth required and for the degraded liveness shape.
  Rationale: the leak test and the "200 while down" test are the two properties a plausible
  implementation gets wrong invisibly. Affected areas: `backend/internal/observability/`,
  `backend/internal/service/`, `backend/internal/repository/`, `backend/internal/router/`
  tests.

- [ ] 13. Add the frontend diagnostics page. Types and a `getSystemDiagnostics` client in
  `frontend/src/types/api.ts` and `frontend/src/api/resources.ts`; a
  `frontend/src/pages/Diagnostics/DiagnosticsPage.tsx` with a dependency status grid,
  queue panel, provider panel and latency table; a manual refresh button and a visible
  `checkedAt`; explicit copy stating latency figures are per-process since last restart, so
  the volatility from the design decision is disclosed in the UI rather than only in docs.
  Reason codes render as Chinese labels from a closed map, with an unknown code falling back
  to a neutral string instead of printing the raw value. Route at `/diagnostics`, lazily
  loaded, registered in `PrimaryNav` under a new 系统 group, added to `sectionLabels`, and
  added to `expectedRouteChunks` — **along with the missing `QualityPage` entry**, closing the
  pre-existing sync gap. Rationale: the verify script's contract is that the list matches the
  lazy imports; leaving `QualityPage` out means the check silently stopped covering it.
  Affected areas: `frontend/src/types/api.ts`, `frontend/src/api/resources.ts`,
  `frontend/src/pages/Diagnostics/`, `frontend/src/router/index.tsx`,
  `frontend/src/components/navigation/PrimaryNav.tsx`, `frontend/src/layouts/AppShell.tsx`,
  `frontend/scripts/verify-route-chunks.mjs`, `frontend/src/styles/pages/`.

- [ ] 14. Add frontend tests. Client query-string test; page tests for healthy render, a
  down dependency rendering its Chinese reason label, an unknown reason code falling back
  without printing the raw code, `not_configured` Redis rendering as 未配置 rather than an
  error, empty latency metrics rendering an empty state instead of `NaN`, and refresh
  re-requesting. Rationale: the fallback-label and empty-metrics cases are where this page
  would otherwise show `undefined` or `NaN` to an operator during an actual incident.
  Affected areas: `frontend/src/pages/Diagnostics/`, `frontend/src/api/` tests.

- [ ] 15. Document and record. Add a `## 系统诊断` section to `docs/04-api-design.md` covering
  both endpoints, the closed reason-code set, the deliberate omissions required by
  deliverable 4, and the per-process volatility of latency figures. Update
  `docs/15-product-improvement-roadmap.md` progress to mark the phase done and record the
  authenticated-not-admin deviation as P2 follow-up. Append a handoff section to
  `docs/12-handoff.md` covering the recorder's volatility, why providers are not probed, the
  `EnsureReady` vs `CheckHealth` split, and what remains unverified against real
  PostgreSQL/Redis/MinIO. Rationale: the two deviations here (no admin gate, no provider
  probe) are deliberate and would otherwise read as oversights to the next person.
  Affected areas: `docs/`.

## Verification

- `cd backend && go vet ./... && go test -count=1 ./...`
- `cd backend && go test -count=1 -race ./internal/observability ./internal/service ./internal/repository ./internal/router`
- `cd frontend && npx tsc -b && npm test && npm run build`
- Not verifiable in this environment: real PostgreSQL, Redis and MinIO probes. The database
  and Redis probes will run against the SQLite test DB and a nil client respectively; the
  MinIO `BucketExists` path has no local server. This must be stated as unverified rather
  than implied working.

