# Agent Instructions

## Task Scope
- Follow the current user request; use `docs/12-handoff.md` for current status, open work, and verification limits.
- Create or change backend/frontend code only when needed by the current task.
- Complete implementation, relevant verification, and required documentation within the requested scope; report unmet acceptance criteria.
- Run local fixture-based tests, fix failures caused by the change, and rerun affected tests without per-step approval; real-service test boundaries are in `docs/00-ai-development-guide.md`.

## Commands
Run each command from the repository root in PowerShell. Replace example test targets with affected packages/files. Go SQLite tests require CGO and a C compiler.

| Task | Command |
|------|---------|
| Backend package test (example) | `cd backend; go test ./internal/retrieval` |
| Backend full test suite | `cd backend; go test ./...` |
| Backend doctor | `cd backend; go run ./cmd/doctor` |
| Apply SQL migrations | `cd backend; go run ./cmd/migrate` |
| Seed default user | `cd backend; go run ./cmd/seed` |
| Backend dev server | `cd backend; go run ./cmd/server` |
| Frontend file test (example) | `cd frontend; npm test -- src/pages/Chat/ChatPage.test.tsx` |
| Frontend full test suite | `cd frontend; npm test` |
| Frontend build | `cd frontend; npm run build` |
| Frontend dev server | `cd frontend; npm run dev -- --host 127.0.0.1 --port 5173` |

## External References
Read references as the task needs them; search long documents for relevant sections.

| When working on | File |
|------|------|
| Development constraints or execution boundaries | `docs/00-ai-development-guide.md` |
| Product scope | `docs/01-prd.md` |
| Service boundaries or module layout | `docs/02-architecture.md` |
| Schema or migrations | `docs/03-database-design.md` |
| APIs, access control or errors | `docs/04-api-design.md`, `docs/09-error-codes.md` |
| Retrieval, model context or citations | `docs/05-rag-pipeline.md` |
| Setup, configuration or deployment | `README.md`, `docs/08-env-config.md`, `docs/13-deployment.md` |
| Frontend behavior or API integration | `docs/10-frontend-spec.md` |
| Current status or open work | `docs/12-handoff.md`, `docs/15-backlog.md` |
| Verification or release acceptance | `docs/14-verification.md` |

## Key Conventions
- Keep MVP scope: login, knowledge bases, document upload, parsing, chunking, embedding, pgvector search, Rerank, chat, and citations.
- Keep out of MVP: multi-tenancy, SSO, complex RBAC, audit logs, non-MinIO object storage, and lifecycle management. DOCX support is limited to text-oriented OOXML parsing (headings, lists, tables); images, formulas, text boxes, OCR, and legacy `.doc` remain unsupported.
- Backend must follow `handler -> service -> repository`.
- Backend database access must use GORM.
- Backend logging uses zap via `backend/internal/logger`.
- Model calls must go through provider interfaces for embedding, rerank, chat, and title generation.
- Rerank is part of the standard RAG path, not an optional later enhancement.
- Citations must come only from reranked chunks included in the prompt.
- All knowledge-base-related data access must check ownership through `knowledge_bases.owner_id` and enforce the current access matrix in `docs/04-api-design.md`.
- Chat session access also requires `chat_sessions.user_id` to match the caller.
- Root `.env` contains real local values; do not commit or quote secrets, and use `.env.example` placeholders in documentation.
- Keep API fields camelCase and database fields snake_case.
- Update docs when changing public API, schema, defaults, or RAG behavior.
- Real browser checks against the local integrated environment only need the `1920x1080` viewport.
