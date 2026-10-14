# 六项功能扩展验收

日期：2026-10-13 至 2026-10-14。范围为用户选定的 1、3、4、8、9、10，执行顺序和约束见 [扩展计划](28-feature-extension-plan.md)。六项均已实现并完成本轮验收；按用户 2026-10-14 后续要求，源码与此前会话搜索一并纳入本次 Git 提交，业务数据库和 8080/5173 尚未发布本次功能。

## 功能结果

| 功能 | 交付与验收结果 |
| --- | --- |
| 回答收藏与备注 | 收藏确切回答版本，保存个人备注、搜索、分页和跳回原文。实际 API 验证幂等、Unicode 长度、字面搜索、归属和生命周期；浏览器编辑备注并定位旧版回答，撤权后拒绝保存并清空页面，列表隐藏收藏。 |
| 文档版本文本对比 | 只比较同库同替换链的两个已完成版本，展示增删行与两端行号。实际上传、worker 处理、替换后得到新增 3 行/删除 2 行；两端权限、错误和大小边界有回归。浏览器切换版本清除旧结果，关闭后回到详情。 |
| 对话分支 | 复制到指定回答版本为止的历史、引用和完整知识库依赖。PostgreSQL 并发同请求只生成一个分支，原会话保留；不复制收藏、反馈或用量。浏览器从旧版回答创建含 2 条消息的分支，明确选择打开后再导航，来源入口正确；依赖库撤权后分支不可访问。 |
| 个人提问模板 | 个人 CRUD、搜索和变量校验；重复变量只填一次。实际 API 验证账号隔离；浏览器从现有草稿新建模板，填写设备/事项后追加到原草稿，保留原输入且没有自动发送。 |
| 文件夹/ZIP 导入 | 真实文件夹和 ZIP 共展开 4 份支持格式资料，保留目录/归档路径；PNG 附件明确跳过，重复选择忽略。浏览器逐文件上传和后台处理全部完成，数据库与详情中的 `sourcePath` 一致，ZIP 内 CSV 正常发布行片段。 |
| XLSX/CSV 入库 | 真实 CSV 的引号逗号/换行、空行，XLSX 多表/稀疏行/表头和未缓存公式均通过。实际 worker 发布、pgvector 检索、Rerank、JSON/SSE 回答、历史引用和文本预览贯通；浏览器准确高亮工作表/原始行，切换文档和同文档行不保留旧高亮。 |

## 本地回归

- 后端全量 `go test ./...`、`go vet ./...` 通过；最后请求体边界和导出来源调整后，handler/service/router 相关测试通过。表格 parser/splitter/processor、检索元数据以及各新功能的权限、并发、事务和失败路径有本地回归。
- 前端全量 **99 个文件 / 850 项**通过。随后空表提示和样式调整后相关 **4 文件 / 80 项**通过；最后对比弹窗 portal 和收藏卡片宽度修正后，DocumentVersionDialog、DocumentDetailDrawer、Dialog、ChatBookmarks 共 **4 文件 / 51 项**通过。这些是相应阶段的回归数量，不相加作为独立用例总数。
- 最终 `typecheck:test`、`lint`、TypeScript 生产编译、Vite 构建及 **11 个路由分包**检查通过。构建写入 `output/features-20261013/dist`，没有覆盖正在服务的 `frontend/dist`。

本机 Go SQLite 测试需要 CGO 与 C 编译器，使用 `CGO_ENABLED=1` 和已建立的 `backend/tmp/go` 作为 `GOTMPDIR`。前端默认并发曾耗尽本机内存；最终全量使用 2 个 worker，从仓库根目录执行：

```powershell
Push-Location frontend
node node_modules/vitest/vitest.mjs run --maxWorkers=2
Pop-Location
```

保持 frontend 为进程工作目录；现有部分测试按工作目录读取文件，不能只从根目录给 Vitest 加 `--root frontend`。

## 实际 PostgreSQL 与 API

隔离 schema 为 `rag_accept_20261013_features`。验收服务使用真实 PostgreSQL/pgvector、实际 GORM 仓储、鉴权、文档 worker 和本地文件存储。模型 Provider 接入同进程的本地 HTTP 固定响应，未调用外部模型；未注入 Redis 依赖，也未使用业务 MinIO。

- 完整执行 **40 个 SQL 文件**（001–039，包含两个 010 文件），重复执行 034–039 通过。启动结构检查通过，在回滚事务中移除正确的错误码约束后，启动检查明确要求 039。
- 实际 API 验收共 **7 组**：收藏、分支、模板、归档/软删/恢复/永久删除、文档版本/来源路径、表格全链路、关联库撤权/恢复。结果保存为 `output/features-20261013/api-results.json`。
- 分支验证包括同时提交相同 `clientRequestId`、截断至旧回答版本、依赖继承、来源永久删除后独立分支存活及来源外键置空。
- 文档验证包括上传→处理完成→替换→对比，以及路径穿越拒绝、相对来源路径保存、两端访问限制。
- CSV 夹具的首个数据记录占原文件 **第 3–4 行**，另一个记录位于第 5 行。XLSX 夹具“库存”表头在第 2 行、记录在第 5 行，“维护”表记录在第 3 行；无缓存公式不计算、不产生值。
- JSON/SSE 的引用表格元数据均来自实际进入 Prompt 的片段，持久化后与预览 `tableRows` 一致；不会让模型推测工作表或行号。空表返回 `empty_content`，超限表格返回永久失败 `table_limit_exceeded`，均无已发布片段。
- 浏览器导入后，隔离数据共 **10 份文档：8 份完成、2 份预期失败**；共有 **5 个表格片段**，其中 ZIP 导入新增 CSV 第 2 行片段。检查结果见 `database-documents.json` 和 `database-table-chunks.json`。

上述 JSON 文件均位于 `output/features-20261013/`。这里只证明功能和数据链路，不据固定模型响应判断检索质量、回答正确率或 Rerank 校准效果。

## 浏览器与视觉检查

使用命名浏览器 `features-20261014`，仅 **1920×1080**。页面连接独立前端 15179 和后端 18086，未替换浏览器 API 响应。下列截图保留在忽略目录 `output/playwright/`。

| 流程 | 证据文件 |
| --- | --- |
| 收藏显示、个人备注与原回答入口 | `features-bookmarks-fixed.png` |
| 从旧版创建分支、保留来源会话 | `features-branch-created.png` |
| 变量模板及保留草稿插入 | `features-template.png`、`features-template-draft.png` |
| 版本增删文本、行号及弹窗层级 | `features-version-diff-fixed.png` |
| 文件夹/ZIP 路径与跳过提示、4 份资料完成 | `features-folder-zip-preview.png`、`features-folder-zip-completed.png` |
| ZIP 内 CSV 来源路径、正文和原始行号 | `features-import-source-path.png` |
| XLSX 库存表第 5 行整条记录高亮 | `features-xlsx-source.png` |
| CSV 第 3–4 行高亮及切换第 5 行 | `features-csv-source.png`、`features-csv-source-switch.png` |
| 撤权拒绝保存、清空会话、收藏隐藏与分支拒绝访问 | `features-revoked-bookmark.png`、`features-revoked-bookmark-list.png`、`features-revoked-branch.png` |

浏览器验收发现文档版本对比窗口位于 portaled 详情抽屉后方，导致右半部分被遮挡。已将该功能对话框同样挂载到 body，保持现有焦点管理；复测窗口全区域不被遮挡，切换版本清除结果、关闭恢复详情均通过。收藏原文按钮也补齐整行宽度。保留的无 `-fixed` 同名旧截图仅用于记录修复前状态。

撤权时实际收藏 PUT 返回 404，原会话内容和弹窗清除；随后列表返回 0 条收藏，分支历史和详情均返回 404。浏览器控制台相应资源 404 是预期拒绝路径。检查后已恢复合成用户的关联库访问，再清理整个隔离环境。

## 清理与发布边界

- 已停止命名浏览器及其进程、临时前端/后端，18086/15179 端口释放；删除的 schema 严格限定为 `rag_accept_20261013_features`。
- `cleanup.json` 确认 schema 已删除、public 六类业务表行数与根 `.env` 哈希保持不变。`runtime-cleanup.json` 确认临时进程退出，业务 8080 `/healthz` 的数据库/Redis/存储均为 ok，5173 返回 200。
- 当前业务后端仍为 `rag-server-chat-search-20261013.exe`，PID 28716；前端 PID 23488。保留原有进程级 Redis 500ms 预算和全部模型/检索默认，public 仅执行至 033。进程号可能随重启变化。
- **034–039 未应用到业务 public，六项功能尚未业务发布。** 发布需备份、停止旧后端、顺序迁移和同步更新前后端，见 [部署指南](13-deployment.md#六项功能扩展发布迁移-034039)。单实例与任务租约暂缓的决定保持。
- 既有跨会话搜索改动与六项扩展一并纳入本次 Git 提交；用户原有 `backend/cmd/dbquery/`、`backend/cmd/tmp-explain/` 未改且不纳入提交，夹具、构建、日志和截图均在忽略目录。

本轮未覆盖外部模型质量、真实 Redis/MinIO 的新专项验收、跨浏览器/触屏/屏幕阅读器、并发大批量容量基准或业务发布后的复验。表格不支持旧 `.xls`、宏、公式重算或统计分析引擎；版本对比仅比较解析文本。产品上限与行为以 [API](04-api-design.md)、[RAG](05-rag-pipeline.md) 和 [前端规范](10-frontend-spec.md) 为准。
