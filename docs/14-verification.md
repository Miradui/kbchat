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

当前 [CI](../.github/workflows/ci.yml) 执行后端 vet/test/build，以及前端 npm ci、lint、测试类型检查、test、build（含 11 路由分包）。它提供一次性PostgreSQL/pgvector测试库，并校验Collector、Prometheus配置与告警规则；模型/MinIO/OCR及真实观测部署仍不在CI范围。

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
| 手动 RAG evals 工具回归 | 仓库根目录 | `python3 -m unittest discover -s benchmarks/tests -v` |

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

入口及变量见 [PostgreSQL 并发测试](../backend/internal/repository/postgres_concurrency_integration_test.go)、[完整迁移测试](../backend/internal/repository/knowledge_workflow_postgres_integration_test.go)、[时间迁移测试](../backend/internal/database/timestamp_migration_integration_test.go)、[MinIO 测试](../backend/internal/storage/minio_integration_test.go)。当前CI显式提供一次性PostgreSQL测试DSN；本地运行也须使用已授权的专用测试库，不能替换为部署数据库。完整迁移入口为 `TestPostgresKnowledgeWorkflowMigrationsAndDocumentScope`；现有 schema 单元测试使用 SQLite，不能据此宣称 PostgreSQL 生产启动约束已实测。

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
- 当前dev包含Recorder、OTel工作流与指标测试及Collector/Prometheus配置/规则，入口见 [当前实现](38-observability.md#当前实现与验证)。真实OTLP转发开关为 `RAG_TEST_OTLP_ENDPOINT` / `RAG_TEST_OTLP_METRICS_ENDPOINT`，仅使用明确授权的专用Collector；真实模型、业务库和MinIO不因观测任务自动获得测试授权。

## 候选版本发布清单

1. 固定提交、依赖锁与构建产物；对同一版本执行后端/前端门禁。先区分已有工作区改动的归属，再决定提交范围。
2. 在授权的隔离 PostgreSQL 执行全部 SQL 迁移与生产启动检查；核对业务环境自己的迁移记录。迁移要求以 [数据库设计](03-database-design.md) 和当前 SQL/启动检查为准，不能凭历史交接判断目标库已经升级。
3. 按 [部署运维](13-deployment.md) 备份同一停写窗口的数据库、MinIO、历史本地文件与配置，验证恢复；随后只执行尚未应用的迁移，运行单个 backend。
4. 1920×1080 验证登录、上传/失败/重试、问答与引用、历史定位/编辑确认、双标签重生成、归档和撤权；检查最终统一导航布局，等待目标页标志后再断言。
5. 对实际发布的Embedding、Rerank、Chat、所用存储（local/MinIO）及启用的OCR完成真实链路；核对citations只来自本轮进入Prompt的候选，严格/降级状态不混淆。
6. 验证SIGTERM、正在生成的SSE、文档任务恢复、代理超时/请求体上限，以及实际日志/指标。Trace/告警在候选包含或用户要求该能力时按对应方案验收；已列为目标但缺载体时保持待验证，不能改写成N/A。
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

### EVALS-SCALE-003：官方200文档与200题基线（2026-11-25–26）

任务：**Implementation / L2**（语料、工具扩容）及 **Exploration / L3**（隔离真实模型运行）。用户认可扩大规模并明确选择公开官方技术文档，继续不做CI门禁。基线为干净的 `dev@911f2c6d6db77f8aceb2459c9d48ea647eca7b18`；不改应用RAG、默认模型或业务库。

语料为 [Kubernetes中文200篇](../benchmarks/datasets/kubernetes-zh-200/README.md)，固定上游 `1ad3951a91f073a5ac0037ede662bebdc054774b`，同提交站点版本v1.37并含发展中特性，不泛化为所有发布版本。200篇在同一知识库；160正例/40缺资料题，150dev/50网络存储主题test，29跨文档题、100篇提供直接gold/100篇干扰。正例依据文档与问题家族不跨split，通用概念仍可能重复；主题保留集不是随机同分布。来源/CC BY 4.0/修改说明和全部依赖hash在数据集内冻结，重建逐字节一致。

工具增加 `--split dev|test|all`、家族隔离、来源clean hash核对、`seed --timeout`与只轮询pending、gold缺失不放行、实际切片统计；evals保存split/topic与intent，支持done或持久消息元数据，general/unknown不移除分母。63项工具测试通过；隔离移除split隔离或放宽gold就绪守卫后目标断言均失败。

独立审查：架构探子A给出扩容边界；4个来源起草探子QW/QP/QO/QT各50题，只有获准/tmp草案；RWP/ROH逐题审200题，RCODE审工具及清洗，RFIX定向补审修复，均无项目文件修改。初审发现动态feature-state丢状态、第三方声明误删，以及7道跨文档必要性不足和2道限定歧义；主代理修复后，独立Ruby YAML核对93个实际依赖gate、140处状态/74篇和14篇三分支声明一致，9道题修正及全部200篇重建一致。复盘见LES-005。

真实运行于2026-11-25 23:16至26日00:33完成（Asia/Shanghai）：DeepSeek Flash、Qwen3 Embedding 0.6B/1024维、ollama-reranker；TopN30/TopK5/标准阈值0.3、排名对照阈值0。两个独立run均导入200篇、2374片，发布正文内容哈希一致；估算687473切片token、247批Embedding（非计费token/实际调用回执）。先dev后test，中间不调参；160道正例在发布切片中都可用最多4片覆盖全部gold锚点，没有先天超过Top5才能覆盖的题。800次原问句检索、200次真实问答全部完成；全部问答intent为knowledge_base，未发生Rerank fallback。

| 指标 | dev | 网络/存储主题test | 描述性合并 |
| --- | --- | --- | --- |
| 严格回答通过 | 139/150（92.67%） | 42/50（84.00%） | 181/200（90.50%） |
| 部分完整/附加断言/引用问题 | 11 | 8 | 19 |
| 默认原问句检索完整依据 | 111/120 | 38/40 | 149/160（93.13%） |
| 聊天最终上下文完整依据 | 109/120 | 35/40 | 144/160（90.00%） |
| 跨文档题严格通过 | 12/21 | 5/8 | 17/29（58.62%） |
| 缺资料所求值未编造 | 30/30 | 10/10 | 40/40；整条回答严格通过38/40 |

原问句vector/hybrid/reranked/standard完整依据分别134/118/149/149（分母160），文档Recall@5分别95.94%/93.75%/98.75%/98.75%，标准MRR@5为0.9572；找到文档不等于找齐事实。同一standard响应debug中完整依据由召回并集158降到融合Top30的154，再降到精排Top5的149，阈值0.3未额外损失完整题数。聊天经过改写，不能把原问句检索值直接当作聊天上下文结果。

本机Apple M5/32GB、OrbStack10CPU/约15.66GiB；顺序问答首字P50/P95为7.40/12.96秒、完成8.12/14.39秒；标准检索P50/P95为5.81/7.57秒。向量查询已预热，真实本地精排是主要等待来源；本轮没有并发压测，不能沿用小语料时延或推断最大QPS。

答案审核JW/JP/JO/JH由4个独立通用子代理各核对50题实际答案与引用，分别46/47/46/42通过，4/3/4/8部分完整；仅写获准/tmp标签，未修改项目。主代理整合标签并核对全部19个partial、40个缺资料回答和其他可疑项。审核属于AI来源可见非盲审核，非人类领域专家盲评；0个fail不等于零错误。W11/O38存在不支持的引用格式，自动sourceIndexValidity对未识别语法不报错，不能据该值宣称引用全正确。H24冻结参考额外要求题面未明确要求的检查时机，保留原partial；仅按题面接受时test为43/50（86%）、总体182/200（91%），只作敏感性分析，不改旧标签。未来修题或调参须另建保留版本。

C01/C02/C03/C04：工具静态语法与63项测试通过；家族隔离及gold就绪守卫Break均检出目标回退，清洗保真/问题来源/完整重建经独立审查。C05：两组隔离真实服务完成所有计划样本并停止，所属运行容器为0、卷与证据保留；未改业务服务。C06：运行代码与数据冻结身份一致，最终只读审查RFINAL独立复算1000样本、200份审核hash、全部指标/阶段/时延及发布切片，并确认两份evals与内存重算逐字段相等；1750个唯一文件内容核对、103处文档链接和63项测试通过，未发现重要问题；不设置质量CI门禁、不推送或部署，远端CI未运行。暂存全量diff检查报告导入正文及原版LICENSE中的上游行尾空格/末尾空行；为保留已测语料哈希与Markdown换行，保留原文，排除这两类导入文件后的代码/自有文档diff检查通过。应用后端/前端未修改，不重复应用全量构建；企业语料、专家盲评、多轮、注入对抗、OCR和并发容量未验收。

证据：`output/evals-scale-20261125/` 保存固定上游checkout、运行计划、12步退出回执、语料/阶段统计、冻结审核包与标签、metrics.json、详细report.md和最终内容manifest；原始run位于 `output/benchmarks/kubernetes-200-dev-20261125/` 和 `kubernetes-200-test-20261125/`。这些output目录被Git忽略，克隆后不保证存在；仓库保留语料、许可、工具及此结果记录。数据身份为 `1459831c9ba4b74461eec685fee3df977e64a64bca625201fdb362773a978b08`。本轮是扩大评测而非调参提升，跨文档、融合截断及精排延迟继续列为待办；主代理完成整合与最终验收，本地提交回执保存在final-manifest.json；未推送。最终审查仅提出该manifest入口当时尚未生成，已在交付归档时补齐；报告同时明确1100/500为累计预算预留量，每run上限仍为2000。

### EVALS-RUN-002：当前版本48题与性能实测（2026-11-25）

任务：**Exploration / L3**（隔离真实模型与容器测量），附带 **Bugfix / L2**（离线评分管道读取）。用户要求按新的evals重新测试，继续不做CI门禁。应用测量版本为干净的 `dev@c3cb328f7cb2f55e0d95158354ce04918a442f3d`；仅离线评分器、其回归测试和结果文档有后续修改，后端与模型配置不变。

- 环境与输入：独立Docker Compose、PostgreSQL/pgvector、Redis和上传卷；Apple M5/32GB，OrbStack 10 CPU/约15.66GiB。DeepSeek Flash、本地Qwen3 Embedding 0.6B/1024维、ollama-reranker；48题/6篇虚构Markdown/33切片，39道有依据、9道缺资料。TopN30/TopK5，标准和聊天阈值0.3，排名三组阈值0；实际运行镜像与输入哈希留存。
- 检索：192/192成功；四模式文档Recall@5均100%。完整依据Top5：vector、hybrid和standard各38/39（97.44%），reranked阈值0为39/39。MRR分别0.9829、0.9872、1、1。vector漏T08，hybrid与standard漏E05；本轮原问句审批片段精排第3、0.164578，被0.3过滤，不混用历史改写查询的0.0241。
- 质量：48/48请求完成，严格完整44/48（91.67%），部分4题E05/T02/T03/T15，无核心错误fail；有依据题完整35/39（89.74%），9/9缺资料题未编造所求值。回答上下文及正文实际引用完整依据均38/39；引用编号48/48合法。主代理亲审48题，两名独立子代理各24题，结论一致；这是AI来源可见非盲审，不是业务专家审核。T02要求分别明示数据库及附件14天、T03明确一个实例、T15还要求测试构建和版本产物记录，冻结标准比部分题面自然读法更严；保留原标准，不事后抬分。
- 流式：10题、每轮每题2次，并发1/2/4、两轮正反顺序，各40请求；120/120完成，均有多个delta且无Rerank fallback。首字P50为3.54/3.58/3.81秒，P95为5.21/5.75/5.38秒；完成P95为5.57/6.14/5.68秒。包含分类检索等待，非纯模型TTFT，不含会话创建/浏览器/代理。
- 负载：两个知识库分别1,000/10,000条随机1024维向量（100/1,000文档元数据），全表合计11,000合成向量加33质量切片；列表/向量、并发1/4/16、每组合1,000请求，共12,000/12,000成功。1万向量组P95为30.70/147.88/616.15ms；驱动观察吞吐32.70/34.39/36.64req/s，包含预算/落盘及客户端开销，不是最大QPS。本轮没有EXPLAIN，不从旧计划推断新运行使用HNSW或顺序扫描。

执行入口：仓库根目录 `python3 output/evals-run-20261125/execute.py`，冻结计划依次执行现有 `init/up/seed/run retrieval/run quality/run stream/run load/down`；所有阶段退出0。通过 `review --import` 导入48条答案与引用哈希绑定的审核，`evals --run output/benchmarks/evals-20261125-current` 生成最终报告。顶层模型相关预算6510/7000（含缓存命中搜索），不等于Provider请求数或费用。测试容器已停止，所属运行容器数0，卷及证据保留，原业务环境未写入。

失败及修复：完整48题评分首次触发Node `readFileSync(0)` 非阻塞管道EAGAIN；改为异步读stdin至EOF后解码。仅离线解析器改变，未重跑模型或改原样本。新增48条超管道容量Unicode批次测试，旧代码在隔离副本出现目标断言失败，修复后50项benchmark工具测试通过、无跳过；Node语法和Git空白检查通过。本次没有生产规则变化，不另做业务Break；真实测量与工具缺陷分别保留证据。

独立验收：EVALS-RUN-002-QA/QB分别只读审核24题，与主代理48题主审一致；EVALS-RUN-002-AUDIT独立复算12,360条样本、分母、Recall/MRR、引用指标、各组P50/P95及驱动吞吐，全部匹配。AUDIT核对12,429份文件哈希、复现原stdin的EAGAIN、验证修复后48条大批量结果并运行50项工具测试，无遗留P1/P2。三名子代理均未修改文件，主代理完成评分器修复、报告及文档集成；应用测量输入和原始结果保持不变。

状态：本轮测量、审核、工具修复与本地验收完成。证据：`output/benchmarks/evals-20261125-current/`保存原始样本、plan、manifest/runtime身份、review、summary/report及evals；`output/evals-run-20261125/`保存冻结计划/rubric、执行回执、独立审核包、主审笔记、指标汇总、可用于简历的报告、Red/最终测试及`final-manifest.json`。本地提交SHA随交付记录保存，未推送；目录被Git忽略，克隆后不保证存在。未执行业务数据、MinIO/OCR、多轮泛化、浏览器或远端CI验收；无调参提升、最大QPS或总体准确率结论，BENCH-RAG-001-Q/P保持开放。

### EVALS-001：手动 RAG 离线评测（2026-11-25）

任务：**Implementation / L2**。用户要求添加 RAG evals，随后明确“不做 CI 门禁”。基线为干净的 `dev@05e9b833c7447d4357210bad402b757ac905c819`。范围仅为 benchmark 工具、相关测试与使用/交接记录；不修改 CI、应用代码、数据库、模型配置或生产 RAG 行为。

状态：本地实现、相关验证和独立复核完成；不推送或部署。本次交付为评测工具，当前版本的真实模型质量未重新验收。

实现：新增手动 `evals --run … [--baseline …]`，从冻结语料、运行文档映射、cohort 计划与原始样本重算，不信任缓存 checks。报告保留计划分母、失败/未知/未运行/无效状态、各检索模式、题型与分组，区分全部引用和正文实际标注的依据覆盖。事实/完整性/引用支持/缺资料处理继续依赖答案哈希绑定的人工审核；不完整审核和 fixture 不生成语义准确率。基线对比只输出兼容指标差值；低分、不完整和不可比较不产生质量失败退出码，输入损坏或过期审核仍报错。

本地验证：

- C01/C02/C04：新增21项评分、报告、离线CLI和边界测试；全部49项benchmark测试通过、无跳过，包括真实Markdown适配器的26组语法/上下文及CLI集成。复用原审核校验并保留既有导入测试。CLI检查显示不构造Runtime、不检查当前应用源码、不改写原benchmark报告；无新增依赖或前后端构建目标。quality评分使用Node 22.18+、现有前端依赖和产品引用插件；本机实测Node 26.13.1，未单独复验22.18版本。纯评分单元测试用固定解析结果，缺前端依赖时两项集成检查明确跳过。
- C03：新功能无旧评分行为，最初功能Red不适用。三个隔离Break分别把计划分母换成成功分母、把正文引用覆盖换成全部片段、删除审核答案哈希校验；对应测试均出现预期断言失败，非编译或环境失败。独立审查发现初版正则不支持组合引用、误计代码/链接，以及MDAST会计入未显示的脚注；修复直接复用产品Markdown/引用插件及后续渲染树转换。隔离恢复初版引用算法、撤回渲染树转换后，对应合同断言均失败；最终适配器通过全部26组。原工作区未被破坏。
- C05：对本机已有 `suite-smoke-final`（fixture）、`suite-real-001` 与 `suite-real-final`（历史real）执行离线命令；两类报告均生成，同一输入自比差值为0，不同题目计划拒绝给差值。原语料、样本、审核及旧报告哈希保持一致。未启动Docker/业务服务，未重新调用真实模型；既有真实样本只证明离线读取兼容性，不证明当前版本RAG效果。
- C06：最终输入身份、检查回执、历史输入未修改证据与Break日志保存于 `output/evals-20261125/`；派生记录自身排除循环哈希。最终内容见 `final-manifest.json`，本地提交SHA随交付报告保存；本次无推送授权，远端CI未触发或查询，不增加质量门禁。

子任务：EVALS-001-A 为通用子代理按架构指令只读调查已有语料/执行/审核/比较接口；EVALS-001-R运行47项测试并发现引用语法/上下文P2问题，EVALS-001-R2运行21项测试，确认原问题修复并发现未引用脚注P2问题；EVALS-001-R3在修复后运行3项适配器测试，并以产品实际SSR渲染独立对照26组场景，未发现新问题。子代理均无文件修改；主代理完成代码、测试与文档修改、两项修复和最终集成验收，未遗留重要审查项。使用口径与局限只维护在 [benchmarks README](../benchmarks/README.md#手动-rag-evals)。现有BENCH-RAG-001-Q/P待办继续保留；无新增LESSONS事项。

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

### MERGE-OBS-001：合并远端监控与本地功能收敛（2026-11-19）

状态：本地合并验收通过；合并提交 `7271cda` 已推送到 `origin/dev`，远端CI以对应提交的Actions实际回执为准。基线为本地提交 `3e9daf0497ba0f8622719fc7e707faa6e412ab72`，合并远端 `origin/dev` 的 `ebe0144720c7a67e3205f3a5154a5b0fa79404ad`；合并前备份分支与 bundle 位于工作区外的 `kbchat-premerge-20261119-3e9daf0/`。`.DS_Store` 临时文件未纳入提交。

- 合并保留本地已确认的功能退役、首问摘要标题和 UI 改动，并接入远端的 OTel Trace/Metrics、请求追踪编号、任务 `traceparent`、安全响应上限、启动只读 schema 检查、worker/聊天并发保护和观测部署配置。两个 `049` 文件按完整文件名分别保留：`049_document_job_traceparent.sql` 与 `049_retire_personal_chat_features.sql`。
- 后端：Go 1.27.4，继承的 `RAG_TEST_*` 开关为空；受影响包定向测试通过。全量 `go test -json ./...` 通过 1584 个 pass 事件、0 fail、5 skip；`go vet ./...`、`go build ./...` 通过。`go test -race` 覆盖 observability、service、repository、router、job、cmd/server 通过。一次性 PostgreSQL 16/pgvector 测试库执行完整迁移、EnsureSchema、049 traceparent 重复执行和约束拒绝检查通过。
- 前端：Node 22.23.5；`npm ci --no-audit --no-fund`、lint、测试 TypeScript、`npm test -- --maxWorkers 2`（110 文件/943 项）和生产构建/11 路由分包通过。
- 观测配置：Compose config、Collector validate、Prometheus config 和 10 组告警规则检查通过。真实 Collector/Jaeger/Grafana 查询、业务模型/MinIO/OCR 质量、目标业务库升级和发布联调未运行。
- 远端：查询到 `origin/dev` 最新历史 run `44523440691` 对 `ebe0144` 结论为 failure；它不能代表本次合并候选。推送后需查询新提交对应 CI 结束状态，不能沿用历史失败或本地通过结论。

本次冲突解决后的代码、配置、SQL、文档和CI内容身份保存于 `output/merge-observability-20261119/candidate-manifest.json`，命令及退出码保存于同目录 `backend-results.json`、`frontend-results.json`、`observability-results.json` 及各检查日志。派生报告不参与自身哈希，相关输入不排除；该目录被Git忽略，克隆后不保证存在。C01/C02/C04通过当前合并范围；C03复用现有标题事务/归档/退役/遥测断言及迁移缺列破坏场景，不新增关键规则或独立功能；C05限于一次性PostgreSQL和观测配置/规则，真实业务部署与浏览器未验收；C06在推送后继续核对新提交CI。代码独立复核未发现可行动回归，文档复核发现的入口/保留期/证据引用已补齐。

### ENV-OBS-002：本机环境更新与监控部署（2026-11-19）

状态：完成，本机应用和监控部署及适用实测通过。任务为Infrastructure / L3，用户授权重新部署本机环境及监控。源码为 `e1cda2442db7b0d3051ede5ef1d63e74f8fc8005`，本轮未修改应用源码；沿用OrbStack的deploy项目、数据库/Redis原卷、1024维向量及Ollama/Rerank配置。

- 在停止前后端、确认后端进程退出后备份本机数据库/原文件、根.env、LaunchAgents及旧程序；备份目录权限0700。数据库dump已在独立临时容器恢复，1个用户、0篇文档及vector(1024)一致。仅执行缺失的 `049_document_job_traceparent.sql`，未重跑全库迁移或退役迁移。
- 当前源码重新构建前端及六个后端命令，构建通过。安装新二进制并设置本地Trace/Metrics OTLP端点，默认只读EnsureSchema启动成功；doctor确认1024维、pgvector 0.8.7和Redis正常。应用健康、登录、管理员诊断与首页API通过，1920×1080浏览器首页/诊断页显示正常。
- Collector、Jaeger、Prometheus已运行：真实应用Trace可查询，应用心跳/请求计数/队列成功状态进入Prometheus；观测工作流使用SQLite及模型HTTP夹具向真实本机Collector转发，两个定向测试通过。Grafana 13.3.0及数据源代理查询通过，18个面板查询均能执行；Jaeger查询到真实诊断请求的16个span，Prometheus当前实例心跳新鲜、两个队列采集成功，8条规则health=ok且inactive。
- 本地compose override为四个监控服务增加unless-stopped；现有manage.sh覆盖完整observability profile。后端LaunchAgent退出预算改为30秒，保留单个backend/worker。

证据位于 `output/local-env-monitoring-20261119/`：初始源码SHA-256、build-results.json、migration/doctor/app-health、backup-restore、live-otlp-workflow及core-metrics/Trace回执；本地运行资料和备份被Git忽略，不能作为克隆仓库的必备文件。真实模型RAG质量、MinIO/OCR及生产发布不在本次部署验证结论内。

本轮补充结果：新版启停脚本已实际完成一次全环境restart，采用bootout并等待旧PID退出后bootstrap；六个容器均running且unless-stopped，前后端/重排LaunchAgents运行，只有单个backend。1920×1080浏览器检查首页、系统诊断、Jaeger真实Trace、Prometheus告警及Grafana看板通过；缺少真实模型/问答流量的面板如实显示No data。

保留的失败与修正：镜像下载耗时较长，应用先恢复；首次直接执行Grafana表达式未展开模板变量而返回400，使用实际服务及5m窗口展开后18项通过。restart后旧实例最后一次队列采集失败值短暂保留，第一次检查未通过；旧样本过期后重新检查通过，未删除历史指标或放宽断言。原重启脚本的kickstart -k改为bootout/等待/bootstrap，以遵守退出预算。

C01/C02/C04/C05通过上述部署范围；C03行为Red/Break不适用，本次未修改应用关键规则，复用已通过的迁移/观测断言，实测备份恢复与重启；C06固定e1cda24源码、已安装二进制、前端构建、容器镜像ID、部署配置与证据SHA-256，敏感.env仅记录哈希。最终回执为同目录 `final-manifest.json`、`deploy-result.json`、`evidence/live-checks.json`、`evidence/containers-final.json`、`evidence/status-final.log`与浏览器截图。源码对应CI在前轮已实际通过（run 44538596582），本轮只修改本机运行配置/脚本及部署记录，没有新增应用代码或推送。升级备份保留在该目录的backup，权限0700，未自动删除。

### BUG-IME-001：中文输入法确认回车误发送（2026-11-19）

状态：修复及本地验收通过，任务为Bugfix / L2。基线为dev@e1cda24加既有部署文档差异；暂存区为空，保留既有文档与未跟踪文件。普通发送只经过ChatComposer，新对话与已有会话共享同一实例逻辑。

- 问题：键盘发送仅检查nativeEvent.isComposing，组合状态未暴露或compositionend早于确认Enter到达时会错误提交；Safari的确认键可仍带keyCode=229。补充compositionstart/end状态、229兼容判断及表单组合状态守卫；确认后的下一次Enter和点击发送正常，Shift+Enter继续换行。没有新增延时窗口、后端改动或改变现有输入法期间不发送的产品合同。
- C01/C03：新增三个事件序列用例，修复前均因onSubmit意外调用而失败（3失败/7通过、退出1）；修复后10项通过（退出0），覆盖缺少原生组合标记、Safari确认顺序、组合期间表单提交及确认后恢复发送。Red同时证明关键组合状态/229守卫的目标回退可被捕获；未另做破坏实验。
- C02/C04：Node22.23.5，ChatComposer、ChatPage及播报/导出4文件121项通过；前端lint、测试TypeScript、生产构建与11路由分包均退出0。变更局限于共享输入框，未扩大到首页导航或编辑重生成快捷键。
- C05/C06：测试使用jsdom合成composition/keyboard事件，不冒充真实操作系统输入法验收；未调用业务模型，未启动/停止用户接管的后端，未提交/推送或触发远端CI。基线全文/哈希、Red/Green、门禁日志及最终内容身份保存在 `output/chat-ime-20261119/`；目录被Git忽略，克隆后不保证存在。

现代Web指南采用ime-safe-enter-submit的229兼容策略，保持显式发送按钮与既有原生表单路径。没有新增LESSONS事项。

### DATA-DEMO-001：本机演示资料（2026-11-19）

状态：完成，用户授权补充本机测试数据。任务为Infrastructure / L2；以现有用户admin通过应用API创建3个明确标记【演示】的私有知识库、6篇合成Markdown文档和6道带参考答案/引用要求的评测问题。批次为kbchat-demo-20261119-v1，资料明确说明虚构用途；保留原有1个知识库，不覆盖既有内容。文本上传使用固定requestId，知识库及评测问题先精确匹配再创建，结果及时保存便于对账。

6篇文档均由真实worker完成解析、切片、1024维本地Embedding；API预览可读。三组样例语义检索经过本地Rerank并返回相关片段，无降级；分别覆盖远程办公制度、产品套餐表格和恢复/备份多段资料。6道评测问题已保存但未执行评测运行，本次未调用用户新配置的Chat模型，不据检索结果声称回答质量通过。

处理了本次数据导入的运行前置：用户手动后端从backend/cmd/server启动，相对UPLOAD_DIR指向缺失目录；创建该处uploads到既有backend/uploads的相对符号链接，health由storage=down恢复为全部ok。未重启/终止用户进程或修改.env；两个启动目录共用相同存储，避免演示资料分散。

证据在 `output/demo-data-20261119/`：dataset.json及documents保存资料全文，before-inventory.json保存既有知识库ID，state.json保存新资源ID/requestId，run.log、retrieval-checks.json、verification.json保存处理/预览/检索/健康及资料哈希。C01/C04/C05/C06通过本次新增数据范围；C02/C03的应用构建与Red/Break不适用，本次未改应用源码或规则。保留已有IME修复和文档差异，未提交/推送，无新增LESSONS事项。

### BUG-MD-001：聊天原文预览Markdown排版（2026-11-20）

状态：修复及本地验收通过，任务为Bugfix / L2。用户截图中的Markdown表格在聊天引用摘录及原文中均显示为管道文本；文档详情已有安全渲染，但ChatSourcePreview仍使用blockquote/pre直接输出。基线为dev@e1cda24加已有IME修复及部署/演示文档差异，暂存区为空；旧差异保留。

- 将既有文档阅读渲染抽为共享DocumentMarkdown，保持GFM、skipHtml、默认URL过滤、图片替代文字和普通source标记。聊天两处采用同一渲染，非Markdown及PDF仍走原路径；跨页面阅读样式移到共享样式表。
- 高亮沿用既有BOM/CRLF规范化和UTF-8字节转换，在完整Markdown的AST文本节点上标记，不向原文插入HTML或拆断表格。实体/转义/代码不能直接映射时标记相交文本单元；定位ref指向首个标记，同文档切换引用重算高亮。滚动容器及表格可键盘聚焦。
- C01/C03：两项用户场景回归在旧代码明确失败（找不到标题/表格，2失败19通过，退出1）；修复后通过。另覆盖中文/emoji/CRLF、重复段落、实体/转义、加粗/链接、列表/代码、同文档切换、清除高亮以及HTML/危险链接/远程图片边界。没有新增安全授权规则，不另做全局安全策略变更。
- C02/C04：Node22.23.5，7个相关文件179项通过；lint、测试TypeScript、生产构建及11路由分包通过。初次类型检查发现Root可含Doctype的类型不兼容，改为只替换匹配的文本节点后复验通过，原失败日志保留。
- C05：1920×1080本机真实前端与用户运行中的后端，打开已有“北京出差住宿报销多少？”会话的差旅文档；摘录及原文均有表格，原文12个表格单元格高亮，点击定位可用；切换到第二条引用后表格标记清除、仅对应段落高亮。页面宽度与scrollWidth均为1920，无整页横向溢出；未发送消息、调用模型或重启后端。
- C06：源码输入、构建、命令/退出码与截图位于 `output/markdown-preview-20261120/`（baseline.json、red.log、checks.json、verification.json及browser-*.jpg）；目录被Git忽略，报告本身不参与循环哈希。独立代码复核未发现可行动缺陷；未提交/推送或触发远端CI，不据本地验证宣称已发布。

现代Web指南仅用于避免不可信HTML进入危险DOM入口，继续通过既有React Markdown节点渲染；没有新增LESSONS事项。

### BUG-PREVIEW-001：来源预览掉到页面下方（2026-11-20）

状态：修复及本地验收通过，Bugfix / L2。用户确认点击回答编号后预览落到页面下方、被遮挡或挤变形。基线为dev@e1cda24加已有IME、Markdown及部署/演示文档差异，保留既有工作区和空暂存区。

- 根因：桌面分栏从1280px开始，但旧的max-width:1599px规则仍让chat-preview跨全部网格列，面板被放到下一行，并和对话平分可用高度。1440×900实测修复前预览top=478、width=1204，聊天高度422，页面scrollHeight=1201；与既定右侧360px分栏合同冲突。上一轮1920验证未覆盖该断点，保留其历史范围，不当作本次布局通过证据。
- 移除失效跨列规则，将最小阅读高度仅用于1279px及以下抽屉；桌面内容按可用高度收缩并内部滚动。引用自动定位及按钮共用容器scrollTo，避免scrollIntoView带动页面和其他面板。Markdown、权限及聊天写入流程未改。
- C01/C03：浏览器尺寸证据直接复现错位；定位范围测试在旧实现失败（2失败20通过），修复后通过。C02/C04：4个相关文件133项通过，lint、测试TypeScript、生产构建/11路由分包通过。本次无新授权或并发关键规则，不另做Break。
- C05：真实前端与现有演示会话，在1440×900重复打开/关闭/切换引用及定位，预览恢复top=56、left=1080、width=360，对话高度844，页面scrollHeight=900。1280/1599/1600/1920宽边界检查均保持同顶右侧分栏和无页面溢出；1279px抽屉的标题和页面位置在定位后保持。标准1920×1080验收同时通过；额外尺寸只针对已复现的断点缺陷。未重启后端或发送模型请求。
- C06：输入快照、差异、Red/Green、门禁和浏览器尺寸/截图存于 `output/citation-layout-20261120/`（before/、baseline.json、red.log、green.log、checks.json、browser-red.json、browser-green.json、verification.json），目录被Git忽略。未提交/推送或触发远端CI。

使用Modern Web Guidance的css-layout指导保留明确网格列和容器内滚动，未以隐藏页面溢出来掩盖错位。

### REL-COMPOSE-001：Docker/Compose发布候选（2026-11-20）

任务：Infrastructure / L3。用户授权“先弄成可发布的版本”，明确Docker/Compose。版本为0.1.0-rc.1；基线dev@e1cda24加已完成的IME、Markdown、预览布局修复与部署/演示记录。单后端/worker、本地文件具名卷为本候选的验收范围，用户手动运行的原环境保持运行。安装/升级合同统一见 [Docker发布说明](../deploy/RELEASE.md)，发布内容见 [变更说明](../deploy/CHANGELOG.md)。

交付：多阶段前后端Dockerfile（基础镜像digest固定、构建上下文白名单、非root后端及只读根文件系统）、生产Nginx/Compose、内部数据库/Redis、精确可信代理IP、持久卷、35秒停止预算、依赖响应体探针、可选独立监控栈。release.sh提供空库初始化、首位管理员、停止后指定迁移、备份及空目标恢复；源码打包仅使用已提交Git内容，不含真实env/数据/证据。CI新增Linux amd64整套容器构建及初始化/重启冒烟。

发布阻断修复：CHK-001全局文档回收站列表/清空排除已删除知识库；CHK-002批量收藏、取消、分类移动统一repository事务，后续数据库失败全部回滚，分类移动仅更新相关字段；额外发现的批量删库同类缺口一并修复。后续目标被删除导致零行更新也回滚。既有权限预检、用户资料、RAG候选和引用合同保持。

| 验收 | 实际结果与边界 |
| --- | --- |
| C01 | 近期前端修复全部纳入；明确单实例、本地卷和显式迁移，R01–R09及多实例未扩展；生产秘密不进入构建/提交 |
| C02 | 最终后端1594个测试/子测试pass事件、5项真实服务条件跳过；vet/build及repository/service/router/job/server五包race通过。前端111文件952项、lint/测试类型/build和11路由分包通过。Docker arm64镜像构建及整栈启动通过，amd64由最终提交CI确认 |
| C03 | SQLite旧实现复现收藏/取消/分类部分写入和回收站越界（5子场景失败），批量删库另有有效Red；原生PG触发器验证四类批量回滚。隔离移除清空回收站过滤后目标断言失败；放行restarting的脚本副本被测试拒绝。初始化已有库/运行中迁移备份拒绝用实际Compose及fake-Docker状态测试覆盖 |
| C04 | 一次性PG完整SQL迁移/约束和回滚通过；生产Compose初始化1024维、管理员、SPA刷新、应用健康、重启通过。独立权限场景验证未授权读取/跨用户会话拒绝、viewer正文可读且原文件拒绝、撤权后不可读、归档写入409、已删库文档不被清空及恢复后可读 |
| C05 | 隔离容器真实入库6文档，三组Embedding/Rerank检索无降级；DeepSeek当前模型deepseek-flash六题规则全部通过，人工对照合成资料及引用编号一致。流式问答期间SIGTERM约3秒正常退出且返回done；带六篇原文件/向量/会话引用的停写备份恢复到独立空项目，下载哈希、三组检索和持久消息/引用验证通过。1920×1080生产Nginx前端登录、文档/刷新、Markdown引用及评测结果页面通过。可选监控组合的Trace、心跳与18面板已查询通过 |
| C06 | 最终提交与CI回执、源码/镜像/产物摘要保存在output/release-compose-20261120；交付包由package-release.sh从最终已提交内容生成，SHA256SUMS可核对。正式远端发布/镜像仓库推送和目标业务部署不由本地候选准备替代 |

实际失败及修正保留：第一次容器启动因动态地址分配占用固定Nginx IP失败，改为固定地址在动态池外后初始化/重启/CI冒烟通过；脚本运行中编辑导致一次旧进程解析错误，脚本固定后重新构建/语法检查通过；权限验收脚本误将restore的204期待为200，按实际API合同修正并对账后复验通过。独立审查发现的宿主COMPOSE_PROJECT_NAME污染和restarting绕过停写守卫已修复，并以同名变量污染的实际冒烟及独立状态测试验证。

证据入口：baseline.json、guards-red.log/guards-green.log、batch-delete-red.log、guards-postgres.log、backend-final-checks.json、frontend-checks.json、compose-smoke.log、init/start日志、acceptance/evaluation-runs.json与manual-answer-review.json、stream-shutdown.json、backup/restore日志与restore-verification.json、access-acceptance.json、optional-monitoring.json、browser-*.jpg及最终verification.json。包含真实凭据的runtime.env和备份仅留在被忽略的本地目录且权限受限，不进入发布包。

剩余边界：六题仅为有限合成样本，非总体模型质量保证；生产域名/TLS、外部网关真实客户端IP、用户语料、MinIO及启用OCR要在实际目标配置复验。镜像提供OCR工具但本轮默认关闭。SSE没有周期心跳、worker没有各自独立心跳、文本超大资料统一预算、迁移版本台账及多实例仍在待办，当前单实例发布不承诺这些能力。

### BENCH-RAG-001：性能与回答质量基线（2026-11-21）

状态：测量及结果核对完成，发现的质量/性能问题仍在有效待办。用户授权实际测试性能与质量；任务为Exploration / L3，固定应用代码dev@7736aff。本轮仅增加隔离测量材料和文档记录，未修改应用代码或默认配置。

环境为Apple M5、10核、32 GiB主机，Go 1.27.4原生单后端，OrbStack独立PostgreSQL16/pgvector0.8.7和Redis；专用端口18880/15433/16380与上传目录。空库执行全部迁移并设1024维向量列，模型为DeepSeek Flash、本地Qwen3 Embedding 0.6B与本地Q8_0 Reranker。OTLP导出关闭；隔离环境聊天限流提高至10,000/min。原业务服务和数据库未迁移、重启或写入。

- 质量：6篇合成Markdown真实入库，得到33个切片；36题参考事实在调用前固定，27道有依据、9道缺资料，全部流式完成。主代理逐题对照原文，两位子代理各独立核查18题，严格完整通过33/36（91.7%），部分3题；没有领域专家人工或盲评。E05漏掉审批条件，T02/T03为明示完整性/操作含义不足；9道缺资料题未编造所求值。34个answered、2个no_basis不能直接解释为正确率。
- 检索：TopN30/TopK5、显式threshold=0的原问句排名对照，完整必要依据进入Top5分别为纯向量26/27、混合27/27、混合+精排27/27；默认0.3阈值则26/27。E05重写查询下审批片段精排分约0.0241，诊断设0时可取到，0.3时被过滤。诊断未改库配置或覆盖原结果。
- 容量：1,000/10,000条确定性随机归一化向量，分别对应100/1,000份元数据文档；列表与向量检索、并发1/4/16、每组1,000次，共12,000次全部成功。10,000向量检索查询向量缓存100%命中，关闭关键词/精排；P95为30.3/146.1/589.7 ms，观察吞吐34.4/36.0/37.9 req/s。EXPLAIN ANALYZE显示默认计划顺序扫描10,000个chunks、连接1,000份documents并排序，约32 ms；没有使用HNSW，不称ANN索引基准。
- 流式：固定10个有依据问题、独立会话及请求ID，两轮顺序1→2→4与4→2→1，每档40条，共120条全部knowledge_base/answered并收到done，无降级。合并首个非空delta P50为3.82/4.14/3.95 s、P95为9.41/7.77/5.14 s；完成P95为11.63/8.10/5.48 s。远端模型及分时环境有波动，不能推导并发加速或最大容量；会话创建不在计时内，HTTP连接不复用。

测量入口、原始样本与详情位于 `output/benchmark-20261121/`：report.md、cases.json、environment.json、retrieval-samples.jsonl、quality-answers.jsonl、quality-review.json、component-*-summary.json、stream*-summary.json、vector-10000-explain.json、summary.json、verification.json及manifest.json。目录被Git忽略，克隆后不保证存在。private-env.json/compose.env含凭据，仅本地受限保留，不进入分享包。样本、脚本、二进制和版本均有哈希；初轮performance脚本归档为performance-initial.py。

C01/C05覆盖上述固定数据、真实服务与目标；C02当前server/migrate/bootstrap-admin构建通过；C03计时/SSE分帧/中文/不完整事件及分位数3项检查通过，独立复算原始统计一致，初始累计hitRate差值不作本轮命中率、最终按hits/misses增量重算；没有应用规则改动，不做行为Red/Break。C04为实测链路与测量程序检查，未重跑全量应用测试。C06绑定7736aff及本轮输入/产物；未查询远端CI或发布。157次流式调用包含1预检、36质量、120性能；用量记录为157次意图、155次回答，总267,412 tokens，不推测费用。所有测试进程及专用容器已停止，测试卷和证据保留。

限于短篇合成语料、同一主机、单个远端Chat模型与有限样本；未覆盖多轮质量、持续饱和负载、生产网络/代理、浏览器、真实业务语料、MinIO或OCR。后续优化需明确目标、保持基线和保留题集，并重新测量。

### BENCH-SUITE-001：仓库内可复用基准工具（2026-11-21）

状态：实现完成，本地验收通过；远端CI未运行。用户授权将BENCH-RAG-001测试纳入项目并完善；任务为Infrastructure / L3。保留上一轮三份文档的既有未提交记录，应用基线为dev@7736aff；没有修改业务实现、默认模型或真实业务库。

交付入口为 [benchmarks/README.md](../benchmarks/README.md) 与 `python3 -m benchmarks`。独立Docker项目以run UUID标记容器/卷/网络，数据库/Redis无宿主端口，API仅回环；进程环境白名单、不读取根.env，只允许显式十项模型配置。空库迁移、向量维度与身份标记事务提交；启动/采样校验输入和镜像，清理校验标签、确定资源名和挂载卷。默认fixture模型，real模式允许原已授权模型；请求预算不等同Provider次数或金额。

- 语料：6篇虚构Markdown、48道固定题，新增金额/时间/文件数/退款/回退边界；全部来源锚点通过校验。retrieval、quality、stream、load分别保存计划及样本，未知和已失败记录不自动重跑；reconcile按原请求ID只读恢复消息，时延保持未知。SSE有真正总deadline，畸形/错ID/error/EOF不算done成功。
- 报告：计划/成功/失败/未知/未运行分母独立，检索每模式单独统计，缓存按计数增量重算。质量审核绑定答案哈希及审核者/方法，缺资料处理失败不能标pass；缺审核不通过基线门禁。比较匹配题序、语料、模型、维度、工作负载、脚本/环境，后端源码可变化。导出使用白名单并排除private凭据。
- C02/C04：Python编译、命令help、链接及diff检查通过；28项标准库unittest通过。CI增加相同单元检查、无真实密钥的Compose smoke及报告artifact；本轮未推送或查询远端CI。
- C03：独立审查指出的6个行为缺陷先由回归用例明确失败（5 fail/1 error，均为目标行为、无编译失败），修复后通过。另在隔离副本移除同名卷归属检查、未审核比较门禁、SSE总deadline，三项Break均因目标断言失败。初轮心跳timeout分类失败记录保留并已修正。
- C05：最终fixture容器smoke从空库迁移、33切片入库、检索/问答/流式/容量共8组37样本全部成功并清理。real模式六题联调24次检索及6回答成功，审核5完整/1部分；重复命令30个样本哈希和预算不变，停止恢复、reconcile、审核导入及导出通过。CLI最终退出码调整后再跑完整fixture和两题真实回归，结果见证据回执；真实联调用于验证工具，不取代48题完整质量评估。
- C06：源码与数据逐文件hash、镜像ID、各run manifest、样本和日志在 `output/bench-suite-20261121/` 及 `output/benchmarks/suite-*/`，最终内容身份见verification.json。初轮Redis镜像隐式匿名卷被加强后的保护拒绝；确认该次创建的精确容器/卷后清理，改为显式带标签redis_data卷，后续smoke通过。根.env和用户原服务未修改，专用服务在验收后停止；output忽略且含私密配置，分享只用export产物。

本轮只把测试纳入工程，不调整精排阈值或优化向量查询。Open-loop/持续饱和压测、自动事实裁判、业务语料/多轮质量、MinIO/OCR仍不在本套件结果中；已知结果边界写入使用文档。LESSONS记录匿名卷实际事件，不新增未经验证的常驻规则。

### BUG-PALETTE-001：命令面板焦点轮廓裁切（2026-11-22）

状态：本地修复与受影响验收完成，未提交、推送或发布。任务为Bugfix / L2，基于dev@7736aff及既有未提交输入；保留原Chat、benchmarks及文档差异和暂存状态。本次应用代码仅修改`frontend/src/styles/app-shell.css`，并同步前端规范与交接。

- C01：截图问题在浏览器复现。裸输入框继承全局2px轮廓及2px正偏移，向外扩4px；搜索行没有上下留白，顶部被面板`overflow: hidden`裁切，底部越过分隔线。改为搜索行使用主题焦点色和负偏移的`outline`，包含图标与输入框；输入不重复描边，结果按钮继续使用原有可见轮廓。
- C02/C04：Node24.22.3下，`npm test -- src/components/CommandPalette.test.tsx src/styles/style-contracts.test.ts src/styles/viewport-units.test.ts src/layouts/AppShell.test.tsx --maxWorkers 2`的4文件/51项通过；`npm run lint`、`npm run typecheck:test`和`npm run build`通过，生产构建确认11个路由分包。测试子进程移除`RAG_TEST_*`，不修改持久配置。
- C03：修复前实际源码的浏览器截图与几何断言明确检出顶部越界4px。最终同一检查脚本在隔离浏览器还原快照中的旧搜索行CSS，再次因相同目标断言失败（退出1）；最终样式通过（退出0）。该同语义回退同时核验焦点规则的测试有效性，没有以构建或夹具失败充数。
- C05：Google Chrome157.0.8103.79、1920×1080、真实生产路由与合成HTTP夹具，浅色/深色岩板蓝、浅色灰绿及强制高对比模式共16项通过。覆盖完整内侧轮廓、至少3:1对比、方向键、Tab/Shift+Tab、加载中不变高、快捷键重开、Escape归焦和页面无横向溢出；主代理审读浅/深色截图。没有访问业务API、数据库或模型。
- C06：修复前快照、最终输入/构建产物SHA-256、脚本、命令日志、截图及Red/Green回执在`output/search-focus-20261122/`，入口为`verification.json`。该目录被Git忽略，不是克隆后的必备资料；未查询远端CI，本地结果不代表发布验收。

验收脚本首次拦截范围误包含Vite源码路径，已收窄至`/api/v1/`；这次夹具错误不计入Red。快捷键重开时首次立即读取出现暂态计算值，绘制后为正确轮廓；补齐两帧绘制等待后再做最终Red/Green，原始观察保留。未改变产品键盘逻辑，未覆盖其他浏览器、读屏器或触屏；本次不触发后端、模型、迁移与发布验收。LESSONS无新增事项。

### FEAT-HOME-001：首页提问直接进入对话（2026-11-22）

状态：本地实现与受影响验收完成，未提交、推送或发布。任务为Implementation / L3，风险来自跨路由的一次性自动提交、异步创建及账号归属。基线为dev@7736aff及已有未提交输入；保留原聊天筛选、搜索焦点、benchmarks和工程文档差异及暂存状态。

- C01：从Claude桌面的kbchat会话恢复原请求与选定方案：首页点击提问或Enter直接发送并进入对话，普通`/chat?q=`仍仅预填，不能发送时保留问题。原会话在读代码时被429中断。本轮只修改首页交接、问答页编排及受影响线程生命周期，不修改API、RAG、后端、数据库或模型配置。
- 实现：首页使用绑定账号的一次性导航意图与独立草稿，消费时从历史移除问题并保留恢复标识；刷新/Back只恢复，范围调整继续使用该草稿。加载时显示已提交问题与准备状态，失败提示读取错误与局部重试，不把失败当作没有知识库。自动发送在StrictMode重放后执行，原请求持有者继续完成流式、停止和对账；草稿转正式会话不清首段文本/引用。账号变化取消绑定的旧发送，保留新账号草稿；首页Enter包含组合状态、原生isComposing与229保护。
- C02/C04：Node24.22.3下，`npm test -- src/pages/Home src/pages/Chat/ChatPage.test.tsx src/pages/Chat/useChatThread.test.tsx src/pages/Chat/useChatDraft.test.tsx src/pages/Chat/ChatComposer.test.tsx --maxWorkers 2`最终7文件/187项通过，包含新增17项跨页回归；`npm run lint`、`npm run typecheck:test`和`npm run build`通过，确认11个路由分包。运行前真实服务开关未启用，未访问业务服务。
- C03：旧首页实现由“点击后应收到回答”的回归明确失败。独立核验另复现旧稿拼入回退问题、恢复后范围切换丢稿、账号取消误清新账号草稿、草稿转路由丢首段流文本；主代理补齐组合断言，修复前5项失败、12项通过，修复后17项全部通过。隔离副本删除消费后草稿恢复标识，目标刷新用例因输入丢失失败（退出1）；最终实现同一目标通过。首次Break因Vite拒绝外部worker模块导入而未执行用例，该次不算有效失败；仅在副本补齐文件读取范围后重新验证。
- C05：Codex内置浏览器、1920×1080、生产SPA与独立Python HTTP/SSE夹具，10条页面检查记录覆盖点击/Enter直接提问、回答完成与刷新、普通q预填、慢加载准备、错误恢复及重试不自动发。请求回执确认点击和Enter各一次create/stream，刷新及普通q不增加写请求；错误及局部重试均无create/stream。最终构建再次首页提交仅一次create/stream并收到done，截图与几何核验确认一个main、无横向溢出。主代理审读最终截图，临时viewport已恢复；仅使用合成资料和账户，不是模型质量或真实业务验收。
- C06：初始内容快照、最终相关输入/构建SHA-256、任务补丁、命令及退出码、Red/Break、独立核验材料、浏览器请求和截图位于`output/home-question-20261122/`，入口`verification.json`。该目录被Git忽略，克隆后不保证存在；未查询远端CI。本轮仅本地前端交付，后端、迁移、真实模型/存储和发布验收不适用。

初轮测试的文本选择器同时命中问题正文与textarea、重试按钮名称及ByRole选项类型已按真实语义修正，失败日志保留；这些夹具/类型问题不算行为Red。浏览器一次中间刷新未取到动态路由模块，随后刷新恢复，另一次慢知识库的定位等待触及工具deadline；最终页面及请求回执核对通过，不将超时本身算成功。LESSONS记录账号取消误清新账号草稿的真实事件。

### DOC-UX-001：用户体验评审文档整理（2026-11-23）

任务：Documentation / L1。用户要求将本轮用户视角评审整理成文档；基线为dev@7736aff及原有未提交内容。交付 [用户体验评审与改进建议](18-user-experience-review.md)，同步导航、需求草案关联和交接；R01–R09的定义、原优先级、原建议顺序及未确认状态保留。

材料来源为同日UX-REVIEW-20261123：本地管理员、1920×1080页面观察及前端代码核对，使用现有演示资料和历史问答；未新增上传、模型提问或配置保存。普通成员、移动端、101库运行及后端部署版本未验收，历史BENCH-RAG-001未重跑。文档整理本身不产生新的应用或模型通过结论。

文档验收检查结构、相对链接及锚点、R01–R09映射、事实与建议的证据等级，以及原工作区内容保留；结果和最终内容SHA-256见`output/ux-review-20261123/documentation/verification.json`。原始评审快照保持不变；本地output目录被Git忽略，克隆后不保证存在。应用测试、构建、行为Red/Break和真实服务复验不适用于本次纯文档范围；未查询远端CI，未提交、推送或发布。LESSONS无新增事项。

### UX-FLOW-001：体验评审第一批任务衔接（2026-11-23）

状态：第一批前端实现、本地检查及独立审查完成；创建本地提交，未推送或发布，远端CI未触发。任务为Implementation / L3，风险来自跨路由草稿、异步文档状态、上传批次身份及个人跟进权限。基线为干净的`dev@e2391c6c038434b98468a966eda04756abef6e9c`。用户要求按18号体验评审开始修改，本批采用R03–R05任务引导、R02导入后指定资料提问与已有个人跟进的衔接。

- C01：总结选择1份资料及输出形式，对比选择2份及比较事项，制度查询填写主题／适用对象；只生成可编辑问题，保留草稿，不自动发送。导入结果由批次及最新任务状态驱动，部分不可用或超过20份/5库须显式选择子集；整库入口另列。草稿发送前确认全部文档身份、原库与完成状态，失败不缩小或扩大范围。仅明确no_basis提供下一步，跟进保留原问题和确切回答链接；个人记录仍按同会话相同问题共用，自动／多库补资料明确选择有写入能力的目标。
- C02/C04：`frontend`下，`NODE_OPTIONS=--no-experimental-webstorage npm test -- --maxWorkers 2`的118文件/1012项通过；审查修复后定向ChatPage、useDraftDocuments、DocumentsPage共156项通过。最终`npm run lint`、`npm run typecheck:test`、`npm run build`均通过，生产构建确认11个路由分包。运行环境Node26.13.1、Vite7.3.7、Vitest4.1.12、React19.2.7、TypeScript5.9.3；继承环境未启用RAG_TEST入口，Node实验Web Storage仅在测试子进程关闭，不改项目配置。
- C03：旧Provider的“问这份资料”回归实际失败；隔离副本回退ChatPage后，失效文档范围用例按预期失败。独立审查发现受控的移动／未就绪／数量错误被脱敏器统一覆盖为通用文案，新增具体原因断言后，隔离撤回修复的3个目标用例失败，修复后通过。四项Break分别移除就绪保护、取消守卫、20份上限、自动范围目标库显式选择，均出现目标断言失败。新任务表单没有等价旧行为，Red不适用，其数量规则由Break覆盖。
- C05：生产SPA、Google Chrome、1920×1080及隔离HTTP/SSE夹具六组流程通过：总结选择与草稿保留；对比实际create/stream仅携带两份ID；失权、处理中、移动范围拦截及重试；个人跟进确切回答、保存和跨库目标；导入部分失败、列表筛选后完整批次及显式子集；深色模式、Escape与页面边界。请求记录验证预填不写入、选择子集不含失败项；主代理审读总结、跟进、导入子集和深色截图。夹具响应不作为模型总结／对比质量通过。
- C06：最终源码、相关配置和构建产物SHA-256、命令日志、Red/Break、浏览器请求与截图位于`output/ux-first-batch-20261123/`，统一入口`verification.json`，提交SHA写入该回执；目录被Git忽略，克隆后不保证存在。未操作根.env、真实业务服务、数据库、模型或部署。远端CI未查询/未触发，本地交付不代表发布验收。

实际子任务与复核：

| 任务／角色 | 修改与职责 | 结果和主代理接续 |
| --- | --- | --- |
| UX-START-DESIGN / architect | 只读定位Chat、导入与个人跟进合同 | 完成；明确复用既有API、问题级记录与自动主库语义，无文件修改 |
| UX-TASK / frontend | ChatTaskDialog、ChatDocumentPicker及测试 | 10项定向测试和局部lint通过；主代理完成ChatPage接线、文档名核验及统一验收 |
| UX-IMPORT / frontend | ImportContext、Provider、DocumentsPage、ImportBatchChat及测试 | 55项定向通过；超过10分钟预算后停止，主代理确认无遗留写进程，接手并修复最后类型收窄，统一测试／浏览器通过 |
| UX-FOLLOWUP / frontend | ChatNoBasisActions、QualityIssueDialog、QualityPage及测试 | 38项定向和局部lint通过；主代理完成回调、配对与样式集成 |
| UX-REVIEW-CHAT / reviewer | 只读聊天候选与草稿／选择器边界 | 143项定向通过，发现1项P3具体错误原因丢失；主代理修复 |
| UX-REVIEW-IMPORT-FOLLOWUP / reviewer | 只读导入与个人跟进候选 | 71项定向通过，未发现可证实问题 |
| UX-RECHECK-SCOPE / reviewer | 只读补审P3修复及错误脱敏 | 14项定向通过，确认仅受控本地文案直出，未知异常与取消保护保持，未发现问题 |

记录保留实际失败：初轮测试环境localStorage错误、选择器名称和类型错误已修正，不计行为Red；新组件未存在时的import失败不计Red；隔离副本初次被Vite拒绝共享PDF worker导入，补齐副本读取范围后才取得有效Red。两次浏览器脚本使用错误搜索框名称，按页面实际“按文件名搜索”修正后完成最终六组流程。输入已冻结后执行两份独立审查；P3修复仅改变hook及测试并经新审查者补审。

Modern Web Guidance使用`forms`与`accessibility`：表单校验遵循“move focus to the first invalid field”，模态复用现有焦点、inert和恢复机制（“Manage focus correctly to and from updated content”），不引入新UI依赖。LESSONS无新增事项。

剩余边界：R01、R06–R09及评审第4节通用改进未进入本批；R08团队交接、按回答版本独立持久化均未新增。BENCH-RAG-001-Q回答完整性仍未关闭；真实模型／业务语料、真实服务上传、普通成员完整浏览器流程、读屏器、触屏与远端CI未覆盖。现有API/schema和RAG默认规则不变，本批后端构建／迁移／发布验收不适用。

### PERF-FE-001：前端性能优化与大文件拆分（2026-11-24）

变更范围与本地门禁结论：仅改动前端源码、样式、单测、`frontend/nginx.conf`、路由构建校验脚本及文档（`dev` 分支本地提交，未推送或部署，未改动后端业务代码、API/schema 或 RAG 默认合同）。完成 9 项优化：

1. **聊天草稿与列表重绘隔离**（`ChatScopedComposer.tsx`、`ChatMessage.tsx`、`ChatNoBasisActions.tsx`、`ChatPage.tsx`）：输入草稿订阅下沉至组合器局部组件，`MessageBubble` 通过稳定引用与 `memo` 隔离，单测 `ChatPage.render.test.tsx` 证实键入期间已有气泡不重渲染且引用弹窗与无依据跟进保持可用。
2. **外壳注册隔离**（`appShellContext.ts`、`WorkspaceLayout.tsx`、`AppShell.tsx`、`useSessionActions.tsx`）：外壳同步按结构相等跳过与卸载解绑分离，单测 `WorkspaceLayout.test.tsx` 证实页面输入不触发 `AppShellFrame` 同步重渲染。
3. **Markdown 上下文与流式高亮推迟**（`CodeBlock.tsx`、`ChatMarkdown.tsx`）：记忆化 `CitationContext` 并通过 `StreamingContext` 在 `streaming={true}` 时跳过 `lowlight` 高亮，流式结束（`streaming={false}`）立即恢复同步高亮（`ChatMarkdown.test.tsx` 覆盖）。
4. **Nginx 静态压缩与 PDF 缓存**（`frontend/nginx.conf`）：启用 `gzip`（level 5 / 1024 B）、在 `location /api/` 显式关闭 `gzip off;` 以防流式与下载缓冲，为 `/pdfjs/` 增加 30 天缓存头。
5. **非首屏重弹窗懒加载**：拆分 `DocumentImportDialog`、`CommandPalette`、`AccountSettingsDialog`、`QualityIssueDialog`、`EvaluationCaseDialog`、`ChatSourcePreview`、`ChatTaskDialog`、`ChatDocumentPicker`、`ChatBookmarks`、`ChatSearchDialog`、`ChatFeedbackDialog`；`src/styles/index.css` 中 `./touch.css` 末位顺序保持不变（`ChatSearchDialog` 因同时被 `ChatBookmarks`/`ChatMessageSearch` 静态引入而与对应分片共打）。
6. **路由分片构建校验扩展**（`frontend/scripts/verify-route-chunks.mjs`、`frontend/test/routeChunks.test.ts`）：校验清单从 11 个补全为 12 个路由分片（纳入 `UsersPage`）。
7. **React Query 查询与缓存失效扩展**（`queryClient.ts`、`api/resources/*`、`HomePage.tsx`、`useKnowledgeBaseList.ts`、`useKnowledgeBase.ts`、`useDocumentList.ts`）：为首页统计/文档/失败文档/活动、知识库列表与详情、文档列表与计数接入 `useQuery` 与版本隔离失效；`useDocumentList` 维持单一 `3000ms` 轮询定时器与已有列表保留策略。
8. **超过 100 个知识库分页与就地筛选**（`hooks/useKnowledgeBaseOptions.ts`、`ChatEmptyState.tsx`、`styles/pages/chat.css`）：`useKnowledgeBaseOptions` 分页拉取最多 20 页×100 条并按 `id` 去重及支持取消信号；`ChatEmptyState` 在知识库超过 12 个时提供按名称筛选框，保留失权库禁用态（`useKnowledgeBaseOptions.test.tsx`、`ChatPage.test.tsx` 覆盖 101 个知识库场景）。
9. **按域拆分高行数文件**：`src/types/api.ts`（1,081 → 8 行，导出桶 + `src/types/api/*.ts`）、`src/api/resources.ts`（1,003 → 17 行，导出桶 + `src/api/resources/*.ts`）、`ChatPage.tsx`（1,047 行 + `ChatRecoveryNotices.tsx`/`ChatModals.tsx`/`ChatEmptyState.tsx`/`ChatScopedComposer.tsx`）、`useChatThread.ts`（1,005 行 + `chatThreadHelpers.ts`）、`DocumentImportDialog.tsx`（900 → 729 行 + `documentImportUtils.ts`/`DuplicateChoice.tsx`）、`DocumentsPage.tsx`（827 → 703 行 + `DocumentsFilterBar.tsx`/`DocumentsBatchBar.tsx`），全量外部导出符号保持不变。

最终编辑后门禁检查（工作目录 `frontend/`，本机 Node `v26.13.1` 沿用 `UX-FLOW-001` 的 `NODE_OPTIONS="--no-experimental-webstorage"` 参数以禁用实验性全局 webstorage）：

- `npm run lint`（`eslint src --max-warnings 0`）：退出码 `0`，0 警告 0 错误。
- `npm run typecheck:test`（`tsc -p tsconfig.test.json`）：退出码 `0`。
- `NODE_OPTIONS="--no-experimental-webstorage" node node_modules/vitest/vitest.mjs run --maxWorkers 2`：退出码 `0`，**119 个测试文件、1,019 项测试全部通过**（`Duration 43.29s`）。
- `npm run build`（`tsc -b && vite build && npm run verify:route-chunks`）：退出码 `0`，变换 2,554 个模块，输出 `Verified 12 route-level JavaScript chunks.`。

实测构建产物关键体积对比（`dist/assets`，修改前基线 vs 修改后）：

- 入口脚本 `dist/index.html` 引用 `index-*.js`：`434,612 B` → `384,215 B`（`gzip 124.63 kB`，**-50,397 B / -11.6%**）。
- `ChatPage-*.js`：`110,796 B` → `96,610 B`（`gzip 31.42 kB`，**-14,186 B / -12.8%**；另拆出 `ChatMarkdown-*.js` `76,791 B` 及各独立按需弹窗分片：`ChatSourcePreview-*.js` `8,757 B`、`ChatBookmarks-*.js` `6,301 B`、`ChatTaskDialog-*.js` `5,506 B`、`ChatDocumentPicker-*.js` `4,093 B`、`ChatFeedbackDialog-*.js` `2,005 B`）。
- `QualityIssueDialog-*.js`：`91,994 B` → `11,030 B`（`gzip 4.28 kB`；`EvaluationCaseDialog-*.js` `3,219 B`、`CommandPalette-*.js` `5,275 B`、`AccountSettingsDialog-*.js` `9,984 B`、`DocumentImportDialog-*.js` `26,264 B`）。
- `DocumentsPage-*.js`：`46,869 B` → `48,556 B`（`gzip 16.45 kB`）；`index-*.css`：`127,762 B` → `127,821 B`（`gzip 21.21 kB`）。

未验证边界：前端 HTTP/SSE 均为 Vitest/jsdom 隔离夹具；真实 Docker/Nginx 容器内的实际响应压缩、`gzip off;` 流式传输与 `/pdfjs/` 缓存响应头未做实测；1920×1080 真实浏览器交互、真实后端/数据库/模型与远端 CI 均未运行。
