# 数据库设计

数据库使用 PostgreSQL，向量能力使用 pgvector。

## 时间约定

- 所有业务时间字段使用 `TIMESTAMPTZ` 表示绝对时刻，包括创建、更新、软删除、任务锁定和调度时间。PostgreSQL 保存时刻，不保留输入时区名称。
- 数据库连接入口 `database.Open` 将每条应用连接的会话时区固定为 UTC，使 `now()` 默认值和 SQL 时间转换采用同一约定；GORM 自动生成的时间使用 UTC 和微秒精度。
- Go 模型继续使用 `time.Time`、`*time.Time` 和 `gorm.DeletedAt`，由 GORM 的 PostgreSQL 方言映射为 `timestamptz`；原生 pgx 驱动处理带不同时区的参数，无需自定义时间编码。
- API 时间携带 `Z` 或明确的时区偏移，前端按浏览器时区显示；数据库中的 UTC 数值不等于用户本地钟面时间。
- 旧库先执行 `023_timestamps_with_time_zone.sql`：使用 `USING 列名 AT TIME ZONE 'UTC'` 将无时区字段转为 `TIMESTAMPTZ`，保持旧值当前按 UTC 读取时的含义，不额外校正历史偏差。已有 `TIMESTAMPTZ` 字段跳过，重复执行不会再次换算时间。
- 启动检查会拒绝仍有无时区业务时间字段的 PostgreSQL schema，并提示执行 023；启动期 `AutoMigrate` 不负责修改已有列类型。全新数据库按顺序执行全部迁移，001–022 保留历史定义，以下示例展示 023 后的结构。升级与备份步骤见 [部署指南](13-deployment.md#73-已有数据库)。

## 扩展

迁移 025 为 `users` 增加 `status`、`last_login_at`、`created_by`；迁移 026 新增 `model_usage_records` 保存模型调用用途、模型名、token 和延迟；迁移 027 为 `knowledge_bases` 增加 `answer_config`。

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

## users

```sql
CREATE TABLE users (
    id UUID PRIMARY KEY,
    username VARCHAR(64) UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    display_name VARCHAR(128),
    avatar_url TEXT,
    role VARCHAR(32) DEFAULT 'user',
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);
```

资料字段的接口上限按 Unicode 码点（Go rune）计数，不能按 UTF-16 code unit
或 UTF-8 字节误算。密码明文不落库；登录和改密在进入 bcrypt 前按 UTF-8
编码检查 72 字节上限。

`users.role` 是系统角色：`user` 为普通用户，`admin` 为系统管理员；与知识库成员的 `viewer` / `editor` / `manager` 以及 `owner_id` 无关。系统管理员可以读取系统诊断，但不会因此取得其他用户知识库或会话的访问权。未知系统角色不能访问诊断。

首位系统管理员通过 `cmd/bootstrap-admin` 显式指定账号初始化，事务级 PostgreSQL advisory lock 串行化首次创建或提升。同名管理员重复执行不修改数据，已有其他管理员时拒绝继续初始化。复用已有 `users.role` 字段，无需新 schema 迁移；具体命令见 [部署指南](13-deployment.md#74-初始化系统管理员)。

## user_avatars

迁移 `022_user_avatars.sql` 为每位用户保留一张经过解码、居中裁剪和重新编码的 PNG 缩略图。
原始上传不落库；256×256 缩略图与用户头像地址在同一事务中替换或移除。

```sql
CREATE TABLE user_avatars (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    version UUID NOT NULL,
    data BYTEA NOT NULL CHECK (octet_length(data) <= 524288),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

`users.avatar_url` 保存带版本的站内读取地址；旧版本读取返回 404。省略头像的资料保存仅修改显示名称，
显式外部地址/清空会删除托管缩略图；旧托管地址提交返回冲突，不能移除较新的图片。

## knowledge_bases

```sql
CREATE TABLE knowledge_bases (
    id UUID PRIMARY KEY,
    name VARCHAR(128) NOT NULL,
    description TEXT,
    owner_id UUID NOT NULL REFERENCES users(id),
    updated_by_id UUID REFERENCES users(id) ON DELETE SET NULL,
    category_id UUID REFERENCES knowledge_base_categories(id) ON DELETE SET NULL,
    visibility VARCHAR(32) NOT NULL DEFAULT 'private',
    retrieval_config JSONB DEFAULT '{
      "vectorTopN": 30,
      "rerankTopK": 5,
      "scoreThreshold": 0.3,
      "enableRerank": true
    }',
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    deleted_at TIMESTAMPTZ NULL
);
```

`visibility` 当前只用于前端展示公开/私有类型，不改变主数据访问控制；文档、检索、聊天等知识库数据仍按 `knowledge_bases.owner_id` 校验。成员表只用于权限工作台的成员管理能力。

## knowledge_base_categories

```sql
CREATE TABLE knowledge_base_categories (
    id UUID PRIMARY KEY,
    owner_id UUID NOT NULL REFERENCES users(id),
    parent_id UUID REFERENCES knowledge_base_categories(id) ON DELETE RESTRICT,
    name VARCHAR(128) NOT NULL,
    sort_order INT DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);
```

分类为用户私有树结构。删除分类前必须确认没有子分类，也没有知识库引用该分类。

## knowledge_base_favorites

```sql
CREATE TABLE knowledge_base_favorites (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    knowledge_base_id UUID NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (user_id, knowledge_base_id)
);
```

收藏只允许作用于当前用户拥有的知识库。

## knowledge_base_view_events

```sql
CREATE TABLE knowledge_base_view_events (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    knowledge_base_id UUID NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
    viewed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

浏览量和最近浏览由显式接口写入，不在 GET 接口中隐式记录。

## knowledge_base_members

```sql
CREATE TABLE knowledge_base_members (
    knowledge_base_id UUID NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role VARCHAR(32) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (knowledge_base_id, user_id),
    CONSTRAINT knowledge_base_members_role_check CHECK (role IN ('manager', 'member'))
);
```

`owner` 不写入成员表，始终来自 `knowledge_bases.owner_id`。当前成员角色只支持 `manager` 和 `member`；owner 和 manager 可管理成员，owner 不能被删除或降级。

## knowledge_base_workspace_preferences

```sql
CREATE TABLE knowledge_base_workspace_preferences (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    view_mode VARCHAR(32) NOT NULL DEFAULT 'table',
    scope VARCHAR(32) NOT NULL DEFAULT 'all',
    sort VARCHAR(32) NOT NULL DEFAULT 'updatedAt_desc',
    visibility VARCHAR(32) NOT NULL DEFAULT 'all',
    expanded_category_ids JSONB NOT NULL DEFAULT '[]',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

用于保存当前用户知识库工作台的视图偏好，不影响权限判断，也不改变实际数据过滤规则。

## documents

```sql
CREATE TABLE documents (
    id UUID PRIMARY KEY,
    knowledge_base_id UUID NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
    uploader_id UUID NOT NULL REFERENCES users(id),
    filename VARCHAR(255) NOT NULL,
    file_type VARCHAR(32),
    file_size BIGINT,
    storage_path TEXT NOT NULL,
    status VARCHAR(32) DEFAULT 'uploaded',
    error_message TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    deleted_at TIMESTAMPTZ NULL
);
```

允许状态：

```text
uploaded
parsing
chunking
embedding
completed
failed
```

## document_chunks

```sql
CREATE TABLE document_chunks (
    id UUID PRIMARY KEY,
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    knowledge_base_id UUID NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
    chunk_index INT NOT NULL,
    content TEXT NOT NULL,
    token_count INT,
    page_number INT,
    metadata JSONB,
    embedding vector(1536),
    search_vector tsvector,
    created_at TIMESTAMPTZ DEFAULT now()
);
```

`embedding vector(1536)` 是当前 MVP 默认值，必须与 `EMBEDDING_DIMENSION=1536` 保持一致。当前 Qwen3 Embedding 模型需要在 Provider 调用时显式请求输出 1536 维。更换 embedding 模型维度时，必须新增数据库 migration 修改向量维度并重建索引。

`search_vector` 是关键词召回使用的词元索引（迁移 024 引入）。它由后端 `internal/document/lexer` 生成 tsvector 字面量并以 `::tsvector` 写入，不是 `to_tsvector()` 对 `content` 的解析结果，因此不依赖任何 PostgreSQL 中文分词扩展；索引与查询必须使用同一分词器。该列在 chunk 发布事务中与 `embedding` 一起写入；迁移 024 之前发布的 chunk 该列为 `NULL`，需运行 `go run ./cmd/reindex-keywords` 回填，回填前这些 chunk 只参与向量召回。分词规则变更后同样需要重跑回填。

`document_chunks(document_id, knowledge_base_id)` 通过复合外键引用 `documents(id, knowledge_base_id)`；chunk 的冗余知识库字段必须与所属文档一致。检索同时校验两侧 `knowledge_base_id`，不得只信任 chunk 冗余字段。

`page_number` 对 PDF chunk 保存原文件的 1-based 物理页码；空白页被跳过时后续页码仍保持原值。TXT、Markdown 等没有物理页概念的格式保存 `NULL`。当前 PDF chunk 不跨页，因此单值 `page_number` 能明确定位来源页。

`metadata` 中的 `startOffset`、`endOffset` 表示 chunk 主来源内容在规范化 segment 内的 UTF-8 byte offset；PDF 使用页内 offset。额外 overlap、Markdown 标题前缀、代码 fence 或重复的表格 header 不计入该范围。该范围不是原文件二进制的精确字节坐标。`metadata.fileType` 记录切片策略使用的规范化文件类型。

## document_jobs

```sql
CREATE TABLE document_jobs (
    id UUID PRIMARY KEY,
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    job_type VARCHAR(64) NOT NULL,
    status VARCHAR(32) DEFAULT 'pending',
    retry_count INT DEFAULT 0,
    error_message TEXT,
    locked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);
```

允许任务状态：

```text
pending
running
completed
failed
cancelled
```

`cancelled` 由文档取消接口写入。既有数据库通过
`backend/migrations/013_document_job_cancelled_status.sql` 更新
`document_jobs_status_check`；仅依赖 SQLite `AutoMigrate` 的测试不会重建这条
PostgreSQL CHECK 约束，因此不能代替该 migration。

## storage_cleanup_jobs

```sql
CREATE TABLE storage_cleanup_jobs (
    id UUID PRIMARY KEY,
    storage_path TEXT NOT NULL UNIQUE,
    retry_count INT NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ NULL,
    locked_at TIMESTAMPTZ NULL,
    lease_token UUID NULL,
    last_error TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

永久删除文档或知识库时，清理任务与业务数据删除在同一数据库事务内写入。对象删除成功后才移除任务；MinIO 或本地存储临时失败时保留 `storage_path` 并持续重试，避免业务行已删除后形成无法定位的孤儿对象。每次领取生成新的 `lease_token`，完成和重试必须匹配当前 token，过期 worker 的迟到结果不能覆盖新领取者。

真实 PostgreSQL 行锁集成测试只读取显式的 `RAG_TEST_POSTGRES_DSN`；未设置时
测试跳过。设置后测试会创建独立的 `rag_it_<uuid>` schema，并在结束时删除，
因此该 DSN 应指向允许创建和删除 schema 的专用测试数据库。

## chat_sessions

```sql
CREATE TABLE chat_sessions (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id),
    knowledge_base_id UUID NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
    title VARCHAR(255),
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    archived_at TIMESTAMPTZ NULL,
    deleted_at TIMESTAMPTZ NULL
);
```

当前 `POST /chat/sessions/:id/archive` 设置 `archived_at`，默认会话列表过滤已归档会话；`GET /chat/sessions/:id` 仍可查看归档会话。`DELETE /chat/sessions/:id` 设置 `deleted_at` 进行软删除并保留全部消息；默认列表、详情和消息查询过滤已删除会话。聊天回收站支持列表、恢复、单项永久删除和清空，只有永久删除才会物理删除会话并级联删除消息。

## chat_messages

```sql
CREATE TABLE chat_messages (
    id UUID PRIMARY KEY,
    session_id UUID NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
    role VARCHAR(32) NOT NULL,
    content TEXT NOT NULL,
    citations JSONB,
    client_request_id UUID,
    rerank_fallback JSONB,
    feedback_rating VARCHAR(16),
    feedback_updated_at TIMESTAMPTZ NULL,
    feedback_reason VARCHAR(32) NOT NULL DEFAULT '',
    feedback_comment TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ DEFAULT now()
);
```

`client_request_id` 和 `rerank_fallback` 对历史消息及 regenerate 消息保持 nullable。发送消息时，user/assistant 消息对共享同一个 `client_request_id`；assistant 消息保存本次 `rerank_fallback`，以便重复请求重建原响应。

既有数据库通过 `backend/migrations/014_chat_message_feedback.sql` 增加
`feedback_rating` 和 `feedback_updated_at`。`feedback_rating` 允许 `NULL`、
`positive`、`negative`，并由 `chat_messages_feedback_rating_check` 约束；service
另行限制只有当前用户可见会话中的 assistant 消息可以提交反馈。

迁移 `021_quality_evaluations.sql` 增加 `feedback_reason`、`feedback_comment`。原因和说明为空字符串表示
未提供详情，好评清空二者；service 校验原因枚举与说明最长 1000 字，质量反馈列表返回这些字段。

允许 role：

```text
user
assistant
system
```

## evaluation_cases 与 evaluation_runs

迁移 `021_quality_evaluations.sql` 增加固定测试问题与持久化运行记录：

```sql
CREATE TABLE evaluation_cases (
    id UUID PRIMARY KEY,
    knowledge_base_id UUID NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
    created_by UUID NOT NULL REFERENCES users(id),
    question TEXT NOT NULL,
    expected_answer TEXT NOT NULL DEFAULT '',
    required_keywords JSONB NOT NULL DEFAULT '[]',
    require_citation BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE evaluation_runs (
    id UUID PRIMARY KEY,
    knowledge_base_id UUID NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
    created_by UUID NOT NULL REFERENCES users(id),
    client_request_id UUID NOT NULL,
    request_hash VARCHAR(64) NOT NULL,
    name VARCHAR(80) NOT NULL,
    status VARCHAR(20) NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
    config JSONB NOT NULL,
    cases JSONB NOT NULL,
    results JSONB NOT NULL DEFAULT '[]',
    runtime JSONB NOT NULL DEFAULT '{}',
    error_message TEXT NOT NULL DEFAULT '',
    lease_token UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX idx_evaluation_run_request
    ON evaluation_runs(knowledge_base_id, created_by, client_request_id);
CREATE INDEX idx_evaluation_cases_knowledge_base_id ON evaluation_cases(knowledge_base_id);
CREATE INDEX idx_evaluation_runs_knowledge_base_id ON evaluation_runs(knowledge_base_id);
CREATE INDEX idx_evaluation_runs_status ON evaluation_runs(status);
```

`cases` 保存完整问题快照而非外键引用，删除或编辑测试问题不改变历史评测。
`request_hash` 保存规范化请求的 SHA-256，用于区别同键重试与复用编号提交不同内容。
每库最多 200 个测试问题，同时最多 3 个 queued/running 运行；repository 先锁知识库行再检查计数并写入，
避免并发提交越过上限。`results` 顺序保存每题回答、引用、规则判定、错误与耗时。

worker 通过 `FOR UPDATE SKIP LOCKED` 领取运行并发放 `lease_token`。每 5 秒刷新 `updated_at`；
结果写入必须同时匹配运行 id、lease token 和 running 状态，取消清除租约，禁止迟到写入。
超过 2 分钟没有续租的运行标记 failed，不自动重放。知识库软删除后不可读取/领取并停止续租；
永久删除依赖外键级联删除两张表中的数据。评测不写 `chat_sessions` 或 `chat_messages`。

## 索引

```sql
CREATE INDEX idx_knowledge_bases_owner_id ON knowledge_bases (owner_id);
CREATE UNIQUE INDEX idx_chat_messages_session_client_role
    ON chat_messages (session_id, client_request_id, role)
    WHERE client_request_id IS NOT NULL AND role IN ('user', 'assistant');
CREATE INDEX idx_knowledge_bases_updated_by_id ON knowledge_bases (updated_by_id);
CREATE INDEX idx_knowledge_bases_category_id ON knowledge_bases (category_id);
CREATE INDEX idx_knowledge_bases_visibility ON knowledge_bases (visibility);
CREATE INDEX idx_kb_categories_owner_id ON knowledge_base_categories (owner_id);
CREATE INDEX idx_kb_categories_parent_id ON knowledge_base_categories (parent_id);
CREATE INDEX idx_kb_favorites_user_id ON knowledge_base_favorites (user_id);
CREATE INDEX idx_kb_favorites_kb_id ON knowledge_base_favorites (knowledge_base_id);
CREATE INDEX idx_kb_view_events_user_id ON knowledge_base_view_events (user_id);
CREATE INDEX idx_kb_view_events_kb_id ON knowledge_base_view_events (knowledge_base_id);
CREATE INDEX idx_kb_view_events_viewed_at ON knowledge_base_view_events (viewed_at);
CREATE INDEX idx_kb_members_user_id ON knowledge_base_members (user_id);
CREATE INDEX idx_kb_members_role ON knowledge_base_members (role);
CREATE INDEX idx_documents_kb_id ON documents (knowledge_base_id);
CREATE INDEX idx_documents_uploader_id ON documents (uploader_id);
CREATE INDEX idx_chunks_document_id ON document_chunks (document_id);
CREATE INDEX idx_chunks_kb_id ON document_chunks (knowledge_base_id);
CREATE INDEX idx_jobs_status ON document_jobs (status);
CREATE INDEX idx_chat_sessions_user_id ON chat_sessions (user_id);
CREATE INDEX idx_chat_sessions_kb_id ON chat_sessions (knowledge_base_id);
CREATE INDEX idx_chat_sessions_archived_at ON chat_sessions (archived_at);
CREATE INDEX idx_chat_sessions_deleted_at ON chat_sessions (deleted_at);

CREATE INDEX idx_chunks_embedding_hnsw
ON document_chunks
USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

CREATE INDEX idx_chunks_search_vector
ON document_chunks
USING gin (search_vector);
```

向量索引自迁移 024 起为 HNSW，替换了早期的 `idx_chunks_embedding`（ivfflat）；HNSW 不需要在数据到位后重建，增量写入后的召回率更稳定。查询时后端在事务内 `SET LOCAL hnsw.ef_search = max(40, vectorTopN)`，保证 HNSW 至少返回请求数量的候选。全新数据库依次执行 001–024 时，早期迁移创建的 ivfflat 索引会在 024 中被删除，空表上的代价可以忽略。

## P1 Tag Extension

```sql
CREATE TABLE knowledge_base_tags (
    id UUID PRIMARY KEY,
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(64) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE UNIQUE INDEX uk_kb_tags_owner_name
ON knowledge_base_tags (owner_id, name);

CREATE TABLE knowledge_base_tag_bindings (
    knowledge_base_id UUID NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
    tag_id UUID NOT NULL REFERENCES knowledge_base_tags(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (knowledge_base_id, tag_id)
);

CREATE INDEX idx_kb_tags_owner_id ON knowledge_base_tags (owner_id);
CREATE INDEX idx_kb_tag_bindings_kb_id ON knowledge_base_tag_bindings (knowledge_base_id);
CREATE INDEX idx_kb_tag_bindings_tag_id ON knowledge_base_tag_bindings (tag_id);
```

## AI 开发约束

1. 所有查询 documents、chunks、chat sessions 时必须校验知识库 owner。
2. 删除 document 时必须级联删除 chunks。
3. citations 保存在 assistant 消息的 `citations` 字段。
4. 不要创建多租户相关表。
5. 不要把文件二进制内容写入数据库。
## 迁移 025–027

迁移 025 为 `users` 增加 `status`、`last_login_at`、`created_by`；迁移 026 新增 `model_usage_records` 保存模型调用用途、模型名、token 和延迟；迁移 027 为 `knowledge_bases` 增加 `answer_config`。
