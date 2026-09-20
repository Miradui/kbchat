# 环境变量规范

本文档定义 MVP 的 `.env.example` 内容。开发时可以创建本地 `.env`，但不要提交真实密钥。

进程环境变量优先于磁盘中的 `.env`。因此容器、systemd 或命令行注入的值可以可靠覆盖本地文件；`.env` 只为尚未设置的变量提供默认值。

## P4–P6 配置

`CHAT_ALLOWED_MODELS` 是可选的逗号分隔回答模型白名单；`MODEL_PRICING` 可选地提供按百万 token 的 prompt/completion 价格 JSON，用于质量页成本估算。

## .env.example

```env
APP_ENV=development
SERVER_PORT=8080
CORS_ALLOWED_ORIGINS=http://127.0.0.1:5173,http://localhost:5173

DATABASE_URL=postgres://rag:rag@localhost:5432/rag?sslmode=disable
REDIS_ADDR=localhost:6379
REDIS_PASSWORD=
REDIS_DB=0
RATE_LIMIT_ENABLED=true
RATE_LIMIT_LOGIN_PER_MINUTE=10
RATE_LIMIT_CHAT_PER_MINUTE=30
RATE_LIMIT_FAILURE_MODE=open
TRUSTED_PROXY_CIDRS=
EMBEDDING_CACHE_TTL=24h

JWT_SECRET=change-me-to-a-long-random-secret
JWT_EXPIRES_IN=24h

# 仅 cmd/bootstrap-admin -create 使用；提升现有账号无需设置。
BOOTSTRAP_ADMIN_PASSWORD=
BOOTSTRAP_ADMIN_DISPLAY_NAME=

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

STORAGE_PROVIDER=local
UPLOAD_DIR=./uploads
MINIO_ENDPOINT=http://127.0.0.1:9000
MINIO_ACCESS_KEY=replace-with-minio-access-key
MINIO_SECRET_KEY=replace-with-minio-secret-key
MINIO_BUCKET=rag-documents
MINIO_REGION=
MINIO_USE_SSL=false
MAX_UPLOAD_SIZE_MB=50

VECTOR_TOP_N=30
RERANK_TOP_K=5
SCORE_THRESHOLD=0.3
CHAT_HISTORY_LIMIT=10
KEYWORD_SEARCH_ENABLED=true

WORKER_CONCURRENCY=2
WORKER_MAX_RETRIES=3
WORKER_RETRY_DELAY=10s
STORAGE_OPERATION_TIMEOUT=2m

VITE_API_BASE_URL=http://127.0.0.1:8080/api/v1
```

## 配置说明

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `APP_ENV` | `development` | 应用环境 |
| `SERVER_PORT` | `8080` | Gin 服务端口 |
| `CORS_ALLOWED_ORIGINS` | `http://127.0.0.1:5173,http://localhost:5173` | 允许跨域访问 API 的前端 Origin，多个值用逗号分隔 |
| `DATABASE_URL` | 本地 PostgreSQL | 数据库连接；应用连接的会话时区固定为 UTC，连接参数中的 `timezone` / `TimeZone` 会统一为 UTC |
| `REDIS_ADDR` | `localhost:6379` | Redis 地址 |
| `REDIS_PASSWORD` | 空 | Redis 密码 |
| `REDIS_DB` | `0` | Redis DB |
| `RATE_LIMIT_ENABLED` | `true` | 是否启用登录 IP 与聊天用户限流 |
| `RATE_LIMIT_LOGIN_PER_MINUTE` | `10` | 同一客户端 IP 每分钟登录请求上限 |
| `RATE_LIMIT_CHAT_PER_MINUTE` | `30` | 同一用户每分钟回答生成请求上限，普通发送、流式发送与重新生成合计 |
| `RATE_LIMIT_FAILURE_MODE` | `open` | Redis 计数失败策略：`open` 放行并记录 warning；`closed` 返回 503 |
| `TRUSTED_PROXY_CIDRS` | 空 | 逗号分隔的可信反向代理 CIDR；只有直连来源可信时才读取 `X-Forwarded-For` |
| `EMBEDDING_CACHE_TTL` | `24h` | query embedding Redis 缓存 TTL，使用 Go duration 格式 |
| `JWT_SECRET` | 无 | JWT 签名密钥；必填，须由密码学安全随机源生成至少 32 字节，并替换示例占位值 |
| `BOOTSTRAP_ADMIN_PASSWORD` | 空 | 仅运维 CLI 显式创建首位系统管理员时使用；至少 8 个字符、最多 72 个 UTF-8 字节。提升现有用户时不读取或覆盖其密码 |
| `BOOTSTRAP_ADMIN_DISPLAY_NAME` | 指定的用户名 | 仅首位管理员创建时使用，最多 128 个 Unicode 码点；留空使用 `-username` |
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
| `STORAGE_PROVIDER` | `local` | 文档存储实现：`local` 或 `minio` |
| `STORAGE_OPERATION_TIMEOUT` | `2m` | 单次 MinIO 存储操作、上传失败补偿删除和 cleanup worker 删除的超时，使用 Go duration 格式；仅 MinIO 模式要求为正数 |
| `UPLOAD_DIR` | `./uploads` | 本地上传目录；MinIO 模式仍用于读取切换前的存量文件 |
| `MINIO_ENDPOINT` | 无 | MinIO API endpoint，可写 `host:port` 或 `http(s)://host:port`；不得包含路径或凭据 |
| `MINIO_ACCESS_KEY` | 无 | MinIO access key；仅 `STORAGE_PROVIDER=minio` 时必填；需具备读取 bucket policy 的权限 |
| `MINIO_SECRET_KEY` | 无 | MinIO secret key；仅 `STORAGE_PROVIDER=minio` 时必填，不得提交真实值 |
| `MINIO_BUCKET` | `rag-documents` | 私有文档 bucket；服务启动时不存在会自动创建 |
| `MINIO_REGION` | 空 | 可选 MinIO region |
| `MINIO_USE_SSL` | `false` | endpoint 未写 scheme 时是否使用 HTTPS；显式 `http://` / `https://` 优先 |
| `MAX_UPLOAD_SIZE_MB` | `50` | 单文件上传上限（MiB）；必须为正数，请求体另预留 1 MiB multipart 开销 |
| `VECTOR_TOP_N` | `30` | 向量召回数量 |
| `RERANK_TOP_K` | `5` | Rerank 后数量 |
| `SCORE_THRESHOLD` | `0.3` | 最低相关分阈值 |
| `KEYWORD_SEARCH_ENABLED` | `true` | 关键词召回全局开关。`false` 时所有知识库都只用向量召回，知识库 `enableKeyword` 保存但不生效 |
| `ENABLE_RERANK` | `true` | 旧兼容开关；优先使用 `RERANK_ENABLED` |
| `WORKER_CONCURRENCY` | `2` | 文档处理 worker 并发任务数 |
| `WORKER_MAX_RETRIES` | `3` | 文档处理任务失败后的最大重试次数 |
| `WORKER_RETRY_DELAY` | `10s` | 文档处理和对象清理任务的基础重试退避时间，使用 Go duration 格式 |
| `VITE_API_BASE_URL` | `/api/v1` | 前端 API 地址；跨域/分离部署时设置为完整后端地址 |

`VECTOR_TOP_N`、`RERANK_TOP_K` 和 `SCORE_THRESHOLD` 是知识库未保存对应 `retrievalConfig` 时的默认值。运行时限制 `vectorTopN<=100`、`rerankTopK<=20`，并保证 `rerankTopK<=vectorTopN`。

## Redis 限流与 query embedding 缓存

登录使用 `ratelimit:login:<客户端 IP>`，三个回答生成接口共用 `ratelimit:chat:<用户 ID>`。固定窗口计数通过单条 Lua 脚本原子执行 `INCR` 与首次 `EXPIRE`。`RATE_LIMIT_ENABLED=false` 会同时关闭这两类限流。

`TRUSTED_PROXY_CIDRS` 留空时忽略所有 `X-Forwarded-For`。配置后，只有 TCP 直连地址落在可信网段时才从右向左检查代理链并取首个不可信地址；值必须是 CIDR，例如 `127.0.0.1/32` 或 Nginx 所在的私网网段，不能写裸 IP。

检索按 `embed:<model>:<sha256(normalized query)>` 缓存 query vector。规范化只折叠首尾和连续 Unicode 空白，同一规范化文本也用于实际 Embedding 调用；向量以版本化二进制格式保存。缓存命中不产生 Provider 调用指标，读写失败始终降级为直接调用 Provider。Redis 停止时，`open` 模式仍允许登录和聊天，`closed` 模式的受限接口返回 `RATE_LIMIT_UNAVAILABLE`；embedding 缓存两种模式都只降级。

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

## 关键词召回

`KEYWORD_SEARCH_ENABLED=true`（默认）时，检索在向量召回之外执行一次基于 `document_chunks.search_vector` 的关键词召回，两路结果按 RRF 融合后再进入 Rerank；关闭后行为与只有向量召回时完全一致。它只是全局缺省与开关，各知识库通过 `retrievalConfig.enableKeyword` 决定是否使用，搜索接口也可按请求覆盖。

关键词索引由后端分词器生成，不依赖 PostgreSQL 中文分词扩展。升级到迁移 024 后需要对既有 chunk 执行一次 `go run ./cmd/reindex-keywords`，否则这些 chunk 在重新处理前不会参与关键词召回；新处理的文档在发布时自动写入。分词规则见 [RAG 规范](05-rag-pipeline.md)“混合召回与融合”。

## AI 开发约束

1. 不要在代码中硬编码 API Key。
2. 不要提交真实 `.env`。
3. 不要让配置默认绕过鉴权。
4. 不要在未迁移数据库的情况下修改 embedding 维度。
5. 程序和 `.env.example` 默认开启 Rerank，标准 RAG 启动必须配置可用的 `RERANK_*`。仅在明确调试无 Rerank Provider 的向量降级路径时，才显式设置 `RERANK_ENABLED=false`。
6. `CHAT_HISTORY_LIMIT` 不要设置过大，避免上下文成本失控；需要长记忆时应另行设计摘要机制。
7. 会话标题摘要必须使用 `TITLE_*` 独立模型配置，不要复用 `CHAT_*`。
### P4–P6 配置

`CHAT_ALLOWED_MODELS` 是可选的逗号分隔回答模型白名单；`MODEL_PRICING` 可选地提供按百万 token 的 prompt/completion 价格 JSON，用于质量页成本估算。
