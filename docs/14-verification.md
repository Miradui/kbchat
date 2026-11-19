# 验证与发布验收

## 执行边界

历史通过只证明当时的版本和环境；本轮验收必须对应最终候选内容。纯文档检查结构、引用、命令与规则语义，代码先验证受影响范围，再按实际跨模块影响扩大。

默认测试使用 SQLite、临时文件、HTTP 替身和 jsdom，前提是进程没有启用真实服务入口。检查继承的 `RAG_TEST_*` 开关是否启用，不输出凭据；只授权夹具时在测试子进程移除真实入口开关，保留用户持久配置。真实测试必须核实本次已授权的目标与影响；一次性库或历史验收不能证明业务环境已升级。完整执行方式见 [开发约定](00-ai-development-guide.md#执行边界)。

## 任务风险与验收

### 风险选择

按实际影响选择等级，不能为规避验收而降级。任务类型和文件后缀不直接决定风险；普通 CRUD 不因有写入自动成为 L3，涉及鉴权、事务、一致性或发布的配置/重构仍须升级。

| 等级 | 影响与例子 | 必需验证 |
| --- | --- | --- |
| L1 | 文档、注释、格式；可证明不影响行为的轻量整理 | 范围/diff、适用结构/格式/引用、规则语义和最终内容身份；不机械构建或做行为 Red/Break |
| L2 | 普通业务逻辑、API、查询、一般功能或会改变行为的重构 | 受影响自动化用例或等价检查、必要集成、关键边界及受影响目标构建 |
| L3 | 并发/异步、事务/一致性、权限/安全、可靠性、迁移、部署/发布与关键基础设施 | 适用 Red、关键规则 Break、分层回归、完成条件所需真实环境与最终版本/产物身份 |

已有有效覆盖先复用，缺覆盖才补有独立预期的用例，不写复述实现的测试。缺工具、权限或环境的必需检查标为 **未运行（Not run）** 并保持待验证；**不适用（N/A）** 必须说明任务为何不触发该检查，二者不能替换。失败、部分完成、取消和未知分别记录，不把未结束的检查当成通过。

### C01–C06

每次考虑下列维度，按风险执行适用检查。小型 L1 可以合并记录及共用不适用原因，无需复制一整套验收表。

| ID | 维度 | 证据要求 |
| --- | --- | --- |
| C01 | 行为与范围 | 用户原例/文档目标、相关入口、前后契约、已确认决定；事实与候选解释分开 |
| C02 | 构建与产物 | 本次实际所需静态检查/构建及目标身份；纯文档不机械构建 |
| C03 | 测试有效性 | 独立预期、覆盖边界及适用 Red/Break 的目标失败；人工阅读不冒充必需自动化 |
| C04 | 分层回归 | 受影响单元、集成和流程及关键边界；纯文档核对结构、引用与旧约束去向 |
| C05 | 真实使用 | 完成条件需要的实际配置、响应/状态、服务/语料身份；模拟不能冒充实测 |
| C06 | 最终版本与披露 | 被测提交和未提交输入快照、命令/退出码/结果、CI、未运行原因与剩余边界 |

### Red 与 Break

- **Red**：L2/L3 可复现行为缺陷用回归测试证明修复时必需；L3 关键行为回退验证也适用。在修复前或隔离撤回相关修复后执行，旧版须能编译/运行且目标断言明确失败。编译失败、跳过、无关错误或网络不可用不能充数。
- **Break**：L3 新增/修改关键规则时必需；L2 关键规则或测试有效性存疑时也执行。用最小语义破坏证明用例抓住目标错误，不能靠破坏构建冒充；同语义旧失败证据可复用并说明覆盖关系。
- 实验在隔离副本、夹具或模拟执行器上进行，保留用户工作区；真实破坏实验只在明确授权的隔离目标执行。纯新功能无可回退旧行为时可说明 Red 不适用，关键规则 Break 仍按触发条件执行；L1 纯文档的行为 Red/Break 不适用。

### 最终版本与 CI

验收身份包含 HEAD 及相关未提交/未跟踪输入的内容快照或 SHA-256，详见 [Git 约定](00-ai-development-guide.md#git-与内容身份)。后续改变代码、配置、语料、规则或产物须补验受影响部分；旧结果不能直接转为当前通过。

当前 [CI](../.github/workflows/ci.yml) 执行后端 vet/test/build，以及前端 npm ci、lint、测试类型检查、test、build（含 11 路由分包）。它没有 PostgreSQL service/测试 DSN，也未配置 Collector/Prometheus 检查；默认的环境开关测试会跳过，不能据 CI 宣称真实服务通过。

当任务涉及提交、合并或发布且该 CI 是必需门禁时，必须确认最终目标提交的适用 CI **实际结束且通过**。运行中、取消、跳过、未启动均不能当通过；本地与 CI 不替代缺失的必需检查。未查询远端时如实写未查询，不推断分支保护。纯本地文档交付不要求为获得 CI 回执而自行提交或推送。

## 本地检查

从仓库根目录确定下表工作目录，每次命令/工具调用显式设置该目录，使用当前可用 shell。PowerShell 可用 `Set-Location`，POSIX shell 可用 `cd`；目录切换不跨工具调用隐式延续。Go SQLite 测试需要 CGO 和 C 编译器，工具版本以 `backend/go.mod`、`frontend/package.json` 和 CI 为准。

| 检查 | 工作目录 | 命令 |
| --- | --- | --- |
| 后端受影响包（示例） | `backend` | `go test ./internal/retrieval` |
| 后端全量 | `backend` | `go test ./...` |
| 后端静态检查 | `backend` | `go vet ./...` |
| 后端构建 | `backend` | `go build ./...` |
| 前端受影响文件（示例） | `frontend` | `npm test -- src/pages/Chat/ChatPage.test.tsx` |
| 前端全量 | `frontend` | `npm test` |
| 前端 lint | `frontend` | `npm run lint` |
| 测试 TypeScript | `frontend` | `npm run typecheck:test` |
| 前端构建与路由分包 | `frontend` | `npm run build` |

示例目标替换为受影响包/文件；先定向检查，只有范围、失败或新疑点需要时才扩大。`typecheck:test` 按 `tsconfig.test.json` 的 include 检查测试，不等同于所有测试文件的类型检查；`verify:route-chunks` 依赖 `dist/assets`，已由 build 调用，不重复当作独立构建。

本机默认 Vitest 并发曾出现内存耗尽；需要限制并发时，在 `frontend` 运行 `node node_modules/vitest/vitest.mjs run --maxWorkers 2`。构建工具若无法使用系统临时目录，可将当前进程的 `TEMP` / `TMP` 指向工作区内可写临时目录；不要因此修改产品配置或覆盖正在使用的构建。

## 运行与初始化入口

下列命令按 [开发约定](00-ai-development-guide.md#执行边界) 核实目标后执行，读取入口不代表本次必须运行。安装、依赖准备和完整操作见 [README](../README.md)，已有库升级与生产账号见 [部署运维](13-deployment.md)。

| 目的 | 工作目录 | 命令 | 影响 |
| --- | --- | --- | --- |
| 依赖诊断 | `backend` | `go run ./cmd/doctor` | 访问实际配置的数据库/Redis等依赖，不等同于模型质量验收 |
| 全新数据库初始化 | `backend` | `go run ./cmd/migrate` | 执行 SQL 写入；已有库只按部署记录执行缺失迁移 |
| 本地开发账号 | `backend` | `go run ./cmd/seed` | 创建账号，不覆盖已存在账号；生产不用默认开发口令 |
| 首位系统管理员 | `backend` | `go run ./cmd/bootstrap-admin -username admin` | 提升明确选定的已有账号；新建与密码要求见部署指南 |
| 后端开发服务 | `backend` | `go run ./cmd/server` | 启动 API 与文档/清理/评测 worker，可能写真实数据或调用模型 |
| 前端开发服务 | `frontend` | `npm run dev -- --host 127.0.0.1 --port 5173` | 连接配置的后端；浏览器操作的目标仍须核实 |

## 真实服务入口

### PostgreSQL 与 MinIO

| 开关 | 测试范围 | 数据边界 |
| --- | --- | --- |
| `RAG_TEST_POSTGRES_DSN` | repository 的 pgvector、关键词、权限/锁/并发、完整迁移，以及 database 的时间迁移 | 未设置 DSN 时跳过；使用专用测试库与随机 schema/事务，完整迁移可能创建库级 vector 扩展；不启动业务 worker |
| `RAG_TEST_MINIO_*` | 私有 bucket 的上传、读取、字节一致性、物化及删除 | 三项连接变量齐备即运行；必须另显式指定本次授权的 `RAG_TEST_MINIO_BUCKET`，不清空业务 bucket |

入口及变量见 [PostgreSQL 并发测试](../backend/internal/repository/postgres_concurrency_integration_test.go)、[完整迁移测试](../backend/internal/repository/knowledge_workflow_postgres_integration_test.go)、[时间迁移测试](../backend/internal/database/timestamp_migration_integration_test.go)、[MinIO 测试](../backend/internal/storage/minio_integration_test.go)。当前 CI 未配置 PostgreSQL；这些测试需显式提供已授权的专用测试 DSN，不能替换为部署数据库。完整迁移入口为 `TestPostgresKnowledgeWorkflowMigrationsAndDocumentScope`；现有 schema 单元测试使用 SQLite，不能据此宣称 PostgreSQL 生产启动约束已实测。

MinIO 测试若省略 `RAG_TEST_MINIO_BUCKET` 会回落到 `rag-documents`，不是强制隔离保护；`EnsureReady` 可能创建 bucket。操作者须显式指定已授权测试 bucket，并核对对象上传与删除范围，不因 UUID 对象路径自动取得业务 bucket 授权。

repository 的测试 schema 使用 `rag_it_<UTC 时间戳>_<随机>`，连接带 `lock_timeout=5s`、`statement_timeout=60s`。正常结束自动清理；测试进程被强制中止时 cleanup 可能不执行，后续测试只回收超过 24 小时的同格式 schema。其他 schema 不受影响。

### 模型合同

密钥只从环境读取，不写入命令、文档或提交。下列测试产生真实调用及可能的费用，默认跳过；运行前核实端点、模型与授权范围。

| 场景 | 环境变量 | 在 backend 目录运行 |
| --- | --- | --- |
| 有依据、资料不足、隐私拒答；JSON/SSE | `RAG_TEST_CHAT_PROVIDER=1`、`RAG_TEST_CHAT_BASE_URL`、`RAG_TEST_CHAT_API_KEY`、逗号分隔的 `RAG_TEST_CHAT_MODELS` | `go test ./internal/service -run '^TestRealChatProviderRefusalContract$' -count=1 -v` |
| 严格依据、冲突、历史误导、提示注入、常识标注；9 类 × JSON/SSE | `RAG_TEST_CHAT_GROUNDING=1` 和同一组 BASE_URL/API_KEY/MODELS；不依赖 `RAG_TEST_CHAT_PROVIDER` 开关 | `go test ./internal/service -run '^TestRealChatGroundingContract$' -count=1 -v` |
| 精排目标文档首位、ID 完整/不重复、有限分数与降序 | `RAG_TEST_RERANK_PROVIDER=1`、`RAG_TEST_RERANK_BASE_URL`、`RAG_TEST_RERANK_API_KEY`、`RAG_TEST_RERANK_MODEL` | `go test ./internal/provider/rerank -run '^TestRealRerankProviderContract$' -count=1 -v` |

这些测试不打开业务数据库。合同通过不代表总体回答准确率、任意语言或业务语料质量；完整召回、Prompt 与 citations 仍须独立检查。真实回答需人工审读，不能把词面断言或相关性分数当成事实证明。

### OCR、浏览器与可观测性

- OCR 真实入口需显式 `RAG_TEST_PDF_OCR=1`，在授权的测试 PDF 上运行受信任的 Poppler/Tesseract；验证工具、语言、取消与资源上限，不能用合成校对快照证明真实识别准确率。配置见 [环境配置](08-env-config.md#文档工作流pdf-ocr-配置)。
- 本地集成浏览器使用 **1920×1080**，运行真实生产路由；明确哪些 HTTP 服务是替身。触屏、读屏器与其他浏览器的历史覆盖有限，不能据桌面检查宣称全部通过。
- 当前 dev 的可观测性检查使用 Recorder/系统诊断现有测试，入口见 [当前实现](38-observability.md#当前实现与验证)。旧 OTel/Collector/Prometheus 只保留历史合同摘要，恢复对应实现与配置后重新核实命令，缺少载体时不执行或声称通过；真实模型、业务库和 MinIO 不因观测任务自动获得测试授权。

## 候选版本发布清单

1. 固定提交、依赖锁与构建产物；对同一版本执行后端/前端门禁。先区分已有工作区改动的归属，再决定提交范围。
2. 在授权的隔离 PostgreSQL 执行全部 SQL 迁移与生产启动检查；核对业务环境自己的迁移记录。迁移要求以 [数据库设计](03-database-design.md) 和当前 SQL/启动检查为准，不能凭历史交接判断目标库已经升级。
3. 按 [部署运维](13-deployment.md) 备份同一停写窗口的数据库、MinIO、历史本地文件与配置，验证恢复；随后只执行尚未应用的迁移，运行单个 backend。
4. 1920×1080 验证登录、上传/失败/重试、问答与引用、历史定位/编辑确认、双标签重生成、归档和撤权；检查最终统一导航布局，等待目标页标志后再断言。
5. 对实际发布的Embedding、Rerank、Chat、所用存储（local/MinIO）及启用的OCR完成真实链路；核对citations只来自本轮进入Prompt的候选，严格/降级状态不混淆。
6. 验证SIGTERM、正在生成的SSE、文档任务恢复、代理超时/请求体上限，以及实际日志/指标。Trace/告警在候选包含或用户要求该能力时按对应方案验收；已列为目标但缺载体时保持待验证，不能改写成N/A。
7. 记录未覆盖项与剩余风险，按 [有效待办](15-backlog.md) 判断其是否影响本次发布；不得把未知状态标为通过。

## 已有证据索引

以下保留从历次记录提炼的历史事实与本地证据入口，本轮没有重跑这些测试，也未调查其他分支的执行版本。路径用代码表示：被忽略、仅存在于旧分支或已缺失的产物都不是当前仓库必备文件；旧 OTel 结果不证明当前 dev 已具备该实现。

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

## 记录格式

新增验证结果写明日期、被测版本/改动范围、命令、真实/替身边界、结果、证据位置、未满足项；必要时更新上表。临时端口、PID、曾经使用的账号和重复清理日志留在本地运行产物，不写入现行部署说明。

### DOC-AGENT-001：Agent 工程文档整理（2026-11-18）

状态：完成，工程文档验收通过。任务为 **Documentation / L1**，本任务不改代码、脚本、依赖、产品默认值或运行环境。

- 基线：`dev@dd5a526e50341f6705f4e62dc293d90aee9aa226`，任务最初工作区干净；首次写入前发现独立的未跟踪 `docs/UI_UX_REDESIGN_PLAN.md`，后续观察到独立前端改动。其代码验证归对应任务；本次快照单独列明工程文档和相关事实输入，保留其他任务内容及暂存状态。
- 问题：入口保留早期MVP/PowerShell口径，缺少Git、子代理、风险和内容身份规则；验证文档有失效迁移链接、CI描述不符，发布/配置文档把旧OTel/049方案当作当前dev能力，部分owner-only措辞与能力矩阵冲突。
- 措施：复用现有文档职责，新增必要LESSONS入口；修正已确认的分支、命令和权限表述，保留历史记录与产品决定，不自动实施草案、观测方案或待办。

| 文件 | 本次职责 |
| --- | --- |
| [AGENTS](../AGENTS.md) | 常驻约束、dev分支、任务入口与专项读取触发 |
| [开发约定](00-ai-development-guide.md) | 推进、Git、无历史子代理、执行边界、进度与LESSONS规则 |
| 本文件 | L1–L3、C01–C06、Red/Break、实际检查/运行入口与本次结果 |
| [交接](12-handoff.md)、[待办](15-backlog.md) | 当前分支状态、未关闭/暂缓工作与本次发现的待复核项 |
| [LESSONS](17-lessons.md) | LES-001真实事件与一次复盘证据 |
| [根README](../README.md)、[导航](README.md) | 工程入口与职责可发现性 |
| 产品/架构/数据库/API/配置/错误/前端/部署/可观测性 | 只校正已确认的权限和分支事实，历史OTel方案仍在所属文档 |

共享文件边界：`docs/10-frontend-spec.md` 的“错误追踪编号”由本任务校正，“AI问答页”第17项的预览分栏断点由并行UI工作修改并自行验收。结构/链接检查与SHA-256绑定共享文件的最新全文，但本次语义通过结论只覆盖工程文档改动；其他前端代码不纳入本任务验收。

旧约束对照的基线是上述HEAD的AGENTS及用户提供的子代理约定；这里是迁移记录，活跃规则以链接位置为准。

| 旧条目 | 处理与落点 |
| --- | --- |
| 跟随当前请求，以交接识别现状 | 保留：[AGENTS开始与交付](../AGENTS.md#开始与交付)、开发约定任务推进 |
| 仅按任务需要修改前后端 | 保留：AGENTS明确范围，本次只改文档 |
| 完成实现、相关检查、文档并披露未满足项 | 保留：AGENTS、C01–C06与记录格式 |
| 本地夹具可直接运行，修复并复测不逐步确认 | 保留：AGENTS、开发约定执行边界；真实开关授权要求仍有效 |
| 后端/前端命令和CGO要求 | 迁移：[本地检查](#本地检查)、[运行入口](#运行与初始化入口)；补齐实际CI静态检查，PowerShell改为可用shell与显式工作目录 |
| 按任务读取专项规范 | 保留并补充触发与用途：AGENTS读取表；所需奠基文档由主代理完整亲读 |
| MVP核心闭环及非目标 | 保留核心与禁止未批准扩展；按已有产品说明澄清当前扩展，不删除已支持本地存储/协作/PDF OCR，不新增额外对象存储 |
| DOCX文字OOXML子集、图片/公式/文本框/OCR/.doc不支持 | 保留DOCX边界，明确DOCX OCR与已有可选PDF OCR的区别：AGENTS及产品说明 |
| handler → service → repository | 保留：AGENTS提醒，架构维护职责 |
| 数据库访问GORM | 保留：AGENTS、架构 |
| zap经backend/internal/logger | 保留：AGENTS、架构 |
| Embedding/Rerank/Chat/Title Provider接口 | 保留：AGENTS、架构Provider边界 |
| Rerank属于标准路径 | 保留：AGENTS；现有显式关闭/失败降级仍按RAG/API合同，不冒充精排 |
| 原开发约定的本轮事实依据、历史上下文与分类失败回knowledge_base | 保留：AGENTS常驻约束与RAG规范 |
| citations只来自已精排且进入Prompt的片段 | 保留标准路径；已存在的显式降级仍只用本轮最终候选，不复用旧引用或扩大资料范围 |
| owner_id与当前API矩阵 | 保留所有者及成员能力，修正旧owner-only文字；系统汇总/转移例外按已有API，不授予正文或他人会话权限 |
| 会话user_id必须匹配调用者 | 保留：AGENTS、API会话双重校验 |
| .env真实值与示例占位 | 保留：AGENTS、配置；本轮未读取/修改根.env |
| API camelCase、DB snake_case | 保留：AGENTS、对应专项规范 |
| 公共API/schema/默认值/RAG变化同步文档 | 保留：AGENTS、导航维护规则 |
| 原开发约定的显式迁移、可丢弃库AutoMigrate与单实例worker | 保留：AGENTS、配置/部署、待办多实例前置合同 |
| 本地集成浏览器仅1920×1080 | 保留：AGENTS、开发约定、真实使用验收 |
| 探子宽读、默认配置、fork_turns=none、并发后立即全员等待、一轮、10分钟介入、沿出处复核 | 保留：[子代理](00-ai-development-guide.md#子代理)；并发额度与关闭工具按实际可用能力，不固化示例进程数 |

| 验收 | 当前结果与边界 |
| --- | --- |
| C01 | 通过：旧约束去向、职责和实际命令/权限/分支事实已核对；本任务保留产品决定，未改代码 |
| C02 | N/A：纯文档，不运行应用构建或静态代码门禁 |
| C03 | 通过：两名独立探子按实际任务场景复核，主代理沿关键出处抽查；未发现越权、弱化要求或L1过度验证。行为Red/Break为N/A |
| C04 | 通过：标准库检查19份文档/233处本地链接、围栏/表格/锚点及相关命令/源码入口，Git空白检查通过；新增LESSONS的no-index退出1且无空白诊断，仅表示新文件差异 |
| C05 | N/A：本次不要求业务/模型/MinIO/OCR/浏览器实测，未运行真实服务 |
| C06 | 通过：HEAD/分支、完整文档与相关事实输入的SHA-256、检查回执及独立复核身份保存在下述最终快照；CI未查询，本任务未提交/推送，不宣称应用或CI通过 |

修订前核验保留：探子检查18份已跟踪文档的156处本地链接，发现1处失效文件目标 `backend/internal/database/migration_integration_test.go`；已替换为repository完整迁移入口。历史049/观测命令的载体也不在当前dev，本轮没有执行这些命令，不把它们记录成应用测试失败或通过。

本次最终快照与回执存于 `output/agent-docs-20261118/verification.json`，包含实际文档内容SHA-256、HEAD/分支、检查结果与未运行项；报告自身作为派生证据排除循环哈希，被检查规则不排除。该目录被Git忽略，克隆后不保证存在，提交文档里的结果与范围说明仍保留。

剩余范围：历史观测方案对齐、CHK-001文档回收站边界、CHK-002批量写入故障原子性留在 [待办](15-backlog.md)；都是后续实现/复核任务，本次文档交付不宣称它们已修复或实测通过。

### DOC-CLEANUP-001：文档清理（2026-11-18）

任务：**Documentation / L1**。基线为 `dev@dd5a526e50341f6705f4e62dc293d90aee9aa226` 加任务开始时的未提交内容；当时有20份Markdown，已有工程文档与前端差异，暂存区为空。只整理文档，保留其他任务内容及暂存状态。

| 处理 | 原内容与去向 |
| --- | --- |
| 删除原长计划 | `docs/UI_UX_REDESIGN_PLAN.md` 的环境断言、逐页重复方案、施工步骤和重复门禁退出现行文档；30个UX编号、12个工作包及依赖、待确认事项迁入 [待核对清单](15-backlog.md#ui-调研清单待核对)。未采纳的设计数值不变成规范，未验收的UI不标完成 |
| 精简历史操作 | [可观测性](38-observability.md)保留当前Recorder/诊断入口、历史合同与现行引用的入口锚点，移除无代码/配置载体的部署/迁移/测试命令；历史结果仍在已有证据索引，未关闭条件仍在待办 |
| 收敛入口 | 根README移除重复专项文档表，完整目录统一在 [文档导航](README.md)；交接只链接本记录和UI清单，不复制施工日志。其余现行规范、R01–R09草案、LESSONS和历史验收记录保留 |

状态：完成，文档验收通过（C01/C03/C04/C06）。19份现行Markdown的231处本地链接（含95处锚点）、围栏/表格、导航覆盖及迁移编号已核验；两名独立探子复核后补齐首token计样边界、首页长问题观察，并准确限定保留锚点的范围。20份原文快照、73个其他未提交文件及暂存状态保留一致。C02/C05和行为Red/Break不适用：本次没有代码行为变更，不运行应用构建或真实服务；远端CI未查询。无新增LESSONS事项。

原文和输入身份保存在 `output/docs-cleanup-20261118-102933/`：`before/` 包含本轮20份Markdown全文，`baseline.json` 保存HEAD/分支、文档SHA-256和其他未提交文件摘要，`before.diff`及`staged-before.diff`保存既有差异。UI原文件未提交，恢复依赖该全文快照；目录被Git忽略，克隆后不保证存在。最终检查回执及内容摘要写入同目录的 `verification.json`，派生报告排除自身循环哈希。

### CI-FE-001：前端视口样式 CI 失败核验（2026-11-18）

任务：**Bugfix / L2**。[Actions run 44129711489](https://github.com/Miradui/kbchat/actions/runs/44129711489) 的 `dev@dd5a526e50341f6705f4e62dc293d90aee9aa226` 在 Frontend 的 Test 步骤失败；公开 annotation 指向 `viewport-units.test.ts:47`，检出 `pages/library.css` 的 `40vh`。`.kb-prompt-preview` 须使用 `max-height: 40dvh`，遵循已有竖向视口样式约束。

任务开始时主工作区已有这一行修复及其他UI/文档改动。本轮保留现有代码，在失败提交的隔离副本只应用此单行修复，保存 `fix.patch`；没有修改测试、依赖或CI配置，也未提交/推送。独立核验324个前端及CI跟踪输入，唯一差异为此行；90个既有工作区文件哈希及暂存状态在追加本记录前全部一致。

| 验收 | 结果与范围 |
| --- | --- |
| C01/C03 | 同一原测试在修复前检出 `40vh`（1失败、20通过，退出1），修复后21条通过（退出0）；原断言和非空覆盖保护未改。Red有效；未改关键规则，不另做Break |
| C02/C04 | macOS arm64、Node 22.23.5：隔离候选 `npm ci --no-audit --no-fund`、lint、测试类型检查、build均退出0；`npm test -- --maxWorkers 2` 为109文件/907项通过，退出0；构建验证11个路由分包。当前主工作区的视口测试也在Node22下21项通过 |
| C05 | N/A：本次核验已有CSS单位合同和前端门禁，不要求业务服务、模型或真实浏览器验收；不据静态断言证明移动端软键盘的实际表现 |
| C06 | 失败提交、隔离候选的完整源码快照/输入SHA-256、补丁、命令/退出码、产物摘要及现有工作区基线保存于下述证据目录；远端原run仍为失败，本轮未触发新CI，不宣称远端通过 |

本机默认Node26直接运行时另有 `window.localStorage` 不可用导致的测试cleanup失败；临时禁用实验Web Storage后视口测试通过，正式隔离门禁改用Node22且无需此开关。此环境问题没有被当成远端根因，也没有据此修改产品或测试。完整远端日志因登录/API限流不可得，失败根因由公开annotation和本地同断言复现确认。

证据：`output/ci-frontend-44129711489/verification.json`、`candidate-inputs.json`、`candidate/`、`fix.patch` 和检查日志。目录被Git忽略，克隆后不保证存在；派生报告排除自身循环哈希。新增记录只涉及本节及交接引用，无新增LESSONS事项。完成范围为最小修复的本地核验；整份未提交UI改动未纳入全量通过结论，后续提交/推送后仍须核对对应新提交的CI。

### FEAT-SLIM-001：已确认功能收敛（2026-11-19）

状态：完成，本地实现与适用验收通过。任务为 **Implementation / L3**，风险来自退役迁移及首问命名的并发保护；首页统计和界面调整按受影响行为验收。本次没有提交、推送、发布或执行业务库迁移。

授权来自原评估聊天的12项功能确认及本聊天的继续请求：移除对话分支创建、个人提问模板、搜索CSV导出；标题使用首问摘要与手动改名；首页采用全量待处理数字和最近文档。保留会话导出、收藏备注、PDF OCR/校对、知识库收藏/浏览、费用报表、跨设备偏好、头像与主题、知识库回答模板。

基线：`dev@dd5a526e50341f6705f4e62dc293d90aee9aa226` 加782份现有文件；暂存区为空。完整基线、既有差异和最终检查证据位于 `output/feature-simplification-20261119/`，该目录被Git忽略。范围相对于任务开始的内容快照确定，保留既有UI和工程文档改动；Finder的`.DS_Store`变化不归入实现范围。

实现与数据边界：

- 退役功能已从前端入口、API客户端、路由、业务层及独立模型/Provider中移除；[049迁移](../backend/migrations/049_retire_personal_chat_features.sql)删除个人提问模板表及分支请求幂等字段，历史分支会话、来源关系、消息、引用、收藏备注和`purpose=title`费用记录保留。仅在本轮一次性PostgreSQL中执行迁移；业务部署按[升级步骤](13-deployment.md#7-数据库初始化和升级)停旧后端、备份并显式迁移。
- JSON/SSE首问及已持久化检索失败使用用户问题摘要命名，无标题模型调用；首问命名与消息对共用事务，并使用生成前的标题/时间戳快照保护手动改名。同名保存“新会话”、消息或标题写入失败、取消、重放、后续轮次和重生成均有覆盖。
- 首页使用未截断的处理数字；失败统计在分页前排除取消错误码和最新取消任务，之后真正失败的重试重新计入。最近文档保留状态与链接，重试时优先显示当前任务状态；公共文档台账仍包含取消记录。

| 维度 | 最终结果与范围 |
| --- | --- |
| C01 | 通过：12项已确认决定逐项对齐；知识库回答模板、会话导出、历史资料和明确保留功能未退役。历史分支访问仍按来源资料与当前权限验证 |
| C02 | 通过：Go 1.27.4/CGO与Node 22.23.5；后端vet/build，前端lint、测试类型检查、build及11路由分包均退出0 |
| C03 | 通过：旧版首页漏掉最近样例之外的处理数字、退役API仍可用，及生成期间保存默认标题/重试状态错误均有有效Red。最小破坏标题时间戳保护、049迁移和取消过滤后，目标断言分别失败；均可编译、无跳过或无关失败充数 |
| C04 | 通过：最终后端全量24个测试包、1484个测试/子测试pass事件；最终前端109文件/928项通过。隔离PostgreSQL的repository/database检查44个pass事件、无跳过，覆盖049迁移、历史数据/删除关系、原生时间戳和首问快照；定向首问/首页29个pass事件也通过 |
| C05 | 通过本次适用范围：真实PostgreSQL 16.11/pgvector 0.8.2一次性随机schema，以及Chrome 157的1920×1080生产前端+HTTP内存夹具。浏览器8个场景覆盖全量数字/近期重试、键盘跳转、主题、引用/收藏备注、手动改名/导出、搜索筛选及流式新会话；无页面错误或退役接口请求。模型、MinIO、OCR质量和业务库/发布联调未运行，不属于本次本地功能退役的完成条件 |
| C06 | 通过：最终源码与构建、夹具及脚本内容身份、命令/退出码、Red/Break及浏览器图证保存在下述目录；相关候选源码与工作区逐文件核对，暂存区保持原状。远端CI未查询，不宣称业务已升级或生产部署就绪 |

最终证据入口：`final-manifest.json`、`task.diff`与`scope-verification.json`固定本次范围和源码；`backend-final-*.json/log`、`frontend-final-*.json/log`保存门禁；`break-experiments.json`及对应日志保存目标失败；`browser-observations.json`、`browser-stable-final-command.json`、`browser-final-http-state.json`、`browser-*.png`保存页面与HTTP观察。截图将有限动画推进到结束以获得稳定画面，图证复查及8个浏览器场景重验通过；应用代码和构建输入未改变。环境开关测试的跳过列表在后端全量回执中，PostgreSQL项由单独原生检查补验。

本轮失败及修复保留原回执：漏改的ChatService构造调用与旧诊断断言已补齐；历史用量夹具改为明确时间范围；时间戳迁移夹具不再假定无时间字段或较晚新增表含旧类型。浏览器脚本首次使用旧标题“文档”，依实际页面“文档资料”修正，最终8场景实际结束且退出0。标题同名并发问题的复盘见[LES-002](17-lessons.md#les-002并发保护使用写入前的原始快照)。

最终两名探子分别复核退役/保留合同与文档/证据。代码合同未发现新问题；文档复核发现数据库时间约定和部署段落仍有两句“生产只读启动已实现”的旧措辞，已按实际AutoMigrate入口修正并重验文档。复核输入及结果在`review-input-manifest.json`与`independent-reviews.json`，补修未改变应用代码或构建输入。

部署限制：本轮确认server仍无条件调用AutoMigrate，既有文档的生产只读启动描述不等同于当前实现；[CHK-003](15-backlog.md#尚未关闭的工程事项)继续开放。本次没有扩展为启动机制改造，真实发布仍须处理该事项并完成所属发布验收。


### ENV-LOCAL-001：OrbStack与Ollama本地部署（2026-11-19）

状态：本地开发环境已部署并通过健康与登录检查；任务为Infrastructure / L3。用户授权本地部署及使用已安装的Ollama模型，后续明确“先部署好”，因此不扩展业务/模型质量验收。

- 版本：`dev@dd5a526e50341f6705f4e62dc293d90aee9aa226`加本轮开始的既有工作区；应用源码未修改。内容身份、初始Git状态和产物SHA-256见`output/local-env/initial-inputs.json`、`initial-git-status.txt`、`final-manifest.json`，真实配置只记录哈希，不收录密钥正文。
- 部署：OrbStack提供PostgreSQL 16/pgvector 0.8.7及Redis 7，空库执行50份SQL文件（最高049，含同号完整文件名），再执行带空库守卫的本机`embedding-1024.sql`，向量列与实际Qwen3 Embedding 0.6B输出一致。根`.env`配置Qwen3.5 4B Chat及1024维Embedding；Ollama无原生rerank接口，由其随附llama-server加载已下载的Qwen3 Reranker 0.6B Q8 GGUF提供接口，保持Rerank启用/strict。
- 运行：单个后端、Vite开发前端及Rerank使用当前用户LaunchAgents；容器命名卷持久化且设置unless-stopped，PG/Redis/Rerank/前端绑定本机。后端保持现有监听行为。根`.env`权限0600，JWT为随机值；首次开发管理员初始化成功。启停、日志及Ollama升级路径限制见`output/local-env/README.md`和`manage.sh`。
- 验证：后端相关命令构建、前端npm ci/build及11路由分包通过；显式迁移、1024维doctor、两个容器健康、后端及前端代理healthz的database/redis/storage均为ok，前端HTTP 200，管理员经前端代理登录成功。独立Chat返回OK，Embedding返回1024维，Reranker对中英文相关资料均给出高于无关资料的真实分数；这些有限探测不证明完整RAG质量。
- 本轮失败与修正：镜像拉取TLS/EOF失败后重试成功；首次nohup服务随执行会话结束而退出，改用LaunchAgents并确认运行；复制模板中完整MinIO占位值触发备用远端存储探测，清空未使用连接项并创建本地uploads后健康正常。保留原日志，不用启动HTTP 200代替依赖状态检查。
- C01/C02/C04/C05：通过本次部署范围，依据上述真实回执；C03的行为Red/Break为N/A，本次未修应用行为或修改共享关键规则，采用既有迁移/启动断言及空库保护；C06：本机未提交工作区及产物已固定哈希，远端CI未查询。未运行业务入库/问答、浏览器、MinIO、OCR、恢复演练及生产发布验收；CHK-003仍开放，本次为本机开发环境。LESSONS无新增事项。

详细回执与命令入口仅维护在`output/local-env/`；未提交、推送或修改用户既有应用代码。
