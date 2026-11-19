# 可观测性

当前 dev 已包含 OpenTelemetry Trace/Metrics、进程内 Recorder、zap 关联日志和可选的本地观测栈。空导出端点只保留本地 Trace 上下文与诊断快照；设置端点后，Trace/Metrics 异步导出，不阻断业务请求。部署、真实服务和发布版本仍需按实际目标单独核实。

## 当前实现与验证

- `backend/internal/observability/tracing.go` 初始化 OTel SDK。Trace 和 Metrics 端点必须是无凭据的绝对 HTTP(S) URL；导出超时 3 秒且不重试。Trace 使用 W3C `traceparent`/`tracestate`，不传播 baggage；每个进程生成服务实例 ID。
- `backend/internal/observability/metrics.go` 和 Recorder 记录 HTTP 结果/耗时、阶段耗时、Provider 调用、文档任务、限流、Embedding cache、Rerank/向量精确回退及队列状态。Metrics 不依赖 Trace 采样，启用端点后每 15 秒采集队列；应用心跳独立记录。标签限制为方法、路由模板、状态类、结果和受控分类，不使用问题、Prompt、回答、正文、资源 ID 或原始错误。
- `backend/internal/observability/export.go` 在 Trace 导出边界移除 SQL、连接串、认证信息、URL 查询、原始异常和堆栈，并清空 span status 描述。zap 日志通过 Trace ID/Span ID 关联。
- HTTP 响应在存在有效上下文时带 `X-Trace-ID`；JSON 错误和 SSE `error` 事件带 `traceId`。错误码、幂等编号和追踪编号各自独立，公共错误仍保持脱敏。
- `chat_first_token` 记录流式Provider调用开始至首个delta，纯阻塞接口和本地拒答不计入；若流式接口回落完整JSON/阻塞调用，记录整段等待并以 `streaming=false` 区分，不能当作真实流式首token。`chat_first_visible_text` 表示HTTP入口至服务端首次成功写入并flush非空正文的耗时，不代表浏览器绘制；仅citations、写失败或已取消不产生样本。SSE 在 HTTP 200 后仍按 completed/failed/cancelled 记录最终结果，取消不计 Provider 故障。
- 文档任务将固定长度的 `traceparent` 保存到 `document_jobs`，worker 重试/重建时恢复父上下文；旧任务为空时创建新的 Trace。该字段由 `049_document_job_traceparent.sql` 引入。

## 本地观测栈

`deploy/docker-compose.yml` 的 `observability` profile 提供 Jaeger、OTel Collector、Prometheus 和 Grafana，端口仅绑定到回环地址；默认数据库/Redis 启动不会拉起它们。配置和版本固定在 `deploy/`，Grafana 看板和 Prometheus 告警规则由仓库文件提供。未配置 Alertmanager 或 Loki，不会自动向外部发送通知。

从仓库根目录启动本地观测栈：

```bash
docker compose -f deploy/docker-compose.yml --profile observability up -d grafana
```

| 入口 | 本地地址 |
| --- | --- |
| Grafana只读看板 | `http://127.0.0.1:3000/d/rag-observability` |
| Prometheus告警 | `http://127.0.0.1:9090/alerts` |
| Jaeger查询 | `http://127.0.0.1:16686` |
| Collector OTLP/HTTP | `http://127.0.0.1:4318/v1/traces`、`/v1/metrics` |

Grafana为匿名Viewer，仅供本地开发；生产需另定身份与网络边界。在Jaeger选择服务 `rag-backend` 并按错误中的Trace ID查询，或在zap日志搜索同一 `trace_id`。Grafana exemplar直链打开Jaeger UI；配置不注册依赖旧查询接口的Jaeger数据源。看板含18面板，空窗口显示No data；采集失败后的旧队列样本最多保留两分钟，应同时检查采集成功与应用心跳。

Prometheus通过named volume保存7天指标，Grafana使用独立volume；Jaeger使用最多10,000条内存Trace，重启清空。生产保留周期由部署侧明确配置，均不替代业务备份。

从仓库根目录检查配置：

```bash
docker compose -f deploy/docker-compose.yml --profile observability config --quiet
docker run --rm -v "$PWD/deploy:/config:ro" otel/opentelemetry-collector-contrib:0.165.0 validate --config=/config/otel-collector.yaml
docker run --rm --entrypoint promtool -v "$PWD/deploy/prometheus:/etc/prometheus:ro" prom/prometheus:v3.16.0 check config /etc/prometheus/prometheus.yml
docker run --rm --entrypoint promtool -v "$PWD/deploy/prometheus:/etc/prometheus:ro" prom/prometheus:v3.16.0 test rules /etc/prometheus/alerts.test.yml
```

业务后端只在明确配置 `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` / `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` 后导出数据。Collector、Prometheus、Grafana 和 Jaeger 的真实启动、查询、保留期及网络边界属于部署验收，不由配置检查代替。

## 指标与告警口径

| 范围 | 当前合同 |
| --- | --- |
| 请求 | 固定 HTTP 方法、Gin 路由模板、状态类和 completed/failed/cancelled；SSE 200 后失败仍计入 failed，健康检查和普通 4xx 的告警口径另行排除 |
| Provider | Chat、Embedding、Rerank、Keyword；取消不计故障，错误只保留受控分类，不保存原始响应 |
| 阶段 | 检索、Embedding、向量/关键词召回、Rerank、Prompt、生成、首 token、首段正文；缓存命中不冒充 Provider 调用 |
| 任务 | 每次文档 worker 尝试的结果和耗时；重试是独立尝试，队列读取失败时标记 collection_success=0 并省略队列值 |
| 队列 | 文档/清理积压、最早等待年龄、应用心跳；查询通过 repository 只读，使用统一超时，不把未知状态写成健康零值 |
| 聚合 | P95 由 Prometheus 直方图桶合并计算，不平均实例 P95；共享队列不按实例重复相加 |
| 存储 | Recorder 每项最多 512 个耗时样本，服务重启归零；Prometheus/Jaeger 的历史保留由实际部署决定，不替代数据库和原文件备份 |
| 告警 | 规则覆盖 Collector 抓取、应用心跳、请求失败率、首段正文 P95、Provider 故障、文档/清理等待和队列采集失败；阈值和持续时间是初始值，需按实际 SLO 校准 |

## 数据导出边界

不把问题、Prompt、回答正文、文档正文、SQL、连接串、URL 查询参数、认证信息、原始 Provider 响应、原始异常或堆栈写入公开 Trace/Metrics。业务 ID 可在受控 Trace/日志字段中用于排障，但不作为高基数 Metrics 标签。导出队列有界，满队列或接收端故障允许丢遥测，业务流程继续。worker与HTTP处理结束后，Trace/Metrics共用最多三秒刷新预算。

## 验证范围

当前 CI 运行后端 vet/test/build、一次性 PostgreSQL/pgvector 测试和前端门禁，并校验 Collector、Prometheus 配置及告警规则。后端观测工作流、Recorder、指标和脱敏用例覆盖成功、失败、取消、重试、队列读取失败和追踪关联；默认真实模型、MinIO、OCR 与业务数据库不因该任务自动获得授权。真实 Collector 接收/Jaeger 查询、生产部署、告警通知和恢复演练必须在明确目标上单独完成。

历史验证结果保留在 [验证证据索引](14-verification.md#已有证据索引)，历史版本的环境和结论不能直接替代当前候选版本验收。

在 `backend` 目录运行观测夹具：

```bash
go test ./internal/router -run '^Test(ObservabilityWorkflow|MetricsSurviveDisabledTracingAndQueueReadFailure)$' -count=1
```

使用生产Gin路由、服务、repository、解析器、worker及OTLP导出器；SQLite、模型HTTP和OTLP接收端为夹具。稳定结果写入 `backend/internal/router/testdata/observability/runs/latest/`。

仅在明确授权的专用Collector上转发测试数据时，设置 `RAG_TEST_OTLP_ENDPOINT` 和/或 `RAG_TEST_OTLP_METRICS_ENDPOINT` 为完整的Trace/Metrics接收地址，再运行 `TestObservabilityWorkflow`。服务名为 `rag-test`；这两个开关不授权业务数据库或真实模型，默认测试应清除继承的真实服务开关，详见 [执行边界](14-verification.md#执行边界)。
