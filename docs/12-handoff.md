# 当前交接

更新日期：2026-09-20。本文件记录当前实现、有效待办和验证范围；稳定合同在对应规范中维护，历史实施过程通过 Git 查询。

## 当前实现

- 后端与前端已完成登录、知识库、文档处理、检索、RAG 问答和引用主链路，工作台已接入真实 API。
- 已有分类、标签、收藏、批量操作、回收站、成员能力矩阵、活动记录、系统诊断，以及本地 / 私有 MinIO 存储。
- 文档支持 TXT、Markdown、PDF、DOCX，具备进度、取消、重试、查重、版本替换、预览和片段定位；DOCX 解析正文段落、Heading 1–6、列表和 GFM 表格，忽略页眉页脚、批注、删除修订、图片、公式、文本框和 OCR；上传任务可在同一浏览器标签页切换页面时继续。
- 聊天支持流式回答、多轮检索、首问命名、回答版本切换、会话查找、来源预览、反馈和导出；质量页支持知识缺口与回归评测。
- 检索为向量召回与关键词召回的 RRF 融合（迁移 024，HNSW 向量索引，`KEYWORD_SEARCH_ENABLED` 与知识库 `enableKeyword` 开关），检索测试面板可查看关键词与融合阶段。
- Redis 已用于两类固定窗口限流与 query embedding 缓存：登录默认按可信客户端 IP 每分钟 10 次，回答生成三个接口按用户合计每分钟 30 次；缓存默认 24 小时。诊断页展示限流触发数和缓存 hit / miss / error / 命中率，登录与聊天对 429 显示就地倒计时提示。
- 中文品牌为“知汇”，保留蓝色主题、明暗模式和现有交互约定。功能与 API 详情见 [README](../README.md)、[API 规范](04-api-design.md)、[前端规范](10-frontend-spec.md)。

## 最近完成

- 2026-09-20：功能优化计划 P2 限流与 Redis 落地完成。新增 Lua 原子固定窗口计数、可信代理链 IP 解析、open / closed 故障策略、登录与聊天路由接线、版本化 float32 query embedding 缓存，以及相应进程内诊断指标。前端统一解析 `Retry-After`，登录表单和聊天输入区就地展示 429，发送受限时恢复问题。后端全量 test、vet、build 与前端生产构建通过；P2 前端定向测试通过。真实 Redis 停机演练、真实 Provider 调用计数和浏览器复验未执行。
- 2026-09-20：功能优化计划 P3 DOCX 解析完成。新增基于 `encoding/xml` 的 OOXML 解析器，支持正文、Heading 1–6、编号/项目列表、GFM 表格与合并单元格空值，忽略页眉页脚、批注和删除修订；上传按扩展名与 ZIP 魔数校验，预览返回解析文本，前端补充 DOCX MIME、图标与能力提示。后端全量 test 与前端文档页定向测试、生产构建通过；真实 DOCX 上传/worker/浏览器端到端复验待集成环境执行。
- 2026-09-20：功能优化计划 P4–P6 已接入。P4 提供管理员用户管理、禁用账号即时失效、一次性密码与最后管理员保护；P5 提供可选 Provider usage、`model_usage_records` 和质量页 token 汇总；P6 提供知识库回答配置与回答提示词扩展。P4–P6 的迁移和真实 Provider/部署复验待集成环境执行。
- 2026-09-20：功能优化计划 P1 混合检索完成。新增 `internal/document/lexer`（中文 bigram + 精确词元分词，索引与查询共用）、`document_chunks.search_vector` 与 GIN 索引、HNSW 替换 ivfflat（迁移 024，`cmd/migrate` 新增 `-timeout`）、`cmd/reindex-keywords` 回填 CLI、`ChunkRepository.SearchByKeyword`、retrieval 的 RRF 融合与 `keywordStage` / `fusionStage` debug、`retrievalConfig.enableKeyword`、`KEYWORD_SEARCH_ENABLED`、capabilities 的 `keywordSearchEnabled`，以及检索配置表单、检索测试面板和评测面板的开关与展示。关闭关键词召回时行为与旧版一致，既有 retrieval 测试未改动即通过。本地数据库尚未执行 024，也未运行回填；后端 vet / 全量 test / build 与前端 tsc、生产构建、路由分包检查通过。详见下表与 [功能优化计划](17-improvement-plan.md)。

- 2026-09-14：I11 时间修复完成，业务时间统一使用 `timestamptz`。应用会话和自动时间保持 UTC、微秒精度，移除自定义 timestamp 编码；启动检查会提示未迁移的旧列。已执行 023，保持旧值原有的 UTC 解释，不批量校正历史偏差。真实 PostgreSQL、业务接口和前端时间格式化检查通过，详情见下表。
- 2026-09-14：项目文档由 34 份收敛为 14 份，有效内容与引用归入现行规范；项目指令明确按需查阅、完成标准和执行边界。旧文件名引用、文档链接、目录路径、UTF-8/LF 与 `git diff --check` 检查通过，该次整理的源码变更仅为注释。
- 2026-09-11：首问自动命名、知识库批量操作和图标、账户设置与头像、全站交互巡检、CI 与 README 已完成。逐页结果见 [交互巡检](16-interaction-review.md)。
- 数据库执行记录：2026-09-14 本地数据库已执行到 `023_timestamps_with_time_zone.sql`，19 张表的 42 个时间字段均为 `timestamptz`。其他环境仍需按自身迁移记录升级，新版 backend 启动前须完成 023，步骤见 [部署指南](13-deployment.md)。

## 有效待办

### 功能优化计划（2026-09-20）

- 六个改进阶段的目标、设计要点、涉及改动、测试与验收见 [功能优化计划](17-improvement-plan.md)。P1–P6 均已完成代码接入；仍需在部署环境执行 025–027 迁移、真实 Provider usage/模型覆盖和浏览器复验。

## 验证记录与边界

以下记录按日期列出。2026-09-14 已备份本地数据库并执行 023 类型迁移，现有业务记录的内容与时间含义经前后校验保持一致。写入回归使用事务内临时表和临时上传目录；全新安装流程在独立 schema 的事务中执行后回滚。本轮没有启动后台 worker、调用模型服务、复跑整站浏览器巡检或查询远端 CI。

| 项目 | 最新记录及限制 |
| --- | --- |
| 本地自动检查 | 2026-09-20 P3 后端 `go test ./...` 通过；前端文档相关 4 个测试文件 103/103 通过，`npm run build`（含 TypeScript、Vite 与 11 项路由分包检查）通过。前端全量为 73 个文件、659/669 项通过：`ChatSourcePreview.test.tsx` 的 9 项 PDF 预览失败仍是下方已知问题；另有 1 项 ChatPage 对账用例只在全量并发运行中超时，单文件复跑 83/83 通过。 |
| 真实浏览器 | 2026-09-11 在 1920×1080 检查主要页面及明暗主题；Markdown 上传、处理、片段、问答与单题评测已走通。仅代表已记录的路径。 |
| 数据库迁移 | 2026-09-14 已将 30 个旧列转为 `timestamptz`，保留已有 12 个带时区列。19 张表共 325 条记录的语义校验值一致，67 个索引、63 个约束、时间列默认值和空值设置不变。迁移前的 pg_dump 备份已通过 pg_restore 全归档读取校验。临时表验证非 UTC 会话、重复执行和旧 schema 拒绝启动；独立 schema 完整执行 001–023 后通过启动检查并回滚。备份与校验记录在 `output/timestamptz-20260914/`。 |
| 当前时间 | 2026-09-14 原生 `timestamptz` 在 cache_statement / exec / simple_protocol 三种模式通过新增、更新、范围查询、SQL 默认值和软删除回归。真实路由处理链在 19 张临时表上通过 9 项知识库/文档/会话操作、2 次连续条件命名及 2 条活动时间检查，实际 schema 通过启动检查。现有前端格式函数在 Asia/Shanghai 下核对 18 个 API 时间及跨日、相对时间；上传时间 15:31Z 显示为本地 23:31。记录在 `output/timestamptz-20260914/`，未单独进行浏览器页面复验。 |
| Rerank | 最近联调环境未启用 Rerank，真实精排调用未在该轮验证；成功、失败和 fallback 由后端测试覆盖。启用后的端到端验证仍需真实服务。 |
| 首问标题 | 最近真实调用走首问摘要兜底，成功提炼由定向测试覆盖；真实标题模型成功路径仍需验证。 |
| 多账号、PDF、辅助设备 | 最近巡检未追加 PDF 浏览器验收、多账号完整协作、NVDA / VoiceOver 或真实触屏设备验证。不能从 jsdom 或 CSS 检查推断实机效果。 |
| 拒答标记 | 2026-08-31 记录只在 deepseek-v4-flash 上验证过标记遵从；其他 Provider、模型和提示模板未覆盖。识别规则见 [RAG 规范](05-rag-pipeline.md)。 |
| GitHub CI | 2026-09-11 工作流已通过本地 actionlint 与安装验证，Node 22 的 GitHub 执行当时尚待确认；本轮没有查询远端运行状态。 |
| 混合检索 | 2026-09-20 `chunk_keyword_postgres_integration_test.go` 在本地 PostgreSQL 独立 schema 通过：精确编码与 CJK 词元排序、知识库与软删除隔离、连字符编码不被无连字符写法误匹配、NULL 索引后回填恢复召回。RRF 融合、阈值语义、开关优先级、debug 阶段由 retrieval 单元测试覆盖。未在真实知识库数据上做开关前后的命中对照，也未做浏览器巡检；HNSW 在真实数据量下的构建耗时与 `EXPLAIN` 走索引未验证。 |
| 限流与缓存 | 2026-09-20 miniredis 覆盖 Lua 原子计数、窗口过期、Redis 故障 open / closed 与二进制向量往返；中间件覆盖可信代理链，路由测试确认第 11 次登录返回 429，三个回答生成接口共享用户限额。retrieval 测试确认相同问题第二次命中 Redis 缓存、Provider 与其指标只增加一次，缓存故障继续检索。未对本地真实 Redis 做停机演练、未调用真实 Embedding Provider，也未做浏览器联调。 |
| 已知问题 | 2026-09-20 设置 `RAG_TEST_POSTGRES_DSN` 后 `TestPostgresRecycleBinRestoreLosesToPermanentDelete/chat_session` 在 HEAD（eb4b752）即挂起直至超时，与本轮改动无关（在独立 worktree 复现）；CI 因未设置该变量跳过。前端 `ChatSourcePreview.test.tsx` 有 9 项失败，来自工作区中尚未提交的 PDF 预览改动（`pdfjs-dist`、`components/pdf/PdfPreview`），非本轮改动引入。 |

验收使用的临时业务数据在对应巡检结束时已清理；原有测试知识库、账户资料和主题已按记录恢复。截图与复查脚本位于被 Git 忽略的 `output/playwright/`，具体文件前缀见交互巡检。

## 继续工作时

- 根据当前请求选择待办，不重新执行已经完成的初始化或阶段计划。
- 运行与测试入口见 [README](../README.md) 和 [AGENTS.md](../AGENTS.md)；目录职责见 [架构](02-architecture.md)。
- 默认本地替身测试与 `RAG_TEST_*` 真实服务测试的边界见 [开发规范](00-ai-development-guide.md)；doctor、migrate、seed 和后台 worker 按已授权环境执行。
- 本地真实配置在根 `.env`，不得复制到文档、日志输出或提交；配置说明使用 [环境变量规范](08-env-config.md) 与 `.env.example` 占位值。
- 更新公开字段、权限、默认参数或 RAG 行为时同步正式规范；交接只维护当前状态、待办和验证范围。
