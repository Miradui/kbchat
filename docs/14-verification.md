# 验证与发布验收

## 执行边界

验证使用与待发布代码匹配的构建。历史通过记录只证明当时的版本和环境，不作为当前全量回归结果。纯文档变更检查链接、命令与内容一致性；代码变更先验证受影响范围，跨模块影响再扩大检查。

默认测试使用 SQLite、临时文件、HTTP 替身和 jsdom。真实服务必须指定本次任务已授权的测试目标；不得把本地夹具、一次性数据库或历史验收当作业务环境已经升级。

## 本地检查

以下两组命令各自从仓库根目录开始，在 PowerShell 执行。Go SQLite 测试需要 CGO 和 C 编译器。

```powershell
Set-Location backend
go test ./...
go vet ./...
go build ./...
```

```powershell
Set-Location frontend
npm run lint
npm run typecheck:test
npm test
npm run build
```

日常修改只运行受影响包/文件，具体入口见 [AGENTS.md](../AGENTS.md)。前端构建包含 11 个路由分包检查。CI 配置见 [工作流](../.github/workflows/ci.yml)，另有 Collector/Prometheus 配置与告警行为检查；不据本地检查宣称远端 CI 已通过。

本机默认 Vitest 并发曾出现内存耗尽；需要限制并发时，在 `frontend` 目录运行 `node node_modules/vitest/vitest.mjs run --maxWorkers 2`。构建工具若无法使用系统临时目录，可将当前进程的 `TEMP` / `TMP` 指向工作区内可写临时目录；不要因此修改产品配置或覆盖正在使用的构建。

## 真实服务入口

### PostgreSQL 与 MinIO

| 开关 | 测试范围 | 数据边界 |
| --- | --- | --- |
| `RAG_TEST_POSTGRES_DSN` | repository 的 pgvector、关键词、权限/锁/并发，以及 database 的时间迁移、完整迁移和启动检查 | 专用测试库中的随机 schema/事务；不迁移业务 public，不启动业务 worker |
| `RAG_TEST_MINIO_*` | 私有 bucket 的上传、读取、字节一致性、物化及删除 | 必须指定本次授权的测试 bucket，不清空业务 bucket |

入口及变量见 [PostgreSQL 并发测试](../backend/internal/repository/postgres_concurrency_integration_test.go)、[完整迁移测试](../backend/internal/database/migration_integration_test.go)、[时间迁移测试](../backend/internal/database/timestamp_migration_integration_test.go)、[MinIO 测试](../backend/internal/storage/minio_integration_test.go)。CI 提供一次性 pgvector PostgreSQL，不能替换为部署数据库。

repository 的测试 schema 使用 `rag_it_<UTC 时间戳>_<随机>`，连接带 `lock_timeout=5s`、`statement_timeout=60s`。正常结束自动清理；测试进程被强制中止时 cleanup 可能不执行，后续测试只回收超过 24 小时的同格式 schema。其他 schema 不受影响。

### 模型合同

密钥只从环境读取，不写入命令、文档或提交。下列测试产生真实调用及可能的费用，默认跳过；运行前核实端点、模型与授权范围。

| 场景 | 环境变量 | 在 backend 目录运行 |
| --- | --- | --- |
| 有依据、资料不足、隐私拒答；JSON/SSE | `RAG_TEST_CHAT_PROVIDER=1`、`RAG_TEST_CHAT_BASE_URL`、`RAG_TEST_CHAT_API_KEY`、逗号分隔的 `RAG_TEST_CHAT_MODELS` | `go test ./internal/service -run '^TestRealChatProviderRefusalContract$' -count=1 -v` |
| 严格依据、冲突、历史误导、提示注入、常识标注；9 类 × JSON/SSE | 同一组 `RAG_TEST_CHAT_*`，另设 `RAG_TEST_CHAT_GROUNDING=1` | `go test ./internal/service -run '^TestRealChatGroundingContract$' -count=1 -v` |
| 精排目标文档首位、ID 完整/不重复、有限分数与降序 | `RAG_TEST_RERANK_PROVIDER=1`、`RAG_TEST_RERANK_BASE_URL`、`RAG_TEST_RERANK_API_KEY`、`RAG_TEST_RERANK_MODEL` | `go test ./internal/provider/rerank -run '^TestRealRerankProviderContract$' -count=1 -v` |

这些测试不打开业务数据库。合同通过不代表总体回答准确率、任意语言或业务语料质量；完整召回、Prompt 与 citations 仍须独立检查。真实回答需人工审读，不能把词面断言或相关性分数当成事实证明。

### OCR、浏览器与可观测性

- OCR 需在授权的测试 PDF 上运行受信任的 Poppler/Tesseract；验证工具、语言、取消与资源上限，不能用合成校对快照证明真实识别准确率。配置见 [环境配置](08-env-config.md#文档工作流pdf-ocr-配置)。
- 本地集成浏览器使用 **1920×1080**，运行真实生产路由；明确哪些 HTTP 服务是替身。触屏、读屏器与其他浏览器的历史覆盖有限，不能据桌面检查宣称全部通过。
- OTel 夹具、真实 Collector/Jaeger 转发、Prometheus 规则检查见 [可观测性验证](38-observability.md#验证)。真实模型、业务库和 MinIO 不因启动观测工具而自动获得测试授权。

## 候选版本发布清单

1. 固定提交、依赖锁与构建产物；对同一版本执行后端/前端门禁。先区分已有工作区改动的归属，再决定提交范围。
2. 在授权的隔离 PostgreSQL 执行全部 SQL 迁移与生产启动检查；核对业务环境自己的迁移记录。当前源码要求至 **049**，不能凭历史交接判断目标库已经升级。
3. 按 [部署运维](13-deployment.md) 备份同一停写窗口的数据库、MinIO、历史本地文件与配置，验证恢复；随后只执行尚未应用的迁移，运行单个 backend。
4. 1920×1080 验证登录、上传/失败/重试、问答与引用、历史定位/编辑确认、双标签重生成、归档和撤权；检查最终统一导航布局，等待目标页标志后再断言。
5. 对实际发布的 Embedding、Rerank、Chat、MinIO 及可选 OCR 完成真实链路；核对最终 citations 只来自本轮进入 Prompt 的候选，严格/降级状态不混淆。
6. 验证 SIGTERM、正在生成的 SSE、文档任务恢复、代理超时/请求体上限、日志/Trace/指标关联和告警恢复。
7. 记录未覆盖项与剩余风险，按 [有效待办](15-backlog.md) 判断其是否影响本次发布；不得把未知状态标为通过。

## 已有证据索引

以下按当时版本与环境保存验证结果；历史记录不替代当前版本检查。路径用代码表示，避免把被忽略且可能不存在的产物当成仓库必备文件。

| 时间与范围 | 证据及结论 | 适用限制 |
| --- | --- | --- |
| 2026-09，交互修复与前端工程化 | `output/playwright/continue-audit-*`；批量操作、头像、异步状态、焦点与 CI 本地检查 | 旧布局；不替代当前导航复验 |
| 2026-09-28，混合检索、管理员、用量与重建 | `output/continue-p1-samples.json`、`output/continue-p7-real.log`、`output/continue-*`；独立 PG、真实模型与浏览器 | 12 题小样本；不证明总体召回提升 |
| 2026-09-28，真实 Rerank 与 citations | `output/rerank-acceptance.json`、`output/rerank-wire.jsonl`、`output/rerank-sse.json`；严格精排、JSON/SSE、Prompt 与引用映射 | 合成问题和当时模型/语料 |
| 2026-09，Redis 与 40 题参数校准 | `output/redis-wait-before.json`、`output/redis-wait-after.json`、`output/redis-recovery-real.json`；`output/rerank-business-cases.json`、`output/rerank-business-calibration.json` | 候选 TopK=3/阈值0.95 未应用；复核仍有 2 道无答案题过阈值，不据此修改全局默认 |
| 2026-09-29，严格依据、MinIO、PDF、协作 | `output/grounding-model-final.log`、`output/grounding-acceptance.json`；18/18 依据场景、6/6 原拒答合同、真实私有 MinIO 和多角色浏览器 | 有限模型/语言/样本；当时无 OCR，后续高亮另测 |
| 2026-09-29，手动多库与自动范围 | `output/multi-acceptance.json`、`output/multi-wire.jsonl`；`output/auto-scope-*`、`output/scope-db-upgrade-*.json` | 手动多库含真实服务；自动范围当轮主要是 fixture，后续真实自动问答见下一行 |
| 2026-09-30，阅读与窄屏布局 | `output/ui-resume-full-tests.log`、`output/playwright/ui-refine-*`、`output/playwright/ui-resume-reader-*` | 旧蓝色布局和 API 夹具，不代表当前最终布局 |
| 2026-10-08，PDF、高亮、自动问答与长历史 | `output/ui-sequence-acceptance.json`、`output/followup-20261008/`、`output/doc-followup-acceptance.json`、`output/history-20261008/` | 真实 PDF/模型与隔离 PG；本机 1000 条夹具首屏中位 910.7→290.8ms，不泛化到远端容量 |
| 2026-10-13，会话内容搜索 | `output/chat-search-20261013/api-checks.json`、`output/chat-search-20261013/browser-flow.log` | 局部历史与权限已测；无大规模数据库性能结论 |
| 2026-10-13，收藏/分支/模板/版本对比/文件夹/表格 | `output/features-20261013/api-results.json`、`output/features-20261013/cleanup.json` | 独立 PostgreSQL 与真实 worker，模型固定响应；不代表业务已发布 |
| 2026-10-15，上传恢复、表格设置、版本策略、OCR | `output/workflow-20261015/`、`output/playwright/workflow-*`、`output/ocr-tools/` | 本地 OCR 工具和隔离环境；不证明任意扫描件准确率 |
| 2026-10-19，草稿/指定文档/编辑/校对/质量闭环 | `output/knowledge-workflow-20261019/api-results.json`、`output/knowledge-workflow-20261019/cleanup.json` | PG 与固定模型；校对页面使用合成快照，不是完整 OCR 识别重验 |
| 2026-10-19，统一导航布局 | `output/perplexity-frontend-20261019/`；最终回归 108 文件/900 项 | 最终导航浏览器脚本提前结束，旧布局图证不代表最终布局通过 |
| 2026-10-20，全仓审查 | Git 中的该轮审查与修复历史；`output/release-review-20261028/coverage.json` 为后续发布复核覆盖记录 | 未关闭事项保留在待办；不把已修复结论继续列为缺陷 |
| 2026-10-28，发布边界修复 | `output/release-fix-20261028/verification-summary.json`；27 包/1568 pass 事件（含一次性 PG）、前端108文件/914项及构建 | 只证明当轮工作区；5 项真实服务测试跳过，恢复演练/固定发布版本仍待完成 |
| 2026-11-05，知识库提示词交互 | `frontend/src/test/fixtures/answer-prompt/runs/latest/`、`output/answer-prompt-followup-20261105/` | 生产页面与 HTTP 夹具；16 文件/191 项，不代表模型效果验证 |
| 2026-11-10，Trace 与日志关联 | `backend/internal/router/testdata/observability/runs/latest/`、`output/observability-20261110/` | 真实 Jaeger，业务数据库/模型/存储为夹具 |
| 2026-11-11，Metrics 与告警 | `output/observability-phase2-20261110/live/`、同一 router 稳定结果；27 包/1534 pass 事件、6包race、18查询、10组告警通过 | 真实 Collector/Prometheus/Grafana/Jaeger；历史样本重启保留，业务库/真实模型/MinIO/容器运行未联调 |
| 2026-11-19，提交前本地回归 | `output/git-push-20261119/verification-summary.json`；后端 `go test -count=1 ./...` 27个有测试包通过，vet/build通过；前端110文件/922项中921项通过，lint、测试类型检查、构建及11路由分包检查通过 | `viewport-units.test.ts` 发现 `library.css` 的既有 `40vh`，1项失败；测试与样式均与原HEAD一致。构建改用工作区临时目录后通过；真实服务测试开关关闭，未运行真实服务、迁移或部署验收 |

## 记录格式

新增验证结果写明日期、被测版本/改动范围、命令、真实/替身边界、结果、证据位置、未满足项；必要时更新上表。临时端口、PID、曾经使用的账号和重复清理日志留在本地运行产物，不写入现行部署说明。
