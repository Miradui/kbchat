# RAG Knowledge Base

RAG Knowledge Base is an MVP knowledge-base and chat application. The backend is built with Gin, GORM, PostgreSQL, Redis, JWT, pgvector, and OpenAI-compatible model providers. The frontend is a Vite React workspace for login, knowledge bases, documents, search, and chat.

## Current Scope

Included in the MVP:

- Login and current-user auth with JWT.
- Knowledge bases, categories, tags, favorites, recent views, and recycle bin.
- Document upload, parsing, chunking, embedding, preview, download, reprocess, and recycle bin.
- pgvector semantic search, OpenAI-compatible rerank, chat sessions, citations, and archived sessions.
- Knowledge-base member management with `owner`, `manager`, and `member` views.

Out of MVP for now:

- SSO, complex RBAC, multi-tenancy, audit logs, object storage, and docx parsing.

## Repository Layout

```text
backend/   Gin API, GORM repositories, services, migrations, worker
frontend/  Vite React app
docs/      Product, architecture, API, database, RAG, and handoff docs
deploy/    Local docker-compose for infrastructure
plans/     Implementation plans
```

Start with these docs when changing behavior:

- `docs/04-api-design.md` for API contracts.
- `docs/05-rag-pipeline.md` for retrieval and citation rules.
- `docs/08-env-config.md` for environment configuration.
- `docs/12-handoff.md` for current implementation status.

## Prerequisites

- Go 1.24+
- Node.js 20+
- PostgreSQL with pgvector
- Redis

The default local infrastructure can be started from `deploy/docker-compose.yml` if you want local PostgreSQL and Redis.

## Environment Setup

Create a local `.env` from the example:

```powershell
Copy-Item .env.example .env
```

Then edit `.env` with your real database, Redis, JWT, and model-provider values. Never commit `.env`.

At minimum, configure:

- `DATABASE_URL`
- `REDIS_ADDR`
- `JWT_SECRET`
- `CHAT_BASE_URL`, `CHAT_API_KEY`, `CHAT_MODEL`
- `TITLE_BASE_URL`, `TITLE_API_KEY`, `TITLE_MODEL`
- `EMBEDDING_BASE_URL`, `EMBEDDING_API_KEY`, `EMBEDDING_MODEL`
- `RERANK_ENABLED`, `RERANK_BASE_URL`, `RERANK_API_KEY`, `RERANK_MODEL`, `RERANK_FAILURE_MODE`

## Backend

Run commands from `backend/`.

```powershell
go test ./...
go run ./cmd/doctor
go run ./cmd/migrate
go run ./cmd/seed
go run ./cmd/server
```

Default seeded account:

```text
username: admin
password: 123456
```

The document worker runs inside the backend server process. It is configured with:

- `WORKER_CONCURRENCY` for parallel document jobs.
- `WORKER_MAX_RETRIES` for failed job retry budget.
- `WORKER_RETRY_DELAY` for retry backoff, using Go duration syntax such as `10s` or `1m`.

Different documents may run concurrently, but jobs for the same document are serialized. Reprocessing keeps the previous chunks until all new embeddings succeed and the replacement transaction commits.

Rerank is enabled in `.env.example` and uses an OpenAI-compatible `/rerank` endpoint. The backend posts `model`, `query`, and candidate chunk `documents`, then maps response `results[].index` and `relevance_score` or `score` back to chunk IDs. `RERANK_FAILURE_MODE=strict` is the default and returns `RERANK_FAILED`; `fallback` keeps vector order, leaves `rerankScore` empty, and marks `rerankFallback` in search responses.

## Frontend

Run commands from `frontend/`.

```powershell
npm install
npm run dev -- --host 127.0.0.1 --port 5173
npm run build
```

If the frontend is served separately from the API, set:

```text
VITE_API_BASE_URL=http://127.0.0.1:8080/api/v1
CORS_ALLOWED_ORIGINS=http://127.0.0.1:5173
```

When using the Vite dev server with a proxy or same-origin API, the default `/api/v1` works.

## Verification

Use these checks before handing off changes:

```powershell
cd backend
go test ./...

cd ../frontend
npm run build
```

For API behavior, prefer real HTTP smoke tests against the local backend after migrations and seed have run.

## Notes

- API fields are camelCase; database fields are snake_case.
- Knowledge-base data access must check ownership through `knowledge_bases.owner_id`.
- Citations must come only from the final chunks included in the prompt.
- Rerank is part of the standard RAG path and is enabled by default; set `RERANK_ENABLED=false` only when explicitly testing the vector-only degradation path.
