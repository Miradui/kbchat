# 可观测性

本页区分当前dev的实现与先前文档保存的OTel方案。2026-11-18对 `dev@dd5a526e50341f6705f4e62dc293d90aee9aa226` 的源码核查仅确认进程内Recorder；未查询其他分支或实际部署，不能据此否定旧版本的验收。切换代码版本后须重新核实入口。

## 当前实现与验证

- [Recorder](../backend/internal/observability/recorder.go) 保存有界耗时与Provider/限流/缓存/回退计数，每项最多512个样本，服务重启归零；[系统诊断](04-api-design.md#系统诊断) 由当前系统管理员访问，业务数据库仍经repository读取。
- HTTP请求及问答时延使用zap日志。当前没有OTel SDK/导出器、独立历史Metrics、Trace响应编号、任务traceparent或 `049_document_job_traceparent.sql`；当前049用于已确认的功能退役。
- [Compose](../deploy/docker-compose.yml) 只含PostgreSQL/Redis；OTel/Prometheus/Grafana配置及旧工作流测试不在本分支。当前 [CI](../.github/workflows/ci.yml) 未配置观测专项检查。

以下源码检查在 `backend` 工作目录执行，按 [验证边界](14-verification.md#执行边界) 核实真实服务开关；本次文档整理没有运行这些测试：

```text
go test ./internal/observability
go test ./internal/router -run '^TestDiagnostics' -count=1
```

测试载体为 [Recorder/分类](../backend/internal/observability/recorder_test.go) 和 [系统诊断路由](../backend/internal/router/system_diagnostics_route_test.go)，不是OTel/Collector联调。使用 `-run` 前确认实际测试名有匹配，退出0但无匹配不能算覆盖。

## 历史 OTel 方案

本节只保留后续分支对齐需要的合同摘要，不代表当前dev能力或默认配置。OTel SDK/导出器、Trace字段、任务traceparent/049迁移、观测Compose profile、Collector/Prometheus/Grafana配置及旧工作流测试均不在本分支。启动条件见 [有效待办](15-backlog.md#条件性工作)，旧验收日期、结果与环境边界见 [证据索引](14-verification.md#已有证据索引)。

原方案采用“应用OTel → Collector → Jaeger Trace / Prometheus Metrics → Grafana”，zap按Trace关联；即时诊断、模型用量与质量评测分别保留自身职责。以下均是历史方案约定，只有恢复相应载体后才按实际范围实现和验证。

| 范围 | 保留的历史合同 |
| --- | --- |
| 请求关联 | W3C traceparent/tracestate传播，不传播baggage；X-Trace-ID响应头和JSON/SSE错误traceId与上传requestId、聊天clientRequestId独立；前端只展示有效编号，跨源头需同步配置 |
| 追踪层次 | HTTP、意图/Prompt/回答、Embedding缓存与混合召回/Rerank、五类模型调用、数据库/Redis、解析/OCR/切片/发布及消息持久化；可区分生成成功后保存失败 |
| 任务关联 | 入队保存固定长度traceparent，每次执行/重试独立span并关联上传；旧任务无父上下文时新建Trace，失败和取消分开；不据此允许多实例worker |
| SSE结果 | HTTP 200后仍按completed/failed/cancelled记录最终结果；取消不计Provider故障，降级不能伪装成功精排 |
| 首段耗时 | chat_first_token是流式Provider调用开始至首delta，纯阻塞接口和本地拒答不计入；流式接口回落完整JSON/阻塞调用时可记录整段等待，以streaming=false标识，不当作真实流式首token。chat_first_visible_text是HTTP入口至非空正文成功写入并flush，本地拒答/阻塞接口经SSE输出正文也计入，不是浏览器绘制；仅citations、写失败或已取消不产生样本 |
| 独立指标 | Metrics不依赖Trace采样；HTTP结果/耗时、阶段耗时、Provider调用、任务尝试/耗时、队列状态/年龄、清理积压、采集成功/心跳、精排/精确召回回退、缓存与限流分别记录；失败尝试计时，缓存命中或空候选不冒充模型调用 |
| 队列与聚合 | 队列经repository只读，共用两秒预算；采集失败标未知，不发健康零值，用应用心跳区分Collector存活。P95合并直方图桶而非平均实例P95；共享队列gauge取max，不重复相加 |
| 标签与导出 | 只用受控低基数标签，业务ID只进Trace/日志；不导出问题/Prompt/回答/文档正文、SQL、连接串、原始异常/堆栈、URL查询与认证信息，保留受控分类、错误码和必要资源ID |
| 导出可靠性 | 有界异步队列，不阻塞业务；单次导出最多三秒、不重试，满队列/接收端故障允许丢遥测；worker与HTTP结束后Trace/Metrics共用最多三秒刷新，遥测故障不阻断业务 |
| 历史窗口 | 原开发方案Metrics采集/发送及Prometheus抓取/评估为15秒、直方图桶5ms–120s；Prometheus七天持久历史、Jaeger最多10000条内存Trace且重启清空。保留周期由实际部署重新决定，不替代业务备份或当前Recorder的512样本窗口 |
| 看板与告警 | 原18面板/8规则覆盖请求、正文/阶段P95、Provider、任务/清理等待、缓存/降级/限流、采集与心跳；无样本显示No data，旧队列样本需判断新鲜度。失败率含SSE后失败、排除取消/普通4xx/健康检查，阈值有最低样本量与持续时间，按实际SLO校准 |
| 访问与通知 | 原匿名Viewer只限本地回环开发，生产另定身份/网络边界；未接Alertmanager接收端或Loki。Grafana到Jaeger的exemplar直链需核对实际版本兼容，不自动发通知或新增适配服务 |
| 恢复后的验证 | 夹具覆盖成功、SSE后失败/取消、检索故障、任务重试/重建、持久化失败、关闭采样、队列读取失败、日志关联/脱敏及遥测故障下业务成功；另外核实迁移、配置、真实Collector接收/查询和告警触发/恢复/低样本抑制 |

已移除本分支不存在的启动、049迁移、OTLP转发、Collector/promtool及测试命令，避免被当作运行入口。旧版本与配置细节可查Git历史；本轮输入全文另保存在 [文档清理快照](14-verification.md#doc-cleanup-001文档清理2026-11-18)。继续观测工作时固定目标版本，先找回实现、配置与用例，再更新当前操作文档；旧结果和零测试匹配都不能证明当前通过。
