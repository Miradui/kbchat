# 项目目录结构

## 总体结构

```text
rag/
├── backend/
├── frontend/
├── deploy/
├── docs/
└── README.md
```

## 后端结构

```text
backend/
├── cmd/
│   └── server/
│       └── main.go
├── internal/
│   ├── auth/
│   ├── chat/
│   ├── config/
│   ├── document/
│   │   ├── parser/
│   │   ├── processor/
│   │   └── splitter/
│   ├── dto/
│   ├── embedding/
│   ├── handler/
│   ├── job/
│   ├── middleware/
│   ├── model/
│   ├── provider/
│   │   ├── chat/
│   │   ├── embedding/
│   │   └── rerank/
│   ├── repository/
│   ├── retrieval/
│   ├── router/
│   ├── service/
│   └── storage/
├── migrations/
├── uploads/
├── go.mod
└── go.sum
```

## 前端结构

```text
frontend/
├── src/
│   ├── api/
│   ├── components/
│   ├── hooks/
│   ├── layouts/
│   ├── pages/
│   │   ├── Login/
│   │   ├── KnowledgeBase/
│   │   ├── Documents/
│   │   └── Chat/
│   ├── router/
│   ├── store/
│   ├── types/
│   ├── utils/
│   ├── App.tsx
│   └── main.tsx
├── package.json
└── vite.config.ts
```

## 部署结构

```text
deploy/
└── docker-compose.yml
```

Docker Compose 需要包含：

```text
postgres with pgvector
redis
```

## 模块职责

| 目录 | 职责 |
| --- | --- |
| `auth` | 密码、JWT、当前用户 |
| `chat` | 会话、消息、问答编排 |
| `document` | 解析、切片、文档处理 |
| `embedding` | Embedding 业务接口 |
| `provider` | 外部模型 HTTP 实现 |
| `retrieval` | pgvector 召回、Rerank、排序 |
| `storage` | 本地 / MinIO S3 文件保存、读取、物化和删除 |
| `job` | 后台任务和 worker |

## AI 开发约束

1. 不要把所有代码堆在 `main.go`。
2. 不要新增与文档不一致的顶层目录。
3. 不要把 provider 实现写进 service。
4. 不要把前端页面全部写进 `App.tsx`。
5. 后续如需新增目录，必须能说明职责，并保持分层清晰。
