# P2 权限与协作

## Objective

实现 `docs/15-product-improvement-roadmap.md` 中「P2 权限与协作」的四项交付：

1. 在现有 owner/member 能力上明确 viewer/editor/manager 行为矩阵。
2. 下载、导出、反馈运营数据和永久删除分别校验权限。
3. 对所有资源 ID 增加跨用户、已删除知识库和成员撤销后的契约测试。
4. 暂不引入复杂组织树、SSO 或通用策略引擎。

## Current Evidence

调查结论：**系统目前实质上是 owner-only 的。**

- `knowledge_base_members` 在整个代码库里只被**一处**用于鉴权：
  `findKnowledgeBaseForManagement` (`knowledge_base_service.go:757`)，它只认
  `Role == "manager"`，且只守 5 个端点（permissions 读写 + 成员增删改）。
- 其余全部知识库、文档、会话、检索、搜索、质量端点都按
  `knowledge_bases.owner_id = <caller>` 鉴权，完全不看成员表。**一个 `manager` 成员今天
  连文档都读不到，也在列表里看不见这个知识库。**
- `member` 角色已持久化但**不授予任何权限**：满足 CHECK 约束、出现在 `Members[]` 里，
  实际权限为零。
- `role` 的值域由 `migrations/009_kb_members_and_chat_archive.sql:8` 的
  `CHECK (role IN ('manager', 'member'))` 约束，没有 Go 常量集合，全是裸字符串字面量。
  加 `viewer`/`editor` 必须新开一个迁移重建该约束。
- 鉴权分散在 repository 谓词里而不是一个决策函数里：`FindByIDAndOwner`
  (`document_repository.go:171`)、`FindMessageByIDAndOwner` (`chat_repository.go:310`)、
  `global_search_repository.go` 的 5 处裸 SQL 都硬编码 `owner_id`。**今天没有单一改动点。**
- 404 与 403 的口径已经不一致：唯一的成员感知 helper 返回 403，所有 owner-only 路径返回
  404。
- `visibility`（`private`/`public`）存了、能过滤，但**任何鉴权路径都不读它**，`public`
  当前不授予任何权限。
- `managed` 列表 scope 被接受但是死的：`workspaceBaseQuery`
  (`knowledge_base_repository.go:122`) 无条件 `owner_id = ?`。
- `AddMember` 是 upsert 而不是 create：`members.Save` 走 `ON CONFLICT DO UPDATE`，POST
  会静默覆盖已有角色并仍然返回 201。
- 三个 helper 都把「目标是 owner」拒成 400 `OWNER_MEMBER_IMMUTABLE`。
- 硬删除有 6 个端点（3 个单条 + 3 个清空），全部 owner-only；导出有 2 个
  （会话导出、搜索导出），没有文档导出。
- `validateQualityKnowledgeBase` (`chat_service.go:749`) 在 `knowledgeBaseId` 为 nil 时
  **直接返回 nil**，作用域完全依赖 repository 的 `owner_id` 过滤。
- JWT 只带 `UserID`，没有角色声明；`middleware/auth.go:16` 不做任何资源级鉴权。

## Design Decisions

### 角色是四级线性等级，不是能力位图

`viewer < editor < manager < owner`。每个能力声明它需要的**最低**等级，鉴权是一次比较。

不做能力位图（每个成员一组独立开关）的理由：位图的表达力用不上——四项交付要的是四种人，
不是任意组合——但它会让每个端点的鉴权变成一次集合运算，且没有任何 UI 能让用户理解自己
被授予了什么。线性等级可以在一行里说清："editor 能做 viewer 的一切，外加改内容"。

`owner` 仍然不是成员表里的一行，它由 `knowledge_bases.owner_id` 决定。这一点不变：owner
是所有权而不是授权，把它写进成员表会产生两个真相来源。

### 迁移把历史 `member` 读成 `viewer`，不留在无权限状态

`member` 今天权限为零。迁移后它映射到 `viewer`（可读可问，不可改）。

理由：owner 当初把这些人**显式加进了知识库**，零权限是当前实现的缺陷而不是 owner 的意图；
让他们停在零权限等于把一个 bug 冻结成语义。历史行用 UPDATE 改写成 `viewer`，值域从
`{manager, member}` 变成 `{viewer, editor, manager}`，旧值 `member` 不再合法。

这与上一阶段「不回填」的选择方向相反，原因是这次能确定地知道答案：`member` 的语义是明确
的单一值，不需要从自由文本里猜。

### 鉴权是「先解析再判断」，不再靠 repository 谓词

新增 `internal/access` 包：角色常量、能力常量、`Resolve(actor, kb, member) Role`、
`Authorize(role, capability) error`。服务层用一个 helper 取代 `FindByIDAndOwner` 这类
调用：先按 id 取资源，再解析实际角色，再对所需能力判断。

代价是 repository 层不再自带鉴权护栏，一次遗漏就是一个越权。补偿措施是交付 3 的契约测
试：对每个资源 id 都验证跨用户、已删除知识库、成员撤销后的行为，以及一个遍历路由表断言
「每个知识库相关路由都声明了所需能力」的测试。

### 无权访问返回 404，有权但能力不足返回 403

`viewer` 尝试删除文档得到 403（他知道这个文档存在）；毫无关系的用户得到 404（不能从状态
码推断 id 是否存在）。这是现有两种口径的合并规则，而不是新发明的一种：把 owner-only 路径
的 404 保留给「无任何访问权」，把成员感知 helper 的 403 保留给「有访问权但不够」。

### 能力矩阵

| 能力 | 最低角色 | 覆盖 |
| --- | --- | --- |
| `kb.read` | viewer | 知识库详情、统计、列表可见性、收藏、浏览记录 |
| `kb.search` | viewer | `POST /knowledge-bases/:id/search`、全局搜索命中 |
| `chat.use` | viewer | 会话增删改、提问、流式、编辑、重生成 |
| `chat.export` | viewer | `GET /chat/sessions/:id/export`（只导出自己的会话） |
| `feedback.write` | viewer | 对自己收到的回答评价 |
| `document.read` | viewer | 文档列表、详情、预览、chunks |
| `document.download` | editor | 下载原始文件 |
| `content.write` | editor | 上传、替换、改元数据、重新处理、软删除、还原 |
| `content.purge` | manager | 6 个硬删除端点 |
| `quality.read` | manager | `/chat/quality/*` 运营数据 |
| `members.read` | manager | `GET /:id/permissions` |
| `members.write` | manager | 成员增删改、`PUT /:id/permissions` |
| `kb.write` | manager | 改知识库名称、描述、分类、标签、可见性 |
| `kb.delete` | owner | 软删除、还原知识库 |

四处需要解释的边界：

- **`document.download` 是 editor 而不是 viewer。** viewer 通过引用和 chunks 已经能看到
  被索引的正文，所以这条线不是「能不能看内容」。原始文件比索引正文多：修订记录、批注、
  嵌入对象、作者元数据都不进 chunk。把下载留给 editor 让「参与维护的人」和「只是来问问
  题的人」分开，这也是交付 2 要求它单独校验的原因。
- **`quality.read` 是 manager 而不是 editor。** 质量数据聚合的是**别人**问过的问题和给出
  的负反馈。这比编辑内容多一步：它暴露同事的使用行为。
- **`content.purge` 是 manager 而不是 owner。** 硬删除不可逆，但让 owner 成为唯一能清回
  收站的人会让委派管理失去意义。给 manager，同时保留 `kb.delete` 为 owner-only——删掉整
  个知识库和清理它内部的垃圾不是一件事。
- **`chat.use` 和 `chat.export` 都是 viewer，且都只作用于自己的会话。** 会话仍然按
  `chat_sessions.user_id` 归属；能力检查是叠加在上面的第二道，不是替代。

### `visibility` 暂不参与鉴权

`public` 今天不授予任何权限，本轮**不改这一点**。让 `public` 意味着「本实例任何登录用户
可读」是一个产品决定而不是权限重构的副产品：它会让每个已存在的 `public` 知识库在一次部
署后突然对所有人可读，而 owner 从未同意过。留作待办并写进 handoff。

### 不做的事

不引入组织树、SSO、通用策略引擎，不给 JWT 加角色声明（诊断接口的角色限制是独立待办，见
roadmap），不改 `users.role`。

## Implementation Plan

1. [ ] **`internal/access` 包**：角色与能力常量、等级序、`Rank`、`Allows`、
   `CapabilityMinRole` 矩阵，以及一个断言矩阵覆盖全部能力常量的测试。
   *Rationale*：矩阵是这一阶段的真相来源，先让它可测且独立于服务层。
   *Affected*：`backend/internal/access/`。

2. [ ] **migration 020**：重建 `knowledge_base_members_role_check` 为
   `('viewer','editor','manager')`，把历史 `member` UPDATE 成 `viewer`。
   *Rationale*：值域是 schema 的一部分；Go 常量与 CHECK 必须同时存在，测试解析迁移防漂移。
   *Affected*：`backend/migrations/020_*.sql`。

3. [ ] **解析器接进服务层**：`KnowledgeBaseService` 上新增
   `resolveKnowledgeBaseAccess(ctx, actorID, kbID, capability)`，返回 kb + 实际角色；
   404/403 按上面的口径。用它重写 `findKnowledgeBaseForManagement`。
   *Rationale*：先建立单一决策点，再逐个端点迁移，避免一次大改。
   *Affected*：`internal/service/knowledge_base_service.go`。

4. [ ] **知识库读路径迁移**：详情、统计、收藏、浏览、permissions 读写、成员增删改按矩阵
   走新 helper；`kb.write` 与 `kb.delete` 分开。
   *Affected*：`knowledge_base_service.go`、`handler/knowledge_base_handler.go`。

5. [ ] **列表可见性**：`workspaceBaseQuery` 从 `owner_id = ?` 改为「owner 或成员」，
   `managed` scope 变成真的过滤 manager 成员身份；响应带 `effectiveRole`。
   *Rationale*：成员看不见知识库时角色矩阵没有任何可观察效果，这是用户第一眼会发现的缺陷。
   *Affected*：`repository/knowledge_base_repository.go`、`dto/knowledge_base.go`。

6. [ ] **文档路径迁移**：`document.read` / `document.download` / `content.write` /
   `content.purge` 分别校验；`findDocument` 改为先取文档再解析知识库访问。
   *Affected*：`internal/service/document_service.go`、`repository/document_repository.go`。

7. [ ] **会话与反馈路径迁移**：`findSession` 不再要求 KB owner，改为 `chat.use`；
   导出走 `chat.export`；反馈走 `feedback.write`；硬删除走 `content.purge`。
   *Affected*：`internal/service/chat_service.go`、`repository/chat_repository.go`。

8. [ ] **质量与检索路径迁移**：`/chat/quality/*` 走 `quality.read`（含
   `knowledgeBaseId` 为 nil 时的作用域收敛）；检索与全局搜索走 `kb.search`。
   *Affected*：`chat_service.go`、`internal/retrieval/service.go`、
   `repository/global_search_repository.go`。

9. [ ] **契约测试**：跨用户、已删除知识库、成员撤销后，对每个资源 id 断言状态码；
   一个遍历能力矩阵的表驱动测试覆盖全部端点。
   *Rationale*：鉴权护栏从 repository 谓词移到服务层后，遗漏不再有编译期信号。
   *Affected*：`internal/service/*_test.go`、`internal/router/router_test.go`。

10. [ ] **前端角色与能力**：`MemberRole` 改为三值，角色文案与选择器更新，
    `effectiveRole` 驱动按钮与入口的可见性。
    *Affected*：`frontend/src/types/api.ts`、`pages/KnowledgeBase/MembersPanel.tsx`、
    文档与会话页面的操作入口。

11. [ ] **文档**：`04-api-design.md` 记录能力矩阵、`effectiveRole` 字段、404/403 口径；
    `09-error-codes.md` 记录 403 场景；roadmap 标记完成；handoff 记录 `member` 被改写成
    `viewer` 的理由、`visibility` 暂不参与鉴权、以及护栏位置变化带来的风险。
