# 多库检索与跨库会话验收

日期：2026-09-29。用户确认继续使用统一 Embedding，暂无每库独立模型需求。本轮实现多库语义检索和固定范围的跨库会话；没有更改根 `.env`、迁移 public 或提交 Git。

## 实现合同

- `POST /knowledge-bases/search` 支持 1–5 库；所有库先鉴权，查询只做一次 Embedding。各库独立召回和融合，轮流贡献候选，再统一 Rerank、阈值过滤和 TopK。空库不占候选名额。
- 创建会话支持 `knowledgeBaseIds`；旧 `knowledgeBaseId` 继续可用，作为首选库和唯一用量归属。范围创建后不可变，原会话无需回填。
- 跨库问答使用系统检索设置、默认 Chat 模型和严格依据规则。单库继续使用各自的检索/回答配置。引用及 Prompt 标明库 ID/名称，导出包含全部库。
- 会话属于发起用户，并逐次检查全部关联库。任一库撤权/软删除使整个会话不可访问；恢复后可继续访问。永久删除任一库会一并删除相关跨库会话，不静默缩小范围。
- 跨库消息不进入单库质量、负反馈和知识缺口视图，避免将其他库资料展示给单库管理员。评测仍为单库。用量只记首选库一次，不按库数重复累计。
- 前端卡片多选建会话，侧栏按任一关联库可筛选到会话；引用卡片和预览标库，下载权限取引用所属库。撤权清空历史、来源、未确认状态及相关缓存选项。

正式约定见 [API](04-api-design.md#多知识库语义检索)、[schema](03-database-design.md#chat_session_knowledge_bases迁移-030)、[RAG](05-rag-pipeline.md#统一-embedding-的多库检索与会话)、[前端](10-frontend-spec.md#多库聊天2026-09-29)。

## 验证结果

| 范围 | 结果 |
| --- | --- |
| 后端本地 | 全量 `go test ./...`、`go vet ./...` 通过；最终排序/参数校验修改后 dto/service/retrieval/repository/router 相关回归通过，相关 vet 通过。 |
| 新增专项 | DTO 10 组边界；统一 Embedding、候选配额、全局精排、空库及关键词失败回退；逐库权限、用户隔离、导出/编辑/重新生成/回收站、撤权与删库；检索过程中撤权不发 citations、不落库。 |
| 前端本地 | 全量 88 文件/757 项通过；随后增加草稿 404 回归并修正新测试的异步断言，聊天页面最终 87 项通过。生产构建/11 路由分包、测试类型检查和 lint 通过。 |
| PostgreSQL | 真实 001–030 迁移；030 重复执行、附加库外键禁止静默缩小范围、会话删除清除关联；原文档/知识库/会话恢复与永久删除竞争通过。测试 schema 自动清理。 |
| 真实模型 | 两个独立所有者的库各入库一份同名 Markdown，内容分别是“日备份保留35天”和“恢复承诺18分钟”；另有空库。统一 Embedding 模型/维度核对通过；多库检索、JSON 回答、SSE 追问及浏览器首问均通过真实 Rerank。 |
| 依据链路 | JSON/SSE 返回两个库的互补事实；精排无降级。转发记录逐项核对 citation 序号、chunkId、knowledgeBaseId、content 与实际 Chat Prompt 一致，同名文件没有混淆。 |
| 真实权限 | 任一库无权限时整个检索失败；系统管理员不绕过成员权限；库所有者不能读取成员的私有会话；次库撤权后 JSON/SSE/历史/导出与列表均拒绝。次库删除/恢复、会话归档/回收站/恢复通过。 |
| 1920×1080 浏览器 | 卡片多选后首问创建固定两库会话；真实流式显示35天/18分钟；同名来源标库、次库原文预览和定位高亮；撤销次库权限后再次发送，清空历史/预览/失效列表和选项，回 `/chat` 并提示。 |
| 用量与隔离 | 真实用量归属与会话首选库不一致记录为0；两份文档 Embedding 来源不一致为0；单库质量视图不返回跨库回答。 |

本轮真实模型样本用于功能合同验收，不代表跨库召回率、回答正确率或性能基准。候选配额保证进入精排的机会，最终 TopK 不保证每库都有片段。5 库上限有本地边界覆盖，真实业务链路用两资料库及一个空库。

## 部署与保留边界

新增迁移 `030_chat_session_knowledge_bases.sql`。public 仍停在028，新版正式启动前需执行029/030并发布对应前后端；创建跨库会话后不能回滚运行只校验首选库的旧后端。无需重新 Embedding 存量文档。

根 `.env` SHA256 与验收前一致，仍为 `RERANK_ENABLED=false`；本轮仅临时进程使用 `true/strict`，正式启用精排需配置并重启。每库独立 Embedding、双 Chat 模型评测、任务租约继续暂缓。

生成前、输出引用前和结束时重新检查跨库权限；已经发出的流式文字无法撤回，不提供事务级即时撤权承诺。跨库评测及成本按库分摊未实现，当前分别保持单库评测和首选库计量。

## 临时资源与证据

本轮使用独立 `rag_accept_20260929_multi` schema、本地临时上传目录和18080/15173服务；没有针对 public 启动 worker。schema、浏览器及临时服务已清理/停止；合成文件和日志保留在忽略目录，未执行递归文件清理。

- `output/multi-acceptance.json`、`multi-api.log`：真实 HTTP 合同与结果。
- `output/multi-wire.jsonl`、`multi-sse.json`：合成模型请求/精排结果/流式事件，不记录认证头。
- `output/multi-inventory.log`、`multi-postgres-tests.log`、`multi-cleanup.log`：模型来源、用量、迁移/并发、清理证据。
- `output/multi-*test*.log`、`multi-frontend-full.log`、`multi-backend-full.log` 等：本地验证。
- `output/playwright/multi-selected.png`、`multi-source.png`、`multi-revoked.png`：浏览器证据。

用户原有 `backend/cmd/dbquery/`、`backend/cmd/tmp-explain/` 未改动；本轮未查询远端 GitHub CI。
