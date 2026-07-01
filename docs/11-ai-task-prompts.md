# AI 任务拆分

本文档用于把项目拆成可交给 AI 逐步执行的任务。每次开发只执行一个任务，完成验收后再进入下一个任务。

## 任务 1：初始化后端工程

目标：

创建 Gin 后端基础工程。

输入文档：

```text
00-ai-development-guide.md
02-architecture.md
06-project-structure.md
08-env-config.md
```

输出：

```text
backend/cmd/server/main.go
backend/internal/config
backend/internal/router
backend/internal/middleware
backend/go.mod
```

禁止：

1. 不实现业务模块。
2. 不实现 RAG。
3. 不创建前端代码。

验收：

```text
后端可启动
健康检查接口可访问
配置可从环境变量读取
```

## 任务 2：初始化前端工程

目标：

创建 React 前端基础工程和路由框架。

输入文档：

```text
06-project-structure.md
10-frontend-spec.md
```

输出：

```text
frontend/src/App.tsx
frontend/src/main.tsx
frontend/src/router
frontend/src/api
frontend/package.json
```

禁止：

1. 不实现复杂 UI。
2. 不写 mock 后端逻辑。

验收：

```text
前端可启动
路由可进入登录页
API client 支持 token 注入
```

## 任务 3：Docker Compose 与数据库设计落地

目标：

创建 PostgreSQL、pgvector、Redis 的本地开发环境和数据库 migration。

输入文档：

```text
03-database-design.md
08-env-config.md
```

输出：

```text
deploy/docker-compose.yml
backend/migrations
```

禁止：

1. 不改 embedding 维度。
2. 不引入多租户表。

验收：

```text
PostgreSQL 启动后 pgvector 可用
所有 MVP 表可创建
索引可创建
```

## 任务 4：登录鉴权

目标：

实现账号密码登录、JWT 鉴权、当前用户接口。

输入文档：

```text
04-api-design.md
09-error-codes.md
10-frontend-spec.md
```

输出：

```text
backend/internal/auth
backend/internal/handler auth
backend/internal/middleware jwt
frontend/src/pages/Login
```

禁止：

1. 不实现 SSO。
2. 不实现复杂 RBAC。

验收：

```text
正确账号密码登录成功
错误账号密码返回错误
受保护接口无 token 返回 UNAUTHORIZED
前端登录成功后进入知识库列表
```

## 任务 5：知识库 CRUD

目标：

实现用户私有知识库管理。

输入文档：

```text
03-database-design.md
04-api-design.md
10-frontend-spec.md
```

输出：

```text
backend/internal/handler knowledge_base
backend/internal/service knowledge_base
backend/internal/repository knowledge_base
frontend/src/pages/KnowledgeBase
```

禁止：

1. 不实现共享知识库。
2. 不实现组织权限。

验收：

```text
用户只能管理自己的知识库
CRUD API 可用
前端可创建、编辑、删除、查看知识库
```

## 任务 6：文档上传

目标：

实现文档上传、本地保存、文档记录和任务创建。

输入文档：

```text
03-database-design.md
04-api-design.md
05-rag-pipeline.md
10-frontend-spec.md
```

输出：

```text
backend/internal/storage
backend/internal/document
backend/internal/job
frontend/src/pages/Documents
```

禁止：

1. 不支持 docx。
2. 不把文件内容写入数据库。

验收：

```text
可上传 txt、md、pdf
上传后创建 documents 记录
上传后创建 document_jobs 记录
前端显示文档状态
```

## 任务 7：文档处理任务

目标：

实现数据库任务表 worker 和文档状态流转。

输入文档：

```text
02-architecture.md
05-rag-pipeline.md
07-milestones.md
```

输出：

```text
backend/internal/job
backend/internal/document/processor
```

禁止：

1. 不使用复杂分布式队列。
2. 不跳过 failed 状态处理。

验收：

```text
worker 能领取 pending job
状态按 parsing、chunking、embedding、completed 流转
失败时写入 error_message
```

## 任务 8：切片与 Embedding

目标：

实现文档解析、切片、Embedding 入库。

输入文档：

```text
05-rag-pipeline.md
08-env-config.md
03-database-design.md
```

输出：

```text
backend/internal/document/parser
backend/internal/document/splitter
backend/internal/embedding
backend/internal/provider/embedding
```

禁止：

1. 不修改默认 embedding 维度 1536。
2. 不支持 docx。

验收：

```text
txt、md、pdf 可解析
chunkIndex 稳定递增
chunks 写入 document_chunks
embedding 维度为 1536
```

## 任务 9：向量检索与 Rerank

目标：

实现 search API、pgvector TopN 和 Rerank TopK。

输入文档：

```text
04-api-design.md
05-rag-pipeline.md
08-env-config.md
```

输出：

```text
backend/internal/retrieval
backend/internal/provider/rerank
backend/internal/handler search
```

禁止：

1. 不跨知识库检索。
2. 不跳过 Rerank。

验收：

```text
默认 vectorTopN=30
默认 rerankTopK=5
返回 vectorScore 和 rerankScore
结果按 rerankScore 排序
```

## 任务 10：聊天问答与引用来源

目标：

实现会话、消息、RAG 问答和 citations。

输入文档：

```text
04-api-design.md
05-rag-pipeline.md
09-error-codes.md
```

输出：

```text
backend/internal/chat
backend/internal/provider/chat
frontend/src/pages/Chat
```

禁止：

1. 不编造 citations。
2. 不引用未进入 Prompt 的 chunks。
3. 不把历史 assistant 消息当作事实依据。
4. 不把无限历史直接塞进 Prompt。

验收：

```text
用户可创建会话并发送消息
多轮追问会读取最近 CHAT_HISTORY_LIMIT 条历史消息
Chat Provider 会先输出 intent 和 standaloneQuery
conversation 问题跳过知识库检索并返回空 citations
knowledge_base 问题使用 standaloneQuery 检索
系统返回 answer 和 citations
assistant 消息保存 citations
citations 只来自本轮进入 Prompt 的 chunks
无相关内容时不编造答案
```

## 任务 11：前端页面联调

目标：

完成登录、知识库、文档和聊天页面的端到端联调。

输入文档：

```text
10-frontend-spec.md
04-api-design.md
09-error-codes.md
```

输出：

```text
frontend/src/pages
frontend/src/api
frontend/src/types
```

禁止：

1. 不用假数据替代真实 API。
2. 不隐藏后端错误信息。

验收：

```text
登录到问答完整链路可操作
文档状态轮询正常
聊天页展示 citations
401 自动回登录页
```

## 任务 12：MVP 验收修复

目标：

修复端到端流程中的缺陷，补充 README 和基础测试。

输入文档：

```text
所有 docs 文档
```

输出：

```text
README.md
基础测试
必要修复
```

禁止：

1. 不扩展 MVP 之外的大功能。
2. 不重构已通过验收的模块，除非修复缺陷需要。

验收：

```text
新环境可启动
上传文档到聊天问答闭环可演示
错误响应格式一致
权限校验有效
Rerank 和 citations 正常
```
