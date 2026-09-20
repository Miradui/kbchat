# 系统架构

项目采用 Gin 单体后端和 React 前端。目录总览与启动命令见根目录 README；本文件维护模块职责、调用关系和权限边界。

## 总体架构

```text
React Frontend
    | HTTP JSON / Multipart / SSE
    v
Gin Backend
    |-- PostgreSQL + pgvector
    |-- Redis
    |-- Document Storage (Local / MinIO S3)
    |-- Embedding / Rerank / Chat / Title Providers
```

## 后端目录与职责

以下路径相对仓库根目录。新代码按职责进入现有模块，HTTP 层保持 `handler -> service -> repository`。

| 目录 | 职责 |
| --- | --- |
| `backend/cmd` | server、doctor、migrate、seed 命令入口；入口负责组装依赖 |
| `backend/internal/config` | 环境配置加载与校验 |
| `backend/internal/database`、`backend/internal/cache` | GORM 数据库；Redis 连接、固定窗口计数与 query embedding 二进制缓存 |
| `backend/internal/router`、`backend/internal/middleware` | 路由、JWT、可信代理 IP 解析、限流、请求日志与跨域处理 |
| `backend/internal/handler`、`backend/internal/dto` | HTTP 入参、校验和响应结构 |
| `backend/internal/service` | 业务编排、权限调用与事务边界，包括文档、聊天、评测和工作台 |
| `backend/internal/repository`、`backend/internal/model` | GORM 数据访问、持久化模型；不调用模型 Provider |
| `backend/internal/auth` | 密码与 JWT |
| `backend/internal/access`、`backend/internal/authz` | 角色能力矩阵与共享知识库授权 |
| `backend/internal/document` | parser、splitter、lexer、processor：解析、切片、关键词分词与文档处理 |
| `backend/internal/embedding`、`backend/internal/rerank`、`backend/internal/chat`、`backend/internal/title` | 模型能力接口及相关值类型 |
| `backend/internal/provider` | Chat、Embedding、Rerank、Title 的 HTTP 实现 |
| `backend/internal/retrieval` | 向量召回、关键词召回、RRF 融合、Rerank、阈值过滤和检索管线 |
| `backend/internal/storage` | 本地 / MinIO 文件保存、读取、物化和删除 |
| `backend/internal/job` | 后台任务领取、执行与重试 |
| `backend/internal/logger`、`backend/internal/observability` | zap 日志、进程内指标和可公开的失败分类 |
| `backend/internal/apperror` | 统一业务错误 |
| `backend/migrations` | PostgreSQL 结构与数据迁移 |

## 前端目录与职责

| 目录 | 职责 |
| --- | --- |
| `frontend/src/router`、`frontend/src/layouts` | 路由、应用外壳与账户设置 |
| `frontend/src/pages` | 页面级数据和交互编排 |
| `frontend/src/components` | 复用 UI、反馈和跨页面组件 |
| `frontend/src/api`、`frontend/src/types` | HTTP/SSE/上传客户端与 API 类型 |
| `frontend/src/store` | 用户、主题、token 与系统能力状态 |
| `frontend/src/utils`、`frontend/src/styles` | 通用工具和样式 |
| `frontend/src/test` | 测试环境和渲染辅助；行为测试与对应实现放在一起 |

页面与深链接约定见 `10-frontend-spec.md`，不把页面实现集中到 `App.tsx`。`deploy/docker-compose.yml` 提供本地 PostgreSQL/pgvector 与 Redis，生产部署见 `13-deployment.md`。

## 请求流

普通业务请求：

```text
React -> Gin Router -> Middleware -> Handler -> Service -> Repository -> PostgreSQL
```

文档上传请求：

```text
React -> Upload API -> Storage (Local / MinIO) -> documents -> document_jobs -> Worker
```

MinIO bucket 保持私有。下载和预览经过 JWT 与知识库能力校验的后端 API，不向前端暴露对象地址。`documents.storage_path` 使用 `minio://bucket/key` 标识远端对象；历史本地路径继续由 `UPLOAD_DIR` 读取。远端对象解析时物化到受限临时文件，完成后清理。

问答请求：

```text
React -> Chat API -> 会话归属与知识库能力校验 -> 最近历史
      -> Chat Provider 输出 intent 和 standaloneQuery
      -> conversation：基于历史回答，citations=[]
      -> knowledge_base：Redis query embedding cache -> Embedding Provider（miss / error）
                         -> pgvector TopN -> 关键词召回 -> RRF -> Rerank TopK
                         -> Prompt（系统约束 + 最近历史 + 本轮 chunks）
                         -> Chat Provider -> 保存消息 -> answer 和 citations
```

登录在进入 Auth handler 前按可信客户端 IP 限流；普通发送、流式发送和重新生成在 JWT 鉴权后按用户 ID 共用限额。Redis 故障策略只决定限流是放行还是返回 503，查询向量缓存始终降级到 Provider。

流式协议见 `04-api-design.md` 的聊天消息接口；Rerank 关闭或显式降级时的排序、阈值和引用规则见 `05-rag-pipeline.md`。

## Provider 边界

业务层依赖能力接口，接口签名直接以源码为准：

| 能力 | 接口文件 | 默认实现 |
| --- | --- | --- |
| Embedding | `backend/internal/embedding/provider.go` | `backend/internal/provider/embedding/openai.go` |
| Rerank | `backend/internal/rerank/provider.go` | `backend/internal/provider/rerank/openai.go` |
| Chat | `backend/internal/chat/provider.go` | `backend/internal/provider/chat/openai.go` |
| Title | `backend/internal/title/title.go` | `backend/internal/provider/title/openai.go` |

Chat、Embedding 和 Title 使用 `github.com/sashabaranov/go-openai` 调用兼容 API；供应商扩展 `/rerank` 由独立 Provider 实现。Provider 不依赖 handler 或 Gin。

## 异步任务

- `documents.status` 记录用户可见状态，`document_jobs` 记录后台处理、租约和重试；后端 worker 从数据库领取任务。
- 存储永久清理通过持久化任务重试；评测运行由后台执行并记录进度与取消状态。持久化结构见 `03-database-design.md`。
- Redis 承担登录 / 聊天固定窗口计数和 query embedding 缓存；这些数据允许过期或在故障时按配置降级，持久任务状态仍保存在 PostgreSQL。
- 启动 server 会启动后台处理，真实环境操作边界见 `00-ai-development-guide.md`。

## 权限边界

1. 知识库所有者由 `knowledge_bases.owner_id` 确定；成员角色由 `knowledge_base_members.role` 确定。所有相关请求按所需能力校验，矩阵与 403/404 语义见 `04-api-design.md`。
2. `backend/internal/access` 定义角色和能力，`backend/internal/authz` 提供 service 与 retrieval 共享的授权判断；列表查询同时限定当前调用者可访问的资源。
3. 文档、切片、检索和质量运营沿所属知识库校验；聊天会话及消息还必须满足 `chat_sessions.user_id` 为当前用户。
4. `visibility=public` 只影响展示和筛选，不能让非成员访问资源；前端 capabilities 只控制展示，不能替代服务端鉴权。
5. 删除、恢复和永久清理按各资源对应能力处理；知识库回收站保持 owner 范围，不能统一替换为宽泛的成员权限。

## 模块边界

- 业务数据库访问使用 GORM，经 repository 执行；handler 不直接访问数据库或模型。
- 聊天的知识检索复用 retrieval 管线，引用只来自本轮进入 Prompt 的片段。
- 保持单体应用和明确模块职责，新增目录应有实际职责和调用方。
