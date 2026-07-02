# 跨会话交接

## 当前状态

已完成：

1. `docs/` AI 开发规范文档包。
2. 根目录 `AGENTS.md`。
3. 后端 Gin 基础工程。
4. 前端 Vite React 基础工程；后续暂缓，先开发后端。
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
   - txt、md、pdf 文档解析入口。
   - 文本切片。
   - OpenAI-compatible Embedding Provider。
   - 文档处理状态流转和 chunks 入库。
   - 向量检索 API。
   - Rerank Provider 接口和 disabled 实现；当前 `RERANK_ENABLED=false` 时跳过 rerank。
   - 聊天会话和消息 API。
   - OpenAI-compatible Chat Provider。
   - OpenAI-compatible Title Provider；会话默认标题会在首次问答后用独立 `TITLE_*` API 摘要更新，不复用 Chat Provider。
   - 多轮 RAG Prompt 组装：最近历史用于 Chat Provider 意图分类、检索问题改写和最终回答上下文。
   - AI 意图分类分支：Chat Provider 输出 `conversation` 或 `knowledge_base`；程序按 intent 路由。`conversation` 跳过知识库检索，直接基于历史回答，`citations=[]`。
   - answer + citations 返回和消息保存。
   - 知识库工作台接口：分类树、增强列表、统计、收藏、最近浏览。
   - 全局文档列表和全局导入文档接口。
   - 全局关键词搜索接口，覆盖当前用户拥有的知识库、文档和 chunk 内容。
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
Rerank: 已配置独立 RERANK_BASE_URL / RERANK_API_KEY / RERANK_MODEL，但 RERANK_ENABLED=false
```

## 当前后端接口

```text
GET  /healthz
GET  /api/v1/healthz
POST /api/v1/auth/login
GET  /api/v1/auth/me
POST /api/v1/auth/logout
GET  /api/v1/users/search
GET  /api/v1/knowledge-base-categories
POST /api/v1/knowledge-base-categories
PUT  /api/v1/knowledge-base-categories/:id
DELETE /api/v1/knowledge-base-categories/:id
POST /api/v1/knowledge-bases
GET  /api/v1/knowledge-bases
GET  /api/v1/knowledge-bases/workspace-preference
PUT  /api/v1/knowledge-bases/workspace-preference
POST /api/v1/knowledge-bases/batch-favorite
POST /api/v1/knowledge-bases/batch-move-category
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
POST /api/v1/documents/:id/restore
POST /api/v1/documents/:id/reprocess
GET  /api/v1/documents/:id/chunks
POST /api/v1/knowledge-bases/:id/search
GET  /api/v1/search
POST /api/v1/chat/sessions
GET  /api/v1/chat/sessions
GET  /api/v1/chat/sessions/:id
PUT  /api/v1/chat/sessions/:id
DELETE /api/v1/chat/sessions/:id
POST /api/v1/chat/sessions/:id/archive
GET  /api/v1/chat/sessions/:id/messages
POST /api/v1/chat/sessions/:id/messages
```

除登录和健康检查外，接口需要：

```text
Authorization: Bearer <token>
```

## 下一步建议

后端 MVP 主链路已跑通，下一步建议：

1. 前端联调登录、知识库、文档、聊天页面。
2. 实现 Rerank Provider；当前 `.env` 中 `RERANK_ENABLED=false`。
3. 前端接入真实成员管理、会话详情/改名/删除、下载和 chunks 分页。
4. 优化文档处理 worker 的重试和并发控制。
5. 补 README 启动说明。

前端页面后续再联调，不作为当前优先级。

## 注意事项

1. Schema 以 `backend/migrations/001_init_schema.sql` 为准。
2. GORM 当前只做 ORM 访问，不让 AutoMigrate 修改已存在表结构。
3. 如果新增表，优先更新 SQL migration，再补 GORM model。
4. 不要把 `.env` 内容复制进文档或提交历史。
5. Rerank、citations、权限校验仍是后续 RAG 模块必须遵守的硬约束。
6. 已用真实 HTTP 链路验证：上传 txt 文档后 worker 可处理到 `completed`，并生成 chunks。
7. 已用真实 HTTP 链路验证：search API 可基于 query embedding 返回当前知识库 chunks；当前 Rerank 关闭时 `rerankScore=null`。
8. 已用真实 HTTP 链路验证：聊天问答可返回 answer 和 citations，并保存 user/assistant 两条消息。
9. 删除知识库会级联清理 chat_sessions，已通过临时数据清理验证。
10. 已补单元测试验证：聊天回答会携带最近历史消息，AI 意图分类会输出 intent 和 standaloneQuery；citations 仍只来自本轮 chunks。
11. 已移除程序关键词判断。会话类问题是否跳过知识库检索由 Chat Provider 分类结果决定；分类 JSON 解析失败时默认按 `knowledge_base` 处理。
12. 知识库 `visibility=public|private` 当前只用于前端展示，不改变文档、检索、聊天等主数据访问控制；这些接口仍按 `knowledge_bases.owner_id` 校验。权限管理接口允许 owner 或 manager 管理成员。
13. 浏览量和最近浏览通过 `POST /api/v1/knowledge-bases/:id/view` 显式记录，不在 GET 接口中隐式写入。
14. `GET /api/v1/search` 是关键词搜索；知识库内语义检索仍使用 `POST /api/v1/knowledge-bases/:id/search`。
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
- 当前文档批量接口同样采用 all-or-nothing 语义；批量重处理会清理旧 chunks 并重新写入 `process_document` 任务
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
