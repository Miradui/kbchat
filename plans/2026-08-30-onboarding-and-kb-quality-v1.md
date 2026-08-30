# P2 首次使用与知识库质量

## Objective

实现 `docs/15-product-improvement-roadmap.md` 中「P2 首次使用与知识库质量」的四项交付：

1. 创建知识库后直接引导上传文档，处理完成后提示可开始提问。
2. 检测同知识库内的重复文件内容，并由用户决定替换或保留。
3. 支持文档版本替换、过期提醒和解析异常提示。
4. 区分"知识库没有依据"、"检索失败"和"模型拒答"。

## Current Evidence

- 创建知识库后已经跳到 `/knowledge-bases/:id/documents?intent=upload`
  (`KnowledgeBaseListPage.tsx:199`)，`DocumentsPage.tsx:158-160` 消费该参数打开导入
  对话框。**引导的前半段已经存在，缺的是"处理完成后提示可开始提问"。**
- `model.Document` (`models.go:115-130`) 没有内容哈希列，也没有版本或替换关系列。重复
  检测和版本替换都需要新的列。
- `DocumentService.Upload` (`document_service.go:68-114`) 先 `Reserve` 存储路径、再写
  文件、再建 document+job。哈希必须在这个流程里算，且要在写库之前。
- `Document.ErrorMessage` 已存在并出现在 `DocumentResponse.errorMessage`
  (`dto/document.go:17`)。解析器返回的是裸 `fmt.Errorf` 文本，例如
  `parse pdf page 3: ...`、`content is not valid UTF-8`
  (`parser.go:53,71,109,112`)、`document contains no extractable text`
  (`processor.go:112`)。**前端目前直接显示这段英文技术文本。**
- `ChatService.ListKnowledgeGaps` 的注释 (`chat_service.go:461-466`) 明确把交付 4 记为
  P2：`no_citations` 目前同时覆盖"检索无结果"和"固定拒答文案"，因为两者在当前管线里是
  同一个条件；而"有引用但模型仍然拒答"缺少信号。
- 生成路径 (`chat_service.go:1391-1397`)：`len(searchRes.Items) == 0` 时使用固定文案
  `当前知识库中未找到足够依据回答该问题。`，不调用 Provider。检索本身失败时
  `s.retrieval.Search` 返回 error，直接冒泡成 HTTP 错误，会话里不留任何记录。
- `chat_messages` 已有 `intent` 列（migration 018），值域受 CHECK 约束限制为
  `conversation|knowledge_base|null`。
- 最新迁移是 018，下一个编号是 019。
- 前端有 `formatRelativeTime`、`EmptyState`、`ErrorState`、`Badge`、`toast`，页面级
  懒加载页面必须同步 `scripts/verify-route-chunks.mjs`（本次不新增页面）。

## Design Decisions

### 重复检测用内容哈希，不用文件名

同一份文件改个名再上传是最常见的重复情形，按文件名判重会漏掉它；反过来，同名但内容不同
的文件是正常的版本更新，按名字判重会误报。哈希是 SHA-256，在上传流里边写边算，不额外读
一遍文件。

### 重复检测返回 409 并附带冲突信息，不自动替换

自动替换会在用户没有确认的情况下让旧文档的 chunk 消失，而用户可能只是重复点了上传。返回
`DOCUMENT_DUPLICATE_CONTENT` 加上冲突文档的 id/filename/createdAt，由前端弹窗让用户选
"替换"或"保留两份"。保留两份需要显式的 `allowDuplicate=true`。

### 替换是新建一份 + 归档旧的，不是原地覆盖

原地覆盖会让一次失败的重新解析毁掉原本可用的文档：旧 chunk 已删、新 chunk 没建出来，知识
库直接少一块内容。改为新建 document 走完整处理流程，成功后再把旧文档标记为被取代。旧文档
保留 `supersededByID`，可追溯。

### 过期提醒是阈值 + 展示，不是自动删除

新增 `staleAfterDays` 配置（默认 180 天，0 表示关闭）。超过阈值的文档在列表和知识库概览
上出现"内容可能过期"提示。不自动删除、不自动降权检索：文档旧不等于内容错，静默降权会让
检索结果无法解释。

### 解析异常提示：分类映射，原文保留在服务端

新增 `errorCode` 字段（封闭集合），由服务端从 processor/parser 的错误分类得出，前端按代码
显示中文可行动文案。`errorMessage` 保留原文以便排障，但前端优先显示分类文案。与上一阶段
的诊断口径一致：分类给用户，原文给日志。

### 三种失败状态落库成 answerStatus，不靠猜文案

新增 `chat_messages.answer_status`（封闭集合，migration 019）：

- `answered`：正常回答。
- `no_basis`：知识型提问，检索成功但没有命中，用固定拒答文案。
- `retrieval_failed`：检索本身失败（向量化失败、DB 失败）。**这是新增的行为**：现在这种
  情况直接冒泡成 HTTP 错误，会话里什么都不留，用户刷新后看不到自己问过什么。
- `model_refused`：有引用但模型仍然拒答。

`model_refused` 需要一个当前管线没有的信号。用启发式判断会把正常的"根据资料，X 不适用于
Y"误判成拒答。改为在 system prompt 里要求模型在无法作答时输出一个固定标记，服务端识别该
标记后归类，并把标记从用户可见文案里剥掉。识别不到标记就是 `answered`——宁可少报，不可
误报。

历史行 `answer_status` 为 `NULL`，与 018 一致：迁移前的回答无法判定当时的状态，写任何值
都是编造。

## Implementation Plan

1. [ ] **migration 019**：`documents` 加 `content_hash`、`superseded_by_id`、
   `superseded_at`、`error_code`；`chat_messages` 加 `answer_status` 及 CHECK 约束；
   为 `(knowledge_base_id, content_hash)` 建部分唯一索引以外的普通索引（不建唯一索引：
   用户可以显式选择保留两份）。同步 `model` 结构体。
   *Rationale*：迁移是 schema 的唯一真相来源，GORM 不 AutoMigrate 既有结构。
   *Affected*：`backend/migrations/019_*.sql`、`internal/model/models.go`。

2. [ ] **上传时计算内容哈希**：在 `SaveKnowledgeBaseFile` 的流上算 SHA-256，写入
   `content_hash`。
   *Rationale*：边写边算，不额外读一遍文件；哈希必须在建 document 之前拿到。
   *Affected*：`internal/service/document_service.go`、`internal/storage/`。

3. [ ] **重复检测 + 409**：新增 `DocumentRepository.FindByContentHash`（带 owner 校
   验），`Upload` 命中且未带 `allowDuplicate` 时返回 `DOCUMENT_DUPLICATE_CONTENT`，
   payload 带冲突文档信息。命中后必须清理已写入的对象和存储预留。
   *Rationale*：不清理会在每次重复上传时泄漏一个孤儿对象。
   *Affected*：`document_service.go`、`document_repository.go`、`dto/document.go`、
   `handler/document_handler.go`。

4. [ ] **替换接口**：`POST /knowledge-bases/:id/documents/:documentId/replace`，上传新
   文件、走完整处理、成功后把旧文档标记 superseded。
   *Rationale*：新建+归档而不是原地覆盖，一次失败的解析不会毁掉原本可用的内容。
   *Affected*：`document_service.go`、`document_repository.go`、`router.go`、
   `handler/document_handler.go`。

5. [ ] **解析异常分类**：processor/parser 错误映射到封闭 `errorCode` 集合
   （`unsupported_type`、`corrupt_file`、`encoding_invalid`、`empty_content`、
   `embedding_failed`、`storage_failed`、`internal`），写入 `documents.error_code`。
   *Rationale*：用户需要的是"这个文件能怎么修"，不是 `parse pdf page 3: EOF`。
   *Affected*：`internal/document/processor/`、`internal/document/parser/`、
   `repository/document_repository.go`、`dto/document.go`。

6. [ ] **过期提醒**：`STALE_DOCUMENT_AFTER_DAYS` 配置（默认 180，0 关闭），
   `DocumentResponse` 增加 `staleAfterDays` 与 `isStale`。
   *Rationale*：阈值来自配置而不是硬编码，前后端用同一个值，不会漂移。
   *Affected*：`internal/config/config.go`、`dto/document.go`、`document_service.go`。

7. [ ] **answerStatus 落库**：`generatedChatAnswer` 增加 `answerStatus`，在
   `applyGeneratedProvenance` 这个单一写入点写库；`no_basis` 与 `answered` 先接上。
   *Rationale*：沿用 018 的单一写入点约定，分散写入迟早漂移出不自洽的行。
   *Affected*：`internal/service/chat_service.go`。

8. [ ] **检索失败也落库**：检索出错时写一条 `retrieval_failed` 的 assistant 消息再返回
   错误，附带用户可读文案。
   *Rationale*：现在这种情况会话里什么都不留，用户刷新后看不到自己问过什么。
   *Affected*：`chat_service.go`。

9. [ ] **模型拒答标记**：system prompt 增加固定标记要求，服务端识别后归类为
   `model_refused` 并把标记从可见文案剥掉。
   *Rationale*：启发式会把"根据资料，X 不适用于 Y"误判成拒答；识别不到标记就算
   `answered`，宁可少报不可误报。
   *Affected*：`chat_service.go`（prompt 构建与回答后处理）。

10. [ ] **知识缺口按 answerStatus 分类**：`ListKnowledgeGaps` 用 `answer_status` 区分三
    种情况，更新 `chat_service.go:461-466` 那段注释（它现在说这是 P2 待办）。
    *Rationale*：交付 4 的可观测出口就是这个列表，否则新状态没人看得见。
    *Affected*：`chat_service.go`、`repository/chat_repository.go`、`dto/chat.go`。

11. [ ] **后端测试**：哈希稳定性与重复检测（含孤儿对象清理断言）、替换成功与失败路径、
    错误分类映射表、过期阈值边界（含 0 关闭）、四种 answerStatus 各自落库、检索失败留
    痕、拒答标记被剥离且不误报。

12. [ ] **前端：上传完成引导**。文档处理完成后提示可开始提问，带跳转到问答的入口。
    *Affected*：`frontend/src/pages/Documents/DocumentsPage.tsx`。

13. [ ] **前端：重复文件对话框**。409 时弹窗给"替换"与"保留两份"两个选择。
    *Affected*：`DocumentsPage.tsx`、`src/api/resources.ts`、`src/types/api.ts`。

14. [ ] **前端：解析异常与过期提示**。按 `errorCode` 显示中文可行动文案（未知代码回落中
    性文案），过期文档显示提示。
    *Affected*：`DocumentsPage.tsx`、知识库概览页。

15. [ ] **前端：三种失败状态区分**。聊天里按 `answerStatus` 显示不同提示，质量页知识缺口
    按新分类展示。
    *Affected*：`pages/Chat/`、`pages/Quality/QualityPage.tsx`。

16. [ ] **前端测试**：重复对话框两个分支、错误代码映射含未知回落、过期提示阈值、三种
    answerStatus 的渲染差异、上传完成引导出现时机。

17. [ ] **文档**：`04-api-design.md` 记录新字段与新接口、封闭集合、409 契约；roadmap 标记
    完成；handoff 记录 019 不回填的理由、替换的语义、拒答标记的局限（依赖模型遵从提示，
    不遵从时会少报）。

## Verification

- `cd backend && go vet ./... && go test -count=1 ./...`
- `cd frontend && npx tsc -b && npx vitest run && npm run build`
- 每个功能点单独提交。

不可在本环境验证的部分（必须写进 handoff 而不是假装验证过）：

- migration 019 对真实 PostgreSQL 的执行。
- 真实 Provider 是否遵从拒答标记的提示要求。
- 真实 PDF/DOCX 损坏文件的解析错误分类（只能用构造的错误覆盖）。
