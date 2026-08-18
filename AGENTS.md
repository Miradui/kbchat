# Agent Instructions

## Current State
- Backend and frontend skeletons exist.
- Backend development is currently prioritized; frontend feature work is paused until backend APIs are ready.
- Backend uses Gin, GORM, PostgreSQL, Redis, and JWT.
- Backend logging uses zap via `backend/internal/logger`.
- Local real environment values are in root `.env`; do not commit or quote secrets.
- Current handoff status is in `docs/12-handoff.md`.

## Commands
| Task | Command |
|------|---------|
| Backend test | `cd backend; go test ./...` |
| Backend doctor | `cd backend; go run ./cmd/doctor` |
| Apply SQL migrations | `cd backend; go run ./cmd/migrate` |
| Seed default user | `cd backend; go run ./cmd/seed` |
| Backend dev server | `cd backend; go run ./cmd/server` |
| Frontend build | `cd frontend; npm run build` |
| Frontend dev server | `cd frontend; npm run dev -- --host 127.0.0.1 --port 5173` |

## Real Environment Verification
- Real browser checks against the local integrated environment only need the `1920x1080` viewport.

## External References
| Need | File |
|------|------|
| Overall AI rules | `docs/00-ai-development-guide.md` |
| Product scope | `docs/01-prd.md` |
| Architecture | `docs/02-architecture.md` |
| Database schema | `docs/03-database-design.md` |
| API contract | `docs/04-api-design.md` |
| RAG pipeline | `docs/05-rag-pipeline.md` |
| Project layout | `docs/06-project-structure.md` |
| Milestones | `docs/07-milestones.md` |
| Environment config | `docs/08-env-config.md` |
| Error format | `docs/09-error-codes.md` |
| Frontend behavior | `docs/10-frontend-spec.md` |
| Frontend API gaps | `docs/14-frontend-api-gaps.md` |
| AI task order | `docs/11-ai-task-prompts.md` |
| Current handoff | `docs/12-handoff.md` |

## Key Conventions
- Implement tasks in the order defined by `docs/11-ai-task-prompts.md`.
- Keep MVP scope: login, knowledge bases, document upload, parsing, chunking, embedding, pgvector search, Rerank, chat, and citations.
- Keep out of MVP: multi-tenancy, SSO, complex RBAC, audit logs, object storage, and docx parsing.
- Backend must follow `handler -> service -> repository`.
- Backend database access must use GORM.
- Model calls must go through provider interfaces for embedding, rerank, and chat.
- Rerank is part of the standard RAG path, not an optional later enhancement.
- Citations must come only from reranked chunks included in the prompt.
- All knowledge-base-related data access must check ownership through `knowledge_bases.owner_id`.

## Editing Rules
- Do not create backend or frontend code unless the current task asks for it.
- Do not write real secrets; document examples only in `.env.example` form.
- Keep API fields camelCase and database fields snake_case.
- Update docs when changing public API, schema, defaults, or RAG behavior.
