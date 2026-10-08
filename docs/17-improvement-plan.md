# 功能优化计划

制定日期：2026-09-20，2026-09-21 按代码审查结果复核并修订状态，2026-09-24 评估未完成验收与暂缓项并增补 P7–P15，2026-09-28 续接实现与真实验收。本文件是 2026-09 功能巡检后确定的改进阶段实施计划。每个阶段独立交付、独立验证；阶段完成后把状态记入 [跨会话交接](12-handoff.md)，并把稳定下来的行为写进对应规范（API、数据库、RAG、环境变量、前端）。本文件只维护计划与完成状态，不重复规范内容。

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

2026-09-24 评估（见“2026-09-24 评估”一节）后增补：

```text
P7  向量召回过滤短缺修复（HNSW + 知识库 / 软删除过滤）
P8  引用位置信息与原文定位
P9  小型正确性修复（用量模型名与分组、最后更新人、确定性失败不重试、集成测试挂起）
P10 真实环境验收（P1–P9，须用户授权）
P11 知识缺口转测试问题与管理员操作记录
P12 知识库所有权转移
P13 粘贴文本入库
P14 文档任务租约（多实例或滚动发布前置）
P15 Embedding 模型记录、维度校验与重建工具
```

- **先做 P7–P9**：修正已确认的缺陷，三者互不依赖。
- **P10**：在 P7–P9 之后执行。它要在共享开发库写数据并调用真实模型，须先得到用户授权；未获授权不阻塞 P11 之后的阶段。
- **P8**：前端改动基于 [前端改进计划](18-frontend-improvement-plan.md) F1–F6 改过的 `ChatSourcePreview.tsx` 进行（F1–F6 已于 2026-09-25 在本地完成，2026-09-26 提交）。
- **P11–P13**：相互独立。
- **P14**：在部署多个 backend 实例或滚动发布之前完成。
- **P15**：在切换 `EMBEDDING_MODEL` 之前完成。
- **新增迁移**：按实施顺序取下一个可用编号，并加入启动时的 schema 校验（参照 `backend/internal/database/database.go` 对 024–028 的做法）。

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

## 2026-09-24 评估

评估方法：
- 在本地运行全量检查。
- 对开发库（`.env` 指向的共享 PostgreSQL 与 Redis）只做只读查询，在 READ ONLY 事务内执行并回滚。
- 没有调用模型服务，也没有写业务数据。
- 探针脚本在被 Git 忽略的 `backend/tmp/_eval-20260924/`，输出在 `output/eval-*.log`。

### 环境与数据

- **本地检查**（2026-09-24 17:10 左右的工作区，早于前端改进 F1–F6）：后端 `go vet ./...`、`go test ./...` 通过；前端 76 个测试文件 698/698 通过，`npm run build`（含 11 项路由分包检查）通过。
- **开发库版本**：PostgreSQL 15.4、pgvector 0.5.1。部署文档写的是 PostgreSQL 16，也没写 pgvector 最低版本。
- **迁移状态**：public schema 已含 024–028 的列与表；`search_vector` 没有空值，说明关键词回填已完成。
- **数据量**：
  - 1 个知识库；166 个 chunk，其中 77 个属于已软删除文档。
  - 有效文档为 1 个 Markdown、1 个 PDF，没有 DOCX。
  - 1 个系统管理员，0 次评测运行。
  - `model_usage_records` 只有 2026-09-20 修复前的 2 条。
  - Redis 中 `embed:*`、`ratelimit:*` 都是 0 个键。
  - 2026-09-20 之后没有真实问答。
- **存储抽样**（166 个 chunk，平均 719 字符，只能看量级）：
  - `search_vector` 平均每个 chunk 3.7 KB，约为正文字节数的 2.5 倍。
  - `search_vector` 与 GIN 索引合计约占 `document_chunks` 总体积的 44%（2.6 MB / 6.0 MB）。
- **遗留测试 schema**：开发库中有 5 个，已于 2026-09-24 删除，删除前的表与行数记录在 `output/eval-dropped-schemas-20260924.json`。
  - 4 个 `rag_it_*`：PostgreSQL 集成测试挂起后没有清理。
  - 1 个 `rag_accept_*`：来自 2026-09-15 的 PDF 预览验收。

### P1–P6 验收缺口

| 阶段 | 未完成的验收 | 现状 | 去向 |
| --- | --- | --- | --- |
| P1 | 真实数据命中率对照、`EXPLAIN` 走索引 | 当前数据量下规划器选择全表扫描；强制走 HNSW 会暴露召回短缺 | 命中率对照入 P10；“走索引”改为 P7 的“走索引时不短缺” |
| P2 | Redis 停机演练、浏览器复验 | 没有流量记录 | P10 |
| P3 | 真实 DOCX 端到端 | 开发库没有 DOCX | P10；引用定位缺陷见 P8 |
| P4 | 界面流程、真实部署 | 025 已执行；没有 `admin.user.*` 活动 | P10；禁用所有者后知识库无人能管理，见 P12 |
| P5 | 真实 Provider usage | 修复前的 2 条记录证明 DeepSeek 返回 usage，但记下的是返回的模型名 | 模型名问题见 P9；复验入 P10 |
| P6 | 模型覆盖、两库风格对比、评测快照 | 只有 1 个知识库；`CHAT_ALLOWED_MODELS` 只有默认模型；0 次评测运行 | P10 |

### 新发现的缺陷

1. **HNSW 过滤后召回短缺**：pgvector 0.5.1 下强制走 HNSW，6 个样本查询中有 1 个只返回 6/30。见 P7。
2. **Markdown / DOCX 引用无法定位**：chunk 内容带标题前缀，来源预览按原文精确匹配，所以总是失败。开发库 Markdown 文档的 83 个 chunk 全都带多级标题前缀。见 P8。
3. **用量模型名与定价对不上**：用量记录的是 Provider 返回的模型名（真实记录为 `deepseek-flash`，配置为 `deepseek-v4-flash`）。`MODEL_PRICING` 按记录名匹配，按配置名写的价格会全部显示为未定价。见 P9。
4. **知识库“最后更新人”不更新**：编辑后该字段不变；管理员编辑后的回读能成功，只是因为指针别名碰巧改掉了参数。见 P9。

---

## P7 向量召回过滤短缺修复

### 目标

规划器选择 HNSW 索引时，向量召回仍返回 `min(vectorTopN, 该知识库可检索 chunk 数)` 条，且与精确结果一致；不再取决于数据量和 pgvector 版本。

### 问题与证据

- **原因**：HNSW 扫描最多产出 `hnsw.ef_search` 个近邻，知识库与软删除条件在扫描之后才过滤。pgvector 0.8.0 之前没有迭代扫描，被过滤掉的候选不会补回。
- **现有措施不够**：`backend/internal/repository/chunk_repository.go` 的 `SearchByVector` 设置 `SET LOCAL hnsw.ef_search = max(40, limit)`，这只在不过滤时够用。[RAG 规范](05-rag-pipeline.md)“pgvector 查询约束”第 6 条说“保证候选不少于请求数量”，有过滤时不成立。
- **复现（2026-09-24，开发库只读事务）**：
  - 做法：关闭 `enable_seqscan`、`enable_bitmapscan`、`enable_sort`，并把知识库条件改为文本比较使 btree 不可用，从而把生产查询强制为 HNSW 索引扫描；样本查询取有效 chunk 自身的向量。
  - 结果：6 个样本中有 1 个，全表最近 40 个近邻里 34 个属于已删除文档，只返回 6 条，与精确结果重合 0.20；`ef_search=100` 时返回 27 条。其余 5 个都是 30/30。
- **风险**：规划器今天选择全表扫描，结果是精确的。表变大后会改选 HNSW，届时短缺静默出现，没有任何指标报告。多知识库时，其他知识库的 chunk 同样会占用候选额度。

### 设计要点

1. **版本探测**：`ChunkRepository` 首次在 PostgreSQL 上做向量检索时读取 `pg_extension.extversion`，用 `sync.Once` 缓存，按数字段比较版本（不做字符串比较）。版本 ≥ 0.8.0 时，在同一事务内追加 `SET LOCAL hnsw.iterative_scan = strict_order`，`hnsw.max_scan_tuples` 保持默认。
2. **短缺兜底（所有版本）**：
   - 在 `retrieval.Service.Search` 的向量阶段，若返回数少于 `vectorTopN`，调用新增的 `ChunkRepository.CountVectorSearchable(ctx, kbID)`。它的条件与 `publishedChunks` 相同，外加 `embedding IS NOT NULL`。
   - 可检索数大于已返回数时，调用新增的 `SearchByVectorExact`：先用 `WITH … AS MATERIALIZED` 取出该知识库已发布且未删除的 chunk，再在 CTE 上按距离排序取前 N。HNSW 无法作用于 CTE 扫描，所以结果一定精确，也不依赖 `enable_*` 规划器参数。
     - 不要只用 `SET LOCAL enable_indexscan = off`：`enable_*` 只给路径加惩罚成本，其他路径也被禁用时，规划器仍可能选 HNSW。
     - 2026-09-24 在开发库只读验证（`backend/tmp/_eval-20260924/evalprobe4`）：在强制参数下，CTE 写法的 6 个样本全部与精确结果一致；只关 `enable_indexscan` 的写法，样本 1 仍走 HNSW，只返回 6 条。
   - SQLite 路径下两个方法等价。
3. **可观测**：
   - `observability.Recorder` 增加精确回退计数，在 `system/diagnostics` 展示。
   - 检索 debug 的 `vectorStage` 增加 `exactFallback`（布尔，省略表示 false）；为 true 时，检索测试面板显示一行说明。
   - 诊断同时展示 pgvector 版本与是否启用迭代扫描。
4. **不变的行为**：`vectorScore`、RRF、Rerank、阈值语义不变。关键词召回走 GIN 位图扫描，不受影响。
5. **运维**：
   - `cmd/doctor` 输出 pgvector 版本；低于 0.8.0 时提示“依赖精确回退兜底，建议升级”。
   - [部署指南](13-deployment.md) 写明：HNSW 需要 pgvector ≥ 0.5.0，建议 ≥ 0.8.0；自建数据库需要核对版本。
   - [环境变量规范](08-env-config.md) 中“避免超过 ivfflat 维度限制”改为 HNSW 的限制（`vector` 类型索引上限 2000 维）。

### 涉及改动

- `backend/internal/repository/chunk_repository.go`（版本探测、迭代扫描、`CountVectorSearchable`、`SearchByVectorExact`）、`backend/internal/retrieval/service.go`（回退与计数）、`backend/internal/dto/search.go`、`backend/internal/observability`、`backend/internal/service/system_diagnostics.go`、`backend/cmd/doctor`。
- 前端 `RetrievalTestPanel.tsx`、诊断页、`types/api.ts`。
- 文档：`05-rag-pipeline.md`（改写第 6 条，补回退规则与 debug 字段）、`04-api-design.md`（debug 与诊断字段）、`13-deployment.md`、`08-env-config.md`。

### 测试

- **PostgreSQL 集成测试**（`RAG_TEST_POSTGRES_DSN`，独立 schema）：
  - 沿用 `postgres_concurrency_integration_test.go` 的 harness；search_path 需包含 public，才能使用 `vector` 类型与 `<=>`。
  - 数据：用 3 维向量构造知识库 A 的 40 个有效 chunk、离查询最近的 60 个已删除文档 chunk、知识库 B 的 200 个近邻 chunk，并建 HNSW 索引。
  - 在会话级关闭 `enable_seqscan`、`enable_bitmapscan`、`enable_sort`，强制走索引。
  - 断言检索服务返回 30 条且与精确结果一致；pgvector < 0.8 时再断言确实触发了精确回退。
- **retrieval 单元测试**（替身仓库）：返回数不足且可检索数更多时回退；可检索数等于返回数时不回退；回退计数与 `exactFallback` 字段正确；`vectorTopN` 截断不变。
- 现有 retrieval 与 repository 测试不改动即通过。

### 验收

- 上述集成测试通过。
- 在开发库用同样的强制计划复测 2026-09-24 的 6 个样本（方法见 `backend/tmp/_eval-20260924/evalprobe2`）：检索结果全部为 30 条，且与精确结果一致。
- 诊断页能看到 pgvector 版本、迭代扫描状态与精确回退计数。

### 风险

- 精确回退在大知识库上要对全部 chunk 算距离（1536 维向量存于 TOAST），延迟随知识库 chunk 数线性增长。回退计数会暴露它的频率；频繁发生时应升级 pgvector，启用迭代扫描。

---

## P8 引用位置信息与原文定位

### 目标

TXT、Markdown、DOCX 的聊天引用在来源预览中能准确定位并高亮 chunk 的主来源正文，同时为以后的 PDF 引用高亮提供位置数据。

### 问题与证据

- **现象**：切片器把标题路径以 `一级 > 二级\n` 的形式写在 chunk `content` 开头（`backend/internal/document/splitter/splitter.go` `chunkBuilder.content`），citations 原样复制该 `content`（`backend/internal/service/chat_service.go` `citationsFromSearch`）。来源预览（`frontend/src/pages/Chat/ChatSourcePreview.tsx`）用 `content.indexOf(excerpt)` 在原文中精确查找，带前缀的 chunk 永远匹配不上，只显示“可对照上方摘录阅读原文”。overlap 复制的内容同样会让精确匹配失败。
- **开发库证据**：唯一的 Markdown 文档，83 个 chunk 全部带多级标题前缀。
- **已有的位置数据**：chunk `metadata` 里已有 `startOffset` / `endOffset`，表示主来源正文在规范化 segment 内的 UTF-8 字节偏移，不含标题前缀与 overlap（见 RAG 规范“切片规则”）。
  - TXT、Markdown、DOCX 各只有一个 segment；规范化指去 BOM、把 `\r\n` / `\r` 转为 `\n`。
  - 预览接口对 TXT / Markdown 返回原始文本（可能含 BOM 与 CRLF），对 DOCX 返回解析后的同一 segment 文本。
  - 检索 SQL 目前没有选出 `metadata`。

### 设计要点

1. **后端**：
   - `SearchByVector`、`SearchByKeyword` 与 P7 的精确查询一并选出 `document_chunks.metadata`。
   - 在 retrieval 层解析出 `startOffset`、`endOffset`，加入 `SearchResultResponse` 与 `CitationResponse`（可空，camelCase）。解析失败或缺失时为空，不报错。
   - 融合、Rerank、阈值过滤之后保留这两个字段。
   - 新消息的 citations 随 JSONB 持久化；旧消息不回填。
2. **前端定位**：
   - 预览文本先去掉开头的 U+FEFF，把 `\r\n` / `\r` 转为 `\n`。
   - 再用 `TextEncoder` 编码，把字节偏移换算成字符串下标（例如解码 `[0, start)` 后取长度）。
   - 偏移越界、不落在字符边界、或文件类型为 PDF 时，不使用偏移。
3. **没有偏移的旧引用**：先整段精确匹配；失败且 `content` 含换行时，去掉首行（标题前缀）再匹配；仍失败则保持现有提示。
4. **不在本阶段**：
   - PDF 高亮：偏移是 Go 解析器的页内文本偏移，与 pdf.js 文本项不对应；此为 P8 原阶段边界，2026-10-08 后续实现见 [联调与性能报告](24-ui-integration-performance.md#pdf-引用高亮)。
   - `DocumentDetailDrawer` 片段列表的定位不改。

### 涉及改动

- `backend/internal/repository/chunk_repository.go`（`SearchResult` 增加 metadata）、`backend/internal/retrieval/service.go`、`backend/internal/dto/search.go`、`backend/internal/dto/chat.go`、`backend/internal/service/chat_service.go`。
- 前端 `ChatSourcePreview.tsx`、`types/api.ts`。
- 文档：`05-rag-pipeline.md`（citations 字段）、`04-api-design.md`（search 与 citation 响应）、`10-frontend-spec.md`（定位规则）。

### 测试

- **后端**：
  - 检索结果在向量、关键词、融合、Rerank 与 fallback 各路径都携带偏移。
  - metadata 缺失或非法时偏移为空。
  - citations 持久化后读回仍含偏移。
- **前端 `ChatSourcePreview.test.tsx`**：
  - 带多级标题前缀的 Markdown chunk 按偏移高亮正文。
  - 中文多字节字符与 emoji 的偏移换算正确。
  - 源文件带 BOM 与 CRLF 时仍能定位。
  - DOCX 预览文本能定位。
  - 旧引用去掉首行后能匹配。
  - 偏移越界时显示原有提示。

### 验收

- 开发库那份 Markdown 文档的任意引用，“定位到引用”高亮的文本与 chunk 主来源正文一致（在 1920×1080 浏览器复验，可并入 P10）。
- 旧会话的引用行为不退化。

---

## P9 小型正确性修复

以下四项互不依赖，可分开提交。

### A. 用量模型名与按用途分组

- **问题**：
  - `chatcore.Usage.Model` 取的是 Provider 响应里的 `model`（`backend/internal/provider/chat/openai.go` 的非流式与流式路径、`backend/internal/provider/title/openai.go`）。服务商常返回规范名而不是请求名：开发库真实记录为 `deepseek-flash`，而配置与白名单为 `deepseek-v4-flash`。
  - `MODEL_PRICING` 按记录名匹配（`chat_service.go` `GetChatUsage`），按配置名写的价格会显示为未定价。
  - 非流式路径在响应缺少 `model` 时，服务层回退到全局 `CHAT_MODEL`，知识库覆盖的模型会被记错。
- **修复模型名**：Provider 的 `Usage.Model` 一律填本次请求实际发送的模型名（全局配置或 `answerConfig.model` 覆盖），不再用响应中的名称；服务层的回退保留作兜底。不新增列，已有记录不回填，在 API 规范中说明 `model` 是请求模型名。
- **新增按用途分组**：用量接口的 `groupBy` 增加 `purpose`（`intent` / `answer` / `title` / `evaluation`），同步修改 `backend/internal/repository/model_usage_repository.go` `groupExpressions` 与 `chat_service.go` 中的校验。前端 `UsagePanel.tsx` 增加“按用途”选项和中文标签。
- **测试**：Provider 返回不同模型名时记录请求名；覆盖模型被正确记录；按用途聚合正确；按配置名定价后成本非空。
- **文档**：`04`、`03`（`model` 列语义）、`08`（`MODEL_PRICING` 的键是配置中的模型名）。

### B. 知识库“最后更新人”

- **问题**：
  - `KnowledgeBaseRepository.Update` 对预加载了 `Owner` / `UpdatedBy` 的对象执行 `Save`。GORM 保存 belongs-to 关联时，用旧的 `UpdatedBy.ID` 覆盖外键，所以 `updated_by_id` 不会变成本次编辑者。
  - 又因为 `kb.UpdatedByID = &ownerID` 指向函数参数，这个参数也被改成了旧更新人。`Update` 随后用 `FindByIDAndOwner(kb.ID, ownerID)` 回读，对管理员只是“碰巧”成功（2026-09-24 用临时测试与 SQL 日志确认）。
  - 这次 `Save` 还会对关联用户多做一次 upsert。
  - 涉及 `knowledge_base_service.go` 的 `Update`、`BatchMoveCategory`、`UpdatePermissions` 三处 `kb.UpdatedByID = &ownerID`。
- **修复**：
  - `Update` 改为 `Omit(clause.Associations).Save(kb)`。
  - 三处都不再取参数地址。
  - `Update` 结束时的回读改为 `FindByID`（授权在前面已经完成）。
  - 前端“最后更新人”的显示不变。
- **测试**：
  - 管理员改名、改检索配置、改回答配置后返回 200；`updated_by_id` 为该管理员，`owner_id` 不变。
  - 另一位管理员再次编辑后，更新人随之变化。
  - 批量移动分类与修改可见性同样记录编辑者。

### C. 确定性失败不重试

- **问题**：worker 对所有失败都先重试 `maxRetries` 次（默认 3 次，间隔 10 秒）再分类（`backend/internal/job/worker.go`）。没有文字层的 PDF、编码错误、损坏文件每次都白跑三轮，用户要多等约 30 秒才看到原因。
- **修复**：`processor.ClassifyError` 的结果为 `encoding_invalid`、`corrupt_file`、`empty_content`，或错误链包含 `storage.ErrNotFound` 时，直接 `FailJobWithCode`。`embedding_failed`、`storage_failed`（非 NotFound）与 `internal` 继续重试。
- **测试**：各类确定性错误一次即失败并写入错误码；可重试错误的行为不变。

### D. PostgreSQL 集成测试挂起与 schema 清理

- **问题**：设置 `RAG_TEST_POSTGRES_DSN` 后，`TestPostgresRecycleBinRestoreLosesToPermanentDelete/chat_session` 会挂起直到 `go test` 超时。此时 `t.Cleanup` 不执行，独立 schema 残留在库里（开发库曾残留 4 个）。
- **修复**：
  - `postgresDSNWithSearchPath` 按设置 `search_path` 的方式追加 `lock_timeout`（如 5s）与 `statement_timeout`（如 60s）运行参数，让挂起变成可诊断的失败。
  - schema 名改为 `rag_it_<UTC 时间戳>_<随机>`；harness 启动时删除时间戳早于 24 小时的 `rag_it_` schema。
  - 再根据失败信息定位并修复该用例的锁等待。
- **测试**：在授权的测试库上完整运行 `RAG_TEST_POSTGRES_DSN` 相关测试，全部能结束，且不残留 schema。

---

## P10 真实环境验收

### 目标

在真实服务上补齐 P1–P9 的验收，结果记入交接。

### 前置与授权

执行前须得到用户明确授权。这一阶段会：
- 在共享开发库写入业务数据（知识库、文档、会话、评测、用户）；
- 调用真实 Chat / Embedding 服务并产生费用；
- 临时修改 `.env`，例如在 `CHAT_ALLOWED_MODELS` 增加第二个模型、配置 `MODEL_PRICING`。

验收结束后删除临时数据并恢复配置。不得停止共享 Redis。真实浏览器检查只用 1920×1080。

### 清单

| 项 | 做法 | 记录 |
| --- | --- | --- |
| P1 命中率 | 从现有文档挑至少 10 个含型号、错误码、专有名词的问题，用检索测试接口分别在 `enableKeyword` 开与关下运行 | 每题目标 chunk 是否在 `vectorTopN` 内及排名 |
| P7 | 用强制 HNSW 计划复测 2026-09-24 的 6 个样本 | 返回数，以及与精确结果的重合率 |
| P2 | 本机另起临时 Redis 与临时 backend：验证第 11 次登录返回 429 并带 `Retry-After`；同一问题两次检索命中缓存；停止该临时 Redis 后，`open` 模式下仍可登录和问答 | 响应码、诊断计数 |
| P3 / P8 | 上传含 Heading、多级列表、表格、合并单元格的 DOCX；查看片段的 `headingPath` / `structureType`；在聊天中引用它并点“定位到引用” | 片段结构、定位是否准确 |
| P4 | 在界面上创建用户、禁用用户（其旧会话下一次请求返回 401）、重置密码、授予与撤销管理员、验证最后管理员保护 | 每一步的结果与活动记录 |
| P5 / P9A | 新会话首问产生 `intent`、`answer`、`title` 三条记录，`message_id` 已回填，`model` 为配置名；运行一次评测，产生 `evaluation` 记录；配置价格后质量页显示成本；按用途分组 | 用量记录与页面截图 |
| P6 | 白名单加入第二个模型；建第二个知识库，两库设置不同的 `systemPromptAddition` 与模型；用同一问题比较回答风格和 citations 规则；运行评测并在对比页看到配置差异 | 回答摘要、`runtime.chatModel`、对比页 |
| P9B | 以管理员成员身份给知识库改名 | “最后更新人” |

### 验收

清单每一项都有记录；失败项登记为缺陷，回到对应阶段修复。

---

## P11 知识缺口转测试问题与管理员操作记录

### A. 知识缺口一键转测试问题

- **现状**：负反馈行已有“保存为测试问题”，它预填 `EvaluationCaseDialog` 并切到评测标签（`frontend/src/pages/Quality/QualityPage.tsx`）。知识缺口行只有“查看会话”“补充资料”“查看系统状态”。缺口项已带 `question` 与 `knowledgeBaseId`。
- **做法**（纯前端，不改接口）：
  - 四类缺口行都增加“保存为测试问题”，复用同一个对话框和跳转；`repeated_rewrite` 聚类用它的代表问题。
  - 打开对话框前，用现有接口读取该知识库已有的测试问题。问题文本 trim 并折叠空白后完全相同时，提示“已在测试集中”，不重复创建。
  - 达到每库 200 条上限时，展示后端返回的错误。
  - 权限与现有一致（`quality.read`）。
- **修正 API 规范**：[API 规范](04-api-design.md) 中 `no_citations` 的定义要改。代码实际选取的是 citations 为空、且 `answer_status` 不是 `retrieval_failed` / `model_refused` 的知识型回答，而不是 `answer_status='no_basis'`。
- **测试**：每类缺口行都出现按钮并正确预填；重复问题给出提示；保存后切到评测标签。

### B. 管理员操作记录

- **现状**：`admin.user.*` 活动只写进操作者本人的时间线（`GET /activities` 按 `user_id` 过滤），其他管理员看不到，所以 P4 说的“方便追溯”实际做不到。另外，禁用和改名共用同一个动作 `admin.user.updated`。
- **做法**：
  - 新增 `GET /admin/activities`（`RequireSystemAdmin`，分页，`pageSize` 上限 100）。服务端固定只返回 `action` 以 `admin.` 开头的记录，按时间倒序，带操作者的用户名与显示名；不开放其他用户的知识库活动。
  - `AdminUserService.Update` 在状态变化时分别记录 `admin.user.disabled` / `admin.user.enabled`，只有显示名变化时才记录 `admin.user.updated`。
  - 前端 `/admin/users` 增加“操作记录”区域（列表加分页），`activityDisplay.ts` 补上标签。
- **测试**：非管理员返回 403；列表包含多位管理员的操作，且排除非 `admin.` 活动；分页正确；禁用与启用记录为两个独立动作。
- **文档**：`04`、`10`。

---

## P12 知识库所有权转移

### 目标

- 知识库所有者可以把知识库转给其他启用状态的用户。
- 系统管理员可以把某个用户（通常是即将或已经禁用的用户）拥有的全部知识库一次转给他人。

这补上 P4 禁用所有者后知识库无人能管理的缺口。

### 现状

- **所有者专属能力**：`kb.delete`（软删除与恢复知识库）和知识库回收站只有所有者能用；系统管理员没有知识库能力（见 [API 规范](04-api-design.md)“权限与能力矩阵”）。
- **所有者被禁用后**：成员仍可使用知识库，但没有人能删除、恢复知识库或处理回收站；已在回收站中的知识库会一直卡住。
- **缺少入口**：目前没有任何修改 `owner_id` 的入口；成员接口也拒绝把所有者当成员处理（`OWNER_MEMBER_IMMUTABLE`）。
- **分类与标签按用户私有**：写入者只能使用自己的分类和标签（`ensureCategoryOwner` / `ensureTagsOwner`）。

### 设计要点

1. **服务方法** `TransferOwnership(actor, kbID, newOwnerID, keepPreviousOwnerAsManager)`，在单个事务内锁定知识库行后执行：
   - 校验新所有者存在、`status=active`，且不是当前所有者；
   - 更新 `owner_id`，`updated_by_id` 记为操作者；
   - 删除新所有者原有的成员行；
   - `keepPreviousOwnerAsManager=true` 时，为原所有者写入 `manager` 成员行；
   - `category_id` 不属于新所有者时置空；标签绑定、收藏、浏览记录与会话保持不变；
   - 原所有者不保留成员身份时，按现有“撤销成员”规则失去访问，包括其会话。
2. **所有者入口**：`POST /knowledge-bases/:id/transfer-ownership`，请求体 `{newOwnerId, keepPreviousOwnerAsManager}`。能力矩阵新增只有所有者持有的 `kb.transfer`。只允许未删除的知识库。
3. **管理员入口**：`POST /admin/users/:id/transfer-knowledge-bases`，请求体 `{newOwnerId, keepPreviousOwnerAsManager}`，受 `RequireSystemAdmin` 保护。
   - 转移该用户拥有的全部知识库（含回收站中的），复用所有权转移事务，按固定顺序锁定用户与知识库，整个批次原子提交，并返回转移数量。
   - `GET /admin/users` 的列表项增加 `ownedKnowledgeBaseCount`（含回收站）。
4. **活动记录**：为操作者和新所有者各记一条 `kb.ownership_transferred`，带知识库 ID 与名称。
5. **前端**：
   - 知识库设置页的危险区增加“转移所有权”，只有所有者可见。用户选择复用 `/users/search`，它已排除禁用账号。
   - 管理员用户页的行操作增加“转移知识库”，数量为 0 时禁用。
   - 禁用某用户时，如果他拥有知识库，确认框提示先转移。

### 涉及改动

- `access/capability.go`、`service/knowledge_base_service.go`、`service/admin_user_service.go`、`repository/knowledge_base_repository.go`、`knowledge_base_member_repository.go`、`handler`、`router`、`dto`。
- 前端：知识库设置页、`pages/Admin/UsersPage.tsx`、`UserDialogs.tsx`、`api`、`types`。
- 文档：`04`（接口与能力矩阵）、`09`（新错误码，如目标用户无效）、`10`、`README.md`（用户管理流程）。无 schema 变更。

### 测试

- **service**：
  - 所有者转移；
  - 管理员批量转移，含软删除的知识库；
  - 新所有者原有的成员行被移除；
  - 选择保留时，旧所有者成为 manager；
  - 分类置空规则；
  - 目标用户已禁用、不存在或与当前所有者相同时拒绝；
  - 转移后，新所有者可以恢复回收站中的知识库。
- **权限契约**：在 `access_contract_test.go` 增加用例；非所有者成员返回 403，陌生人返回 404。
- **路由**：非管理员调用管理员入口返回 403。
- **前端**：两个入口的确认流程，以及禁用用户时的提示。

### 验收

禁用一个拥有知识库（其中一个在回收站）的用户，由管理员转移后：新所有者能恢复、删除这些知识库，原成员的访问不受影响。

---

## P13 粘贴文本入库

### 目标

在知识库中直接粘贴文本创建文档，走与上传相同的查重、存储、处理与权限流程。

### 现状

上传链路只接受 `*multipart.FileHeader`：`validateFile`、`hashUploadedFile`、`Storage.SaveKnowledgeBaseFile` 都以它为参数，没有从字节或 Reader 保存对象的入口。

### 设计要点

1. **接口**：`POST /knowledge-bases/:id/documents/text`，请求体 `{title, content, format, allowDuplicate}`。
   - `format` 取 `md` 或 `txt`，默认 `md`。
   - 权限与上传相同（`content.write`，编辑者及以上）。
2. **校验**：
   - `title` trim 后为 1–200 个字符；按现有文件名规则清洗后加上扩展名，作为 `filename`。
   - `content` 去掉空白后不能为空，字节数不超过 `MAX_UPLOAD_SIZE_MB`。
3. **重构**：
   - 抽出上传核心，输入改为“文件名、大小、打开 Reader”的来源抽象，multipart 与文本各一个实现。
   - `Storage` 增加 `SaveKnowledgeBaseObject(ctx, location, reader, size)`，本地、MinIO 与路由实现都补上；`SaveKnowledgeBaseFile` 改为基于它实现。
   - 以下行为与上传保持一致：内容哈希查重、`409 DOCUMENT_DUPLICATE_CONTENT`、存储清理预留、文档与任务在同一事务创建、活动记录。
4. **前端**：导入对话框增加“粘贴文本”模式，包含标题、格式（Markdown / 纯文本）、正文与字节计数。提交后刷新列表；重复内容按上传时的 409 交互处理。

### 涉及改动

- `service/document_service.go` 及上传相关文件、`storage`（local、minio、routed）、`handler/document_handler.go`、`router`、`dto/document.go`。
- 前端 `DocumentImportDialog.tsx`、`api/resources.ts`、`types/api.ts`。
- 文档：`04`、`05`（入库来源）、`10`、`README.md`。

### 测试

- **service**：空内容、超长标题、超出大小限制的校验；查重与 `allowDuplicate`；写入的对象字节与请求内容一致；处理任务被创建；权限。
- **storage**：本地实现从 Reader 保存；MinIO 实现走 `RAG_TEST_MINIO_*` 集成测试。
- **前端**：模式切换、校验、提交与重复提示。

### 验收

粘贴一段带标题的 Markdown，处理完成后切片结构与上传同内容 `.md` 文件一致，并且能被问答引用。

---

## P14 文档任务租约（多实例前置）

### 启动条件

部署第二个 backend 实例、或采用新旧进程重叠的滚动发布之前必须完成。当前单实例 systemd 部署不受影响。

### 现状

- **领取任务**：用 `FOR UPDATE SKIP LOCKED` 并在锁内复查，在 PostgreSQL 上是原子的（`backend/internal/repository/document_repository.go` `ClaimPendingJob`）。
- **启动恢复**：worker 启动时，`RecoverRunningJobs` 把所有 `running` 的 `process_document` 任务无条件重置为 `pending`。这会夺走其他存活实例正在处理的任务，而且没有 fencing，两个实例可能同时处理同一文档，先发布的一方被另一方覆盖。
- **租约字段**：`document_jobs.locked_at` 只在领取时写一次，没有心跳、`lease_token` 或持有者。
- **崩溃恢复**：实例崩溃后，它的任务要等某个实例重启才会恢复，期间会阻塞同一文档的后续任务。
- **可参照的实现**：存储清理任务的 `lease_token` 与过期重领（`storage_cleanup_repository.go`），评测运行的心跳与超时判定（`evaluation_repository.go`）。

### 设计要点

1. **迁移**：`document_jobs` 增加 `lease_token UUID`、`heartbeat_at TIMESTAMPTZ` 及相应索引，并加入启动校验。
2. **领取**：写入新的 `lease_token`，同时写 `locked_at` 与 `heartbeat_at`。
3. **心跳**：处理期间每 15 秒刷新 `heartbeat_at`，条件为 `id` 与 `lease_token` 都匹配。刷新失败即视为失去租约，按取消处理并停止发布。
4. **fencing**：进度、状态、`EnsureJobRunning`、`PublishByDocument`、`FailJob`、`RetryJob` 的写入条件都加上 `lease_token`。
5. **过期回收**：删除启动时的无条件重置，改为由各实例周期执行：把 `heartbeat_at` 超过租约时长（如 2 分钟）的 `running` 任务放回 `pending`。
6. **文档**：在 [架构](02-architecture.md) 与 [部署指南](13-deployment.md) 写明多实例的其他前提：
   - 共享存储必须用 MinIO，本地 `uploads` 每台主机各自独立；
   - 诊断指标按进程统计；
   - 限流在 Redis 故障时默认放行。

### 测试

- **SQLite 单元测试**：`lease_token` 不匹配时所有写入都不生效；心跳失败会中止处理。
- **PostgreSQL 集成测试**：两个连接池并发领取时，同一任务只有一方拿到；过期任务会被回收；旧持有者的发布被拒绝。
- **回归**：取消、重试、进度的行为不变。

---

## P15 Embedding 模型记录、维度校验与重建工具

### 目标

防止两类问题：向量列维度与 `EMBEDDING_DIMENSION` 不一致；切换 `EMBEDDING_MODEL` 后新旧向量混用而没人察觉。这也是“每知识库独立 embedding 模型”的前置。

### 现状

- **维度**：`document_chunks.embedding` 为 `vector(1536)`。`EMBEDDING_DIMENSION` 只用于请求 Provider 和校验返回长度，启动、doctor、诊断都不拿它和列维度比较。
- **模型来源**：chunk 与 document 都不记录向量是哪个模型生成的。
- **重新向量化**：只能按文档 ID 列表批量重处理，没有整库重新向量化的工具。
- **查询缓存**：缓存键包含模型、维度与端点，切换模型后不会读到旧缓存；但库里的旧向量仍会被新的查询向量检索。

### 设计要点

1. **启动与 doctor 校验**：在 PostgreSQL 上读取 `embedding` 列声明的维度（`pg_attribute.atttypmod`）。与 `EMBEDDING_DIMENSION` 不一致时启动失败，并提示迁移步骤；doctor 输出两者。
2. **迁移**：`documents` 增加 `embedding_model VARCHAR(128)` 与 `embedding_dimension INT`，由 processor 在发布 chunks 的同一事务中写入。迁移前的旧数据为 NULL，表示未知。
3. **诊断**：展示按 `embedding_model` 统计的有效文档数；与当前配置不同或为未知的数量单独标出。
4. **重建 CLI**：新增 `cmd/reembed`，参数为 `-kb`（可选）、`-only-mismatched`（默认 true，NULL 视为不匹配）、`-dry-run`、`-batch`。
   - 用现有重处理队列为匹配的文档排队，跳过已删除和已有活动任务的文档。
   - 说明中写明：重处理会更换 chunk ID，旧 citations 里的 `chunkId` 会失效，但内容与页码仍保留。
5. **切换流程**：[部署指南](13-deployment.md) 写明：
   - 改 `EMBEDDING_MODEL`（维度不变）后必须运行 `reembed`，完成之前检索质量会下降；
   - 改维度需要先迁移列类型、重建 HNSW 索引，再全量重建。

### 测试

- 维度不一致时启动报错。
- processor 写入模型与维度。
- 诊断统计正确。
- CLI 的筛选、dry-run 与排队（SQLite），以及跳过有活动任务的文档。

---

## 暂缓项（2026-09-24 评估）

原“本计划暂不包含”的 11 项已完成评估，其中 6 项已排期或由新阶段覆盖：
- 知识缺口一键转测试问题排入 P11A；
- 知识库所有权转移排入 P12；
- 粘贴文本入库排入 P13；
- 多实例 worker 租约排入 P14；
- 独立审计表的当前需求由 P11B 满足；
- 每知识库独立 embedding 模型的前置工作由 P15 完成。

跨知识库会话已于 2026-09-29 按用户要求启动并实现：保持统一 Embedding，支持 1–5 库固定范围、统一精排、逐库鉴权和来源标库，验收见 [多库报告](21-multi-kb-acceptance.md)。每库独立模型暂无需求。

PDF 引用高亮已于 2026-10-08 按用户要求启动并实现：在有效引用页中规范化后完整、唯一匹配摘录，保留 PDF.js 原文坐标与文字选择，支持同页切换、翻页返回、缩放、取消和局部重试。未匹配或同页重复不猜位置；Go PDF 字节偏移不用于 PDF.js。保持现有 `document.download` 能力矩阵，只读成员继续阅读摘录与页码，不增加原文件预览权限。匹配、查看器、聊天来源与文档详情的 87 项本地 fixture 回归通过；1920×1080 浏览器完成合成引用与真实鉴权/PDF 字节的组合验证。模型生成这些引用的链路仍受 Embedding 503 阻塞，见 [联调与性能报告](24-ui-integration-performance.md)。规则见 [前端规范](10-frontend-spec.md)。

其余项继续暂缓，启动时遵循下表的约束。工作量为粗估：M 为 2–4 天，L 为 1–2 周，XL 为 2 周以上。

| 项 | 评估结论 | 启动条件 | 设计约束 |
| --- | --- | --- | --- |
| 追问建议 | M。前端读到 `done` 就停止读流；首问的 `done` 已排在同步标题生成之后（超时 5 秒） | P8 完成，且有明确需求 | 用独立接口按需生成，不进 SSE 流；只针对最新一条带 citations 的知识型回答，以这些 citations 为上下文，避免建议知识库答不了的问题；计入 usage（`purpose=suggestion`）与聊天限流 |
| 扫描 PDF OCR | L。没有文字层的 PDF 已归为 `empty_content` 并给出 OCR 建议；部分页是扫描件时，这些页会被静默丢弃；后端是 systemd 原生二进制，没有容器镜像 | 真实语料中扫描件占比明显 | 优先走 Provider 接口（OCR 或视觉模型），而不是本机 Tesseract；需要先定页面图像的提取或渲染方案；可以先做“记录无文字页数并提示” |
| URL 入库 | L。后端没有抓取用户 URL 的代码，也没有 SSRF 防护 | P13 完成 | 解析后的 IP 与每次重定向的目标都要拦截私网、回环、链路本地和云元数据地址；限制重定向次数、大小、超时与 Content-Type；正文抽取为 Markdown；新增 `source_url` 并定义刷新语义 |
| 每知识库独立 embedding 模型 | 用户确认暂无需求，继续暂缓。XL。列固定为 `vector(1536)`；pgvector 0.5.1 没有 `halfvec`，`vector` 的 HNSW 索引上限 2000 维 | P15 完成，且确有多模型需求 | 按维度分列或分表，或用不带维度的列加按维度的部分表达式索引；每库各自的 Provider 与重建流程 |
| 独立审计表 | L。AGENTS.md 把审计日志列在 MVP 之外；当前的追溯需求由 P11B 满足 | 出现合规要求 | 只追加写入，写入失败即操作失败；定义保留期；防篡改 |
| 公开注册 | 不做。系统面向企业内部，P4 已决定由管理员建号；用户名的大小写判重只在应用层做，存在并发窗口 | 产品定位发生变化 | 优先邀请或管理员审批；先补 `lower(username)` 唯一索引，以及按账号和 IP 的注册限流 |
| 首问 `done` 等待标题 | 2026-10-08 已测本地夹具：立即兜底中位 1.070 ms，500 ms 标题 Provider 为 501.312 ms；10/10 通过。当前未配置标题模型，继续摘要兜底，见 [测量报告](24-ui-integration-performance.md#首问标题收尾) | 启用标题模型并实测首问收尾明显变慢 | 改为在 `done` 之后异步生成标题，通过会话列表刷新 |

## 完成状态

| 阶段 | 状态 | 完成日期 | 备注 |
| --- | --- | --- | --- |
| P1 混合检索 | 已完成（验收待补） | 2026-09-21 | 分词与融合规则见 [RAG 规范](05-rag-pipeline.md)“混合召回与融合”；既有环境需执行迁移 024 并运行 `cmd/reindex-keywords`。2026-09-21 补上启动时对 024 的校验，关键词阶段报错改为降级为纯向量召回并记 `keyword` 故障计数。与计划的偏离：召回改为顺序执行而非并行（同一连接池、开销小）。真实数据命中率对照、`EXPLAIN` 走索引与存储增长抽样仍未在集成环境记录。2026-09-24 评估：开发库已执行 024 并完成回填，存储增长已抽样（见“2026-09-24 评估”）；强制走 HNSW 时召回短缺，修复见 P7，“`EXPLAIN` 走索引”由 P7 的验收取代；命中率对照入 P10。 |
| P2 限流与 Redis 落地 | 已完成 | 2026-09-21 | 登录按可信客户端 IP、聊天生成按用户 ID 固定窗口限流；query embedding 缓存 24h。2026-09-21 把消息编辑重生成接口纳入聊天限流，缓存键加入 embedding 维度与端点哈希。真实 Redis 停机演练与集成浏览器复验待部署环境执行。2026-09-24：停机演练（改用本机临时 Redis）与浏览器复验入 P10。 |
| P3 DOCX 解析 | 已完成 | 2026-09-21 | 2026-09-21 修复切片器只对 `md` 启用结构解析的缺陷，DOCX 现与 Markdown 共用同一结构路径（`headingPath` / `structureType` 生效，有对照测试）；补齐 vMerge 续格置空、编号标题保持标题、`numId=0` 不作列表、样式 `basedOn` 继承、段落级 `outlineLvl`、内容控件 / 域 / 嵌套表格文本、连续列表项合并、解压 64MB 上限、`.doc` 与加密文件的明确提示。真实 DOCX 上传端到端复验待集成环境执行。2026-09-24：带标题前缀的 Markdown / DOCX 引用无法在来源预览中定位，见 P8；真实 DOCX 端到端入 P10。 |
| P4 用户管理 | 已完成 | 2026-09-21 | 2026-09-21 修复认证中间件查库失败放行、未知用户视为启用、最后管理员判断包含目标本人且不覆盖禁用路径、管理员可自重置密码；用户名格式校验与大小写不敏感判重；成员搜索排除禁用账号；前端补编辑对话框、分页、二次确认、自身行保护、活动时间线映射；补齐 service / 路由 403 / 前端测试与 04、03、09、10、README 文档。真实部署迁移待执行。2026-09-24：开发库已执行 025；界面流程入 P10；禁用所有者后知识库无人能管理，见 P12；管理员操作记录只有操作者本人能看到，见 P11。 |
| P5 Token 用量统计 | 已完成 | 2026-09-21 | 2026-09-21 修复评测记录零 UUID 触发外键而静默丢失、`message_id` 永不回填、耗时含检索、provider 硬编码、写入错误无日志；实现 `MODEL_PRICING` 解析与成本估算；用量范围改为质量页规则（可读知识库汇总，管理员看全部）；按日键统一为 UTC `YYYY-MM-DD`，按知识库 / 用户返回名称；质量页用量标签补范围与分组控件、折线图、按知识库 / 模型表格与成本列；补 Provider、service、聚合与前端测试，04、03、05、08 文档同步。真实 Provider usage 返回仍待集成环境复验。2026-09-24：开发库只有修复前的 2 条真实记录，证明 DeepSeek 返回 usage；记录的是返回模型名，与配置名不同，定价因此匹配不上，见 P9；复验入 P10。 |
| P6 回答配置 | 已完成 | 2026-09-21 | 2026-09-21 修复保存检索配置或改名会清空回答配置（服务端对缺省块保留已存值，前端两表单互带）、白名单为空时放行任意模型（改为拒绝）、流式降级丢失模型与温度覆盖、`answer_config` 解码错误静默；评测运行新增 `answerConfig` 快照（迁移 028）与 `runtime.chatModel` 实际模型，对比页展示配置差异；模型下拉只列白名单；补 Prompt 组装、校验、快照与前端测试，05、04、03、08、10 文档同步。真实模型覆盖待集成环境复验。2026-09-24：开发库只有 1 个知识库，白名单只有默认模型，复验入 P10；知识库“最后更新人”不随编辑更新，见 P9。 |
| P7 向量召回过滤短缺修复 | 已完成 | 2026-09-28 | 既有提交 da03180 / 170e58c；真实 pgvector 0.5.1 六个强制 HNSW 样本均返回 30 条，与精确 Top 30 重合 30/30。 |
| P8 引用位置信息与原文定位 | 已完成 | 2026-09-28 | 既有提交 c87ab31；1920×1080 浏览器复验 DOCX 与多级标题 Markdown 的字节偏移高亮。 |
| P9 小型正确性修复 | 已完成 | 2026-09-28 | A–C 已有提交；D 补齐测试表并在失败路径释放暂停事务，真实 PostgreSQL 全部通过且无 rag_it 残留。验收额外修复 users.created_by 映射、用量 GROUP BY 常量和标题用量 message_id。 |
| P10 真实环境验收 | 已执行，双模型暂留 | 2026-09-28 | 用户已授权续接，并明确暂留第二 Chat 模型对照。其余结果和边界见下表；采用独立 schema、临时 backend / Redis，不改根 .env。 |
| P11 知识缺口转测试问题与管理员操作记录 | 已完成 | 2026-09-28 | A 已有提交 4ccfdfb；B 接完跨管理员活动接口、分页和前端。 |
| P12 知识库所有权转移 | 已完成 | 2026-09-28 | 所有者单库转移、管理员原子批量转移、能力与界面接线；真实禁用账号的两库（含回收站）转移、恢复、成员保留通过。 |
| P13 粘贴文本入库 | 已完成 | 2026-09-28 | 共用 Reader 来源、查重与处理队列；真实 Markdown 创建/处理/引用与同内容上传查重通过。2026-09-29补齐真实MinIO Reader与multipart、物化解析和删除链路。 |
| P14 文档任务租约 | 用户确认暂缓 | — | 2026-10-08 确认继续单实例；部署多实例或重叠滚动发布前完成 |
| P15 Embedding 模型记录、维度校验与重建工具 | 已完成 | 2026-09-28 | 迁移 029、发布来源、启动/doctor 校验、诊断与 reembed；独立 schema 真实迁移/维度和含历史版本的四文档排队重建通过，public 未应用 029。 |

## 2026-09-28 真实验收记录

本次续接已获授权；用户明确“暂留双模型对照，继续其他验收”。数据库业务写入全部限定在 `rag_accept_20260928_continue`，完整执行 001–029；现有 public 文档只读抽样。临时 backend / Redis / 前端使用 18080 / 16379 / 15173，根 `.env` 未修改，共享 Redis 未停止。临时模型价格为每百万 prompt=1、completion=2，仅验证成本计算，并非厂商报价。

| 验收项 | 结果与证据 |
| --- | --- |
| P1 | 12 个现有文档术语查询，真实 Embedding、生产检索服务按开关对照；目标 chunk 在融合 Top 30 命中由 11/12 到 12/12，MySQL 样本从未命中变为第 21。部分排名下降，样本含通用词，不构成总体质量提升证明。每题排名见 `output/continue-p1-samples.json`。 |
| P7 | EXPLAIN 使用 HNSW；六个样本最终均 30 条、与精确 Top 30 重合 30/30，其中原始 6 条的样本触发精确回退。`output/continue-p7-real.log`。 |
| P2 | 本机 Redis 3.2.100 第 11 次登录返回 429 / Retry-After 59；同问题两次检索 hit=1、miss=1、error=0。停止临时 16379 后登录、检索、完整真实问答成功。 |
| P3 / P8 | 合成 DOCX 包含 Heading 1/2、多级列表、表格与合并单元格；真实 worker 输出 headingPath 和 mixed 结构。DOCX 与多级 Markdown 来源原文均按偏移高亮，截图 `output/playwright/continue-docx-citation.png`、`continue-markdown-citation.png`。 |
| P4 / P11B | 浏览器创建账号、授予/撤销管理员、禁用、密码重置通过；禁用旧 token 下一请求 401。操作记录显示各动作；最后活跃管理员禁止禁用/降级另有真实 PostgreSQL 回归。 |
| P5 / P9A | 真实 intent / answer / title / evaluation 均写入请求模型名 deepseek-v4-flash；修复后首问的 intent / answer / title 都关联回答 message_id，评测没有聊天消息，ID 保持 NULL。首次标题用量缺失由本地 TITLE_API_KEY 为空导致，仅在临时进程补同端点 Chat 凭据后复验成功。成本/用途分组截图 `output/playwright/continue-usage-cost.png`，五种分组通过真实 PostgreSQL 测试。 |
| P6 | 同一 Chat 模型的“一句话”和“编号列表”两份回答配置快照，真实评测均 1/1 规则通过；界面对比显示提示词差异和实际模型。`output/playwright/continue-evaluation-comparison.png`。不同模型、不同库的交叉对照按用户要求暂留。 |
| P9B / P12 | 禁用拥有两库的账号后，管理员在界面一次转给新所有者；回收站库可恢复，正常库可删除，已有 manager 身份保留；manager 改名返回 updatedBy 为本次操作者。 |
| P9D | 暂停事务在断言失败时未释放会令后续连接池清理挂住；新增 defer 释放、提前结束检测和有界等待。补齐 storage_cleanup_jobs、knowledge_bases.updated_at、关键词 metadata 测试表。原聊天会话子用例及全部相关 PostgreSQL 测试均结束并通过，无 rag_it 残留。 |
| P13 / P15 | 浏览器粘贴文本、加入清单、开始导入与处理完成通过；文本创建与同内容文件上传查重、问答引用通过。029 重复执行与 vector(3) / 配置1536拒绝检查通过；reembed 强制 dry-run selected=4 / queued=0，实际 selected=4 / queued=4；worker 全部完成，诊断有效文档4、未知0、不匹配0。范围包含仍可检索的历史版本，避免漏掉旧模型向量。 |

验证边界：上述续接端到端沿用 `RERANK_ENABLED=false`；真实 Rerank 成功路径已由下方追加验收补齐。MinIO 真实服务、PDF 浏览器、触屏与读屏器本轮未测。P1 对照调用生产检索服务而非 HTTP 检索测试页面；其 API 层由路由测试覆盖。P14 仍为条件启动。开发库 public 尚未执行 029，部署本次代码前必须迁移。

验收收尾：临时 schema 已删除，临时 Redis / backend / 前端 / 浏览器均已停止。自动审批策略以 `blocked by policy` 拒绝递归清理 `output/continue-uploads/`，该本地目录保留；没有影响业务配置或共享服务。

### 追加：真实 Rerank 成功链路

用户明确要求“先补真实 Rerank 验收”。使用现有配置的 `Qwen/Qwen3-Reranker-4B`，仅在临时进程启用精排并保持 strict；Embedding 为 `Qwen/Qwen3-Embedding-4B`（1536维），Chat 为 `deepseek-v4-flash`。独立 schema `rag_accept_20260928_rerank` 执行001–029，仅写入合成数据。根 `.env` 未修改，仍为 `RERANK_ENABLED=false`。

| 检查 | 实际结果 |
| --- | --- |
| 真实 Provider 合同 | 中文备份保留期、中文设备错误码、英文备份保留期共3组，每组4篇含干扰项的合成文档；目标文档均首位，ID完整且不重复，分数有限并按降序返回。单次耗时678–1873ms。 |
| 完整入库与检索 | 7份文档 → 7个chunk，真实 Embedding 入库。混合召回、关闭关键词的纯向量召回、中英文查询均正常精排；逐项核对上游返回 index 对应输入内容及 API chunkId、分数。 |
| TopK 与阈值 | threshold=0 / TopK=7 返回7项；TopK=2 返回2项；用样本第一、第二名分数中点约0.996286作测试阈值，返回1项；threshold=1 返回0项。每次按该次真实上游分数核对过滤结果和 debug.finalStage。该测试阈值不是推荐配置。 |
| JSON 与 SSE 问答 | 日备份回答包含35天，设备故障回答包含时钟同步等给定步骤。临时知识库 TopK=1 / threshold=0.3；两种路径的 citations 与实际发送给回答模型的 Prompt chunkId、内容、真实精排第一名及分数一致，未混入其他候选。SSE citations事件与最终响应一致，delta.text拼接等于最终回答，无error事件。 |
| 运行诊断 | 修正验收记录器的压缩响应和SSE字段读取后复验；进程累计真实 Rerank 成功10次、失败0、降级0（含流式复核的重复调用）。精排阶段 p50=1067ms、p95/max=2135ms；仅10次小样本，整体HTTP耗时还含未启动临时Redis时的连接重试，不作为性能基准。 |
| 可复验入口 | 新增默认跳过的 `backend/internal/provider/rerank/real_provider_integration_test.go`；显式真实服务开关见 [开发规范](00-ai-development-guide.md#真实模型合同验证)。Provider、retrieval、service、router 本地fixture测试及 Provider vet 通过，无需修改生产精排逻辑。 |

证据：`output/rerank-provider-real.log`、`output/rerank-acceptance.json`、`output/rerank-wire.jsonl`、`output/rerank-sse.json`；只保存合成模型请求、响应及必要元数据，不记录认证头。临时schema已删除，backend与转发进程已停止；合成上传文件保留在忽略目录 `output/rerank-uploads/`。public未写入，根`.env`的SHA-256校验一致。

边界：本次完成真实成功路径、API过滤和Prompt/引用合同，不新增浏览器检查。备份样本的相似干扰项也出现约0.99高分，不能据此声称默认0.3阈值能剔除所有干扰文档或业务语料总体质量提升。第二Chat模型对照继续按用户要求暂留。

### 追加：Redis等待优化与业务语料校准

按用户要求完成，详细方法、原始证据和边界见 [Redis故障等待与Rerank校准报告](19-redis-rerank-calibration.md)。

- Redis命令默认200ms预算、禁用自动重试、共享5秒故障冷却，到期单探测恢复。连接拒绝对照首次GET 1724ms→52ms，后续缓存/限流在冷却期<1ms；真实临时Redis验证open=200、closed=503，重启后缓存和限流恢复。全量后端test/vet与cache race通过。
- 当前2份资料/89片段，固定40题，20题调参、20题独立问题复核。真实混合召回与Rerank后回放55组参数，选出当前语料候选TopK=3、阈值0.95。复核集14道有答案题完整证据覆盖保持，平均上下文字符1833→1003；无答案拒绝仍为4/6，不能声称解决全部无答案判断。
- 对2道跨片段题与2道精排误放行的无答案题做默认/候选共8次真实回答检查：关键依据保留，无答案题均明确无法确认具体数值。候选参数另有4题生产检索复核，结果满足TopK和阈值。
- 题目与证据由本次任务从现有资料编写，尚未经业务人员确认；不是技术事实准确性审计。候选配置未应用，根`.env`和全局默认未改，public只读。第二模型继续暂留。


## 2026-09-29 回答依据与实际使用验收

- 回答约束：部分依据只答已知内容；冲突资料区分来源与适用范围；历史、文档指令与补充提示词不能替代依据；严格模式不补通用建议，常识模式单独标注。真实 deepseek-v4-flash 9类 × JSON/SSE =18项通过，原拒答合同6项通过。
- 实际环境：独立schema与真实MinIO，完成文本Reader、PDF上传/物化解析/Embedding、私有对象拒绝匿名、下载字节一致、回收站恢复及永久删除清理。
- 浏览器1920×1080：PDF引用直达第2页、翻页/缩放/适合宽度/下载、编辑与只读角色差异、管理员升降级和移除成员，撤权后聊天清理通过。
- 验收修复：中文UniGB CMap解析；详情抽屉重处理进度/预览；已有聊天收到403/404后的旧内容与缓存选项清理。
- 后端全量test/vet通过；前端相关4文件150项、生产构建、类型检查、lint通过。原2026-09-28记录保留历史边界，本节取代其中MinIO/PDF/协作未验收状态。
- 第二Chat模型对照继续按用户要求暂留；触屏、NVDA/VoiceOver、PDF逐字高亮与OCR仍不在本轮通过范围。

环境、证据与限制见[回答依据与实际使用验收](20-grounding-acceptance.md)。
