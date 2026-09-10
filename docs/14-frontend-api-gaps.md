# 前端接口缺口

本文件记录前端在信息架构重构和 UI 优化中发现的后端接口缺口。每条说明缺什么、阻塞哪个页面、以及建议的接口形态。

优先级含义：

- **P1** — 明显影响体验或正确性，前端已做妥协
- **P2** — 后续增强，当前不影响主流程

当前记录的 G1–G21 均已闭环。G14 由前端 XHR 传输进度完成，不需要后端协议变更；G16、G19 已补齐后端端点及前端接入。G21 先记录缺口，再补齐服务端聚合筛选和前端接入。

## 2026-09-10 问答与导入功能核对

本轮先实现回答 Markdown、会话内原文预览、跨页面上传，核对后无需新增后端端点：

- Markdown 复用消息 `content` 与 `citations`；引用按钮只解析当前回答中有效的来源编号，不从正文生成来源数据。
- 原文侧栏复用 `GET /documents/:id`、`GET /documents/:id/preview`、`GET /documents/:id/download`，
  以现有 citation 的 `pageNumber` 定位 PDF 页；服务端继续负责权限校验，前端核对文档所属知识库。
- 跨页面上传复用现有上传、替换、重复文件处理及文档详情接口。上传任务从页面组件提升为应用级状态，
  以文档详情中的真实状态追踪解析与向量化；取消或网络中断造成的未知上传结果不自动重新提交。
- 跨页面继续指当前浏览器标签页内的路由切换，不新增断点续传协议。页面刷新或关闭时，对仍未完成的上传给出离开提醒。

## 2026-09-10 UI 优化发现

### G21 文档「处理中」汇总筛选不完整（P1，已实现）

优化前，文档页计数条的「处理中」包含 `uploaded`、`parsing`、`chunking`、`embedding`，
但点击时只发送 `status=parsing`。这会让用户看到非零计数，却在点击后得到空列表，
也会遗漏正在上传后排队、切片和向量化的文档。首页的处理中入口当时还直接跳转全部文档。

需要在 `GET /documents` 与 `GET /knowledge-bases/:id/documents` 的同一查询面增加
`status=processing`，由服务端按这四个状态筛选并计算分页总数；具体阶段筛选继续保留。
`processing` 只是查询别名，不新增数据库状态。前端计数条和首页使用该汇总筛选，
URL 刷新后应保留筛选，阶段选择器提供「全部处理中」及各具体阶段。

验收：覆盖四种处理中状态、排除 completed/failed、保持知识库权限与分页；
全局页与知识库内文档页的返回结果一致。

落地：共享 repository 查询增加 GORM `IN` 条件；前端查询类型单独定义
`DocumentStatusFilter`，不把 `processing` 混入文档实体状态。文档计数条、阶段选择器、
URL 恢复、首页与知识库概览的处理中入口均已接入；service 回归覆盖权限、全局/知识库作用域和分页，
前端回归覆盖点击筛选、具体阶段切换和直接打开深链接。

代码中引用本文件时使用编号，例如 `// See docs/14-frontend-api-gaps.md G1`。

已实现的条目保留编号并标注「已实现」，接口细节以 `docs/04-api-design.md` 为准。

---

## 已实现

| 缺口 | 落地内容 |
|------|---------|
| G1 | `GET /api/v1/chat/sessions` 支持 `knowledgeBaseId`、`archived`、`q`、`page`、`pageSize`，响应加 `total/page/pageSize` 与 `knowledgeBaseName`、`messageCount`、`lastMessagePreview` |
| G2 | 新增 `POST /api/v1/chat/sessions/:id/messages/stream`（SSE）；无 `done`、`status=0` 与网络异常统一进入结果未知对账，重试复用原 `clientRequestId` |
| G3 | 新增 `POST /api/v1/chat/sessions/:id/unarchive` |
| G4 | `GET /api/v1/knowledge-base-tags` 每项返回 `knowledgeBaseCount` |
| G5 | `GET /api/v1/knowledge-base-categories` 每个节点返回 `directCount` 与 `totalCount` |
| G6 | 新增 `GET /api/v1/system/capabilities` |
| G7 | 新增 `PUT /api/v1/documents/:id`，支持重命名与跨知识库移动（chunks 同事务迁移） |
| G8 | 新增 `POST /api/v1/documents/:id/cancel`；Embedding 批次间检查取消，chunks 发布与 completed 终态原子提交 |
| G9 | `GET /api/v1/search` 结果项新增 `highlights`，偏移量为 UTF-16 code unit |
| G10 | 新增 `GET /api/v1/search/suggest`，仅标题级检索 |
| G11 | 新增 `PUT /api/v1/auth/me`、`POST /api/v1/auth/change-password`；显示字段和密码最小长度按 Unicode 码点计，密码上限与 bcrypt 对齐为 72 个 UTF-8 字节 |
| G12 | 新增 `POST /api/v1/knowledge-bases/batch-tag`，支持 add/remove/replace |
| G13 | 新增 `GET /api/v1/knowledge-bases/:id/stats` |
| G14 | multipart 上传改用 XHR，根据 `loaded / total` 字节展示逐文件真实传输百分比；后端接口不变 |
| G15 | 会话改软删除，新增聊天回收站（列表 / 恢复 / 永久删除 / 清空） |
| G16 | migration 014 增加消息反馈字段；新增 `POST /api/v1/chat/messages/:messageId/feedback` |
| G17 | 新增 `GET /api/v1/home/summary`，一次返回工作台聚合数据 |
| G18 | 新增 `GET /api/v1/activities` 与 `activities` 表（migration 012） |
| G19 | 新增 `GET /api/v1/chat/sessions/:id/export` Markdown 导出和 `GET /api/v1/search/export` CSV 导出 |
| G20 | `GET /api/v1/knowledge-bases/:id/documents` 与 `GET /api/v1/documents` 对齐为同一查询面，重复实现已删除 |
| G21 | 两个文档列表接口支持 `status=processing`，汇总 uploaded、parsing、chunking、embedding，并保持权限和分页一致 |

---

## 最近闭环的条目

### G14 上传进度（已实现）

前端 multipart 请求使用 `XMLHttpRequest.upload.onprogress`，根据 `loaded / total`
字节展示逐文件真实传输百分比。上传完成后仍单独展示文档解析、切片和
Embedding 状态；断点续传不在当前范围。

---

### G16 回答反馈（已实现）

`POST /api/v1/chat/messages/:messageId/feedback` 接受 `positive|negative`，只允许
评价当前用户可见的 assistant 消息。migration 014 持久化评价和更新时间，
消息列表固定返回 nullable `feedback`。

### G19 导出（已实现）

`GET /api/v1/chat/sessions/:id/export` 导出 Markdown 会话及 citations；
`GET /api/v1/search/export?q=&type=` 导出当前筛选的 UTF-8 BOM CSV，最多 5000 条。

### G20 两个文档列表接口能力不对等（已实现）

`GET /api/v1/knowledge-bases/:id/documents` 现在是 `GET /api/v1/documents` 的知识库限定视图：同一套 `q`、`status`、`fileType`、`sort`、`page`、`pageSize`，同一套响应结构，`knowledgeBaseId` 由路径固定。原来那份能力更弱的并行实现（repository 的 `ListByKnowledgeBase`、service 的 `List` 分支、`dto.DocumentListResponse`）已删除，不存在第二条代码路径。

注意这是兼容性变更：该接口过去不分页、一次返回全部文档，现在默认 `pageSize=20`。`frontend/src/pages/KnowledgeBase/KnowledgeBaseOverviewPage.tsx` 已相应改为「最近 6 条 + 按状态取 `total`」，不再靠数一页文档得出状态计数。

---

## 前端接入位置

| 缺口 | 接入位置 |
|------|---------|
| G1 | `frontend/src/pages/Chat/useChatSessions.ts` 服务端筛选分页；`ChatSessionRail.tsx` 只做时间分组 |
| G2 | `frontend/src/api/client.ts` 的 `apiEventStream`；`resources.ts` 的 `sendChatMessageStream`；`useChatThread.ts` 的 `streamingAnswer` / `streamingCitations`；`ChatPage.tsx` 逐字渲染 |
| G3 | `frontend/src/pages/Chat/ChatPage.tsx` 会话菜单的「取消归档」；会话栏「活跃 / 已归档」切换 |
| G4 | `frontend/src/pages/Tags/TagsPage.tsx` 使用量列与删除确认文案 |
| G5 | `frontend/src/pages/KnowledgeBase/CategoryTree.tsx` 节点计数徽标 |
| G6 | `frontend/src/hooks/useSystemCapabilities.ts` + `frontend/src/store/systemCapabilitiesStore.ts`，由 `DocumentImportDialog.tsx` 与 `RetrievalConfigForm.tsx` 消费 |
| G7 | `frontend/src/pages/Documents/DocumentsPage.tsx` 行菜单「重命名」+ `RenameDocumentDialog` |
| G8 | `frontend/src/pages/Documents/DocumentsPage.tsx` 行菜单「取消处理」；`DocumentProgress.tsx` 显示 `cancelled` |
| G9 | `frontend/src/pages/Search/SearchPage.tsx` 的 `highlight()` 改为渲染服务端 `highlights`，客户端子串匹配已删除 |
| G10 | `frontend/src/components/CommandPalette.tsx` 改用 `searchSuggest` |
| G11 | `frontend/src/layouts/AccountSettingsDialog.tsx`，由 `AppShell.tsx` 用户菜单「账户设置」打开 |
| G12 | `frontend/src/pages/KnowledgeBase/KnowledgeBaseListPage.tsx` 批量操作栏的标签 + 方式选择 |
| G13 | `frontend/src/pages/KnowledgeBase/KnowledgeBaseOverviewPage.tsx` 基础信息面板的趋势区 |
| G14 | `frontend/src/api/client.ts` 的 `apiUploadRequest`；`DocumentImportDialog.tsx` 逐文件进度条 |
| G15 | `frontend/src/api/resources.ts` 的 `listChatSessionRecycleBin` / `restoreChatSession` 等 |
| G16 | `frontend/src/api/resources.ts` 的 `setChatMessageFeedback`；`ChatMessage.tsx` / `ChatPage.tsx` 评价控件与局部更新 |
| G17 | `frontend/src/pages/Home/homeData.ts` 单请求 + 并发合流 |
| G18 | `frontend/src/pages/Home/activityDisplay.ts`；`HomePage.tsx` 时间线 |
| G19 | `frontend/src/api/resources.ts` 的两个导出函数；`ChatPage.tsx` 导出 Markdown，`SearchPage.tsx` 导出 CSV |
| G20 | `frontend/src/api/resources.ts` 的 `listDocuments(id, params)`；`KnowledgeBaseOverviewPage.tsx` 按状态取 `total` |
| G21 | `DocumentsPage.tsx` 计数条和阶段选择器、`useDocumentList.ts` URL 恢复、`HomePage.tsx` 与 `KnowledgeBaseOverviewPage.tsx` 处理中入口 |
