# 知汇

[![CI](https://github.com/Miradui/kbchat/actions/workflows/ci.yml/badge.svg)](https://github.com/Miradui/kbchat/actions/workflows/ci.yml)

知汇是一个中文知识库与 AI 问答工作台。上传资料后，系统完成解析、切片、向量化和检索精排，回答可以追溯到实际使用的原文片段。

后端使用 Go、Gin、GORM、PostgreSQL / pgvector、Redis 和 JWT；前端使用 React、TypeScript 和 Vite。对话、标题、Embedding 与 Rerank 通过独立 Provider 接口接入。

## 已有功能

- **知识管理**：知识库、树形分类、多标签、收藏、最近浏览、批量操作与回收站。
- **文档处理**：TXT、Markdown、PDF、DOCX 上传，后台任务进度，重复内容提示、版本替换、预览、下载、重新处理和内容片段定位。
- **检索与问答**：pgvector 向量召回与关键词召回融合、Rerank 精排、多轮问答、流式输出、首问自动命名、回答版本切换、原文引用和会话导出。
- **搜索**：跨知识库查找名称、文件和内容片段，支持键盘建议、命令面板（`Ctrl+K` / `⌘K`）与 CSV 导出。
- **质量运营**：回答反馈、知识缺口、测试问题集、批量回归评测、运行记录和配置对比。
- **账户与协作**：资料与密码设置、头像上传、知识库所有者 / 管理员 / 编辑成员 / 只读成员，以及系统诊断。
- **系统管理**：系统管理员可创建、禁用/启用用户、重置密码和调整系统管理员角色；质量页提供模型 token 用量统计，知识库可定制回答配置。
- **运行保护**：Redis 登录 IP / 聊天用户限流、query embedding 缓存，以及缓存命中率和限流触发诊断。

公开/私有标记目前用于展示；将知识库设为公开不会自动授予其他用户访问权限。多租户、SSO、复杂 RBAC、审计日志及非 MinIO 的对象存储不在当前范围内。DOCX 仅解析正文、标题、列表和表格文本，不处理图片、公式、文本框、OCR 或旧式 `.doc`。

## 本地启动

需要 Go **1.25**（版本以 [`backend/go.mod`](backend/go.mod) 为准）、Node.js **22.13+（22 LTS）或 24 LTS**、npm、PostgreSQL **16 + pgvector** 和 Redis **7**。后端部分测试使用 SQLite，需要启用 CGO 并安装可用的 C 编译器；Windows 可使用 MinGW-w64 GCC。

下面的命令从仓库根目录开始，示例使用 PowerShell。

### 1. 准备配置和基础服务

首次配置时复制示例文件；已有 `.env` 时直接编辑现有文件。

```powershell
git clone https://github.com/Miradui/kbchat.git
cd kbchat
Copy-Item .env.example .env
docker compose -f deploy/docker-compose.yml up -d
```

Compose 只启动 PostgreSQL / pgvector 和 Redis；前后端在下面分别启动。Compose 中的数据库账号仅用于本地开发，与 `.env.example` 对应。

编辑根目录 `.env`，配置以下项目：

| 配置 | 用途 |
| --- | --- |
| `DATABASE_URL`、`REDIS_ADDR` | 数据库与缓存；使用现有服务时修改连接地址 |
| `RATE_LIMIT_*`、`TRUSTED_PROXY_CIDRS`、`EMBEDDING_CACHE_TTL` | 登录 / 聊天限流、可信反向代理和查询向量缓存 |
| `JWT_SECRET` | 替换占位值，使用密码学安全随机源生成至少 32 字节的密钥 |
| `CHAT_BASE_URL`、`CHAT_API_KEY`、`CHAT_MODEL` | 对话及检索意图处理 |
| `EMBEDDING_BASE_URL`、`EMBEDDING_API_KEY`、`EMBEDDING_MODEL` | 文档和问题向量化，输出维度必须为 `1536` |
| `RERANK_ENABLED`、`RERANK_BASE_URL`、`RERANK_API_KEY`、`RERANK_MODEL` | 标准检索链路中的精排服务 |
| `TITLE_BASE_URL`、`TITLE_API_KEY`、`TITLE_MODEL` | 可选的首问标题提炼；不可用时保留首问摘要 |

模型地址、密钥和模型名称需换成实际服务的配置，示例占位值不能直接运行模型调用。Rerank 服务必须支持 `/rerank` 接口；普通对话 API 地址不一定提供该接口。

`.env` 只保存在本地，不应提交。完整参数及默认值见 [环境配置](docs/08-env-config.md)。

### 2. 启动后端

```powershell
cd backend
go mod download
go run ./cmd/migrate
go run ./cmd/seed
go run ./cmd/bootstrap-admin -username admin
go run ./cmd/doctor
go run ./cmd/server
```

默认 API 地址为 `http://127.0.0.1:8080/api/v1`，健康检查为 `http://127.0.0.1:8080/healthz`。

seed 创建普通系统用户，本地默认账号为 `admin` / `123456`；账号名称本身不赋予管理员权限。可在运行 seed 前通过 `SEED_USERNAME`、`SEED_PASSWORD`、`SEED_DISPLAY_NAME` 设置账号，遇到同名账号会跳过且不重置密码。

`bootstrap-admin -username admin` 将明确指定的现有账号提升为首位系统管理员，保留密码与资料；使用自定义 seed 用户名时替换命令中的 `admin`。同一管理员重复执行不会修改账号，已有其他管理员时拒绝再初始化。诊断接口仅系统管理员可用，知识库协作角色独立判定。

生产首次部署可跳过 seed，直接创建首位管理员：在进程环境中设置 `BOOTSTRAP_ADMIN_PASSWORD` 为强密码，可选设置 `BOOTSTRAP_ADMIN_DISPLAY_NAME`，再运行 `go run ./cmd/bootstrap-admin -username <指定账号> -create`。密码至少 8 个字符、最多 72 个 UTF-8 字节；命令不会覆盖现有普通账号。初始化只在运维 CLI 提供，详见 [部署指南](docs/13-deployment.md#74-初始化系统管理员)。

首次部署的账号流程只需要执行一次 `bootstrap-admin`：之后用该管理员登录，在「系统 → 用户管理」（`/admin/users`）创建其余账号、禁用/启用账号、重置密码和授予/撤销系统管理员，不再需要 seed 或直接操作数据库。创建和重置密码得到的密码只显示一次；系统不允许禁用或降级最后一位启用的管理员，管理员也不能在该页面禁用、降级自己或重置自己的密码（改自己的密码走账户设置）。禁用账号后，其已登录会话在下一次请求即失效。

文档处理、评测和存储清理任务随后端进程运行。处理并发及重试由 `WORKER_CONCURRENCY`、`WORKER_MAX_RETRIES`、`WORKER_RETRY_DELAY` 等参数控制。

### 3. 启动前端

打开另一个终端，从仓库根目录执行：

```powershell
cd frontend
npm ci
npm run dev -- --host 127.0.0.1 --port 5173
```

浏览器访问 [知汇本地工作台](http://127.0.0.1:5173)。开发服务器将 `/api` 代理到 `http://localhost:8080`，默认无需设置 `VITE_API_BASE_URL`。

前后端分开部署时，在前端启动或构建环境中设置 `VITE_API_BASE_URL`，并在后端设置匹配的 `CORS_ALLOWED_ORIGINS`。根目录 `.env` 由后端读取，Vite 不会自动读取它；模型密钥不应放入任何 `VITE_*` 变量。

## 检索与存储约定

```text
上传 → 解析 → 切片 → Embedding + 关键词词元 → pgvector
提问 → 意图识别与问题改写 → 向量召回 + 关键词召回 → RRF 融合 → Rerank → Prompt → 流式回答与引用
```

- 默认召回 `30` 条、精排保留 `5` 条，最低相关度 `0.3`。历史对话帮助理解追问，事实依据来自本轮进入 Prompt 的片段。
- 关键词召回默认开启（`KEYWORD_SEARCH_ENABLED`，知识库可单独关闭），用后端分词器生成中文二元组与精确词元，不依赖 PostgreSQL 中文分词扩展；升级到迁移 `024` 后需运行一次 `go run ./cmd/reindex-keywords` 回填既有片段。
- 引用只允许来自实际进入 Prompt 的最终片段。Rerank 默认启用；`RERANK_FAILURE_MODE=strict` 在精排失败时返回错误，显式选择 `fallback` 才允许按向量顺序降级并标明状态。
- 查询向量按模型和规范化问题缓存到 Redis，默认保存 24 小时；命中时跳过 Embedding Provider，Redis 缓存故障自动回退为直接调用。
- 文件默认保存在后端本地 `uploads`。使用 MinIO 时设置 `STORAGE_PROVIDER=minio` 和 `MINIO_*`，bucket 必须保持私有，预览和下载通过鉴权 API。
- 永久删除先登记持久化清理任务，再异步移除文件。重新处理会在新向量全部成功并提交后替换旧片段。
- SQL 迁移位于 `backend/migrations/`。已有环境升级应按迁移说明执行；指定单个文件可使用 `go run ./cmd/migrate -migration 024_hybrid_search.sql -timeout 30m`（`-timeout` 默认 30 秒，索引构建按数据量放宽）。

## 测试与 CI

[GitHub Actions CI](.github/workflows/ci.yml) 在 push、pull request 或手动触发时运行两个独立任务，并取消同一引用上过期的运行：

| 任务 | 检查内容 |
| --- | --- |
| Backend | 根据 `go.mod` 安装 Go，启用 CGO，缓存依赖，执行 `go vet`、全量测试和构建 |
| Frontend | 使用 Node.js 22，缓存 npm 依赖，执行 `npm ci`、全量测试、TypeScript 检查、Vite 构建及 11 项路由分包检查 |

CI 使用单元测试中的数据库和 Provider 替身，不需要生产密钥。真实 PostgreSQL、Redis、存储、模型调用及浏览器联调仍需在集成环境验证。

本地检查：

```powershell
cd backend
go vet ./...
go test ./...
go build ./...

cd ../frontend
npm ci
npm test
npm run build
```

## 目录与文档

```text
backend/    API、业务服务、GORM 仓储、Provider、后台任务和 SQL 迁移
frontend/   React 页面、组件、API 客户端和前端测试
docs/       产品、架构、接口、部署和交接文档
deploy/     本地基础服务 Compose
.github/    GitHub Actions 工作流
```

| 需要了解 | 文档 |
| --- | --- |
| 当前实现与交接 | [跨会话交接](docs/12-handoff.md) · [功能优化计划](docs/17-improvement-plan.md) · [前端改进计划](docs/18-frontend-improvement-plan.md) |
| 产品与架构 | [PRD](docs/01-prd.md) · [系统架构](docs/02-architecture.md) |
| 数据与接口 | [数据库设计](docs/03-database-design.md) · [API 设计](docs/04-api-design.md) · [错误码](docs/09-error-codes.md) |
| 检索行为 | [RAG 链路](docs/05-rag-pipeline.md) |
| 前端与交互 | [前端规范](docs/10-frontend-spec.md) · [交互巡检](docs/16-interaction-review.md) |
| 环境与部署 | [环境配置](docs/08-env-config.md) · [部署运维](docs/13-deployment.md) |
| 开发约定 | [项目指令](AGENTS.md) · [AI 开发规范](docs/00-ai-development-guide.md) |

后端遵循 `handler → service → repository`，数据库访问使用 GORM，模型调用通过 Provider 接口。API 字段采用 camelCase，数据库字段采用 snake_case；知识库访问必须经过所有权及成员权限校验。修改公共接口、schema、默认值或 RAG 行为时，同步更新相关文档。
