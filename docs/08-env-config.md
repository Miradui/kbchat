# 环境变量规范

本文档定义 MVP 的 `.env.example` 内容。开发时可以创建本地 `.env`，但不要提交真实密钥。

## .env.example

```env
APP_ENV=development
SERVER_PORT=8080
CORS_ALLOWED_ORIGINS=http://127.0.0.1:5173,http://localhost:5173

DATABASE_URL=postgres://rag:rag@localhost:5432/rag?sslmode=disable
REDIS_ADDR=localhost:6379
REDIS_PASSWORD=
REDIS_DB=0

JWT_SECRET=replace-with-local-secret
JWT_EXPIRES_IN=24h

MODEL_PROVIDER=openai_compatible

CHAT_BASE_URL=https://api.openai.com/v1
CHAT_API_KEY=replace-with-chat-api-key
CHAT_MODEL=gpt-4.1-mini

TITLE_BASE_URL=https://api.openai.com/v1
TITLE_API_KEY=replace-with-title-api-key
TITLE_MODEL=gpt-4.1-mini

EMBEDDING_BASE_URL=https://api.openai.com/v1
EMBEDDING_API_KEY=replace-with-embedding-api-key
EMBEDDING_MODEL=text-embedding-3-small
EMBEDDING_DIMENSION=1536

RERANK_ENABLED=true
RERANK_BASE_URL=https://api.openai.com/v1
RERANK_API_KEY=replace-with-rerank-api-key
RERANK_MODEL=rerank-model-name
RERANK_FAILURE_MODE=strict

UPLOAD_DIR=./uploads
MAX_UPLOAD_SIZE_MB=50

VECTOR_TOP_N=30
RERANK_TOP_K=5
SCORE_THRESHOLD=0.3
CHAT_HISTORY_LIMIT=10

WORKER_CONCURRENCY=2
WORKER_MAX_RETRIES=3
WORKER_RETRY_DELAY=10s

VITE_API_BASE_URL=http://127.0.0.1:8080/api/v1
```

## 配置说明

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `APP_ENV` | `development` | 应用环境 |
| `SERVER_PORT` | `8080` | Gin 服务端口 |
| `CORS_ALLOWED_ORIGINS` | `http://127.0.0.1:5173,http://localhost:5173` | 允许跨域访问 API 的前端 Origin，多个值用逗号分隔 |
| `DATABASE_URL` | 本地 PostgreSQL | 数据库连接 |
| `REDIS_ADDR` | `localhost:6379` | Redis 地址 |
| `JWT_SECRET` | 无 | JWT 签名密钥 |
| `MODEL_PROVIDER` | `openai_compatible` | 模型 Provider 类型 |
| `CHAT_BASE_URL` | `https://api.openai.com/v1` | Chat OpenAI-compatible 地址 |
| `CHAT_API_KEY` | 无 | Chat API Key |
| `CHAT_MODEL` | `gpt-4.1-mini` | 聊天模型 |
| `CHAT_HISTORY_LIMIT` | `10` | 聊天问答使用的最近历史消息条数 |
| `TITLE_BASE_URL` | `https://api.openai.com/v1` | 会话标题摘要 OpenAI-compatible 地址 |
| `TITLE_API_KEY` | 无 | 会话标题摘要 API Key；独立于 `CHAT_API_KEY` |
| `TITLE_MODEL` | `gpt-4.1-mini` | 会话标题摘要模型 |
| `EMBEDDING_BASE_URL` | `https://api.openai.com/v1` | Embedding OpenAI-compatible 地址 |
| `EMBEDDING_API_KEY` | 无 | Embedding API Key |
| `EMBEDDING_MODEL` | `text-embedding-3-small` | Embedding 模型 |
| `EMBEDDING_DIMENSION` | `1536` | Embedding 维度 |
| `RERANK_ENABLED` | `true` | 是否启用 Rerank Provider |
| `RERANK_BASE_URL` | `https://api.openai.com/v1` | Rerank OpenAI-compatible 地址 |
| `RERANK_API_KEY` | 无 | Rerank API Key |
| `RERANK_MODEL` | `rerank-model-name` | Rerank 模型 |
| `RERANK_FAILURE_MODE` | `strict` | Rerank 失败策略：`strict` 返回 `RERANK_FAILED`；`fallback` 降级为 vector topK 并标记 `rerankFallback` |
| `UPLOAD_DIR` | `./uploads` | 本地上传目录 |
| `VECTOR_TOP_N` | `30` | 向量召回数量 |
| `RERANK_TOP_K` | `5` | Rerank 后数量 |
| `SCORE_THRESHOLD` | `0.3` | 最低相关分阈值 |
| `ENABLE_RERANK` | `true` | 旧兼容开关；优先使用 `RERANK_ENABLED` |
| `WORKER_CONCURRENCY` | `2` | 文档处理 worker 并发任务数 |
| `WORKER_MAX_RETRIES` | `3` | 文档处理任务失败后的最大重试次数 |
| `WORKER_RETRY_DELAY` | `10s` | 文档处理任务重试退避时间，使用 Go duration 格式 |
| `VITE_API_BASE_URL` | `/api/v1` | 前端 API 地址；跨域/分离部署时设置为完整后端地址 |

`VECTOR_TOP_N`、`RERANK_TOP_K` 和 `SCORE_THRESHOLD` 是知识库未保存对应 `retrievalConfig` 时的默认值。运行时限制 `vectorTopN<=100`、`rerankTopK<=20`，并保证 `rerankTopK<=vectorTopN`。

## Embedding 维度约束

`EMBEDDING_DIMENSION` 必须与数据库字段保持一致：

```sql
embedding vector(1536)
```

如果更换 embedding 模型导致维度变化，必须：

1. 新增数据库 migration。
2. 修改 `document_chunks.embedding` 维度。
3. 重建 pgvector 索引。
4. 清理或重新生成旧 chunks embedding。
5. 更新本文档和 `03-database-design.md`。

当前使用 Qwen3 Embedding 时，Provider 必须请求输出 `1536` 维，避免超过 pgvector `ivfflat` 索引的维度限制。

## Rerank Provider 约束

当 `RERANK_ENABLED=true` 时，后端会创建真实 OpenAI-compatible Rerank Provider；当 `RERANK_ENABLED=false` 时使用 disabled provider，检索结果按向量顺序截断到 `RERANK_TOP_K`，`rerankScore` 为空。

Rerank Provider 请求：

```text
POST {RERANK_BASE_URL}/rerank
Authorization: Bearer {RERANK_API_KEY}
```

请求体包含 `model`、`query` 和候选 chunk 内容数组 `documents`。响应必须返回 `results[].index`，并通过 `results[].relevance_score` 或 `results[].score` 返回分数。`index` 必须在候选数组范围内，否则视为 Provider 响应错误。HTTP 超时为 60s。

`RERANK_FAILURE_MODE` 支持：

```text
strict
fallback
```

默认 `strict`。`fallback` 只应在可接受召回质量降级时使用；此模式不会填充 `rerankScore`，并会在搜索响应中返回 `rerankFallback`。

## AI 开发约束

1. 不要在代码中硬编码 API Key。
2. 不要提交真实 `.env`。
3. 不要让配置默认绕过鉴权。
4. 不要在未迁移数据库的情况下修改 embedding 维度。
5. 程序和 `.env.example` 默认开启 Rerank，标准 RAG 启动必须配置可用的 `RERANK_*`。仅在明确调试无 Rerank Provider 的向量降级路径时，才显式设置 `RERANK_ENABLED=false`。
6. `CHAT_HISTORY_LIMIT` 不要设置过大，避免上下文成本失控；需要长记忆时应另行设计摘要机制。
7. 会话标题摘要必须使用 `TITLE_*` 独立模型配置，不要复用 `CHAT_*`。
