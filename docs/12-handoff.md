# 跨会话交接

## 当前状态

已完成：

1. `docs/` AI 开发规范文档包。
2. 根目录 `AGENTS.md`。
3. 后端 Gin 基础工程。
4. 前端 Vite React 工程已接入登录、知识库、文档、检索和聊天主流程；仍需结合真实后端环境持续联调。
5. `deploy/docker-compose.yml` 和 `backend/migrations/001_init_schema.sql`。
6. 根目录 `.env` 已写入用户提供的远程 PostgreSQL 和 Redis 配置。
7. 后端已改用 GORM 做数据库访问。
8. 后端已实现：
   - 配置读取和 `.env` 加载。
   - GORM PostgreSQL 连接。
   - Redis 连接诊断。
   - zap 结构化日志。
   - SQL migration 命令。
   - seed 默认用户命令。
   - 统一错误响应。
   - JWT 生成和鉴权中间件。
   - 登录、当前用户、退出接口。
   - 用户私有知识库 CRUD API。
   - 文档上传、列表、详情、删除、重处理和 chunks 空列表 API。
   - 数据库任务 worker。
   - txt、md、pdf 文档解析入口；PDF 按物理页保留真实页码。
   - 按来源格式切片：TXT 按纯文本处理，Markdown 保留结构，PDF 页内切片且不跨页合并或 overlap。
   - 基于 `go-openai` 的 OpenAI-compatible Embedding Provider。
   - 文档处理状态流转和 chunks 入库。
   - 向量检索 API。
   - OpenAI-compatible Rerank Provider、disabled provider 和可配置失败策略；当前 `RERANK_ENABLED=false` 时跳过 rerank。
   - 语义搜索 debug payload：`POST /api/v1/knowledge-bases/:id/search` 可传 `debug=true` 返回 vector/rerank/final 三段调试信息。
   - 聊天会话和消息 API。
   - 基于 `go-openai` 的 OpenAI-compatible Chat Provider；流式路径保留 `[DONE]` 完成信号校验及非流式兼容回退。
   - 基于 `go-openai` 的 OpenAI-compatible Title Provider；会话默认标题会在首次问答后用独立 `TITLE_*` API 摘要更新，不复用 Chat Provider。
   - 多轮 RAG Prompt 组装：最近历史用于 Chat Provider 意图分类、检索问题改写和最终回答上下文。
   - AI 意图分类分支：Chat Provider 输出 `conversation` 或 `knowledge_base`；程序按 intent 路由。`conversation` 跳过知识库检索，直接基于历史回答，`citations=[]`。
   - answer + citations 返回和消息保存。
   - Chat 响应显式返回 `rerankFallback`；fallback 模式下 citations 来自最终 vector topK 且 `rerankScore=null`。
   - Chat regenerate API：指定 assistant 消息后基于前一条 user 消息重新完整检索生成，并新增 assistant 消息。
   - 文档 DTO 返回最新处理任务状态、阶段、稳定进度、重试次数、最大重试次数和下一次重试时间。
   - 知识库工作台接口：分类树、增强列表、统计、收藏、最近浏览。
   - 全局文档列表和全局导入文档接口。
   - 全局关键词搜索接口，覆盖当前用户拥有的知识库、文档和 chunk 内容。
   - 全局关键词搜索支持服务端类型筛选、稳定分页和总数；`all` 模式按类型公平轮转，避免结果类型饿死。
   - 聊天发送使用 session 作用域的 `clientRequestId` 严格幂等契约，网络结果未知时可跨刷新按请求 ID 恢复。
9. 本地 `.env` 已配置 chat、embedding、rerank 三组模型 Provider；Rerank 当前按用户配置关闭。

## 已验证命令

后端：

```powershell
cd backend
go test ./...
go run ./cmd/doctor
go run ./cmd/migrate
go run ./cmd/seed
```

前端：

```powershell
cd frontend
npm run build
npm run dev -- --host 127.0.0.1 --port 5173
```

远程环境验证：

```text
PostgreSQL: 已连接，migration 已执行
Redis: 已连接，PING 成功
```

## 默认测试账号

```text
username: admin
password: 123456
```

真实连接信息保存在根目录 `.env`，该文件已加入 `.gitignore`。

## 模型配置状态

```text
Chat: 已配置独立 CHAT_BASE_URL / CHAT_API_KEY / CHAT_MODEL
Chat history: 默认 CHAT_HISTORY_LIMIT=10，历史消息只用于理解上下文，不能作为事实依据。
Title: 需要独立 TITLE_BASE_URL / TITLE_API_KEY / TITLE_MODEL；用于首次问答后总结会话名称，不复用 CHAT_*。
Embedding: 已配置独立 EMBEDDING_BASE_URL / EMBEDDING_API_KEY / EMBEDDING_MODEL
Embedding dimension: 1536
Embedding note: 当前使用 Qwen3 Embedding，Provider 调用时必须请求输出 1536 维，以兼容 pgvector ivfflat 索引。
Rerank: 已配置独立 RERANK_BASE_URL / RERANK_API_KEY / RERANK_MODEL；`RERANK_ENABLED=true` 使用真实 `/rerank` Provider，`RERANK_ENABLED=false` 使用 vector topK；`RERANK_FAILURE_MODE=strict` 默认失败返回 `RERANK_FAILED`，可设为 `fallback` 降级并在搜索响应返回 `rerankFallback`
```

## 当前后端接口

```text
GET  /healthz
GET  /api/v1/healthz
POST /api/v1/auth/login
GET  /api/v1/auth/me
PUT  /api/v1/auth/me
POST /api/v1/auth/change-password
POST /api/v1/auth/logout
GET  /api/v1/users/search
GET  /api/v1/system/capabilities
GET  /api/v1/home/summary
GET  /api/v1/activities
GET  /api/v1/knowledge-base-categories
POST /api/v1/knowledge-base-categories
POST /api/v1/knowledge-base-categories/reorder
PUT  /api/v1/knowledge-base-categories/:id
DELETE /api/v1/knowledge-base-categories/:id
GET  /api/v1/knowledge-base-tags
POST /api/v1/knowledge-base-tags
PUT  /api/v1/knowledge-base-tags/:id
DELETE /api/v1/knowledge-base-tags/:id
POST /api/v1/knowledge-bases
GET  /api/v1/knowledge-bases
GET  /api/v1/knowledge-bases/workspace-preference
PUT  /api/v1/knowledge-bases/workspace-preference
POST /api/v1/knowledge-bases/batch-favorite
POST /api/v1/knowledge-bases/batch-move-category
POST /api/v1/knowledge-bases/batch-tag
POST /api/v1/knowledge-bases/batch-delete
POST /api/v1/knowledge-bases/batch-restore
GET  /api/v1/knowledge-bases/recycle-bin
DELETE /api/v1/knowledge-bases/recycle-bin/:id
POST /api/v1/knowledge-bases/recycle-bin/empty
GET  /api/v1/knowledge-bases/stats
GET  /api/v1/knowledge-bases/:id
PUT  /api/v1/knowledge-bases/:id
DELETE /api/v1/knowledge-bases/:id
GET  /api/v1/knowledge-bases/:id/permissions
GET  /api/v1/knowledge-bases/:id/stats
PUT  /api/v1/knowledge-bases/:id/permissions
POST /api/v1/knowledge-bases/:id/members
PUT  /api/v1/knowledge-bases/:id/members/:userId
DELETE /api/v1/knowledge-bases/:id/members/:userId
POST /api/v1/knowledge-bases/:id/restore
POST /api/v1/knowledge-bases/:id/favorite
DELETE /api/v1/knowledge-bases/:id/favorite
POST /api/v1/knowledge-bases/:id/view
POST /api/v1/knowledge-bases/:id/documents
GET  /api/v1/knowledge-bases/:id/documents
GET  /api/v1/documents
GET  /api/v1/documents/recycle-bin
DELETE /api/v1/documents/recycle-bin/:id
POST /api/v1/documents/recycle-bin/empty
POST /api/v1/documents/batch-delete
POST /api/v1/documents/batch-restore
POST /api/v1/documents/batch-reprocess
POST /api/v1/documents
GET  /api/v1/documents/:id
GET  /api/v1/documents/:id/download
GET  /api/v1/documents/:id/preview
DELETE /api/v1/documents/:id
PUT  /api/v1/documents/:id
POST /api/v1/documents/:id/cancel
POST /api/v1/documents/:id/restore
POST /api/v1/documents/:id/reprocess
GET  /api/v1/documents/:id/chunks
POST /api/v1/knowledge-bases/:id/search
GET  /api/v1/search
GET  /api/v1/search/suggest
POST /api/v1/chat/sessions
GET  /api/v1/chat/sessions
GET  /api/v1/chat/sessions/recycle-bin
POST /api/v1/chat/sessions/recycle-bin/empty
DELETE /api/v1/chat/sessions/recycle-bin/:id
GET  /api/v1/chat/sessions/:id
PUT  /api/v1/chat/sessions/:id
DELETE /api/v1/chat/sessions/:id
POST /api/v1/chat/sessions/:id/archive
POST /api/v1/chat/sessions/:id/restore
POST /api/v1/chat/sessions/:id/unarchive
GET  /api/v1/chat/sessions/:id/messages
POST /api/v1/chat/sessions/:id/messages
POST /api/v1/chat/sessions/:id/messages/stream
POST /api/v1/chat/sessions/:id/messages/:messageId/regenerate
```

除登录和健康检查外，接口需要：

```text
Authorization: Bearer <token>
```

## 下一步建议

后端 MVP 主链路已跑通，下一步建议：

1. 使用真实后端环境回归登录、知识库、文档、检索 debug、聊天和 regenerate 页面。
2. 使用真实 Rerank 环境做端到端联调；当前 `.env` 中 `RERANK_ENABLED=false`。
3. 回归真实成员管理、会话详情/改名/删除、下载和 chunks 分页，并补充跨视口交互验证。
4. 优化文档处理 worker 的重试和并发控制。
5. 补 README 启动说明。

前端已完成本轮 API 契约接入，但真实 Provider、异步请求和移动端布局仍需持续联调。

## 注意事项

1. Schema 以 `backend/migrations/001_init_schema.sql` 为准。
2. GORM 当前只做 ORM 访问，不让 AutoMigrate 修改已存在表结构。
3. 如果新增表，优先更新 SQL migration，再补 GORM model。
4. 不要把 `.env` 内容复制进文档或提交历史。
5. Rerank、citations、权限校验仍是后续 RAG 模块必须遵守的硬约束；fallback 模式不得伪造 `rerankScore`。
6. 已用真实 HTTP 链路验证：上传 txt 文档后 worker 可处理到 `completed`，并生成 chunks。
7. 已用真实 HTTP 链路验证：search API 可基于 query embedding 返回当前知识库 chunks；当前 Rerank 关闭时 `rerankScore=null`。
8. 已用真实 HTTP 链路验证：聊天问答可返回 answer 和 citations，并保存 user/assistant 两条消息。
9. 删除知识库会级联清理 chat_sessions，已通过临时数据清理验证。
10. 已补单元测试验证：聊天回答会携带最近历史消息，AI 意图分类会输出 intent 和 standaloneQuery；citations 仍只来自本轮 chunks。
11. 已移除程序关键词判断。会话类问题是否跳过知识库检索由 Chat Provider 分类结果决定；分类 JSON 解析失败时默认按 `knowledge_base` 处理。
12. 知识库 `visibility=public|private` 当前只用于前端展示，不改变文档、检索、聊天等主数据访问控制；这些接口仍按 `knowledge_bases.owner_id` 校验。权限管理接口允许 owner 或 manager 管理成员。
13. 浏览量和最近浏览通过 `POST /api/v1/knowledge-bases/:id/view` 显式记录，不在 GET 接口中隐式写入。
14. `GET /api/v1/search` 是关键词搜索；知识库内语义检索仍使用 `POST /api/v1/knowledge-bases/:id/search`。
15. `POST /api/v1/knowledge-bases/:id/search` 仅在请求 `debug=true` 时返回调试 payload；普通响应不携带 debug。
16. Chat regenerate 不覆盖旧 assistant 消息；它会新增一条 assistant 消息，并且 citations 只来自本次重新检索进入 prompt 的 chunks。
17. `POST /api/v1/chat/sessions/:id/messages` 必须携带 UUID `clientRequestId`；同键同内容返回原消息对，同键不同内容返回 `IDEMPOTENCY_KEY_REUSED`。
18. `GET /api/v1/search` 支持 `type/page/pageSize`，响应包含 `total/page/pageSize`；前端筛选和分页均由 URL 驱动。

## Rerank Provider Update

- 新增 `backend/internal/provider/rerank`，实现 OpenAI-compatible `/rerank` Provider。
- Provider 请求体为 `model`、`query`、`documents`，响应通过 `results[].index` 映射回 chunk，并读取 `relevance_score` 或 `score`。
- `backend/internal/router` 现在根据 `RERANK_ENABLED` 选择真实 provider 或 disabled provider。
- 新增 `RERANK_FAILURE_MODE`，默认 `strict` 返回 `RERANK_FAILED`；`fallback` 保留 vector topK、保持 `rerankScore=null`，并在语义搜索响应返回 `rerankFallback`。
- 已补单元测试覆盖 provider 选择、rerank 成功排序截断、strict 失败、fallback 降级和关闭 rerank 的 vector topK 行为。
## P0 Update

- `backend/migrations/005_kb_profile_and_updated_by.sql` 新增 `users.avatar_url` 和 `knowledge_bases.updated_by_id`。
- `POST /api/v1/auth/login` 和 `GET /api/v1/auth/me` 现在都会返回 `avatarUrl`。
- `GET /api/v1/knowledge-bases` 和 `GET /api/v1/knowledge-bases/:id` 现在返回真实持久化的 `updatedBy`，不再默认等于 owner。
- `POST /api/v1/documents` 和 `POST /api/v1/knowledge-bases/:id/documents` 导入文档后会刷新对应知识库的 `updatedAt` 和 `updatedBy`。

## P1 Update

- `backend/migrations/006_kb_tags.sql` 新增 `knowledge_base_tags` 和 `knowledge_base_tag_bindings`
- 新增 `GET/POST/PUT/DELETE /api/v1/knowledge-base-tags`
- 知识库创建和更新支持 `tagIds`
- 知识库列表支持 `tagIds=uuid,uuid` 筛选，列表和详情返回 `tags`
- 删除仍被引用的标签时返回 `TAG_NOT_EMPTY`
- `backend/migrations/007_recycle_bin.sql` 为 `knowledge_bases` 和 `documents` 新增 `deleted_at`
- 知识库和文档删除改为软删除，默认列表/搜索/检索不再返回已删除数据
- 新增 `GET /api/v1/knowledge-bases/recycle-bin`、`POST /api/v1/knowledge-bases/:id/restore`
- 新增 `GET /api/v1/documents/recycle-bin`、`POST /api/v1/documents/:id/restore`
- 新增 `GET /api/v1/knowledge-bases/:id/permissions`、`PUT /api/v1/knowledge-bases/:id/permissions`
- 权限接口最初为 owner-only 兼容视图；后续 P2 更新已补真实成员管理
- 新增 `POST /api/v1/knowledge-bases/batch-favorite`、`POST /api/v1/knowledge-bases/batch-move-category`
- 新增 `POST /api/v1/knowledge-bases/batch-delete`、`POST /api/v1/knowledge-bases/batch-restore`
- 当前批量接口仅覆盖知识库工作台高频操作，且采用 all-or-nothing 语义：只要混入非 owner 资源，整批失败且不产生部分变更
- 新增 `POST /api/v1/documents/batch-delete`、`POST /api/v1/documents/batch-restore`
- 新增 `POST /api/v1/documents/batch-reprocess`
- 当前文档批量接口同样采用 all-or-nothing 语义；批量重处理保留旧 chunks，直到 processor 完成全部 Embedding 后事务替换
- 新增 `POST /api/v1/knowledge-base-categories/reorder`
- 当前分类树重排接口要求提交当前用户完整分类树，并一次性保存 `parentId` / `sortOrder`；若缺项、跨用户或形成环路则整批失败
- 新增 `backend/migrations/008_kb_workspace_preference.sql`
- 新增 `GET /api/v1/knowledge-bases/workspace-preference`、`PUT /api/v1/knowledge-bases/workspace-preference`
- 当前工作台偏好仅保存当前用户的视图配置：`viewMode`、`scope`、`sort`、`visibility`、`expandedCategoryIds`

## P2 Workspace Management Update

- `backend/migrations/009_kb_members_and_chat_archive.sql` 新增 `knowledge_base_members`，并为 `chat_sessions` 增加 `archived_at` 和 `deleted_at` 字段。
- 新增 `GET /api/v1/users/search`，用于成员选择器。
- `GET /api/v1/knowledge-bases/:id/permissions` 现在返回真实 managers/members；owner 始终来自 `knowledge_bases.owner_id` 并固定保留。
- 新增 `POST /api/v1/knowledge-bases/:id/members`、`PUT /api/v1/knowledge-bases/:id/members/:userId`、`DELETE /api/v1/knowledge-bases/:id/members/:userId`。
- 当前 owner 和 manager 可管理成员；owner 不能被删除、降级或通过成员接口重新分配。
- 新增 `GET /api/v1/chat/sessions/:id`、`PUT /api/v1/chat/sessions/:id`、`DELETE /api/v1/chat/sessions/:id`；PUT 仅支持 title，DELETE 当前为硬删除并清理消息。
- 新增 `POST /api/v1/chat/sessions/:id/archive`；归档后默认会话列表隐藏，详情仍可读取并返回 `archivedAt`。
- 新增 `GET /api/v1/documents/:id/download`，下载原始本地文件；文件缺失返回 `DOCUMENT_FILE_NOT_FOUND`。
- 新增 `GET /api/v1/documents/:id/preview`；txt/md 返回文本内容，pdf/其他文件返回 `downloadUrl` 给前端预览。
- `GET /api/v1/documents/:id/chunks` 支持 `page`、`pageSize`、`q`，返回 `items/total/page/pageSize`。
- 新增 `DELETE /api/v1/knowledge-bases/recycle-bin/:id`、`POST /api/v1/knowledge-bases/recycle-bin/empty`。
- 新增 `DELETE /api/v1/documents/recycle-bin/:id`、`POST /api/v1/documents/recycle-bin/empty`。
- 回收站清空保持 all-or-nothing 语义；永久删除仅允许当前用户 owner 的已删除资源。
- 已补服务层测试覆盖用户搜索、成员管理、manager/非 manager 权限、owner 不可删除、会话详情/改名/删除/归档、下载成功和缺文件、预览文本/PDF、chunks 分页搜索、回收站永久删除/清空 owner 范围。

## P3 Documentation and Worker Reliability Update

- 新增根目录 `README.md`，覆盖项目范围、目录结构、环境准备、后端/前端启动、验证命令和 worker 配置。
- 新增根目录 `.env.example`，仅包含示例值和占位密钥，不包含真实环境配置。
- `.gitignore` 已忽略 `.env`、IDE/本地工具目录、上传文件、日志、前端依赖和构建产物。
- 文档处理 worker 支持可配置并发：`WORKER_CONCURRENCY`，默认 `2`。
- 文档处理 worker 支持失败重试：`WORKER_MAX_RETRIES`，默认 `3`；`WORKER_RETRY_DELAY`，默认 `10s`。
- 失败任务在重试预算耗尽前会重新进入 pending，并使用 `document_jobs.locked_at` 作为下一次可领取时间；耗尽后才将文档状态置为 `failed`。
- 已补 `backend/internal/job` 单元测试覆盖重试、耗尽失败和并发处理。

## Backend API Completion Update

- `backend/internal/dto/search.go` 新增 `debug` 请求字段和 `debug` 响应 payload。
- `backend/internal/retrieval/service.go` 在 `debug=true` 时返回 vector stage、rerank stage、final stage 和 `rerankFallback`，默认响应不变。
- `backend/internal/dto/chat.go` 的发送消息响应新增 `rerankFallback`；未 fallback 时为 `null`。
- 新增 `POST /api/v1/chat/sessions/:id/messages/:messageId/regenerate`，只能重新生成 assistant 消息，会基于其前一条 user 消息重新执行意图分类、检索、Rerank、Prompt 和 Chat Provider，并追加新 assistant 消息。
- `GET /api/v1/documents`、`GET /api/v1/knowledge-bases/:id/documents`、`GET /api/v1/documents/:id` 返回 `jobStatus`、`progress`、`stage`、`retryCount`、`maxRetries`、`nextRetryAt`。
- 本次未新增数据库字段或 migration；document progress 来自已有 `documents.status` 和最新 `document_jobs`。

## Post-merge RAG Correctness and Frontend Integration Update

- 标准检索现在默认读取知识库 `retrievalConfig`；Chat 不再用全局 TopN/TopK 覆盖知识库配置。
- 最终候选应用 `scoreThreshold`：Rerank 成功使用 `rerankScore`，disabled/fallback 使用 `vectorScore`；过滤后的 chunks 才能进入 Prompt 和 citations。
- `vectorTopN` 最大 `100`，`rerankTopK` 最大 `20` 且不会超过 `vectorTopN`。
- fallback 公共原因固定为 `provider_unavailable`，不再返回第三方 Provider 原始错误文本；未 fallback 时 Search 显式返回 `rerankFallback=null`。
- 前端已接入 Chat fallback、最新 assistant 回答 regenerate、知识库检索三阶段 debug，以及文档任务进度/重试信息。
- Chat 发送与 regenerate 已互斥，切换会话后旧请求不会回写当前会话；知识库检索也会忽略晚到的旧响应。
- 新增后端检索/契约/Chat 配置测试和前端资源、Chat、KnowledgeBase、DocumentDetail 测试。

## Document Format-aware Processing Update

- 文档 parser 现在输出带来源格式和可选物理页码的结构化 segments；旧的扁平文本方法仅保留为兼容包装，标准 processor 链路不再使用它。
- TXT 不解释 Markdown 标题、列表、表格或代码围栏；Markdown 继续保留标题路径、列表、表格和代码块结构。
- PDF 按非空物理页切片，空白页跳过但页码不重排；chunk、overlap 都不跨页，`document_chunks.page_number` 和 metadata 同步保存物理页码。
- `startOffset` / `endOffset` 定义为主来源内容在规范化 segment 内的 UTF-8 byte offset，PDF 为页内 offset；额外 overlap 和复制的 Markdown 结构前缀不计入范围，也不代表原文件精确字节坐标。
- 超长 Markdown 列表优先按完整 item 行切分，单行仍超预算时重复原 marker；表格分片重复 header/separator，超长行按 cell 拆成相同列数；代码分片保持成对 fence。这些结构块不注入普通文本 overlap。
- Processor 级 SQLite + repository 测试覆盖 PDF 页码入库、TXT/Markdown 策略选择、Embedding Provider 单批少/多返回零写入，以及后续批次失败时保留旧的完整 chunks。
- Processor 在所有 Embedding 批次成功后才通过数据库事务替换旧 chunks，避免重处理失败留下部分新索引。
- Chunk repository 测试使用 51 条 replacement 在第二批制造主键冲突，验证删除和首批写入一起回滚；repository 也会在事务开始前拒绝混入其他文档的 chunk。
- 当前范围不包含 OCR、PDF 版面树/表格重建、跨页 chunk、通用文档 AST 或 docx 解析。

## Completion Audit Reliability Update

- 文档批量删除、恢复和重处理在 repository transaction 内执行；中途写入或知识库 touch 失败时整批回滚。
- 单文档与批量重处理不会提前删除旧 chunks；同一文档处理中复用活动 job，worker 收尾窗口则创建 pending 后继 job。
- worker 不会在同一文档仍有 running job 时领取后继 pending job，避免并发替换同一索引。
- processor 成功发布 chunks 时在单个 transaction 内同时终结 document/job；worker 的后续完成调用对该 completed 状态幂等。失败终态仍拒绝迟到旧 job 覆盖后继处理状态。
- 知识库列表与统计排除软删除文档和软删除会话。
- Markdown overlap 不跨 headingPath；超长嵌套列表重复缩进 marker；表格识别忽略转义管道和 inline code span 管道，并保持极小预算下的转义原子性。
- 无正文的 Markdown heading 保留为 heading chunk，不会在同级切换或文档结尾静默丢失。
- 全局文档台账展示进度、重试计划和失败原因；轮询不会清除操作错误，所有刷新入口都会捕获失败，写成功后的刷新失败使用独立提示。

## Final Merge Readiness Update

- 文档重处理期间继续检索当前已发布 chunks；只有新一轮解析、切片和全部 Embedding 成功后才原子替换，处理中或失败状态不会让既有索引暂时消失。
- `backend/migrations/010_chunk_document_kb_integrity.sql` 会先按 document 修复历史 chunk 的知识库归属，再通过复合外键约束 `document_id + knowledge_base_id`；repository 写入和向量查询也执行同一隔离规则。
- 文档上传在同一事务内创建 document、processing job 并更新知识库；事务失败会补偿删除已保存文件，文件清理失败保留在内部错误链中。
- Markdown fenced code 在极小预算下优先保留正文并维持正文 offset；合法但没有可检索正文的空/空白 fence 不产生 chunk，也不会吞掉前置 heading。
- 前端当前用户请求按认证世代缓存并复用 in-flight 结果；并发或迟到的旧 401 不会重复跳转，也不会清除新登录 token。
- Chat 可以从任意历史 assistant 回答切换查看真实 citations，右栏展示 filename、pageNumber、content、vectorScore 和 rerankScore；发送、重新生成或切换会话后回到最新回答。
- Chat 工作区在宽屏使用三栏、常见桌面宽度使用两列、`<=980px` 使用单列面板顺序；移动端可纵向访问会话、消息和引用，不依赖被裁剪的横向内容。

## UX Recovery Fixes

- 新问答入口先进入 `/chat/new?knowledgeBaseId=...` 草稿页，首次提交问题时才创建会话，避免仅浏览入口就产生空会话。
- 聊天发送失败会保留原问题并提供重试；网络中断等发送结果未知时先检查消息列表，只有用户明确确认后才重新发送；发送成功但列表刷新失败会单独提示，不会误报为发送失败。
- Chat、Embedding、Rerank 的公开错误消息改为中文业务提示，原始 Provider 错误保留在服务端错误链中。
- 文档公开 DTO 不再返回原始处理错误；配置缺失与一般处理失败分别返回可恢复的中文提示。
- 文档 `failed` 的稳定进度从 `100` 改为 `0`，失败状态由 `status/stage=failed` 单独表达。
- 工作台统计上一周期为 0 时返回 `changeRatio=null`，前端展示“本月新增”或“暂无可比数据”。

## Frontend API Gap Closure Update

本轮补齐 `docs/14-frontend-api-gaps.md` 的 G1、G3、G4、G5、G6、G20，未新增数据库字段或 migration。

- `GET /api/v1/knowledge-base-tags` 每项返回 `knowledgeBaseCount`。计数口径与 `TAG_NOT_EMPTY` 判定完全一致：统计当前用户名下引用该标签的知识库，**包含回收站中的知识库**，因此计数大于 0 就一定删不掉。`POST` 返回 `0`，`PUT` 返回实际计数，知识库内嵌的 `tags` 摘要不带该字段。
- `GET /api/v1/knowledge-base-categories` 每个节点返回 `directCount` 和 `totalCount`；两者都排除软删除知识库，也不含未分类知识库。仅树接口返回，单节点的 `POST` / `PUT` 响应不带。
- 新增 `POST /api/v1/chat/sessions/:id/unarchive`，与 archive 一样幂等，对未归档会话直接返回当前会话。
- `GET /api/v1/chat/sessions` 支持 `knowledgeBaseId`、`archived`、`q`、`page`、`pageSize`，响应加 `total/page/pageSize`。列表项新增 `knowledgeBaseName`、`messageCount`、`lastMessagePreview`；`q` 只匹配会话标题，`lastMessagePreview` 服务端截断到 120 字符。`archived` 一次只返回一侧，不支持混合。
- 新增 `GET /api/v1/system/capabilities`。为保证它与实际校验同源，`internal/retrieval` 的上限常量改为导出的 `MaxVectorTopN` / `MaxRerankTopK`，上传白名单提取为 `service.AllowedDocumentExtensions`，`validateFile` 与该接口读同一份值。
- `GET /api/v1/knowledge-bases/:id/documents` 改为 `GET /api/v1/documents` 的知识库限定视图，共用同一 service 路径；`repository.ListByKnowledgeBase`、`DocumentService.latestJobsForDocuments`、`dto.DocumentListResponse` 已删除。**兼容性变更**：该接口从「不分页返回全部」变为默认 `pageSize=20`，响应结构改为带 `total/page/pageSize` 与 `knowledgeBaseName`。不属于当前用户的知识库仍返回 `KNOWLEDGE_BASE_NOT_FOUND`，不会退化成空列表。
- 知识库详情响应刻意**没有**加文档状态计数：`TestKnowledgeBaseMutationAndDetailResponsesOmitListOnlyDocumentReadinessCounts` 明确要求 create/update/detail 不返回这些 list-only 字段。知识库概览页改为「最近 6 条 + 按状态各取一次 `total`」，`processing` 由 `total - completed - failed` 推出（文档状态只有 completed、failed 和四个处理中状态）。
- 前端接入：`useChatSessions` 改为服务端筛选分页并新增「活跃 / 已归档」切换；会话栏显示最后一条消息摘要与消息数；标签页显示使用量并在删除确认里给出具体数字；分类树节点显示计数（折叠时显示累计值）；`systemCapabilitiesStore` / `useSystemCapabilities` 统一提供服务端限制，请求失败时回落到与服务端默认值一致的常量，表单仍可用。
- 新增测试：`backend/internal/service/frontend_gap_service_test.go`（会话筛选分页与富字段、预览截断、归档筛选与 unarchive 幂等、标签计数与删除判定一致、分类树计数、文档限定列表查询面与越权拒绝、capabilities 与实际限制同源且不别名白名单）、`frontend/src/api/resources.gaps.test.ts`、`frontend/src/store/systemCapabilitiesStore.test.ts`。
- 仍未实现：G2 流式输出、G7 文档重命名/移动、G8 取消任务、G9 高亮位置、G10 搜索建议、G11 账户接口、G12 批量打标签、G13 单知识库统计、G15 会话软删除、G16 回答反馈、G17 首页聚合、G18 活动流、G19 导出。

## Frontend API Gap Closure Update 2

本轮补齐 `docs/14-frontend-api-gaps.md` 的 G7、G8、G9、G10、G11、G12、G13、G15、G17、G18，并闭环上一轮 G6 遗留的 `rerankEnabled` 消费。**G2 流式输出仍未实现**。

### 新增数据库变更

- `backend/migrations/011_document_chunk_kb_move.sql`：把 `document_chunks` 的复合外键 `(document_id, knowledge_base_id)` 改为 `DEFERRABLE INITIALLY IMMEDIATE`。跨知识库移动必须同时改动 document 和 chunks 两侧，非 deferrable 的 `NO ACTION` 外键下两种顺序都会失败；只有移动事务会 `SET CONSTRAINTS ... DEFERRED`，其他写入路径行为不变。
- `backend/migrations/012_activities.sql`：新增 `activities` 表。`resource_name` / `knowledge_base_name` 刻意反范式化保存，因此对资源表**没有外键** —— 删除事件恰恰要在资源已不存在时仍可读。

### 新增端点

- `PUT /api/v1/auth/me`、`POST /api/v1/auth/change-password`
- `POST /api/v1/knowledge-bases/batch-tag`
- `GET /api/v1/knowledge-bases/:id/stats`
- `PUT /api/v1/documents/:id`、`POST /api/v1/documents/:id/cancel`
- `GET /api/v1/search/suggest`
- `GET /api/v1/home/summary`
- `GET /api/v1/activities`
- `GET /api/v1/chat/sessions/recycle-bin`、`POST /api/v1/chat/sessions/:id/restore`、`DELETE /api/v1/chat/sessions/recycle-bin/:id`、`POST /api/v1/chat/sessions/recycle-bin/empty`

### 契约变更（注意兼容性）

- **`DELETE /api/v1/chat/sessions/:id` 从硬删除改为软删除，且不再级联删除消息**。会话进入聊天回收站，消息只在永久删除时清理。`chat_sessions.deleted_at` 早在 migration 009 就存在，本次没有新增字段。原先断言级联删除的 `TestChatSessionDeleteHidesSessionAndMessages` 已改写为 `TestChatSessionDeleteHidesSessionAndKeepsMessages`。
- `GET /api/v1/search` 结果项新增 `highlights`。**偏移量口径是 UTF-16 code unit（JS 字符串下标）**，不是 UTF-8 字节偏移，也不是码点下标。中文场景下三者不同，选错会静默错位。
- `GET /api/v1/system/capabilities` 新增 `account` 段；密码最小字符数、密码 UTF-8 最大字节数和显示字段限制与 `PUT /auth/me`、`POST /auth/change-password` 的校验同源。
- 文档 `jobStatus` 新增 `cancelled` 取值；被取消的文档 `status` 仍是 `failed`，两者只能靠 `jobStatus` 区分。

### 取消任务与 worker 的原子性（G8）

取消与最终发布现在使用同一 document 聚合锁，并把成功发布收紧为单一事务：

- `finalizeJob`（CompleteJob / FailJob）原本就要求 job 仍是 `running`
- **`RetryJob` 补上了同一条 `status='running'` 守卫**。此前它只按 job id 更新，会把已取消的任务重新置为 `pending`，等于复活
- `UpdateStatus` 与批次检查都绑定 `documentID + jobID`，并通过 document 行锁与取消串行化；job 不再 running 时返回 `repository.ErrDocumentJobCancelled`
- 每个 Embedding 批次前后检查 context 与 job 状态；取消提交后不再发起剩余批次
- chunks 替换、document completed、job completed 在同一个事务提交。取消先赢则旧 chunks 保持不变；发布先赢则后续取消不可再生效
- worker 识别该 sentinel，不再记为「重试」

已完成的 Embedding 批次不回滚；只有全部批次成功且 job 仍 running 时才原子发布，因此取消不会留下半套索引，也不会破坏上一版 chunks。

### 跨知识库移动（G7）

- 移动时 document 与其 chunks 在同一事务内一起改 `knowledge_base_id`（配合 migration 011 的 deferrable 外键）
- **文档存在 pending / running 任务时拒绝移动**，返回 `DOCUMENT_JOB_ACTIVE`：已领取的 processor 会按启动时读到的知识库写 chunks
- 重命名不能修改扩展名（`DOCUMENT_EXTENSION_IMMUTABLE`）：`fileType` 由扩展名确定并决定 parser 选择
- 移动会同时 touch 源、目标两个知识库的 `updatedAt` / `updatedBy`

### 活动流（G18）

- 记录是**尽力而为**的：`ActivityRecorder.Record` 吞掉写入错误，不会让触发它的操作失败。时间线是便利视图，不是审计日志
- 通过 `SetActivityRecorder` 在构造之后注入，recorder 为 nil 时完全不记录，因此所有既有构造点和测试无需改动

### 前端接入

- 账户设置对话框挂在 rail 用户菜单下，**按需挂载**：不打开就不会请求 `/auth/me` 与 `/system/capabilities`
- 首页五个区域由 `GET /home/summary` 一次请求驱动，`homeData.ts` 用「并发合流」共享同一个 in-flight promise；promise settle 后即丢弃，因此重试会真正重新发请求。**代价**：这四个区域现在同生共死，不再各自独立失败；时间线是独立资源，仍然独立
- 搜索页的客户端子串匹配 `highlight()` 已删除，改为渲染服务端 `highlights`
- ⌘K 面板改用 `searchSuggest`；由于 suggest 不检索 chunk 内容，面板始终保留「查看全部结果」入口
- 检索配置表单在 `rerankEnabled=false` 且用户勾选精排时主动提示（G6 闭环），不再只能等 `rerankFallback` 被动出现

### 验证状态

- 后端 `go test ./...` 全绿；`go vet` 仅剩 `internal/model/models.go` 3 条既有 struct tag 告警
- 前端 `npx vitest run`：10 个文件失败 / 113 条用例失败，与本轮开工前基线一致（信息架构重构导致的断言漂移，用户已同意暂不修）。`homeData.test.ts` 与 `HomePage.test.tsx` 中直接断言本轮所改契约的用例已同步更新
- **注意**：`npx tsc --noEmit` 对本项目是空操作 —— 根 `tsconfig.json` 是 `files: []` 的 solution 文件。真实类型检查请用 `npx tsc -b`（`npm run build` 用的就是它）

### 仍未实现

- G16 回答反馈、G19 导出、G14 上传进度（纯前端改造）

## Chat Streaming Update (G2)

补齐 `docs/14-frontend-api-gaps.md` 最后一条 P0：`POST /api/v1/chat/sessions/:id/messages/stream`。**无数据库变更**。

### 分层

- `internal/chat.StreamingProvider` 是 `Provider` 之外的**可选**接口，不是把 `Provider` 变宽 —— 这样所有既有实现和测试 fake 无需改动即可继续满足 `Provider`
- `internal/provider/chat` 实现 `ChatStream`，按 OpenAI 兼容的 `stream: true` 协议解析 `data: {json}` 行直到 `data: [DONE]`
- Provider 不支持流式时**回落到阻塞调用**，整段回答作为单个 delta 发出。端点行为不变，只是没有逐字效果
- 流式请求使用独立的 `http.Client`：**不设整体超时**（长回答本来就会超过一次请求预算），取消依赖 request context，只用 `ResponseHeaderTimeout` 兜住无响应的端点

### 只有一条生成路径

`generateAnswer` 没有被复制成流式版本，而是改成接受可选的 `answerHooks`（`onCitations` / `onDelta`）。两个 hook 都为空时行为与原来逐字节相同。这一点直接关系到「citations 只能来自本轮进入 prompt 的 chunks」这条约束：两条平行的生成路径正是这种规则最容易悄悄漂移的地方。落库同理，`buildChatMessagePair` 由两条发送路径共用。

### 事件顺序与文档建议不同（有意为之）

实际顺序是 **`citations` → `delta`* → `done`**，而缺口文档最初建议 `delta` → `citations` → `done`。理由是物理上的：citations 是**进入 prompt 的输入**，检索一结束就已确定，压到最后只是把服务端已掌握的信息扣住不发。先发它还能让前端区分「还在检索」和「已在生成」。conversation 意图也会发一次空 `citations`。

### 中断语义

**生成全部完成之前不写库。** 中断因此不留任何痕迹，客户端按同一 `clientRequestId` 对账：查不到就能安全重发。选择丢弃而非落一条部分消息，是因为被截断的回答会进入历史，之后每一轮都会把它当成上下文读进去。

`done` 是唯一的成功信号；前端 `sendChatMessageStream` 在流未带 `done` 就结束时**抛 `STREAM_INCOMPLETE`**，从而落进 `useChatThread` 既有的「结果未知」对账逻辑，而不是被误当成功后清掉 pending。

OpenAI-compatible Provider 同样把上游 `data: [DONE]` 作为唯一协议完成信号：有效 delta 后直接 EOF、连接截断或非空畸形 JSON data 帧都会返回错误，半截回答不会作为成功结果交给 service 落库。

### 错误的两个阶段

- 首个事件之前：普通 HTTP 错误（401/404/校验/`409 IDEMPOTENCY_KEY_REUSED`）。幂等检查刻意排在任何输出之前，就是为了保住这条路径
- 首个事件之后：响应已锁定 200，只能发 `error` 事件。`handler.errorPayload` 被抽出来给 JSON 错误和 SSE `error` 事件共用，避免两套映射漂移

### 顺带修正的既有问题

**SQLite 测试库从来没有创建过那条部分唯一索引**（`AutoMigrate` 不还原 `migrations/010_chat_message_idempotency.sql` 的 `WHERE` 子句），因此在此之前，幂等的**数据库层保证一直没有被任何测试覆盖**：既有测试通过，靠的是 service 层在插入前的查重，那只挡得住顺序重试，挡不住真正的并发竞争。`newChatServiceTestDB` 现在显式建这条索引，并新增了一个「并发落败方采用胜出者消息对」的测试。

### 测试

- `internal/service/chat_stream_service_test.go`：事件顺序、重放不调用 Provider、同键异内容在发出任何事件前拒绝、**中断后零落库 + 同键重发只产生一对消息**、Provider 中途失败零落库、并发落败方采用胜出者、非流式 Provider 回落、conversation 空 citations、无依据时拒答文本也走 delta
- `internal/handler/chat_stream_handler_test.go`：SSE 帧格式（前端解析器依赖的线上契约）、提交后错误转为事件、断连即停
- `frontend/src/api/eventStream.test.ts`：跨 chunk 边界重组帧、一个 chunk 多帧、注释/keep-alive、CRLF、尾部残帧丢弃
- `frontend/src/api/chatStream.test.ts`：事件顺序、错误事件转 `ApiError`、无 `done` 即 `STREAM_INCOMPLETE`、`done` 后停止消费、坏帧不影响整体

### 验证状态

- 后端 `go test ./...` 全绿（16 个包）；`go vet` 仍只有 `models.go` 3 条既有告警
- 前端 `npx tsc -b` 与 `npm run build` 通过；`npx vitest run` 仍为 10 个文件 / 113 条用例失败，与基线一致（本轮新增 12 条全部通过）

## Correctness Audit Fixes

- 前端聊天只有明确 HTTP 4xx 才视为确定失败；`STREAM_INCOMPLETE`、`status=0`、网络异常和 5xx 都保留原 `clientRequestId` 进入对账。对账发现已提交 assistant 后不会再次发送。
- OpenAI-compatible Chat 流必须收到 `[DONE]`，坏 JSON data 帧不再静默跳过；不完整上游流不新增 user/assistant 消息。
- migration 013 为 PostgreSQL `document_jobs_status_check` 增加 `cancelled`。Embedding 批次间停止、发布/完成原子化，并覆盖取消紧邻发布的竞争。
- 密码最大值改为 UTF-8 72 字节，capabilities 字段为 `account.maxPasswordBytes`；后端超限返回 400，账户设置与登录页使用相同字节口径。
- 用户 repository 拆为 `UpdateProfile` / `UpdatePassword`，资料保存不会用陈旧实体覆盖刚修改的密码。
- 聊天回收站列表与清空共用知识库 owner/可见范围；已删除知识库下的隐藏会话会保留到知识库恢复。
- 从浏览器存储恢复的未知聊天请求会重新启动两轮自动对账；每次核对带递增序号，迟到旧响应不能覆盖较新消息或让核对进度倒退。调用方回调通过 ref 读取，页面重渲染不会重启 timer 或把在途核对误判为旧请求。
- 文档任务领取、失败/完成收尾和永久删除统一先锁 document，再处理 chunks/jobs；知识库永久删除也先按 document ID 顺序锁定文档，消除这些路径与取消之间的 PostgreSQL 锁序反转。
- 聊天回收站清空和单项永久删除先锁定仍处于删除状态的会话；并发恢复使用条件更新，落败方返回 `RESOURCE_NOT_FOUND`。
- 修改密码以读取时的旧哈希做 compare-and-swap；并发使用同一旧密码时只有一个请求成功。登录页不 trim 密码原值，只对真正空字符串做必填校验；表单关闭浏览器原生拦截，由同一套自定义错误负责焦点和 `aria-describedby`。
- 仍未实现且需要后端能力：G16 回答反馈、G19 导出。G14 上传进度仍是纯前端改造。

## Gap Closure Final Update (2026-08-12)

本文较早章节中关于 G14、G16、G19“仍未实现”、聊天会话硬删除，以及
`go vet` 尚有 3 条 struct tag 告警的表述仅保留为历史记录；当前最终状态以本节
为准。

### 已闭环能力

- G14 已由前端闭环：multipart 上传使用 `XMLHttpRequest.upload.onprogress` 的
  `loaded / total` 字节事件展示逐文件真实传输百分比。传输进度与后续解析、
  切片、Embedding 处理进度分开表达，不需要新增后端上传协议。
- `backend/migrations/014_chat_message_feedback.sql` 为 `chat_messages` 新增
  `feedback_rating`、`feedback_updated_at`，并以 CHECK 约束限制评价为
  `positive|negative|null`。
- G16 新增 `POST /api/v1/chat/messages/:messageId/feedback`。只允许评价当前用户
  可见会话中的 assistant 消息，重复提交覆盖原评价；所有消息 DTO 固定返回
  nullable `feedback`，前端可恢复 `aria-pressed` 选择状态。
- G19 新增 `GET /api/v1/chat/sessions/:id/export`，导出按时间升序包含消息和
  citations 的 UTF-8 Markdown；新增 `GET /api/v1/search/export?q=&type=`，导出
  带 UTF-8 BOM 的 CSV。搜索导出允许恰好 5000 条，从 5001 条起返回
  `EXPORT_TOO_LARGE`。
- 聊天会话删除保持软删除语义并保留消息；列表、恢复、单项永久删除和清空
  回收站均已实现，消息只在永久删除时物理清理。
- 账户展示名称和头像上限统一按 Unicode 码点计数；新密码最小长度按码点、
  最大长度按 UTF-8 72 字节计数。登录密码不 trim。
- GORM 聊天幂等部分索引的 `where` 条件改写为等价的
  `role = 'user' OR role = 'assistant'`，移除了非法 `\,` struct tag，同时保持
  user/assistant 消息唯一索引语义。

### 新增或强化的回归覆盖

- feedback service 覆盖 positive/negative 覆盖写、消息列表恢复、owner scope、
  user 消息拒绝和非法 rating。
- Markdown 导出断言精确文件名、知识库行、消息顺序、`### 来源`、页码和三空格
  引用正文缩进。
- CSV 导出断言 UTF-8 BOM、精确表头、owner scope，以及 5000 成功 / 5001
  `EXPORT_TOO_LARGE` 边界。
- router 契约测试直接覆盖三个新增端点，并断言 Markdown/CSV 的
  `Content-Type` 与 `Content-Disposition`。
- ChatPage 覆盖反馈 API 成功回写与导出下载；旧测试改为等待初始 thread/session
  数据真正可用，避免在禁用输入框或 Skeleton 上制造全量并发假失败。

### 最终验证

- `cd backend; go test ./...`：通过。
- `cd backend; go test -race ./internal/repository ./internal/service`：通过。
- `cd backend; go vet ./...`：通过，原 3 条非法 struct tag 告警已清零。
- `cd frontend; npx tsc -b`：通过。
- `cd frontend; npm run build`：通过，route chunk 校验为 9 个页面级 chunk。
- `cd frontend; npx vitest run`：42 个测试文件、283 条用例全部通过；其中
  `ChatPage.test.tsx` 58/58，`DocumentsPage.test.tsx` 22/22。

可选的真实 PostgreSQL 行锁集成测试只读取显式的 `RAG_TEST_POSTGRES_DSN`；
未设置时按设计跳过，设置后使用独立临时 schema。SQLite 单元测试不能替代该
真实锁等待验证。

## Chat UX Update (2026-08-18)

- 聊天模型调用统一通过 `github.com/sashabaranov/go-openai`：Chat、流式 Chat、
  Embedding 和 Title 均使用 OpenAI-compatible SDK；Rerank 的供应商 `/rerank`
  扩展端点仍由独立 Provider 负责。
- user 消息支持复制和编辑；assistant 回答支持复制和重新生成。编辑成功后保留
  原 user 消息 ID，删除其后的旧尾部并写入新的 user/assistant 消息，不保留版本树。
  `Escape` 取消，`Ctrl/Cmd+Enter` 保存并重新生成；编辑结果未知时复用原
  `clientRequestId` 对账，不重复生成。
- 编辑、发送和重新生成互斥；编辑生成在途时禁用其它写操作，避免并发请求覆盖草稿。
  会话列表仍由独立滚动区域承载，顶部知识库选择、新建和活跃/归档切换保持固定。
- 左侧账户栏会显示已保存的头像 URL；图片加载失败时回退默认图标，不影响账户菜单。
- 真实浏览器联调按项目约定只检查 `1920x1080`：登录、深层 URL、会话侧栏、消息
  复制/编辑入口均已验证，控制台错误为 0。`.env` 未修改，工作区改动未提交。

## MinIO Storage Update (2026-08-18)

- 文档存储新增 `STORAGE_PROVIDER=minio`，使用 `github.com/minio/minio-go/v7` 接入 S3-compatible MinIO；配置项为 `MINIO_ENDPOINT`、`MINIO_ACCESS_KEY`、`MINIO_SECRET_KEY`、`MINIO_BUCKET`、`MINIO_REGION`、`MINIO_USE_SSL`。
- MinIO bucket 保持私有，下载和预览继续由现有 owner-scoped API 代理。对象位置以 `minio://bucket/key` 写入 `documents.storage_path`，key 不含用户原始文件名。
- 上传、下载、文本预览、永久删除和 worker 解析统一通过 storage 接口。worker 将远端对象物化到权限受限的临时文件并在本轮处理结束时清理。
- 切换 MinIO 后，非 `minio://` 的历史本地路径仍由 `UPLOAD_DIR` 读取；本次不自动迁移或删除存量本地文件。
- MinIO 必填配置在启动时校验。endpoint 支持 `host:port` 或 `http(s)://host:port`，拒绝路径、嵌入凭据和非 HTTP(S) scheme；启动时检查 bucket，不存在则自动创建，连接、凭据或权限错误会阻止服务启动。
- 使用官方 `github.com/minio/minio-go/v7` SDK。启动时拒绝带 bucket policy 的 bucket，并容忍多进程同时创建同一 bucket 的竞态；凭据必须能够读取 bucket policy。
- migration 015 新增 `storage_cleanup_jobs`。单文档永久删除、文档回收站清空及知识库永久删除会在同一事务持久化对象清理任务，cleanup worker 删除成功后移除任务，存储故障时指数退避并持续重试；每次领取使用新的 `lease_token`，旧 worker 的迟到完成或重试不会覆盖当前租约。
- `STORAGE_PROVIDER=local` 时若仍提供完整 MinIO 配置，会继续读取和清理历史 `minio://` 对象；回切本地存储前不得移除旧 MinIO 配置。

## Storage and Chat Reliability Update (2026-08-19)

- 新增 `STORAGE_OPERATION_TIMEOUT`（默认 `2m`），统一限制 MinIO HTTP 响应头、单次存储操作、上传失败补偿删除和 cleanup worker 删除；MinIO 模式下必须为正数。
- 上传先持久化延迟 cleanup reservation，再写对象；`documents`/`document_jobs` 提交事务内释放 reservation，覆盖对象上传后进程崩溃而数据库尚未提交的孤儿对象窗口。
- Chat 会话栏接入「加载更多会话」服务端分页；直接访问归档会话深链会同步到已归档范围。流式 citations 在正文 delta 前到达时也立即展示。
- 用户主动停止 SSE 后保留已接收内容，并使用原 `clientRequestId` 对账；服务端在生成完成后、持久化前再次检查 context cancellation，避免停止边界上的意外提交。

## Product Roadmap P1 Update (2026-08-19)

- 新增 `docs/15-product-improvement-roadmap.md`，明确文档可观测性、RAG 质量运营、部署健康、首次使用、权限协作和移动端的分阶段目标与验收标准。
- migration 016 为 `document_jobs` 增加持久化 `progress`（0-100）。解析为 10、切分为 30、Embedding 按真实批次从 50 推进到 95、chunks 原子发布后为 100；重试从 0 重新处理，服务重启不会把已提交进度退回阶段默认值。
- 取消任务继续保持 `documents.status=failed`、`jobStatus=cancelled` 的兼容契约，但列表和详情现在显示“已取消”与中性状态，不再把取消误报为失败。

## RAG Knowledge Gap List (2026-08-30)

本轮在 `dev` 分支完成 `docs/15-product-improvement-roadmap.md` 中「P1 RAG 质量运营闭环」
的最后一项交付：知识缺口列表。至此该阶段三项（质量概览、负反馈列表、知识缺口列表）
全部完成，下一项是「P1 部署健康与诊断」。

### 新增数据库字段

- `backend/migrations/018_chat_message_intent_and_retrieval_query.sql` 为
  `chat_messages` 新增 `intent`、`retrieval_query`、`retrieval_query_norm`，
  以 CHECK 约束限制 `intent` 为 `conversation|knowledge_base|null`，并新增部分索引
  `idx_chat_messages_retrieval_query_norm (session_id, retrieval_query_norm)
  WHERE role = 'assistant' AND retrieval_query_norm IS NOT NULL`。
- **刻意不回填历史数据。** 迁移前的回答无法判断当时的意图分类结果，写入任何值都是编造。
  历史行 `intent` 保持 `NULL`，被所有按意图口径统计的指标排除，并通过概览新字段
  `unclassifiedAnswerCount` 显式披露，前端在该值非零时提示这些回答未纳入占比。

意图和 `standaloneQuery` 本来每轮都会算出来但从不落库，这正是路线图里那条指标
（「citations 为空的知识型回答占比」）此前无法表达的原因。

### 单一写入点

三个新列只在 `chat_service.go` 的 `applyGeneratedProvenance` 里写入，阻塞发送、流式
发送、编辑重发和 `RegenerateMessage` 都调用它。分散写入迟早会漂移出「有 intent 但没有
检索式」这类不自洽的行，而这类行会静默地改变统计口径而不是报错。

`normalizeRetrievalQuery` 会小写化、去掉标点符号并**删除所有空白**。中文分词的空格不
稳定，保留空白会把「退货 政策」和「退货政策」拆成两个聚类。归一化后为空时存 `NULL`。

### 为什么排除 regenerate

`repeated_rewrite` 只统计 `client_request_id IS NOT NULL` 的回答。只有发送路径写
`client_request_id`，`RegenerateMessage` 保持为 `nil`，所以这个条件恰好把重新生成排除
在聚类之外——用户在同一个问题上要求重试，和用户换个说法再问，是两种不同的问题。把前者
算成改写，会把「我想要更好的回答」误报成「知识库答不上来」。

### 指标口径修正（兼容性变更）

`withoutCitationsCount` 之前统计所有 citations 为空的 assistant 回答。会话类回答按设计
就没有引用（`docs/04-api-design.md` 多轮上下文规则第 5 条），因此旧值被会话类回答虚高。
该字段现在要求 `intent = 'knowledge_base'`。

对既有数据的影响：迁移后新回答才有 `intent`，历史回答一律 `NULL`，所以刚上线时
`withoutCitationsCount` 会明显下降甚至为 0，`unclassifiedAnswerCount` 接近全量回答数。
这不是数据丢失，是口径从「不可比」变成「只统计可判定的部分」。运营应以上线后的数据
为基线。

同时新增 `knowledgeAnswerCount`、`unclassifiedAnswerCount` 和
`withoutCitationsRate`（分母是 `knowledgeAnswerCount`，不是 `answerCount`）。

「citations 为空」的判定 SQL 统一为 `chatEmptyCitationsSQL` 一处常量，概览、负反馈列表
和缺口查询共用，避免三处各自枚举 `''`/`null`/`[]` 而漂移。

### 两个类别，不是三个

路线图写的是「聚合无引用、依据不足和连续改写问题」，实际交付两个类别。对知识型提问，
「检索不到内容」和「依据不足所以拒答」可证明是同一个条件：citations 由 `searchRes.Items`
推导，固定拒答话术恰好在该切片为空时使用。真正独立的第三种情况是「有引用但模型仍拒答」，
需要判定回答文本，属于 P2 的回答质量评估，本轮不做。

聚类用归一化后的检索式**精确匹配**，没有用 trigram 相似度：`pg_trgm` 在本仓库未启用且
只有 PostgreSQL 有，用了会让聚类逻辑在 SQLite 测试套件里完全无法覆盖。代价是同义改写
（「怎么退货」/「退货流程」）不会归到一组，这是已知限制。

### 分页全序

`no_citations` 按 `created_at DESC, id DESC`，`repeated_rewrite` 按
`last_seen_at DESC, session_id DESC, retrieval_query_norm ASC`。一次请求写入的
user/assistant 消息可能共享时间戳，只按时间排序不是全序，相邻两页会重复或漏行。
不传 `category` 时响应是两个列表的拼接，分页在拼接序列上进行，只取每个类别实际贡献的
那一段，不会把整个结果集读进内存。

`CountRepeatedRewriteGaps` 把分组查询套成子查询再 `COUNT`，直接 `COUNT(*)` 会数组内行数
而不是组数。

### 测试库需要显式建部分索引

`newChatServiceTestDB` 现在除 migration 010 的幂等唯一索引外，还显式创建 018 的
`idx_chat_messages_retrieval_query_norm`——`AutoMigrate` 不还原 `WHERE` 子句，而这个
`WHERE` 正是把聚类查询挡在会话类和未分类行之外的东西。

### 驱动可移植性

`MIN()`/`MAX()` 在 PostgreSQL 保留列类型并返回 `time.Time`，在 SQLite 丢掉类型亲和性
返回文本，直接扫进 `time.Time` 会在生产可用而在测试套件里报错。聚类时间戳改为扫成文本
再由 `parseAggregatedTime` 解析，与工作区列表处理 `MAX(viewed_at)` 的既有做法一致。

### 未验证项

migration 018 未在本环境对真实 PostgreSQL 执行过，其 CHECK 约束和部分索引只经过 SQLite
测试套件的等价重建，未经真实库验证。`cmd/doctor`、`cmd/migrate`、`cmd/seed` 都需要根
`.env` 里的远端 PostgreSQL/Redis，本轮未连接。

## Deployment Health and Diagnostics (2026-08-30)

本轮在 `dev` 分支完成 `docs/15-product-improvement-roadmap.md` 中「P1 部署健康与诊断」
的四项交付。下一项是「P2 首次使用与知识库质量」。

新增：`GET /api/v1/system/diagnostics`（需认证）、依赖感知的 `GET /healthz`、前端
`/diagnostics` 页面。完整字段口径见 `docs/04-api-design.md` 的「系统诊断」。

### 指标存在进程内存里，不落库

`backend/internal/observability/recorder.go` 是一个固定容量的进程内记录器：每个指标一个
512 样本的环形缓冲，分位数用 nearest-rank。

后果必须被知道，而不是被发现：**服务重启后归零，多实例部署下每个实例只报自己的数据。**
前端在页面上明确写出这一点。

取舍原因：把每次检索和生成都写库会给热路径加一次写入，并需要一张随流量无限增长的表。
持久化交给 zap 日志。DTO 里的 `metricsSinceRestart` 恒为 `true`，留作未来接入持久化存储
时不破坏契约的开关。

### Provider 为什么不探测

DB、Redis、存储有真实探针；对话、向量化、重排没有。OpenAI 兼容接口里没有免费的 ping，
为检查而发一次 completion 等于每次打开诊断页都让运维付一次钱，而且测出的延迟不是真实
请求的延迟。Provider 面板因此报告两件事：配置完整性（同时有 key 和模型名），以及真实
业务流量观察到的健康度。

`recentFailures > 0` 只标 `degraded` 不标 `down`：记录器只能看见流量，既有近期失败又有
近期成功的是不稳定，完全没有流量的是未知，两者都不足以断言已经挂了。

### EnsureReady 与 CheckHealth 是两个东西

`storage.CheckHealth` 是新增的只读探针，刻意不复用 `EnsureReady`。MinIO 的
`EnsureReady` 会创建 bucket 并写策略，这在启动时是对的，放在 HTTP 处理器后面是错的——
它会让一次带认证的 GET 重建运维故意删掉的 bucket。`health_test.go` 里有一个
`TestCheckHealthDoesNotCallEnsureReady` 用带标记的假后端守住这一点。

### /healthz 保持 200

即使依赖挂掉也返回 200，真实状态放在响应体。这是存活探针不是就绪探针：503 会让
Kubernetes livenessProbe 重启容器，而重启 API 不会让 Redis 恢复，只会在故障上再叠一层
故障。若之后要加就绪探针，应新开一个端点，不要改这个的语义。

因为它无需认证，响应体只有依赖名和状态，没有 reason、没有耗时、没有计数。

### 泄漏防线在哪

约束「健康检查不得返回密钥、连接串或 Provider 原始敏感错误」由三处共同保证：

1. `observability.Classify` 只按 sentinel 身份和类型匹配，从不看错误文本，返回封闭集合
   里的 `Reason`。`classify_test.go` 里 `TestClassifyNeverReturnsErrorContent` 用嵌了
   DSN、API key 和主机名的错误验证。
2. DTO 里没有任何字段可以放 URL、endpoint、DSN、key 或原始错误。
3. `TestDiagnosticsResponseNeverSerializesSecrets` 序列化整个响应，断言配置里的假密钥、
   假 DSN 和假 Provider 错误文本都不出现。路由层还有一个同类断言。

原始错误以 `WARN` 完整写进服务端日志，这是刻意的：约束限制的是 HTTP 响应，不是运维自己
的日志。

### 认证但未按角色限制

接口只要求登录。JWT 只带 `UserID`，没有角色声明，没有角色中间件，唯一种子用户是
`role: "user"`——加管理员校验会把现有部署全部锁在自己的诊断之外。已作为 P2 待办写进路线
图，含补齐顺序。**在角色迁移路径落地之前不要直接把路由移到管理员组。**

### 路由注入方式

`router.Dependencies{Redis, Metrics}` 是新增的可选依赖结构体，`New` / `NewWithStorage`
委托到 `NewWithDependencies` / `NewWithStorageAndDependencies`，九个现有调用点未改。
Redis 客户端由 `cmd/server/main.go` 注入而不是在路由里重开，这样探针检查的是应用真正在
用的连接池。

有一个坑值得记下：`newRedisProbe(nil)` 返回类型化的 nil 指针，赋给接口字段后接口本身不
是 nil，服务端的「未配置」判断会放过它然后在探针里 panic。现在改成条件赋值，注释写在
`router.go` 里。

### 顺带修掉的：路由 chunk 校验漏了 QualityPage

`frontend/scripts/verify-route-chunks.mjs` 的 `expectedRouteChunks` 里没有
`QualityPage`，尽管它在 `src/router/index.tsx` 里是懒加载的，校验因此静默地停止覆盖它。
本轮补上 `QualityPage` 和 `DiagnosticsPage`，现在覆盖 11 个路由级 chunk。**新增懒加载
页面时必须同步这个列表**，否则校验会继续静默通过。

### 已知的测试保真度问题（本轮刻意不改）

`backend/internal/service/knowledge_base_service.go:700` 和 `:728` 把本地时区的
`time.Now()` 绑进时间比较。PostgreSQL 的 timestamptz 按时刻比较，所以生产无影响；但
SQLite 把时间存成 RFC3339 文本，驱动绑定的是带本地偏移量的值，与 `Z` 值做字典序比较会
静默地匹配不到任何行——本轮 `queue_stats.go` 就踩过这个坑（现在用 `.UTC()`）。这意味着
那两处的 SQLite 测试可能在验证一个恒为空的结果集。改动它需要连带复核相关测试断言，超出
本阶段范围。

### 本环境未能验证的部分

- 全部三个探针（PostgreSQL、Redis、MinIO）只在假实现和内存 SQLite 下验证过，**没有对真
  实依赖跑过**。真实环境下首次访问诊断页时应确认：数据库 `ok`、Redis `ok`、存储 `ok`，
  以及断开某一项后对应行变成 `down` 且 reason 合理。
- migration 018（上一阶段）仍未对真实 PostgreSQL 执行过。
- `dev` 分支尚未推送到 origin，也未获授权推送。
