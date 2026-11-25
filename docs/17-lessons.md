# LESSONS

这里保存真实事件与复盘证据；记录、计数和晋升方式见 [开发约定](00-ai-development-guide.md#进度与-lessons)。正式工程要求维护在 AGENTS、开发约定或验证文档，归档条目不另定义一套活跃规则。

## LES-001：先确认分支，再使用工程记录

- 事件：2026-11-18 的 `DOC-AGENT-001` 文档整理，核查 `dev@dd5a526e50341f6705f4e62dc293d90aee9aa226` 时，现行文档把 049 迁移、OTel/观测 profile 及 PostgreSQL/观测 CI 检查写成已有能力；本分支的对应载体缺失。初始交接还把旧的混合工作区状态写成当前事实。
- 影响：照文档可能选择不存在的迁移/部署入口；`go test -run` 未匹配历史测试名也可能退出 0，不能据此宣布验收通过。本次没有执行这些命令，未发生真实库写入或部署。
- 已证实事实：当前 [启动检查](../backend/internal/database/database.go) 要求 048；[Compose](../deploy/docker-compose.yml) 只有 PostgreSQL/Redis；[CI](../.github/workflows/ci.yml) 只有前后端本地门禁；[Recorder](../backend/internal/observability/recorder.go) 是有界进程内诊断。文档为何形成这次分支差异未调查，不把推测当根因。
- 处理：工程入口与工作流按实际分支重构，发布和配置说明改正；[可观测性](38-observability.md) 明确当前实现与历史方案，旧验收保留在 [证据索引](14-verification.md#已有证据索引)。未实现的分支对齐条件保留在待办，本次不扩展为功能开发。
- 证据：本次 [任务记录](14-verification.md#doc-agent-001agent-工程文档整理2026-11-18) 与本地内容快照 `output/agent-docs-20261118/verification.json`；本轮只读定位和文档检查，不代表应用、CI 或真实服务复验。
- Seen **1×**：2026-11-18 / DOC-AGENT-001。本轮多名探子的复核属于同一次工作事件；未晋升新的经验规则。

## LES-002：并发保护使用写入前的原始快照

- 事件：2026-11-19的FEAT-SLIM-001先在消息持久化后刷新会话，再用标题/`updated_at`做条件命名。独立复核指出：生成期间手动保存同名“新会话”后，消息写入再次更新时间戳，刷新快照会接受该操作并覆盖用户标题。
- 影响与证据：本地JSON和SSE回归均复现“期望新会话，实际首问摘要”；`backend-title-race-red.log`保存目标失败，业务会话未用于实验。只比较当前标题文字不能识别同名保存。
- 处理：保留生成前的标题/时间戳快照，在消息事务的条件更新中命名；手动改名保留而回答仍可提交。补验默认/自定义标题、标题写入失败的消息回滚、检索失败重放及流式取消；移除时间戳保护的最小Break再次检出同一问题。
- 出处：[任务验收](14-verification.md#feat-slim-001已确认功能收敛2026-11-19)、[事务写入](../backend/internal/repository/chat_repository.go)及[首问回归](../backend/internal/service/chat_session_title_test.go)；详细源码快照与失败/通过回执在`output/feature-simplification-20261119/`。
- Seen **1×**：2026-11-19 / FEAT-SLIM-001。初始复核、Red和Break属于同日同一工作事件，不累计额外次数；未晋升正式规则。

## LES-003：隔离容器也要检查镜像隐式数据卷

- 事件：2026-11-21的BENCH-SUITE-001将资源归属检查扩展到挂载卷后，Redis镜像自动创建的匿名/data卷没有run标签，真实smoke因此拒绝继续初始化和自动清理。
- 影响：测试停在独立环境准备阶段，保护没有放行未知卷；用户原服务未受影响。确认本次精确容器、创建时间及匿名卷后完成限定清理。
- 处理：给Redis显式配置带run标签的redis_data卷，补充配置断言；后续完整smoke通过。资源检查同时覆盖标签查询、Compose将使用的确定名称与实际挂载，不能只检查能被项目标签查到的资源。
- 出处：[任务验收](14-verification.md#bench-suite-001仓库内可复用基准工具2026-11-21)、[隔离运行定义](../benchmarks/runtime.py)及[保护测试](../benchmarks/tests/test_benchmark.py)；失败与限定清理回执在output/bench-suite-20261121和suite-smoke-002。
- Seen **1×**：2026-11-21 / BENCH-SUITE-001。仅记录本次实测事件，未晋升常驻规则。

## LES-004：账号取消不能冒充权限失败

- 事件：2026-11-22的FEAT-HOME-001初版在旧账号首页会话创建返回时，用本地403阻止向新账号发送。线程的权限丢失处理调用了已经更新为新账号的回调，清空了新账号已有草稿。
- 影响与证据：隔离夹具及主代理组合回归均复现：切换前后的新账号草稿可见，旧创建返回后为空；消息请求确实被阻止，但发生数据丢失。最初只断言“未发送”没有检出该后果。
- 处理：首页自动提交绑定认证版本，由线程取消旧操作，不进入权限失败回调；保留新的账号草稿及旧请求的持久化对账状态。补验创建前/创建中切换、迟到返回不发送、不展示旧问题、不清新稿，以及首问正常完成。
- 出处：[任务验收](14-verification.md#feat-home-001首页提问直接进入对话2026-11-22)、[线程取消](../frontend/src/pages/Chat/useChatThread.ts)与[跨页回归](../frontend/src/pages/Home/HomeQuestionFlow.test.tsx)；Red与最终结果位于output/home-question-20261122。
- Seen **1×**：2026-11-22 / FEAT-HOME-001。仅记录本次真实失败与修复，未晋升常驻规则。

## LES-005：评测语料清洗需要验证语义保真

- 事件：2026-11-25的EVALS-SCALE-003扩大官方文档评测时，初版清洗器虽可逐字节重建且没有残留模板，却把140处动态特性状态变成空版本/状态，并把14篇第三方责任声明当作导航省略；独立审查还发现部分跨文档题的全部事实实际能由单篇回答。
- 影响：前者会丢失官方版本和责任范围事实，后者会夸大多文档检索难度；在运行真实模型前发现并修复，未将缺陷语料结果作为质量基线。
- 处理：从固定提交的英文feature-gate数据和中文翻译资源展开语义并记录依赖哈希；独立YAML解析核对93份实际gate依赖，140处状态及三类第三方声明一致。跨文档题明确加入第二篇独有且题面要求的事实，随后补审通过。
- 出处：[数据集说明](../benchmarks/datasets/kubernetes-zh-200/README.md)、[清洗器](../benchmarks/build_kubernetes.py)、[语料回归](../benchmarks/tests/test_kubernetes_dataset.py)；审查与冻结快照在`output/evals-scale-20261125/`。
- Seen **1×**：2026-11-25 / EVALS-SCALE-003。重建一致与锚点匹配只能证明结构和内容身份，不能单独证明清洗保真或题目难度；未晋升常驻规则。
