# 数据库设计

迁移 040 新增 `document_upload_receipts`：`user_id`、`knowledge_base_id`、`request_id` 联合主键，`fingerprint varchar(64)`、可空 `document_id`、`created_at timestamptz`。凭据与文档/任务/版本链接一起提交，只记录成功请求；文档永久删除将 `document_id` 置空以保留幂等墓碑，用户或知识库永久删除级联清除。按 `document_id` 建索引。未传请求 ID 的旧客户端不创建凭据。

迁移 041 新增 `documents.table_import JSONB NULL`，保存标准化工作表、表头行和原列号选择，原文件及设置在一个文档版本内不可变。旧行 NULL 保留自动解析默认；重处理不清空设置。041 同时扩展 `documents_error_code_check`，允许 `table_import_invalid`。不自动重处理历史文档。

数据库使用 PostgreSQL，向量能力使用 pgvector。

迁移 042 新增 `knowledge_bases.document_version_policy VARCHAR(16) NOT NULL DEFAULT 'all'`，约束为 `all/current`，旧库和新库默认均保持全部版本。当前有效版本根据既有 `superseded_by_id` 链及已发布 `document_chunks` 动态选择，不改写历史切片，也不依据处理中会变化的 `documents.status` 判断快照是否可用。

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
    status VARCHAR(16) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
    last_login_at TIMESTAMPTZ,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_users_status ON users (status);
CREATE INDEX idx_users_created_by ON users (created_by);
```

`status`、`last_login_at`、`created_by` 由迁移 `025_user_status_and_admin.sql` 加入。`status=disabled` 是可逆的状态而不是删除：账号数据、其拥有的知识库和会话全部保留，禁用后登录被拒，已签发的 JWT 在下一次请求经认证中间件查询 `status` 时失效。`last_login_at` 在登录成功时更新；`created_by` 记录通过 `/admin/users` 创建该账号的管理员，操作者被删除时置空。

`username` 的唯一约束按字面值，但应用层在创建时按 `LOWER(username)` 判重，`Admin` 与 `admin` 不能并存；已有的大小写混合用户名保持原样。

资料字段的接口上限按 Unicode 码点（Go rune）计数，不能按 UTF-16 code unit
或 UTF-8 字节误算。密码明文不落库；登录和改密在进入 bcrypt 前按 UTF-8
编码检查 72 字节上限。

`users.role` 是系统角色：`user` 为普通用户，`admin` 为系统管理员；与知识库成员的 `viewer` / `editor` / `manager` 以及 `owner_id` 无关。系统管理员可以读取系统诊断，但不会因此取得其他用户知识库或会话的访问权。未知系统角色不能访问诊断。

首位系统管理员通过 `cmd/bootstrap-admin` 显式指定账号初始化，事务级 PostgreSQL advisory lock 串行化首次创建或提升。同名管理员重复执行不修改数据，已有其他管理员时拒绝继续初始化。提升现有账号只更新角色；创建账号依赖完整的 users 结构（含迁移 025），GORM 的 `CreatedByID` 显式映射 `created_by`；之后的账号创建、禁用、角色变更都在 `/admin/users` 上完成（见 [接口设计](04-api-design.md#admin-users)），系统会拒绝禁用或降级最后一位启用的管理员。具体命令见 [部署指南](13-deployment.md#74-初始化系统管理员)。

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
    source_path TEXT NOT NULL DEFAULT '' CHECK (octet_length(source_path) <= 1024),
    status VARCHAR(32) DEFAULT 'uploaded',
    error_message TEXT,
    pdf_text_summary JSONB,
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

`documents.pdf_text_summary` 由迁移 032 引入，保存 PDF 最近一次提取的 `{totalPages, textPages, pagesWithoutText}`；页码为从 1 开始的物理页码，数组升序且不重复。启用 OCR 后 `textPages` 包含原生与识别文本页，可选 `ocr` 记录识别进度/结果；剩余无文字页不能据此断言损坏。非 PDF、旧文档和未提取时为 SQL NULL，表示未知，不表示已完整提取。结构及 OCR 状态见 API 规范。

重新处理排队及开始解析时清除旧摘要；原生解析后、OCR 识别期间及结束时在切片和向量化前写入，因此全空 PDF 的 `empty_content`、OCR 失败或后续 Embedding 失败仍保留本次已知页信息。写入复用当前运行任务守卫，取消或失效任务不能覆盖结果。迁移不回填、不重建向量；详情响应返回摘要，列表不携带页码数组。

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
    scope_mode VARCHAR(16) NOT NULL DEFAULT 'manual' CHECK (scope_mode IN ('auto', 'manual')),
    title VARCHAR(255),
    branch_from_session_id UUID REFERENCES chat_sessions(id) ON DELETE SET NULL,
    branch_from_message_id UUID REFERENCES chat_messages(id) ON DELETE SET NULL,
    branch_request_id UUID,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    archived_at TIMESTAMPTZ NULL,
    deleted_at TIMESTAMPTZ NULL
);
```

当前 `POST /chat/sessions/:id/archive` 设置 `archived_at`，默认会话列表过滤已归档会话；`GET /chat/sessions/:id` 仍可查看归档会话。`DELETE /chat/sessions/:id` 设置 `deleted_at` 进行软删除并保留全部消息；默认列表、详情和消息查询过滤已删除会话。聊天回收站支持列表、恢复、单项永久删除和清空，只有永久删除才会物理删除会话并级联删除消息。

## chat_session_knowledge_bases（迁移 030）

首选库继续存于 `chat_sessions.knowledge_base_id`，此表仅存附加库；旧会话没有附加行，自然保持单库，无需回填或重建向量。

```sql
CREATE TABLE chat_session_knowledge_bases (
    session_id UUID NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
    knowledge_base_id UUID NOT NULL REFERENCES knowledge_bases(id) ON DELETE RESTRICT,
    PRIMARY KEY (session_id, knowledge_base_id)
);
CREATE INDEX idx_chat_session_knowledge_bases_knowledge_base_id
    ON chat_session_knowledge_bases (knowledge_base_id);
```

手动会话及附加库关系在同一个 GORM 创建事务中保存，API 限制总计 1–5 库、禁止重复、范围不可修改。迁移 031 增加 `scope_mode`，旧行默认 manual，不修改已有范围。自动会话由服务显式写 auto；首选库保留用于外键、用量和生命周期，但每轮检索全部可访问库。每轮进入 Prompt 的来源库在输出前，通过锁定会话的 GORM 事务和冲突忽略插入关联表，保守累计历史访问依赖，不受 5 库上限限制。中断、编辑和重生成不删除依赖。按库过滤及永久删除同时匹配首选库和附加库。外键 RESTRICT 防止删库时静默缩小会话范围；repository 必须先删除所有相关会话。软删库或撤权不改关联，只使整段会话不可访问。启动要求此表存在。模型用量仍唯一归属首选库；跨库和自动会话消息不进入单库质量聚合。

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

迁移 `033_chat_message_history_index.sql` 为历史游标分页增加 `(session_id, created_at, id)` 复合索引 `idx_chat_messages_session_order`。同时间戳消息以 ID 决定稳定顺序，读取页首向前扩展以保留一轮问题及全部回答版本；不新增列、不改历史消息和模型上下文。API 合同见 [消息读取](04-api-design.md#get-chatsessionsidmessages)。

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
    answer_config JSONB NOT NULL DEFAULT '{"answerLanguage":"auto","allowGeneralKnowledge":false,"model":""}',
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
## model_usage_records

```sql
CREATE TABLE model_usage_records (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    knowledge_base_id UUID NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
    session_id UUID REFERENCES chat_sessions(id) ON DELETE SET NULL,
    message_id UUID REFERENCES chat_messages(id) ON DELETE SET NULL,
    purpose VARCHAR(32) NOT NULL,
    provider VARCHAR(64) NOT NULL,
    model VARCHAR(128) NOT NULL,
    prompt_tokens INTEGER,
    completion_tokens INTEGER,
    total_tokens INTEGER,
    latency_ms BIGINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_model_usage_kb_created ON model_usage_records (knowledge_base_id, created_at);
CREATE INDEX idx_model_usage_user_created ON model_usage_records (user_id, created_at);
```

每次模型调用一行：`purpose` 为 `intent` / `answer` / `title` / `evaluation`；`provider` 为 `MODEL_PROVIDER`；`model` 为请求时使用的模型名（全局配置或知识库覆盖），不采用服务商响应中回显的别名，以便与 `MODEL_PRICING` 和 `CHAT_ALLOWED_MODELS` 对应；2026-09-26 之前写入的行可能是回显名。token 列在 Provider 未返回 usage 时为 NULL，不估算。Chat 的 intent / answer / title 调用在助手消息落库后关联 `message_id`（2026-09-28 之前的标题记录可能为空，不回填）；评测调用 `session_id` 与 `message_id` 为 NULL，只归属知识库。`latency_ms` 是该次模型调用自身的耗时。

## 迁移 024–029

迁移 024 为 `document_chunks` 增加 `search_vector` 并把向量索引换为 HNSW；025 为 `users` 增加 `status`、`last_login_at`、`created_by`；026 新增 `model_usage_records`；027 为 `knowledge_bases` 增加 `answer_config`（`systemPromptAddition`、`answerLanguage`、`allowGeneralKnowledge`、`model`、`temperature`）；028 为 `evaluation_runs` 增加 `answer_config` 快照。029 为 documents 增加 embedding_model 与 embedding_dimension；后端启动时检查这些迁移对应的列或表，缺失即报错。

### 文档向量来源（迁移 029）

`029_document_embedding_identity.sql` 给 `documents` 增加可空的 `embedding_model VARCHAR(128)`、`embedding_dimension INTEGER`。存量记录保持 NULL，表示来源未知；禁止用当前配置回填旧向量的来源。processor 发布新 chunks 时在同一个事务里写入实际配置的模型和校验过的维度，失败不会把未发布的来源标成有效。诊断按模型和维度统计有效文档。

启动和 doctor 查询 `pg_attribute.atttypmod`，按当前 search_path 解析 `document_chunks.embedding`；必须与 `EMBEDDING_DIMENSION` 一致，否则拒绝启动。模型切换与重建步骤见 [部署指南](13-deployment.md#embedding-模型切换与重建)。

## 六项功能扩展（迁移 034–039）

| 迁移 | 数据与约束 |
| --- | --- |
| 034 | `chat_bookmarks`：`message_id` 为主键并引用 `chat_messages`，`user_id` 引用 `users`，两者均 ON DELETE CASCADE；`note TEXT NOT NULL DEFAULT ''` 最多 4000 字；`created_at/updated_at` 为 TIMESTAMPTZ。索引 `(user_id, created_at DESC, message_id DESC)` 支持个人分页。 |
| 035 | `documents.superseded_by_id` 的非空部分索引，供替换链的反向查找。版本读取仅遍历同一个未删除知识库中的未删除文档。 |
| 036 | `chat_sessions.branch_from_session_id` / `branch_from_message_id` 为可空外键，来源永久删除时 SET NULL；`branch_request_id` 为可空 UUID，全局非空唯一索引用于幂等。来源会话字段另有索引。旧会话三字段为空。 |
| 037 | `question_templates`：UUID 主键，`user_id` 引用 `users` ON DELETE CASCADE，`title VARCHAR(100)` 1–100 字，`body TEXT` 1–12000 字，TIMESTAMPTZ 创建/更新时间；索引 `(user_id, updated_at DESC, id DESC)`。变量从正文验证并提取，不单独保存 JSON 副本。 |
| 038 | `documents.source_path TEXT NOT NULL DEFAULT ''`，数据库限制 UTF-8 字节数不超过 1024；应用进一步校验相对路径。原数据为空，不据此推断本地文件系统位置或改变对象存储 key。 |
| 039 | 扩充 `documents_error_code_check` 允许 `table_limit_exceeded`；其余 019 错误码保持。启动额外检查约束定义，缺少 039 时阻止运行。 |

收藏绑定确切回答 ID，重生成不转移到新版本。归档保持可读，软删会话或任一知识库依赖撤权后隐藏，恢复可见；永久删消息/会话级联清除收藏。所有读取仍要求会话归属和全部依赖知识库权限。

创建分支通过 GORM 事务锁定来源会话，复制到指定回答为止的消息、引用和完整依赖集合。副本使用新消息 ID 和严格递增的时间，来源链接、依赖和副本原子提交；不复制收藏、评价、请求编号或模型用量。来源软删/永久删不删除独立分支，分支仍按自己的完整依赖鉴权。

表格不新增表或向量列。`document_chunks.metadata.table` 保存 `{sheetName,rowStart,rowEnd,headerRow}`，CSV 工作表名为空，XLSX 行起止相同。对应 `structureType=table_row`；无通用文本偏移和物理页码。该来源随实际检索片段保存到 `chat_messages.citations`，历史 JSON 缺少 `table` 时兼容原有格式。

## 已发布 PDF 文本快照（043）

`document_pdf_snapshots` 使用 `document_id UUID PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE` 和 `content JSONB NOT NULL`。内容为 `{version:1,totalPages,pages:[{pageNumber,content,textSource?}]}`，最多 500 个物理页，空白页省略；OCR 页标记 `textSource: "ocr"`。快照与替换后的全部 chunks、Embedding 来源和成功任务状态在同一事务内提交。重新处理失败或取消保留旧快照；软删除随原文隐藏，永久删除级联清除。

该表按文档单独读取，避免列表、状态轮询及知识库查询载入大段 OCR 文本；访问前仍需校验文档所属知识库的能力。043 可重复执行，不为旧记录生成快照，并补齐 `pdf_limit_exceeded/ocr_unavailable/ocr_timeout/ocr_failed/ocr_limit_exceeded` 错误码约束。
