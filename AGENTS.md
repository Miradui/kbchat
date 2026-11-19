# Agent 工程入口

## 开始与交付

- 开发使用 `dev` 分支；用户明确指定其他分支时从其要求。修改前检查当前分支、已暂存/未暂存差异和未跟踪文件，保留用户及其他任务的内容。
- 主代理开始任务时读 [开发约定](docs/00-ai-development-guide.md) 和 [当前交接](docs/12-handoff.md)，确定本次交付、任务类型与风险；未关闭事项见 [有效待办](docs/15-backlog.md)，草案不自动成为实现任务。
- 只完成当前用户授权的工作，仅在请求需要时修改后端/前端代码；连续完成必要实现、受影响验证、失败修复及文档同步。纯文档任务按文档范围验收；未满足的必需条件保留为待验证并在交付中说明。
- 主代理亲自完整阅读本次所需的产品、架构、设计、交接依据和即将修改的确切代码/规则；只复用亲读且未变化的内容。宽检索和独立核验优先委派，调度必须遵循开发约定的 [子代理规则](docs/00-ai-development-guide.md#子代理)。
- 任务风险、C01–C06、Red/Break 触发和版本证据在 [验证与发布验收](docs/14-verification.md#任务风险与验收) 定义；完成结论须绑定实际被检查的内容，历史结果不得冒充当前通过。

## 常驻约束

- 保持登录、知识库、导入、解析/切片、Embedding、pgvector、Rerank、聊天与引用的核心闭环；现有扩展和支持边界按 [产品说明](docs/01-prd.md) 维护。不新增未经批准的多租户、SSO、复杂 RBAC、合规审计日志、额外对象存储或生命周期管理。
- DOCX 限于正文、标题、列表和表格的文字 OOXML；图片、公式、文本框、DOCX OCR 和旧 `.doc` 不支持。现有本地/MinIO 存储及可选 PDF OCR 遵循产品与配置规范，不从早期 MVP 文字推导新的功能增删。
- 后端保持 `handler -> service -> repository`，业务数据库访问使用 GORM，日志使用 `backend/internal/logger` 的 zap；Embedding、Rerank、Chat 调用均经过能力 Provider 接口，职责见 [架构](docs/02-architecture.md)。
- 知识库资料访问按 `knowledge_bases.owner_id` 和成员能力执行 [API 权限矩阵](docs/04-api-design.md#权限与能力矩阵)；会话还必须匹配 `chat_sessions.user_id`。公开标记和系统管理员身份不自动授予资料或他人会话权限；系统级汇总、所有权转移只按 API 的显式范围授权。
- Rerank 是标准 RAG 路径。标准路径的 citations 只来自已精排且最终进入本轮 Prompt 的片段；现有显式关闭/失败降级按 [RAG 规范](docs/05-rag-pipeline.md) 保留真实状态，并继续限制在同一最终候选集合，不伪造精排分或复用旧引用。
- 知识型回答的事实只依据本轮授权资料，历史仅提供对话上下文；通用知识/会话意图按RAG合同处理，分类解析失败回到 `knowledge_base`，不在修复中改写此边界。
- 根 `.env` 含真实本地配置，不提交或引用密钥；文档使用 `.env.example` 占位值。公共错误不暴露原始 SQL、Provider 响应、连接串、密钥或文件绝对路径。
- API 字段用 camelCase，数据库字段用 snake_case；公共 API、schema、默认值或 RAG 行为变化时更新所属规范。
- 数据库使用显式 SQL 迁移；AutoMigrate仅限明确启用的可丢弃开发库，生产不使用它补迁移。文档 worker 保持单实例；多实例或重叠发布的租约/fencing 前置条件见 [有效待办](docs/15-backlog.md#多实例任务的最低合同)。
- 默认夹具测试可直接执行，修复本次引入的失败后复测，无需逐步确认。真实服务开关可能继承自进程环境，执行前按开发约定核实已授权的目标。真实浏览器检查本地集成环境只需 **1920×1080**。

## 按任务读取

| 触发 | 读取位置与用途 |
| --- | --- |
| 任务启动、Git、子代理、进度或复盘 | [开发约定](docs/00-ai-development-guide.md)：推进方式及记录职责；[交接](docs/12-handoff.md)：当前状态与验证限制 |
| 产品范围或需求取舍 | [产品说明](docs/01-prd.md)、[有效待办](docs/15-backlog.md)：已确认决定和暂缓条件；需求草案只作讨论依据 |
| 模块职责、共享机制或 Provider | [架构](docs/02-architecture.md)：服务与前端状态边界 |
| 数据模型、查询或迁移 | [数据库设计](docs/03-database-design.md)：字段/关系；[部署运维](docs/13-deployment.md#7-数据库初始化和升级)：实际升级步骤 |
| HTTP/SSE、鉴权、DTO 或错误 | [API](docs/04-api-design.md)、[错误码](docs/09-error-codes.md)：权限矩阵、幂等和错误合同 |
| 解析、检索、Prompt、模型上下文或 citations | [RAG](docs/05-rag-pipeline.md)：候选、预算、依据与降级 |
| 页面、路由或 API 集成 | [前端规范](docs/10-frontend-spec.md)：交互、恢复与共享状态 |
| 安装、配置或部署 | [README](README.md)、[环境配置](docs/08-env-config.md)、[部署运维](docs/13-deployment.md)：命令、真实目标及默认值 |
| 诊断、Trace、指标或告警 | [可观测性](docs/38-observability.md)：先区分当前分支实现和历史方案 |
| 选择检查、真实服务验收或发布 | [验证与发布验收](docs/14-verification.md)：风险、命令、证据和完成条件 |
| 发生值得保留的失败、修复或正例 | [开发约定的记录规则](docs/00-ai-development-guide.md#进度与-lessons)、[LESSONS](docs/17-lessons.md)：真实事件及证据，不为每次任务凑条目 |

## 命令入口

[验证文档](docs/14-verification.md#本地检查) 维护受影响包/文件、全量测试、静态检查和构建命令；[运行入口](docs/14-verification.md#运行与初始化入口) 说明 doctor、迁移、seed 和开发服务的影响。以 `backend/go.mod`、`frontend/package.json` 和实际 [CI](.github/workflows/ci.yml) 核对工具版本与检查内容。

仓库级命令在根目录执行；后端/前端命令每次显式设置 `backend` 或 `frontend` 工作目录，使用当前可用 shell。PowerShell 示例可以按工作目录执行等价命令，不为文档任务强制安装 PowerShell。Go SQLite 测试需要启用 CGO 和 C 编译器。
