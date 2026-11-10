# 知汇

[![CI](https://github.com/Miradui/kbchat/actions/workflows/ci.yml/badge.svg)](https://github.com/Miradui/kbchat/actions/workflows/ci.yml)

知汇是一个支持自行部署的中文知识库与 AI 问答工作台，适合整理团队文档、制度流程、技术资料和常见问题。上传资料后，系统自动解析内容并建立检索索引，用户可以用自然语言提问，通过回答中的引用回到原文核对依据。

项目采用 RAG（检索增强生成）：先从知识库中检索相关内容并精排，再将选中的片段交给模型生成回答。对话、Embedding、Rerank 和标题生成通过独立的 Provider 接口接入模型服务。

## 核心功能

- **知识管理**：知识库、分类、标签、成员协作、收藏和回收站。
- **文档入库**：支持 TXT、Markdown、PDF、DOCX、XLSX、CSV，以及粘贴文本、文件夹和 ZIP 批量导入；提供处理进度、版本替换、文本对比和原文预览。
- **检索问答**：向量与关键词混合检索、Rerank 精排、多轮流式对话和原文引用；支持自动跨库检索，也可限定知识库或文档范围。
- **回答定制**：知识库回答提示词编辑，内置通用问答、制度流程、技术支持、客服答复和资料总结五个模板，支持保存后试问。
- **质量评估**：回答反馈、知识缺口跟进、测试问题集、批量回归评测和结果对比。
- **账号管理**：登录、个人设置、用户管理，以及知识库所有者、管理员、编辑和只读成员权限。

DOCX 支持正文、标题、列表和表格文本，不支持图片、公式、文本框及旧式 `.doc`；表格支持 XLSX 和 UTF-8 CSV，不支持 `.xls`。扫描 PDF 的 OCR 默认关闭，需要另外安装 Poppler、Tesseract 和语言包，详见[部署指南](docs/13-deployment.md)。

## 技术栈

| 层次 | 技术 |
| --- | --- |
| 前端 | React 19、TypeScript、Vite 7 |
| 后端 | Go、Gin、GORM、JWT |
| 数据与检索 | PostgreSQL、pgvector、关键词检索、Rerank |
| 缓存与限流 | Redis |
| 文件存储 | 本地文件系统或 MinIO |

```text
资料上传 → 解析与切片 → Embedding → 存储文档与检索索引
用户提问 → 向量 / 关键词召回 → Rerank 精排 → 模型生成 → 流式回答与原文引用
```

详细设计见[系统架构](docs/02-architecture.md)与 [RAG 链路](docs/05-rag-pipeline.md)。

## 环境要求

| 依赖 | 要求 |
| --- | --- |
| Go | 1.25.0 或更新版本，以 [go.mod](backend/go.mod) 为准 |
| Node.js / npm | Node.js 22.13+（22 LTS）或 24 LTS，使用 npm 安装依赖 |
| PostgreSQL | 16，安装 pgvector 扩展；下方 Compose 已包含 |
| Redis | 7；下方 Compose 已包含 |
| Docker / Docker Compose | 用于启动本地数据库和 Redis；使用已有服务时可跳过 |
| 模型服务 | 可用的 Chat、Embedding 和 Rerank 服务地址、密钥与模型名称 |

后端的 SQLite 测试还需要启用 CGO 并安装 C 编译器，Windows 可使用 MinGW-w64 GCC。

## 安装与本地运行

以下命令使用 PowerShell。首次安装从克隆仓库开始；已经克隆的项目直接进入仓库根目录。

### 1. 获取项目并准备配置

```powershell
git clone https://github.com/Miradui/kbchat.git
cd kbchat
Copy-Item .env.example .env
```

仅首次配置时复制文件；已有 `.env` 时直接编辑，避免覆盖现有配置。根目录 `.env` 由后端读取，不应提交到 Git。

### 2. 启动数据库和 Redis

在仓库根目录执行：

```powershell
docker compose -f deploy/docker-compose.yml up -d
docker compose -f deploy/docker-compose.yml ps
```

等待 PostgreSQL 和 Redis 显示为健康状态后继续。Compose 只启动这两个基础服务，数据库默认连接信息与 `.env.example` 对应，仅用于本地开发。使用已有服务时，修改相应连接配置即可。

### 3. 配置模型服务

编辑根目录 `.env`，核对以下配置：

| 配置项 | 说明 |
| --- | --- |
| `DATABASE_URL`、`REDIS_ADDR` | 数据库与 Redis 连接地址 |
| `JWT_SECRET` | 使用密码学安全随机源生成至少 32 字节的密钥，替换示例值 |
| `CHAT_BASE_URL`、`CHAT_API_KEY`、`CHAT_MODEL` | 对话模型服务 |
| `EMBEDDING_BASE_URL`、`EMBEDDING_API_KEY`、`EMBEDDING_MODEL` | 文档和问题的向量化服务 |
| `EMBEDDING_DIMENSION` | 默认 `1536`，必须与模型输出和数据库向量列维度一致 |
| `RERANK_ENABLED`、`RERANK_BASE_URL`、`RERANK_API_KEY`、`RERANK_MODEL` | 保持 Rerank 启用，填写精排服务配置 |
| `TITLE_BASE_URL`、`TITLE_API_KEY`、`TITLE_MODEL` | 可选的对话标题生成服务；不可用时保留首问摘要 |
| `STORAGE_PROVIDER`、`UPLOAD_DIR` | 默认使用本地文件存储；切换 MinIO 时另配 `MINIO_*` |

示例中的模型地址、密钥和模型名称需要替换为实际服务配置。Rerank 是标准问答链路的一部分，服务须支持 `POST {RERANK_BASE_URL}/rerank`，普通对话 API 地址不一定提供该接口。

首次安装建议使用输出维度为 `1536` 的 Embedding 模型；使用其他维度需同步调整数据库向量列和索引。完整参数见[环境配置](docs/08-env-config.md)，模型切换见[部署指南](docs/13-deployment.md#embedding-模型切换与重建)。

### 4. 初始化数据库和账号

以下初始化命令适用于**全新数据库**。已有部署按[升级指南](docs/13-deployment.md#73-已有数据库)执行对应迁移，不要直接重跑全量迁移。

从仓库根目录进入后端目录：

```powershell
cd backend
go mod download
go run ./cmd/migrate
go run ./cmd/seed
go run ./cmd/bootstrap-admin -username admin
go run ./cmd/doctor
```

`seed` 创建本地开发账号 `admin` / `123456`，`bootstrap-admin` 将该账号设为首位系统管理员。首次登录后请修改密码。可在运行 seed 前通过进程环境变量 `SEED_USERNAME`、`SEED_PASSWORD`、`SEED_DISPLAY_NAME` 自定义账号，并同步替换管理员初始化命令中的用户名；seed 遇到同名账号会跳过，不会重置密码。

`doctor` 检查数据库、向量扩展与维度、Redis 等基础依赖。模型服务是否可用还需通过文档入库和问答验证。生产环境请使用[系统管理员初始化流程](docs/13-deployment.md#74-初始化系统管理员)，不要使用本地开发默认密码。

### 5. 启动后端

继续在 `backend` 目录执行：

```powershell
go run ./cmd/server
```

默认 API 地址为 `http://127.0.0.1:8080/api/v1`。可访问[健康检查](http://127.0.0.1:8080/healthz)确认进程已启动；该接口检查已配置的数据库、Redis和存储，但依赖异常时仍返回HTTP 200，须查看响应体状态；模型服务需另行验证。文档处理、评测等后台任务随后端进程运行。

### 6. 启动前端

打开另一个终端，从仓库根目录执行：

```powershell
cd frontend
npm ci
npm run dev -- --host 127.0.0.1 --port 5173
```

浏览器打开 [http://127.0.0.1:5173](http://127.0.0.1:5173)，使用初始化的账号登录。

开发服务器默认将 `/api` 代理到 `http://localhost:8080`。跨域部署时，在前端启动或构建环境中设置 `VITE_API_BASE_URL`，并在后端配置匹配的 `CORS_ALLOWED_ORIGINS`。Vite 不会自动读取仓库根目录 `.env`；模型密钥应仅配置在后端，不要放入 `VITE_*` 变量。

### 7. 完成第一次问答

1. 创建知识库，上传一份 TXT、Markdown 或其他受支持的文档。
2. 等待文档处理完成，再进入问答页面。
3. 选择该知识库，提出一个能从文档中找到答案的问题。
4. 查看回答并打开引用，核对来源片段。

新对话默认自动检索有权限访问的知识库，也可手动选择知识库或指定文档。回答提示词、模板及其他页面操作见[前端功能说明](docs/10-frontend-spec.md)。

## 开发与验证

后端检查，从仓库根目录执行：

```powershell
cd backend
go vet ./...
go test ./...
go build ./...
```

前端检查，在另一个终端从仓库根目录执行：

```powershell
cd frontend
npm run lint
npm run typecheck:test
npm test
npm run build
```

前端构建产物位于 `frontend/dist`。[GitHub Actions](.github/workflows/ci.yml) 会执行前后端的静态检查、测试和构建，无需生产模型密钥。真实模型效果和完整部署环境仍需单独验证，开发约定见 [AGENTS.md](AGENTS.md)。

## 部署与升级

生产部署建议通过 Nginx 提供前端静态文件并代理后端 API，当前后台任务按单个后端实例运行。数据库和上传文件需配置持久化与备份，使用 MinIO 时 bucket 应保持私有。

数据库变更使用显式 SQL 迁移。当前源码要求迁移至 `049`，缺少所需结构时后端会拒绝启动；已有环境应按版本执行迁移并同步更新前后端。详细步骤、管理员初始化、OCR 安装和模型维护见[部署运维指南](docs/13-deployment.md)。

## 项目结构与文档

完整入口见 [文档导航](docs/README.md)，当前状态、验证证据和未关闭事项分别维护，不将历史验收当作当前部署状态。

```text
backend/    API、业务服务、数据库访问、模型 Provider、后台任务与 SQL 迁移
frontend/   React 页面、组件、API 客户端与前端测试
deploy/     本地 PostgreSQL / Redis 与可选 OTel / Prometheus / Grafana / Jaeger 配置
docs/       产品、架构、接口、配置与部署文档
.github/    GitHub Actions 工作流
```

| 文档 | 内容 |
| --- | --- |
| [产品说明](docs/01-prd.md) | 使用场景与功能范围 |
| [系统架构](docs/02-architecture.md) | 模块划分与服务边界 |
| [数据库设计](docs/03-database-design.md) / [API 设计](docs/04-api-design.md) | 数据模型与接口约定 |
| [RAG 链路](docs/05-rag-pipeline.md) | 解析、检索、回答配置、引用与质量评测 |
| [环境配置](docs/08-env-config.md) | 配置项及默认值 |
| [前端功能说明](docs/10-frontend-spec.md) | 页面与交互行为 |
| [部署运维](docs/13-deployment.md) | 部署、升级、备份与维护 |
| [可观测性](docs/38-observability.md) | 调用链、历史指标、Grafana 看板、告警规则与日志关联 |
| [开发交接](docs/12-handoff.md) | 当前状态与验证边界 |
| [验证与发布验收](docs/14-verification.md) | 检查命令、真实服务边界、证据索引与发布清单 |
| [有效待办](docs/15-backlog.md) | 未关闭问题与明确暂缓项 |

## 许可证

本项目采用 [Apache License 2.0](LICENSE)。
