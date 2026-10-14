# AI 开发总规范

本文档记录项目的开发约束和执行边界。根目录 `AGENTS.md` 提供日常入口；按当前任务查阅本文件及对应模块的相关章节。当前实现、待办与验证范围见 `12-handoff.md`。

## 项目目标

使用 Gin、PostgreSQL、pgvector、Redis、React 开发企业知识库问答系统 MVP。系统必须支持用户登录、创建知识库、上传文档、文档切片、向量检索、Rerank 精排、引用来源和聊天问答。

核心链路：

```text
登录
-> 创建知识库
-> 上传文档
-> 文档解析
-> 文档切片
-> Embedding
-> pgvector TopN 粗召回
-> Rerank TopK 精排
-> Prompt 组装
-> LLM 回答
-> citations 引用来源
```

## MVP 范围

必须实现：

1. 账号密码登录、JWT 鉴权、获取当前用户。
2. 用户私有知识库 CRUD。
3. 文档上传、列表、详情、删除、处理状态。
4. 文档解析、切片、Embedding 入库。
5. pgvector 向量检索。
6. Rerank 精排。
7. 聊天会话、消息保存、RAG 问答。
8. 引用来源 citations。

不在 MVP 范围：

1. 多租户。
2. 复杂 RBAC。
3. SSO。
4. 审计日志。
5. 除 MinIO S3 之外的其他对象存储后端与生命周期管理。
7. 计费和额度系统。

## 技术约束

1. 后端使用 Gin。
2. 数据库使用 PostgreSQL。
3. 向量存储使用 pgvector。
4. Redis 用作缓存、任务状态辅助和后续队列扩展点。
5. 前端使用 React。
6. 文件存储支持本地 `uploads` 与 MinIO S3；MinIO bucket 保持私有，访问必须经过后端权限校验。
7. 异步任务第一版采用数据库任务表加后端 worker。
8. 文档解析支持 `txt`、`md`、`pdf`、`docx`，以及用户明确扩展的 `xlsx` / UTF-8 `csv`；DOCX 仅解析正文、标题、列表和表格文本。表格默认按首个非空记录识别表头，支持文档级工作表/表头/列设置，保留工作表与来源行号；只读取已保存的值，不计算公式、执行宏或支持旧 `.xls`。用户授权的 PDF OCR 扩展仅识别无原生文字页，默认关闭，使用本地有界子进程；不扩展 DOCX 图片/OCR 范围。详细限制见 `05-rag-pipeline.md`。

## 后端分层约束

后端必须采用以下分层：

```text
handler -> service -> repository
```

职责：

1. `handler` 只处理 HTTP 参数、鉴权上下文、响应格式。
2. `service` 负责编排业务流程和事务边界。
3. `repository` 只负责数据库访问。
4. `provider` 负责外部模型调用。
5. `retrieval` 负责向量召回、Rerank 和检索管线。
6. `chat` 负责会话、消息和 RAG 问答。
7. `document` 负责解析、切片和文档处理任务。

禁止：

1. 禁止在 handler 中直接写 SQL。
2. 禁止在 handler 中直接调用模型 API。
3. 禁止业务代码绑定单一模型厂商。
4. 禁止聊天接口绕过知识库权限校验。

## Provider 抽象约束

模型能力必须通过接口抽象：

```go
type EmbeddingProvider interface {
    EmbedTexts(ctx context.Context, texts []string) ([][]float32, error)
}

type RerankProvider interface {
    Rerank(ctx context.Context, query string, documents []RerankDocument) ([]RerankResult, error)
}

type ChatProvider interface {
    Chat(ctx context.Context, messages []ChatMessage) (string, error)
}
```

MVP 默认实现 OpenAI-compatible HTTP Provider。业务层只能依赖接口，不能直接依赖具体 HTTP 实现。

## 权限约束

知识库归属与当前已实现的成员协作权限共同决定访问范围，具体能力矩阵、403/404 和回收站语义见 `04-api-design.md`「权限与能力矩阵」。

1. 所有知识库相关访问都必须检查 `knowledge_bases.owner_id` 归属；成员访问按 `knowledge_base_members.role` 和所需能力授权。
2. documents 和 document_chunks 操作必须校验所属知识库权限，不能只凭资源 ID 访问。
3. chat_sessions 操作同时校验 `chat_sessions.user_id` 和知识库权限；成员角色不能授予他人会话的访问权。
4. 权限由服务端逐次校验；前端 capabilities 和知识库公开标记不能代替授权。
5. 删除知识库时按当前 API 约定处理关联文档、切片、会话和存储清理，保留软删除与永久删除的区别。

## RAG 约束

Rerank 是标准链路，不是可选优化：

```text
最近历史 + 当前问题 -> 独立检索问题 -> Query Embedding -> pgvector TopN -> Rerank TopK -> Prompt -> LLM -> citations
```

默认参数：

```text
vectorTopN=30
rerankTopK=5
scoreThreshold=0.3
enableRerank=true
chatHistoryLimit=10
```

citations 只能来自最终进入 Prompt 的 rerank chunks。禁止引用未参与回答的 chunk。

聊天问答必须支持受限多轮上下文：

1. 默认使用最近 `CHAT_HISTORY_LIMIT=10` 条 `user` / `assistant` 消息。
2. 历史消息用于 Chat Provider 意图分类、改写独立检索问题，以及帮助模型理解当前追问。
3. 历史消息不能作为事实依据；事实依据必须来自本轮进入 Prompt 的 chunks。
4. citations 不能来自历史 assistant 消息。
5. 问候、询问上一句话、刚才说了什么等会话类问题应由 Chat Provider 分类为 `conversation`，程序据此跳过知识库检索，直接基于历史对话回答，并返回空 citations。
6. 意图分类结果解析失败时默认按 `knowledge_base` 处理，避免错误跳过知识库事实校验。

## 错误处理约束

所有 API 错误响应必须使用统一结构：

```json
{
  "code": "ERROR_CODE",
  "message": "用户可读错误信息",
  "details": {}
}
```

错误码定义见 `09-error-codes.md`。

## AI 开发执行规则

1. 以当前用户请求确定范围和验收结果，按实际依赖安排工作；功能维护与前后端联调使用当前代码和接口合同。
2. 开始时明确可验证的完成结果。在授权范围内连续完成实现、必要的运行检查、问题修复和文档同步；除非用户要求阶段评审，否则不在首版实现后默认停下。
3. 验证与改动范围匹配：先运行受影响包或文件的测试，跨模块影响或任务要求时再做全量检查。纯文档改动检查路径、命令来源和内容一致性；出现新改动、失败或未解决风险时再扩大或重复验证。
4. 默认本地测试使用 SQLite、临时文件、HTTP/API 替身和 jsdom；可直接运行、修复本次改动引起的失败并复测，无需逐步确认。后端 SQLite 测试需要 CGO 和 C 编译器，命令入口见根目录 `AGENTS.md`。
5. `RAG_TEST_POSTGRES_DSN` 和 `RAG_TEST_MINIO_*` 会启用真实服务测试并产生写入。运行前核实目标是本次任务授权使用的测试环境；这些测试不能按默认替身测试处理。具体入口见 `backend/internal/repository/postgres_concurrency_integration_test.go` 和 `backend/internal/storage/minio_integration_test.go`。`system_admin_postgres_integration_test.go` 复用独立 schema 和两个连接池，检查首管理员并发创建、提升只成功一次，结束后清理，不修改业务账号。`backend/internal/database/timestamp_integration_test.go` 与 `timestamp_migration_integration_test.go` 也使用该 PostgreSQL 开关：前者检查时间读写，后者仅对事务内临时表执行 023。`backend/internal/repository/chunk_keyword_postgres_integration_test.go` 在独立 schema 内验证关键词召回的 tsvector 匹配、排序与回填，SQLite 替身无法覆盖这部分。临时对象随事务结束或 schema 删除清理，不迁移业务表或启动后台 worker。repository 包的独立 schema 命名为 `rag_it_<UTC 时间戳>_<随机>`，连接带 `lock_timeout=5s`、`statement_timeout=60s`，挂起会变成带等待位置的失败；`go test` 超时中止时 `t.Cleanup` 不执行，下一次运行会删除早于 24 小时的同格式 schema，其他格式的 schema 不受影响。`chunk_vector_postgres_integration_test.go` 在独立 schema 内验证过滤后 HNSW 召回短缺时的精确检索回退。
6. doctor 访问配置的真实服务，migrate、seed 及启动后的后台 worker 可能写入数据。按用户已授权的环境和操作范围执行；只有目标、影响或必要授权仍不明确时才确认，并先完成可独立推进的准备工作。已有授权无需重复请求。
7. 修改公共 API、数据库结构、默认值或 RAG 行为时同步相关文档；更新 `12-handoff.md` 中的当前状态、有效待办和验证范围，历史实施过程由 Git 保留。
8. 交付时说明改动、验证结果和未满足的验收项；真实服务不可用等限制应明确记录，不能用替身测试结果宣称真实联调通过。

### 真实模型合同验证

`backend/internal/service/chat_provider_integration_test.go` 默认跳过。显式设置 `RAG_TEST_CHAT_PROVIDER=1`、`RAG_TEST_CHAT_BASE_URL`、`RAG_TEST_CHAT_API_KEY` 和逗号分隔的 `RAG_TEST_CHAT_MODELS` 后，在 backend 目录运行 `go test ./internal/service -run '^TestRealChatProviderRefusalContract$' -count=1 -v`。密钥只从环境读取，不写入命令、文档或提交。

此测试使用生产回答提示词和拒答处理器，向指定服务发送合成的有依据、资料不足和隐私骚扰问题，分别检查流式与非流式回答；不打开数据库。它会产生真实模型调用及可能的费用，只在任务已授权的目标上启用。结果仅证明所测模型与提示词的合同遵从，不替代完整检索、意图分类或设备验收。

`backend/internal/provider/rerank/real_provider_integration_test.go` 同样默认跳过。显式设置 `RAG_TEST_RERANK_PROVIDER=1`、`RAG_TEST_RERANK_BASE_URL`、`RAG_TEST_RERANK_API_KEY`、`RAG_TEST_RERANK_MODEL` 后，在 backend 目录运行 `go test ./internal/provider/rerank -run '^TestRealRerankProviderContract$' -count=1 -v`。仅向已授权的真实服务发送三组中英文合成问题及干扰文档，不打开数据库；检查目标文档首位、ID 完整且不重复、有限分数与降序结果。测试会产生真实调用和可能的费用，密钥仅从环境读取。样本通过不代表业务语料总体质量提升或阈值已校准；完整检索、Prompt 与 citations 链路需要独立验收。


`backend/internal/service/chat_grounding_integration_test.go` 使用同一组显式 `RAG_TEST_CHAT_*` 端点、密钥与模型设置，另设 `RAG_TEST_CHAT_GROUNDING=1` 后运行 `go test ./internal/service -run '^TestRealChatGroundingContract$' -count=1 -v`。默认跳过，不访问数据库；9 类合成依据问题各检查 JSON/SSE，共 18 次真实调用。覆盖部分依据、冲突与范围差异、文档指令、历史误导、补充提示词、严格建议边界与常识标注。断言检查关键内容并接受等价资料不足措辞，输出仍需人工审读；不将词面匹配视为事实证明。运行范围与费用授权遵循上述真实模型边界。

MinIO 集成测试同时覆盖 multipart 和 UTF-8 文本 Reader 的真实存取、字节数与删除；必须显式指定本次测试 bucket，不能对业务 bucket 做清空操作。2026-09-29 的隔离环境与浏览器验收见 [回答依据与实际使用验收](20-grounding-acceptance.md)。
