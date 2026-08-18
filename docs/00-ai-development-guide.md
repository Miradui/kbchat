# AI 开发总规范

本文档是企业知识库问答系统的最高优先级开发规范。后续使用 AI 生成代码时，必须先阅读本文档，再阅读对应模块文档。

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
6. docx 解析。
7. 计费和额度系统。

## 技术约束

1. 后端使用 Gin。
2. 数据库使用 PostgreSQL。
3. 向量存储使用 pgvector。
4. Redis 用作缓存、任务状态辅助和后续队列扩展点。
5. 前端使用 React。
6. 文件存储支持本地 `uploads` 与 MinIO S3；MinIO bucket 保持私有，访问必须经过后端权限校验。
7. 异步任务第一版采用数据库任务表加后端 worker。
8. 文档解析 MVP 只支持 `txt`、`md`、`pdf`。

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

MVP 使用单租户用户私有知识库：

1. 用户只能访问自己创建的知识库。
2. 所有 documents 操作必须通过 `knowledge_base.owner_id` 校验。
3. 所有 document_chunks 操作必须通过 `knowledge_base.owner_id` 校验。
4. 所有 chat_sessions 操作必须通过 `knowledge_base.owner_id` 和 `chat_sessions.user_id` 校验。
5. 删除知识库必须级联处理文档、切片和会话数据。

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

1. 按 `11-ai-task-prompts.md` 的任务顺序开发。
2. 每次只实现当前任务，不提前实现后续模块。
3. 每个任务必须满足对应验收标准。
4. 修改接口、字段或默认参数时，必须同步更新相关文档。
5. 新增代码必须遵守目录结构和分层约束。
6. 不允许生成与 MVP 无关的大型框架或复杂平台能力。
