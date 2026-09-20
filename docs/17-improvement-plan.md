# 功能优化计划

制定日期：2026-09-20。本文件是 2026-09 功能巡检后确定的六个改进阶段的实施计划。每个阶段独立交付、独立验证；阶段完成后把状态记入 [跨会话交接](12-handoff.md)，并把稳定下来的行为写进对应规范（API、数据库、RAG、环境变量、前端）。本文件只维护计划与完成状态，不重复规范内容。

## 背景与结论

巡检对照代码得到的事实：

| 事实 | 依据 |
| --- | --- |
| 召回只有 pgvector 余弦相似度，没有关键词 / 全文检索 | `backend/internal/repository/chunk_repository.go` `SearchByVector`；业务代码无 `tsvector` / `bm25` |
| 向量索引为 `ivfflat` | `migrations/001_init_schema.sql`、`002_embedding_dimension_1536.sql` |
| Redis 只被 `Open` / `Ping`，没有任何业务读写 | `backend/internal/cache/redis.go` 是 `*redis.Client` 唯一使用处 |
| 没有限流中间件 | `backend/internal/middleware/` 只有 auth、cors、logger |
| 解析只支持 txt / md / pdf | `backend/internal/document/parser/parser.go` |
| 没有注册、没有管理员用户管理接口 | `auth_handler.go` 无 register；`UserService` 只有 `Search` |
| Chat Provider 不读取 usage，消息表没有 token 字段 | `backend/internal/provider/chat/openai.go`；`model.ChatMessage` |
| 系统提示词、模型全局共用，知识库只能配置 `retrievalConfig` | `dto/knowledge_base.go` |

已具备且本计划直接复用的能力：`users.role` 系统角色与 `RequireSystemAdmin` 中间件、`bootstrap-admin` CLI、`EmbeddingDimension` 配置项、`retrieval_config` JSONB、观测 `Recorder`、Provider 接口模式、`system/capabilities` 能力发布。

## 阶段顺序

```text
P1 混合检索（关键词 + 向量，RRF 融合，HNSW 索引）
P2 限流与 Redis 落地（登录 IP 限流、聊天用户限流、query embedding 缓存）
P3 DOCX 解析
P4 系统管理：用户管理
P5 Token 用量统计
P6 按知识库定制回答配置（系统提示、模型覆盖）
```

P1、P2 直接决定回答质量和线上安全，先做。P3 到 P6 相互独立，可按需要调整先后；P6 依赖 P5 的模型名与用量记录才能完整展示，建议放在 P5 之后。

每个阶段遵循相同的交付流程：迁移与后端 → 后端测试 → 前端 → 前端测试与构建 → 文档同步 → 交接记录。后端遵循 `handler -> service -> repository`，数据库走 GORM，模型调用走 Provider 接口。

---

## P1 混合检索

### 目标

对专有名词、错误码、型号、人名等精确匹配问题，关键词召回能补上纯向量召回漏掉的 chunk；向量索引改为 HNSW，减少数据增长后的召回率下降。检索质量之外的接口行为（Rerank、阈值、citations 来源约束）保持不变。

### 设计要点

1. **分词方案不依赖额外 PostgreSQL 扩展。** 当前 Compose 镜像 `pgvector/pgvector:pg16` 不含 `zhparser` / `pg_jieba`。在 Go 侧做规范化分词：中文连续段按字二元组（bigram）切分，ASCII 按单词切分并小写，数字、连字符和下划线组合的型号 / 错误码保留为整体词元；产物直接渲染为带位置的 tsvector 字面量以 `::tsvector` 写入，查询侧用同一函数渲染 `|` 连接的 tsquery 字面量并依赖 `ts_rank_cd` 排序；不经过 PostgreSQL 的文本解析器，避免它对连字符编码和 CJK 串做二次拆分。分词函数放在新包 `backend/internal/document/lexer`，切片和检索共用，保证入库与查询一致。
2. **存储。** `document_chunks` 新增 `search_vector tsvector` 列与 GIN 索引。Processor 在发布 chunks 的同一事务内写入该列；重处理按现有替换逻辑自然覆盖。已有数据由 `cmd/reindex-keywords` 分批回填。
3. **融合。** `ChunkRepository` 新增 `SearchByKeyword(ctx, kbID, query, limit)`，返回与 `SearchByVector` 相同的 `SearchResult` 结构，分数放入新增字段 `KeywordScore *float64`。`retrieval.Service.Search` 在向量召回后并行执行关键词召回，用 RRF（`k=60`）融合为一个候选列表并截断到 `vectorTopN`，再进入现有 Rerank / 阈值 / TopK 流程。融合后的候选保留原始 `vectorScore`（只出现在关键词侧的候选 `vectorScore=0`）。
4. **阈值语义。** Rerank 成功时仍按 `rerankScore` 过滤，不受影响。Rerank 关闭或 fallback 时，只出现在关键词侧的候选没有可比的 `vectorScore`，改为按归一化融合分过滤：`Σ 1/(k+rank)` 除以 `2/(k+1)`，两路第一为 1，单路第一为 0.5。已写入 RAG 规范。
5. **开关。** `retrievalConfig` 增加 `enableKeyword`（默认 `true`），环境变量 `KEYWORD_SEARCH_ENABLED` 提供缺省值；搜索接口允许请求级覆盖，Chat 复用知识库配置，与现有 `enableRerank` 一致。
6. **Debug payload。** `vectorStage` 之外新增 `keywordStage` 和 `fusionStage`，字段与现有 stage 对齐，方便在检索测试面板对照。
7. **HNSW。** 迁移中 `DROP` ivfflat 索引并 `CREATE INDEX ... USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64)`。运行期查询在事务内 `SET LOCAL hnsw.ef_search = max(40, vectorTopN)`，不新增配置项。

### 涉及改动

- 迁移 `024_hybrid_search.sql`：`search_vector` 列、GIN 索引、HNSW 替换 ivfflat；回填由 `cmd/reindex-keywords` 完成（分词在 Go 侧，SQL 无法生成）。`cmd/migrate` 增加 `-timeout`。
- `backend/internal/document/lexer`（新）、`processor`、`repository/chunk_repository.go`、`retrieval/service.go`、`dto/search.go`、`dto/knowledge_base.go`、`config`。
- 前端 `RetrievalConfigForm.tsx`、`RetrievalTestPanel.tsx`（新增开关与 debug stage 展示）、`types/api.ts`。
- 文档：`05-rag-pipeline.md`（检索流程、融合规则、阈值语义、debug payload）、`03-database-design.md`、`04-api-design.md`、`08-env-config.md`、`13-deployment.md`（迁移步骤）。

### 测试

- lexer：中文 bigram、中英混排、型号 / 错误码保留、URL 与 hash 不爆炸、空输入。
- repository：SQLite 替身无法运行 `tsvector`，关键词查询测试标记为 `RAG_TEST_*` 真实数据库测试，与现有向量测试同一边界。
- retrieval：RRF 融合顺序、去重、只在关键词侧命中的候选进入 Rerank、开关关闭时行为与现状完全一致、debug stage 字段。
- 端到端：用真实 PostgreSQL 对一组含精确型号 / 错误码的问题比较开关前后的命中；结果记入交接。

### 验收

- 关闭 `enableKeyword` 时全部现有测试不变。
- 开启后，含精确词元的测试问题在 `vectorTopN` 内的命中率高于纯向量（记录对照样本）。
- 迁移在含数据的库上可重复执行，HNSW 建立后 `EXPLAIN` 显示走索引。

### 风险

- 回填耗时与索引构建锁：迁移说明中要求低峰执行并给出预估。
- bigram 分词对长文本 `tsvector` 体积影响：抽样测量存储增长，写入交接。

---

## P2 限流与 Redis 落地

### 目标

登录接口不能被无限尝试，聊天接口不能被单用户刷爆模型费用；Redis 从"只 Ping"变成真正承担限流计数和 query embedding 缓存，或在确认不需要时从必需依赖中移除。本阶段选择前者。

### 设计要点

1. **限流中间件** `backend/internal/middleware/ratelimit.go`：基于 Redis 的固定窗口计数（`INCR` + `EXPIRE`，单条 Lua 脚本保证原子），键前缀 `ratelimit:{scope}:{key}`。两类作用域：
   - `login`：按客户端 IP，默认 `10` 次 / `1` 分钟；超限返回 `429 RATE_LIMITED`，并设置 `Retry-After`。
   - `chat`：按用户 ID，覆盖 `POST /chat/sessions/:id/messages`、`/messages/stream`、`/messages/:messageId/regenerate`，默认 `30` 次 / `1` 分钟。
   Redis 不可用时的策略由 `RATE_LIMIT_FAILURE_MODE` 控制：`open`（放行并记录 warning，默认）或 `closed`（拒绝）。
2. **配置**：`RATE_LIMIT_ENABLED`、`RATE_LIMIT_LOGIN_PER_MINUTE`、`RATE_LIMIT_CHAT_PER_MINUTE`、`RATE_LIMIT_FAILURE_MODE`、`TRUSTED_PROXY_CIDRS`（决定是否信任 `X-Forwarded-For`）。
3. **Query embedding 缓存**：`retrieval.Service` 在调用 `EmbedTexts` 前查 Redis，键为 `embed:{model}:{sha256(normalized query)}`，值为向量二进制，TTL 默认 `24h`（`EMBEDDING_CACHE_TTL`）。命中时不计入 Provider 调用指标，但记录缓存命中计数进 `Recorder`。缓存失败只降级为直接调用。
4. **诊断**：`system/diagnostics` 增加 Redis 连通性、限流触发计数、embedding 缓存命中率。
5. **前端**：API 客户端识别 `429`，在登录页和聊天输入框给出"请求过于频繁，请 N 秒后再试"提示，不进入通用错误弹窗。

### 涉及改动

- `middleware/ratelimit.go`（新）、`router/router.go`、`config`、`cache`（新增限流与缓存封装）、`retrieval/service.go`、`observability`、`service/system_diagnostics.go`、`apperror` / 错误码。
- 前端 `api/client.ts`、登录页、`ChatComposer.tsx`。
- 文档：`04-api-design.md`（429 响应与受限接口）、`09-error-codes.md`、`08-env-config.md`、`13-deployment.md`（反向代理与 `TRUSTED_PROXY_CIDRS`）、`02-architecture.md`（Redis 职责）。

### 测试

- 中间件用 miniredis 替身：窗口内超限、窗口过期重置、Redis 故障时 open / closed、代理头信任判断。
- retrieval 缓存：命中跳过 Provider、未命中写入、序列化往返、缓存故障降级。
- 路由测试：受限接口集合与未受限接口集合。

### 验收

- 连续 11 次错误登录第 11 次返回 429 并带 `Retry-After`。
- 同一问题第二次检索不产生 Embedding Provider 调用（诊断中缓存命中 +1）。
- Redis 停止时 `open` 模式下服务继续可用。

---

## P3 DOCX 解析

### 目标

支持上传 `.docx`，正文段落、标题层级、列表和表格进入切片，与 Markdown 享有同等的结构感知。

### 设计要点

1. **解析实现**：不引入重量级库，自行解析 OOXML：读取 `word/document.xml`（`encoding/xml` 流式解析）与 `word/styles.xml`（识别 `Heading1..6` 样式及其 `outlineLvl`），忽略页眉页脚、批注、修订删除内容。产物统一转成 Markdown 文本 segment 交给现有切片器：标题按样式层级转 `#`，`w:numPr` 列表转 `-` / `1.`，表格转 GFM 表格（合并单元格按左上角单元格取值、其余置空），其余段落按空行分隔。这样切片阶段不需要新增结构类型，`headingPath` 等 metadata 自然生效。
2. **限制**：不解析嵌入图片、公式、文本框与 OCR；`.doc`（二进制格式）不支持并给出明确错误。加密文档返回解析错误。
3. **文件校验**：上传时按扩展名与 zip 魔数双重判断，`fileType=docx`；`MAX_UPLOAD_SIZE_MB` 沿用。
4. **前端**：上传组件接受 `.docx`，文件类型图标与筛选项补充；预览接口对 docx 返回解析后的纯文本（与 txt / md 预览一致），不做版式还原。

### 涉及改动

- `backend/internal/document/parser/docx.go`（新）、`parser.go` 分派、`service/document_service.go` 类型白名单、预览。
- 前端上传组件、文档列表类型筛选、`types/api.ts`。
- 文档：`05-rag-pipeline.md`（解析范围）、`01-prd.md`、`AGENTS.md`（把 docx 从"不在范围"移出）、`README.md`。

### 测试

- parser：用 `testdata` 下手工构造的最小 docx（标题、多级列表、表格、合并单元格、中文段落、空段落、损坏 zip、加密文档）。
- service：白名单与魔数校验。
- 端到端：上传一份真实 docx，确认 chunks 的 `headingPath` 与 `structureType` 正确。

### 验收

- 含标题 / 列表 / 表格的 docx 上传后处理成功，chunks 结构与同内容的 Markdown 一致。
- 非法或加密文件在 `documents.error_message` 中给出可读原因。

---

## P4 系统管理：用户管理

### 目标

系统管理员可以在界面上创建、查看、禁用 / 启用用户、重置密码和授予 / 撤销系统管理员角色，不再依赖 `seed` 和数据库操作；用户账号可以被禁用而不删除数据。

### 设计要点

1. **数据**：`users` 新增 `status VARCHAR(16) NOT NULL DEFAULT 'active'`（`active` / `disabled`）、`last_login_at timestamptz`、`created_by uuid`。禁用用户的现有 JWT 在下次任何请求时被 `auth` 中间件拒绝（中间件已按 `SystemAdminService` 的做法以数据库为准查用户，在这里加 `status` 判断）。
2. **接口**（全部 `RequireSystemAdmin`）：
   - `GET /admin/users`：分页、按用户名 / 显示名搜索、按状态与角色过滤。
   - `POST /admin/users`：创建用户，返回一次性初始密码或接受管理员指定密码；密码规则复用 `bootstrap-admin` 的长度约束。
   - `PUT /admin/users/:id`：修改显示名、状态。
   - `POST /admin/users/:id/reset-password`：生成新密码并返回一次。
   - `PUT /admin/users/:id/role`：`user` ↔ `admin`。禁止撤销最后一位管理员，禁止管理员禁用或降级自己。
3. **所有权处理**：禁用用户拥有的知识库保持可访问（成员仍可用）；不做所有权转移，作为后续项。
4. **审计**：以上操作全部写入现有 `activities`，`action` 前缀 `admin.user.*`，方便追溯；不新建审计表。
5. **前端**：新增 `/admin/users` 页面（懒加载分包），入口与诊断页并列，仅在 `auth/me` 返回 `role=admin` 时显示。列表 + 创建 / 编辑对话框 + 重置密码结果弹窗（密码只显示一次，提供复制）。
6. **公开注册**：不做。保留由管理员创建账号的路径。

### 涉及改动

- 迁移 `025_user_status_and_admin.sql`。
- `handler/admin_user_handler.go`（新）、`service/admin_user_service.go`（新）、`repository/user_repository.go`、`middleware/auth.go`、`dto/user.go`、`router`。
- 前端 `pages/Admin/UsersPage.tsx` 及子组件、路由、导航、`api/admin.ts`。
- 文档：`04-api-design.md`（Users / Admin 节与能力矩阵）、`03-database-design.md`、`09-error-codes.md`、`10-frontend-spec.md`、`README.md`（首次部署流程调整）。

### 测试

- service：最后一位管理员保护、自我降级 / 禁用拒绝、禁用后 JWT 被拒、密码规则。
- 路由：非管理员访问全部 403。
- 前端：列表筛选、创建校验、重置密码只显示一次、非管理员看不到入口且直达 URL 被重定向。

### 验收

- 全新部署只需 `bootstrap-admin -create` 一次，之后所有账号在界面创建。
- 禁用账号后其已登录会话在下一次请求即失效。

---

## P5 Token 用量统计

### 目标

每条回答记录实际消耗的 prompt / completion token 与模型名，质量页可以按知识库、按用户、按天查看用量与估算成本。

### 设计要点

1. **Provider**：`chatcore.Provider` 与 `StreamingProvider` 的返回值增加 `Usage{PromptTokens, CompletionTokens, TotalTokens int; Model string}`。为不破坏现有实现与测试替身，新增 `UsageReporter` 可选接口（与 `StreamingProvider` 同样的类型断言模式），OpenAI 兼容实现从响应 `usage` 字段读取；流式模式请求体带 `stream_options.include_usage=true`，从最后一个 chunk 读取。Provider 不返回 usage 时记 `NULL`，不估算。
2. **意图分类、标题提炼**的调用也计入，用 `purpose` 区分（`intent` / `answer` / `title` / `evaluation`）。
3. **存储**：新表 `model_usage_records`（`id, user_id, knowledge_base_id, session_id, message_id, purpose, provider, model, prompt_tokens, completion_tokens, total_tokens, latency_ms, created_at`），索引 `(knowledge_base_id, created_at)`、`(user_id, created_at)`。不改 `chat_messages` 结构，避免又一次大表迁移；消息详情通过 `message_id` 关联。
4. **成本估算**：`MODEL_PRICING`（JSON，`{"model": {"prompt": 每百万 token 价格, "completion": ...}}`）为可选配置；未配置只显示 token 数。
5. **接口**：`GET /chat/quality/usage?knowledgeBaseId=&from=&to=&groupBy=day|knowledgeBase|user|model`，权限沿用质量页现有规则（只能看自己可访问的知识库；管理员可看全部）。
6. **前端**：质量页新增"用量"标签页：总量卡片 + 按日折线 + 按知识库 / 模型表格；图表遵循 `dataviz` 约定与现有明暗主题。

### 涉及改动

- 迁移 `026_model_usage_records.sql`。
- `chat` 核心接口、`provider/chat/openai.go`、`provider/title`、`service/chat_service.go`、`service/evaluation_service.go`、`repository/model_usage_repository.go`（新）、`handler/chat_handler.go`、`dto`、`config`。
- 前端 `pages/Quality/UsagePanel.tsx`（新）、`types`。
- 文档：`04-api-design.md`、`03-database-design.md`、`08-env-config.md`、`05-rag-pipeline.md`（记录点说明）。

### 测试

- Provider：非流式与流式 usage 解析、缺失 usage 为 nil。
- service：每次模型调用产生一条记录且 `purpose` 正确；Provider 失败不写记录；评测运行的记录归到对应知识库。
- 聚合查询：按各维度分组的结果与样本数据一致；权限过滤。

### 验收

- 一次知识型问答产生 `intent` 与 `answer` 两条记录（首问再多一条 `title`）。
- 质量页能看到最近 7 天各知识库的 token 用量；配置价格后显示估算成本。

---

## P6 按知识库定制回答配置

### 目标

每个知识库可以设置自己的回答风格与边界（系统提示补充、回答语言、是否允许在片段之外补充常识、模型覆盖），Chat 与评测都按知识库配置生成。

### 设计要点

1. **数据**：`knowledge_bases` 新增 `answer_config JSONB`，字段：`systemPromptAddition string`（上限 2000 字符）、`answerLanguage`（`auto` / `zh` / `en`）、`allowGeneralKnowledge bool`（默认 `false`）、`model string`（空为全局默认，仅允许 `CHAT_ALLOWED_MODELS` 白名单内的值）、`temperature *float64`（0–1）。
2. **Prompt 组装**：基础系统约束（RAG 规范中的六条）不可被覆盖，`systemPromptAddition` 追加在其后；`allowGeneralKnowledge=true` 时替换其中"只能基于提供的知识片段回答"为"优先基于知识片段回答，片段不足时可补充常识并明确标注"，且 `answerStatus` 口径不变。`[[NO_ANSWER]]` 标记规则保持。
3. **模型覆盖**：`chat` Provider 增加按请求指定模型的能力（`Chat(ctx, messages, opts)`，`opts.Model` 为空则用配置默认），只影响最终回答，不影响意图分类与标题。
4. **权限**：只有知识库所有者与管理员成员可修改 `answerConfig`，与 `retrievalConfig` 一致；编辑成员与只读成员只读。
5. **评测**：评测运行快照记录当时的 `answerConfig`，以便对比配置差异；`EvaluationComparison` 展示配置差异项。
6. **前端**：知识库设置页新增"回答配置"区块，与检索配置并列；模型下拉来自 `system/capabilities` 新增的 `chatModels` 列表。

### 涉及改动

- 迁移 `027_kb_answer_config.sql`。
- `dto/knowledge_base.go`、`service/knowledge_base_service.go`、`service/chat_service.go`（Prompt 组装）、`chat` 接口与 Provider、`service/evaluation_service.go`、`handler/system_handler.go`、`config`。
- 前端 `KnowledgeBaseSettingsPage.tsx`、`AnswerConfigForm.tsx`（新）、`EvaluationComparison.tsx`、`types/api.ts`。
- 文档：`05-rag-pipeline.md`（Prompt 规则）、`04-api-design.md`、`03-database-design.md`、`08-env-config.md`、`10-frontend-spec.md`。

### 测试

- Prompt 组装：基础约束不可覆盖、追加文本位置、`allowGeneralKnowledge` 两种模板、语言指令。
- 校验：长度上限、模型白名单、温度范围、权限。
- 评测快照包含 `answerConfig` 且对比页显示差异。

### 验收

- 两个知识库配置不同提示，同一问题得到风格不同的回答且 citations 规则不变。
- 非白名单模型被拒绝并返回校验错误。

---

## 本计划暂不包含

以下项在巡检中提出，但本轮不排期，待上述阶段完成后再评估：跨知识库会话、URL / 粘贴文本入库、扫描 PDF OCR、追问建议、引用在 PDF 预览中的高亮定位、知识缺口一键转测试问题、每知识库独立 embedding 模型、多实例 worker 租约协议、独立审计表、知识库所有权转移、公开注册。

## 完成状态

| 阶段 | 状态 | 完成日期 | 备注 |
| --- | --- | --- | --- |
| P1 混合检索 | 已完成 | 2026-09-20 | 分词与融合规则见 [RAG 规范](05-rag-pipeline.md)“混合召回与融合”；既有环境需执行迁移 024 并运行 `cmd/reindex-keywords`。真实数据上的命中对照与 HNSW 构建耗时待在集成环境补测。 |
| P2 限流与 Redis 落地 | 已完成 | 2026-09-20 | 登录按可信客户端 IP、聊天生成按用户 ID 固定窗口限流；query embedding 按模型与规范化问题缓存 24h；诊断与前端 429 提示已接入。miniredis、路由和前端替身验证通过，真实 Redis 停机演练与集成浏览器复验待部署环境执行。 |
| P3 DOCX 解析 | 已完成 | 2026-09-20 | OOXML 正文/标题/列表/表格解析、ZIP 魔数校验、DOCX 文本预览与前端上传/类型展示已接入；真实 DOCX 上传端到端复验待集成环境执行。 |
| P4 用户管理 | 未开始 | | |
| P5 Token 用量统计 | 未开始 | | |
| P6 回答配置 | 未开始 | | |
