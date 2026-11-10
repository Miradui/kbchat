# 开发约定

## 范围与规范入口

本项目以企业知识库问答为核心，功能范围见 [产品说明](01-prd.md)。只实现当前用户请求；当前状态见 [交接](12-handoff.md)，未关闭问题见 [有效待办](15-backlog.md)。不因历史计划存在而自动扩展工作。

| 工作内容 | 依据 |
| --- | --- |
| 模块职责、后端分层、Provider、日志 | [架构](02-architecture.md) |
| 模型、字段、索引与迁移 | [数据库设计](03-database-design.md) |
| HTTP/SSE、DTO、权限、幂等 | [API 设计](04-api-design.md)、[错误码](09-error-codes.md) |
| 解析、切片、检索、Rerank、Prompt、citations | [RAG 流程](05-rag-pipeline.md) |
| 配置、部署、备份与工具 | [环境配置](08-env-config.md)、[部署运维](13-deployment.md) |
| 页面、路由、状态恢复 | [前端规范](10-frontend-spec.md) |
| Trace、指标与告警 | [可观测性](38-observability.md) |
| 测试命令、真实服务和发布验收 | [验证与发布验收](14-verification.md) |

## 必须保持的约束

- 后端使用 `handler -> service -> repository`，数据库访问使用 GORM，日志使用 `backend/internal/logger` 的 zap；模型调用经 Embedding、Rerank、Chat、Title 接口。
- 所有知识库访问检查 `knowledge_bases.owner_id` 与当前成员能力；会话还检查 `chat_sessions.user_id`。公开标记和系统管理员身份均不自动授予知识库访问权，具体403/404遵循API矩阵。
- Rerank 属于标准 RAG 路径。只有明确配置的关闭/失败降级路径可跳过，并保留真实状态；citations 只来自本轮最终进入 Prompt 的片段。
- 事实依据来自本轮授权资料，历史消息仅提供对话上下文；通用知识与会话意图按现有规则处理，分类解析失败回到 `knowledge_base`。
- API 字段使用 camelCase，数据库字段使用 snake_case。公共错误不包含原始SQL、模型响应、连接串、密钥或文件绝对路径。
- 根 `.env` 是真实本地配置，不提交、不复制其中的密钥；文档示例使用 `.env.example` 的占位值。
- 数据库先执行显式SQL迁移，再启动匹配的应用。开发用 AutoMigrate 仅适用于明确启用的可丢弃数据库，不等同于迁移。
- 保持单实例文档 worker；多实例/重叠滚动发布前先完成任务租约与 fencing。支持范围和非目标以产品说明为准。

## 执行与验证

1. 开始时确定本次可验证的交付结果，按实际依赖连续完成实现、适当验证、修复及文档同步。
2. 默认SQLite、临时文件、HTTP/API替身和jsdom测试可以直接运行；修复本次引入的失败并复测，无需逐步确认。Go SQLite测试需要CGO与C编译器。
3. 验证范围匹配改动：先受影响包/文件；跨模块或有新问题再扩大。纯文档检查路径、命令、合同和链接，不重复启动业务服务。
4. `RAG_TEST_POSTGRES_DSN`、`RAG_TEST_MINIO_*`、`RAG_TEST_CHAT_*`、`RAG_TEST_RERANK_*` 等真实服务开关可能产生写入或费用；先核实是本次已授权的目标，执行方式见验证文档。
5. `doctor` 会访问配置的真实服务；`migrate`、`seed` 和启动后的 worker 可能写数据。目标或影响不明确时先完成可独立的准备，再确认必要信息；已有授权不重复请求。
6. 本地集成浏览器只需1920×1080；夹具通过与真实环境通过分开记录，未覆盖项不得标为完成。
7. 改公共API、schema、默认值或RAG行为时更新所属规范；交接只保留当前状态和验证边界，历史实施过程由Git保存。
8. 交付说明改动、验证和未满足项；不自行提交混合工作区或发布未经授权的环境。
