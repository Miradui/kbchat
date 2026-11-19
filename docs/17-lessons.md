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
