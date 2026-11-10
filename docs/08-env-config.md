# 环境配置

以根目录 [`.env.example`](../.env.example) 为配置模板，不提交真实值。进程环境优先于磁盘 `.env`，后者只补齐未设置的变量。前端Vite不自动读取根 `.env`，模型密钥只放后端。安装步骤见 [README](../README.md)，生产操作见 [部署运维](13-deployment.md)。

## 配置说明

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `APP_ENV` | `development` | 应用环境 |
| `SERVER_PORT` | `8080` | Gin 服务端口 |
| `CORS_ALLOWED_ORIGINS` | `http://127.0.0.1:5173,http://localhost:5173` | 允许跨域访问 API 的前端 Origin，多个值用逗号分隔 |
| `RAG_ALLOW_AUTOMIGRATE` | `false` | 仅本地一次性数据库使用：启动时按 GORM 模型创建缺失表。这样建出的表没有迁移中的 CHECK 约束、外键与级联规则，之后的 `CREATE TABLE IF NOT EXISTS` 会保留这个版本且无法用重跑迁移修复；`APP_ENV=production` 时该开关被忽略。正常流程始终是先执行迁移再启动 |
| `DATABASE_URL` | 本地 PostgreSQL | 数据库连接；应用连接的会话时区固定为 UTC，连接参数中的 `timezone` / `TimeZone` 会统一为 UTC |
| `REDIS_ADDR` | `localhost:6379` | Redis 地址 |
| `REDIS_PASSWORD` | 空 | Redis 密码 |
| `REDIS_DB` | `0` | Redis DB |
| `REDIS_OPERATION_TIMEOUT` | `200ms` | 单次 Redis 命令的总等待预算，覆盖连接、握手、连接池和读写；必须为正 Go duration，不自动重试命令或连接 |
| `REDIS_FAILURE_COOLDOWN` | `5s` | Redis 连接/超时失败后暂停访问的时间；到期仅放行一个恢复探测，成功后恢复缓存和限流；必须为正 Go duration |
| `RATE_LIMIT_ENABLED` | `true` | 是否启用登录 IP 与聊天用户限流 |
| `RATE_LIMIT_LOGIN_PER_MINUTE` | `10` | 同一客户端 IP 每分钟登录请求上限 |
| `RATE_LIMIT_CHAT_PER_MINUTE` | `30` | 同一用户每分钟回答生成请求上限，普通发送、流式发送、重新生成与编辑重生成合计 |
| `RATE_LIMIT_FAILURE_MODE` | `open` | Redis 计数失败策略：`open` 放行并记录 warning；`closed` 返回 503 |
| `TRUSTED_PROXY_CIDRS` | 空 | 逗号分隔的可信反向代理 CIDR；只有直连来源可信时才读取 `X-Forwarded-For` |
| `EMBEDDING_CACHE_TTL` | `24h` | query embedding Redis 缓存 TTL，使用 Go duration 格式 |
| `CHAT_ALLOWED_MODELS` | 空 | 逗号分隔的知识库回答模型白名单；留空不开放模型覆盖 |
| `MODEL_PRICING` | `{}` | 按模型的百万 token 价格 JSON，用于质量页成本估算；键为配置中的模型名（`CHAT_MODEL`、`TITLE_MODEL` 或白名单模型），不是服务商回显的别名 |
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
| `OTEL_SERVICE_NAME` | `rag-backend` | Trace/Metrics共同使用的服务名 |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | 空 | OTLP/HTTP Trace完整端点；空时不导出Trace |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | 空 | OTLP/HTTP Metrics完整端点；空时不周期采集/导出指标 |

`VECTOR_TOP_N`、`RERANK_TOP_K` 和 `SCORE_THRESHOLD` 是知识库未保存对应 `retrievalConfig` 时的默认值。运行时限制 `vectorTopN<=100`、`rerankTopK<=20`，并保证 `rerankTopK<=vectorTopN`。

## 回答模型与用量配置

`CHAT_ALLOWED_MODELS` 是可选的逗号分隔回答模型白名单，留空表示不开放知识库级模型覆盖；`MODEL_PRICING` 可选地提供按百万 token 的 prompt/completion 价格 JSON（例如 `{"gpt-4.1-mini":{"prompt":0.4,"completion":1.6}}`），配置后质量页用量标签显示估算成本，未配置只显示 token 数，格式非法时启动校验失败。

## Redis 限流与 query embedding 缓存

登录使用 `ratelimit:login:<客户端 IP>`，四个回答生成接口（发送、流式发送、重新生成、编辑重生成）共用 `ratelimit:chat:<用户 ID>`。固定窗口计数通过单条 Lua 脚本原子执行 `INCR` 与首次 `EXPIRE`。`RATE_LIMIT_ENABLED=false` 会同时关闭这两类限流。

`TRUSTED_PROXY_CIDRS` 留空时忽略所有 `X-Forwarded-For`。配置后，只有 TCP 直连地址落在可信网段时才从右向左检查代理链并取首个不可信地址；值必须是 CIDR，例如 `127.0.0.1/32` 或 Nginx 所在的私网网段，不能写裸 IP。

检索按 `embed:<model>:<dimension>:<endpoint hash>:<sha256(normalized query)>` 缓存 query vector，模型名、`EMBEDDING_DIMENSION` 与 `EMBEDDING_BASE_URL` 任一变化都会自然失效旧缓存。规范化只折叠首尾和连续 Unicode 空白，同一规范化文本也用于实际 Embedding 调用；向量以版本化二进制格式保存。缓存命中不产生 Provider 调用指标，读写失败始终降级为直接调用 Provider。Redis 停止时，`open` 模式仍允许登录和聊天，`closed` 模式的受限接口返回 `RATE_LIMIT_UNAVAILABLE`；embedding 缓存两种模式都只降级。

缓存、限流和诊断共享同一客户端的故障冷却状态。每次命令最多等待 `REDIS_OPERATION_TIMEOUT`（默认200ms，调度开销另计），不自动重试；连接失败或超时后进入默认5秒冷却，期间直接返回不可用错误，避免缓存读失败后又等待写入或下一次限流。冷却到期的首个命令探测恢复，其余并发请求继续执行既有故障策略；探测失败重新冷却，成功则恢复。客户端请求自身取消不触发冷却；缓存未命中和 Lua `NOSCRIPT` 等 Redis 正常错误响应也不触发，以保留脚本首次加载和过期语义。跨地域或高延迟 Redis 可按实测调整等待预算。

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

当前使用 Qwen3 Embedding 时，Provider 必须请求输出 `1536` 维，与 `document_chunks.embedding vector(1536)` 一致，且不超过 pgvector `vector` 类型 HNSW 索引的 2000 维上限。

## Embedding 配置变更

`EMBEDDING_DIMENSION` 除校验 Provider 返回值外，还在 server 启动和 doctor 中与数据库向量列声明比较，不一致时拒绝启动。升级先执行迁移 029。仅改 `EMBEDDING_MODEL` 也必须重建历史向量；诊断列出未知来源与不匹配文档数，`go run ./cmd/reembed -dry-run` 可先盘点。完整操作流程见 [部署指南](13-deployment.md#embedding-模型切换与重建)。

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

## 文档工作流：PDF OCR 配置

OCR 默认关闭。安装 Poppler、Tesseract 5 及所需语言包后设置 `PDF_OCR_ENABLED=true`；识别过程仅调用本机工具，不向外部识别服务发送文档。识别完成的文字仍走原来的切片、Embedding、检索与引用流程。

| 变量 | 默认值 | 约束与含义 |
| --- | --- | --- |
| `PDF_OCR_ENABLED` | `false` | 只处理未提取到原生文字的 PDF 页 |
| `PDF_OCR_PDFTOPPM_PATH` | `pdftoppm` | 可执行文件名称或绝对路径，不是 shell 命令 |
| `PDF_OCR_TESSERACT_PATH` | `tesseract` | 可执行文件名称或绝对路径 |
| `PDF_OCR_TESSDATA_DIR` | 空 | 空时使用引擎默认语言目录；便携安装应明确指定 |
| `PDF_OCR_LANGUAGES` | `chi_sim+eng` | 1–4 个语言名称，用 `+` 连接，必须已安装 |
| `PDF_OCR_MAX_PAGES` | `40` | 每份文件的待 OCR 页数，范围 1–200，超过则整次失败 |
| `PDF_OCR_MAX_IMAGE_SIDE` | `3000` | 单页渲染图像长边像素，范围 512–4096 |
| `PDF_OCR_PAGE_TIMEOUT` | `30s` | 一页的渲染加识别总时限，范围 1s–2m |
| `PDF_OCR_TIMEOUT` | `5m` | 一份文件的 OCR 总时限，不小于单页时限，最多 20m |

工具不可用在需要 OCR 的任务上返回明确错误，不影响登录或原生文本文档。每页识别输出最多 128 KiB；全部 PDF 最多 500 页、8 MiB 文本，序列化快照最多 16 MiB，图像输出最多 20 MiB、子进程诊断输出最多 16 KiB。取消会终止正在执行的工具，OCR 期间每秒核对任务状态；每个引擎进程限制为一个 OpenMP 线程，文档并发仍由 `WORKER_CONCURRENCY` 决定。

## OpenTelemetry

`OTEL_SERVICE_NAME` 默认 `rag-backend`；`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` 默认空，仅生成本地关联编号，不导出 Trace。配置为完整 HTTP(S) OTLP/HTTP protobuf 地址，例如 `http://127.0.0.1:4318/v1/traces`，即可发送到 Jaeger 或 Collector。通过 OTel SDK 标准 `OTEL_TRACES_SAMPLER` / `OTEL_TRACES_SAMPLER_ARG` 配置采样；默认遵循父采样，根请求采样。接收端故障不阻塞请求；导出最多等待 3 秒，不重试。完整部署、采集范围及脱敏规则见 [可观测性](38-observability.md)。

`OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` 默认空，配置为完整 OTLP/HTTP protobuf 地址（例如 `http://127.0.0.1:4318/v1/metrics`）后启用独立于 Trace 采样的历史指标，每 15 秒采集/发送一次；单次最多三秒、不重试。可观测性 profile 的 4318 端口属于 Collector，负责分发 Trace 和 Metrics；Grafana/Prometheus 的只读本地入口、数据保留与告警规则见 [可观测性](38-observability.md#历史指标看板与告警)。

## 配置安全与约束

1. 不要在代码中硬编码 API Key。
2. 不要提交真实 `.env`。
3. 不要让配置默认绕过鉴权。
4. 不要在未迁移数据库的情况下修改 embedding 维度。
5. 程序和 `.env.example` 默认开启 Rerank，标准 RAG 启动必须配置可用的 `RERANK_*`。仅在明确调试无 Rerank Provider 的向量降级路径时，才显式设置 `RERANK_ENABLED=false`。
6. `CHAT_HISTORY_LIMIT` 不要设置过大，避免上下文成本失控；需要长记忆时应另行设计摘要机制。
7. 会话标题摘要必须使用 `TITLE_*` 独立模型配置，不要复用 `CHAT_*`。
