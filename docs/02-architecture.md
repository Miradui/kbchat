# 系统架构

## 总体架构

```text
React Frontend
    |
    | HTTP JSON / Multipart
    v
Gin Backend
    |
    |-- PostgreSQL + pgvector
    |-- Redis
    |-- Local File Storage
    |-- Embedding Provider
    |-- Rerank Provider
    |-- Chat Provider
```

## 后端模块

```text
cmd/server       应用入口
config           配置加载
router           路由注册
middleware       JWT、日志、错误处理
handler          HTTP 入参和响应
service          业务编排
repository       数据库访问
model            数据库模型
dto              请求和响应结构
auth             登录、密码、JWT
document         文档解析、切片、处理任务
embedding        Embedding 服务抽象
retrieval        向量召回、Rerank、检索管线
chat             会话、消息、RAG 问答
provider         模型 Provider 实现
storage          文件存储
job              数据库任务表和 worker
```

## 请求流

普通业务请求：

```text
React -> Gin Router -> Middleware -> Handler -> Service -> Repository -> PostgreSQL
```

文档上传请求：

```text
React -> Upload API -> Local Storage -> documents -> document_jobs -> Worker
```

问答请求：

```text
React
-> Chat API
-> 校验 session 和 knowledge_base 权限
-> 读取当前会话最近历史消息
-> Chat Provider 输出 intent 和 standaloneQuery
-> conversation：基于历史直接回答，citations=[]
-> knowledge_base：使用 standaloneQuery 进入 RAG
-> Query Embedding
-> pgvector TopN
-> Rerank TopK
-> Prompt（系统约束 + 最近历史 + 本轮 TopK chunks）
-> Chat Provider
-> 保存消息
-> 返回 answer 和 citations
```

## Provider 接口

业务层必须依赖接口：

```go
type EmbeddingProvider interface {
    EmbedTexts(ctx context.Context, texts []string) ([][]float32, error)
}

type RerankDocument struct {
    ID      string
    Content string
}

type RerankResult struct {
    ID    string
    Score float64
}

type RerankProvider interface {
    Rerank(ctx context.Context, query string, documents []RerankDocument) ([]RerankResult, error)
}

type ChatMessage struct {
    Role    string
    Content string
}

type ChatProvider interface {
    Chat(ctx context.Context, messages []ChatMessage) (string, error)
}
```

MVP 默认使用 OpenAI-compatible HTTP API 实现以上接口。

## 异步任务设计

MVP 使用数据库任务表加后端 worker：

```text
documents.status 记录用户可见状态
document_jobs 记录后台任务状态和重试次数
worker goroutine 轮询 pending jobs
```

Redis 第一版用于缓存任务状态或后续扩展，不强制作为主队列。

## 权限边界

所有业务对象最终都必须回到知识库权限：

```text
knowledge_bases.owner_id = currentUser.id
```

检查对象：

1. knowledge_bases。
2. documents。
3. document_chunks。
4. chat_sessions。
5. chat_messages。

## AI 开发约束

1. 不要让 provider 层依赖 handler 或 Gin。
2. 不要让 repository 调用模型接口。
3. 不要让 chat 模块绕过 retrieval 模块直接查 chunks。
4. 不要引入复杂微服务拆分；MVP 是单体应用。
