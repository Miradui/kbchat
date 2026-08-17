# 前端信息架构重构与视觉语言重建 v1

日期：2026-08-05
范围：`frontend/`、`docs/10-frontend-spec.md`、新增 `docs/14-frontend-api-gaps.md`

---

## 1. 诊断：为什么现在"反人类"

以下都是结构性问题，不是审美问题。每条带证据。

| # | 问题 | 证据 |
|---|------|------|
| D1 | **导航断裂**：主导航 3 项，实际 6 个区域。`/documents`、`/tags` 是孤儿路由，只能从知识库列表页工具栏两个文字链接进入，且高亮时伪装成"知识库" | `PrimaryNav.tsx:7-11` 只有 3 项；`PrimaryNav.tsx:14` 把 documents/tags 强行映射为 knowledge-bases |
| D2 | **全局互斥锁冻结整页**：收藏一个知识库 → 所有行操作、分类树、筛选、排序、视��切换、顶部链接全部禁用 | `KnowledgeBaseListPage.tsx:152` 单一 `workspaceMutationRef`；`:169-170` 汇聚成 `workspaceMutationBusy`；`:1062-1091` 连导航链接都被 `aria-disabled` + `tabIndex={-1}` |
| D3 | **纯本地 UI 选择被做成阻塞式网络写**：切换卡片/列表视图、展开分类节点都会 `PUT /workspace-preference`，进而触发 D2 的锁 | `KnowledgeBaseListPage.tsx:428-446` → `persistPreference` → `flushPreferenceQueue` → `setPreferenceSaving(true)` |
| D4 | **两套几乎相同的文档页**，用户要学两遍 | `DocumentsPage.tsx`（773 行）与 `DocumentsLandingPage.tsx`（608 行）各有一套表格、筛选栏、状态卡、导入入口、回收站、详情抽屉 |
| D5 | **知识库内文档页只能客户端筛选**：`GET /knowledge-bases/:id/documents` 无任何 query 参数，全量拉取后前端过滤 | `resources.ts:289`；后端 `document_handler.go:95-113` 确实不读 query |
| D6 | **聊天拆成三页**，且切换知识库的行为不可预测（可能跳到别的会话，也可能新建草稿） | `/chat` `ChatLandingPage` + `/chat/new` + `/chat/:id` 都是 `ChatPage`；`ChatPage.tsx:483-500` `handleKnowledgeBaseChange` |
| D7 | **知识库详情 tab 机制不一致**：概览/问答/设置走 `?tab=`，文档走子路径 | `KnowledgeBaseSectionNav.tsx:12-17` |
| D8 | **"AI 问答"tab 是一个只有一个按钮的空页** | `KnowledgeBaseDetailPage.tsx:726-755` |
| D9 | **实现细节泄漏成用户文案**："发送结果暂时无法确认。请先再次检查；如仍未显示，再确认是否重新发送。"、"操作已成功，但页面数据刷新失败。无需重复提交…" | `ChatPage.tsx:222,585,695`；`KnowledgeBaseListPage.tsx:83` |
| D10 | **统计卡泛滥**：首页 4 + 知识库列表 4 + 全局文档 3 + 知识库文档 3 + 详情 4 = 18 个统计卡，全部不可点击、不可下钻 | 各页 `StatsGrid` / `MetricCard` |
| D11 | **三层互相覆盖的 CSS**：`styles.css`(3726) + `macos.css`(毛玻璃/蓝 `#087cf0`) + `premium.css`(扁平/绿 `#1f6b57`) 覆盖同一批选择器 | `styles/index.css:1-12` 的 import 顺序；`macos.css:24-34` 与 `premium.css:43-53` 对 `button` / `.secondary-button` 的重复定义 |
| D12 | **tokens 里有自认的 legacy 层** | `tokens.css:42` `/* Legacy workspace aliases ... */` 起 20 行别名 |
| D13 | **单文件 1971 行**：列表 + 统计 + 分类 CRUD + 回收站 + 批量 + 表单 + 移动 + 分页全在一个组件 | `KnowledgeBaseListPage.tsx` |
| D14 | **顶栏搜索框是假的**：一直占着 620px，输入后必须按 Enter 才跳走，没有任何即时反馈 | `AppShell.tsx:197-200` |
| D15 | **聊天输入框不像聊天输入框**：固定 2 行、无 Enter 发送、无自动增高；改名是常驻输入框 + "改名"按钮挂在标题栏 | `ChatPage.tsx:1070-1080, 1240-1253` |
| D16 | 表格过宽低信噪：知识库表 8 列（含"更新人""可见性"独立列），文档表 9 列（含永远显示 `-` 的"处理提示"列） | `KnowledgeBaseListPage.tsx:1578-1584`；`DocumentsPage.tsx:624-630` |
| D17 | 分页器最多显示 3 个页码；全局文档页只显示当前页一个数字 | `KnowledgeBaseListPage.tsx:1941-1945`；`DocumentsLandingPage.tsx:520-522` |
| D18 | `formatDateTime` 在 6 个文件里各写一遍，`documentStatusLabel` 写了两遍 | Home / KBList / KBDetail / Chat / ChatLanding / Tags；`KnowledgeBaseDetailPage.tsx:1184` vs `documentDisplay.ts` |

---

## 2. 新信息架构

### 2.1 路由表

```text
/login

/home                              工作台首页
/chat                              问答（空态 = 原 ChatLandingPage 内容）
/chat/:sessionId                   问答线程
/knowledge-bases                   知识库列表
/knowledge-bases/:id               知识库概览
/knowledge-bases/:id/documents     知识库内文档
/knowledge-bases/:id/settings      知识库设置（检索配置 + 检索测试 + 成员权限）
/documents                         全局文档
/tags                              标签
/search                            全局搜索结果页
```

**删除的路由**：`/chat/new`、`?tab=qa`

**兼容重定向**（保护现有深链接和后端/文档里的约定）：

| 旧 | 新 |
|----|----|
| `/chat/new?knowledgeBaseId=X` | `/chat?knowledgeBaseId=X`（301 式 `<Navigate replace>`） |
| `/knowledge-bases/:id?tab=overview` | `/knowledge-bases/:id` |
| `/knowledge-bases/:id?tab=settings` | `/knowledge-bases/:id/settings` |
| `/knowledge-bases/:id?tab=qa` | `/chat?knowledgeBaseId=:id` |

**保持不变的深链接合同**：
`/knowledge-bases/:id/documents?intent=upload`、`?documentId=`、`?chunkId=` —— 引用卡（`ChatMessage.tsx:188`）和全局搜索（`SearchPage.tsx:276-293`）都依赖它们。

### 2.2 主导航

```text
┌─────────────────────┐
│  ⌘  RAG Console     │
│                     │
│  ＋ 新建对话         │   ← CTA
│                     │
│  工作台              │
│    ⌂  首页          │  /home
│    ✳  AI 问答       │  /chat
│                     │
│  知识                │
│    ▤  知识库        │  /knowledge-bases
│    ▢  文档          │  /documents
│    ◈  标签          │  /tags
│                     │
│  ─────────────      │
│  ◯ 当前用户    ⌄    │   ← popover: 主题 / 退出登录
└─────────────────────┘
```

关键变化：
- 6 个区域全部有一级入口，`active` 不再需要伪装映射。
- **分类树从 app rail 移入知识库列表页面内的左列**。现在它挂在侧边栏底部、只在一个页面出现，导致侧栏在页面间跳动（`WorkspaceShell.tsx:26-37`）。移入页面后 app rail 在所有页面完全稳定。
- 用户名 + 退出登录收进底部 popover，腾出顶栏。

### 2.3 顶栏

```text
┌──────────────────────────────────────────────────────────────┐
│  知识库 › 产品文档库                    [🔍 搜索  ⌘K]  [页面操作] │
└──────────────────────────────────────────────────────────────┘
```

- 左：由路由推导的面包屑（承担当前每个页面重复的 `breadcrumb + h1 + page-description` 三件套里的前两件）
- 中/右：**⌘K 命令面板触发按钮**，替代现在那个占 620px 但按 Enter 才有反应的假搜索框
- 右：页面级主操作插槽（如"新建知识库""导入文档"）

**命令面板**（新增 `components/CommandPalette.tsx`）：
- `⌘K` / `Ctrl+K` 唤起，`Esc` 关闭，↑↓ 选择，Enter 打开
- 300ms 防抖调 `GET /search`，`AbortSignal` 取消过期请求（复用 `SearchPage` 已有的正确实现）
- 结果按 知识库 / 文档 / 内容片段 分组，各取前 5
- 底部固定项："查看全部结果 →" 进入 `/search?q=`
- 同时收录导航命令（"新建知识库""导入文档""前往标签"）

---

## 3. 逐页重设计

### 3.1 `/home`

现状：3 个大快捷入口卡 + 4 个统计卡 + 4 个 panel 组成的网格，全是被动信息。

新：

```text
下午好，管理员
────────────────────────────────────────
[ 有什么想问的？                    ↵ ]   ← 直接跳 /chat 并带上问题

⚠ 需要处理                                ← 仅在有内容时出现
   3 个文档处理失败        产品手册.pdf 等   [查看]
   2 个文档正在处理                        [查看]

继续
   ▸ 关于退货政策的问答        产品文档库 · 2 小时前
   ▸ 产品文档库                知识库 · 昨天
   ▸ 技术规范.pdf 已完成处理    技术库 · 昨天
   （会话/知识库/文档合并成一条时间线，不是三个 panel）

24 个知识库 · 186 篇文档 · 1.2k 次浏览 · 340 条问答     ← 一行 inline，不是卡片
```

- 4 个统计卡 → 一行 inline 指标条
- 3 个 panel + 1 个失败 panel → 1 个合并时间线 + 1 个条件式"需要处理"区
- 保留现有的分区独立加载 + 分区重试（`useRegion`，`HomePage.tsx:150-185`），这部分设计是对的

### 3.2 `/knowledge-bases`

```text
┌──────────┬──────────────────────────────────────────────────────┐
│ 分类      │ [搜索…]  全部|我创建|收藏|最近   标签⌄ 可见性⌄ 排序⌄ ▤▦ ⋯ │
│  全部 24  │ ────────────────────────────────────────────────────  │
│  ▸ 产品 8 │ 24 个知识库 · 3 个处理中 · 1 个存在失败   ← 可点击筛选  │
│  ▸ 技术 12│                                                      │
│  ▸ 运营 4 │ ┌──────────────────────────────────────────────────┐ │
│           │ │ ☐ ▤ 产品文档库          可问答   12  2小时前  ★ ⋯│ │
│  管理分类  │ │      产品线全部对外文档                          │ │
│           │ │      #对外 #产品                                 │ │
│           │ └──────────────────────────────────────────────────┘ │
│           │              ‹ 1 2 3 … 12 ›              [新建知识库]│
└──────────┴──────────────────────────────────────────────────────┘
```

- **表格 8 列 → 5 列**：名称（含描述 + 标签 + 可见性图标）/ 状态 / 文档数 / 更新时间 / 操作。"更新人"移到名称单元格的 title；"可见性"变成名称前图标
- **4 个统计卡 → 1 行可点击 inline 计数**（点"3 个处理中"= 筛选出处理中的知识库）
- 「回收站」「管理标签」现在是工具栏上三个并排的次级按钮，收进右侧 `⋯` 溢出菜单
- 「管理分类」移到左侧分类列底部
- 分页器补全：`‹ 1 … 4 5 6 … 12 ›`

### 3.3 `/knowledge-bases/:id`（概览 / 文档 / 设置）

```text
▤ 产品文档库  [私有]                        [基于此知识库提问]  [⋯]
产品线全部对外文档
概览 | 文档 | 设置
─────────────────────────────────────────────────────────────
```

- Sub nav 从 4 项 → **3 项**（删掉只有一个按钮的"AI 问答"tab，D8）
- 「基于此知识库提问」升为常驻主按钮，在三个子页都在（现在只在 overview tab 出现，且有 5 个分支状态：`KnowledgeBaseDetailPage.tsx:624-644`）
- **概览**：左 = 文档处理状态（可用 / 处理中 / 失败 三个数字，点击直接跳到文档页并带上状态筛选）+ 最近文档；右 = 基础信息 + 标签
- **设置**：三个分区 —— 检索配置（**改为可编辑表单**，现在是只读的 `RetrievalConfigGrid`，`PUT /knowledge-bases/:id` 已支持 `retrievalConfig` 但 UI 没暴露）/ 检索测试（保留 debug 面板）/ 成员权限（保留首次进入才加载的懒加载策略）

### 3.4 `/documents` 与 `/knowledge-bases/:id/documents` —— 合并为一个组件

**两个路由，一个实现**：

```tsx
// /documents
<DocumentsPage scope={{ kind: 'global' }} />
// /knowledge-bases/:id/documents
<DocumentsPage scope={{ kind: 'knowledgeBase', id }} />
```

- 数据源统一为 `GET /documents`（支持 `q` / `knowledgeBaseId` / `status` / `fileType` / `sort` / `page` / `pageSize`），知识库作用域下把 `knowledgeBaseId` 钉死。**这顺带解决 D5**：知识库内文档页从"全量拉取 + 客户端过滤"变成服务端筛选分页，不需要新接口。
- 表格 9 列 → 6 列：文件名 / 知识库（仅 global）/ 状态+进度 / 大小 / 更新时间 / 操作。**删掉"处理提示"列**（非失败行永远是 `-`），失败原因改为显示在状态单元格下方，只有失败行才有
- 3 个状态卡 → 1 行可点击 inline 计数
- 导入 Dialog、详情 Drawer、回收站 Drawer、3 秒轮询逻辑**原样保留**（这些是对的）
- 净删除约 600 行重复代码

### 3.5 `/chat`

```text
┌───────────────┬────────────────────────────────────┬─────────┐
│ 产品文档库  ⌄ │ 关于退货政策的问答      ✎    [⋯]    │ 来源 (3)│
│               │ ────────────────────────────────── │         │
│ ＋ 新建对话    │  退货政策规定 30 天内… [1][2]      │ 1 手册  │
│               │                                    │ 2 FAQ   │
│ 今天          │  ┌──────────────────────────────┐  │         │
│ ▸ 退货政策 ●  │  │ 继续追问…                    │  │  (可折叠)│
│ ▸ 保修范围    │  │                    Enter 发送 ↵│  │         │
│ 更早          │  └──────────────────────────────┘  │         │
└───────────────┴────────────────────────────────────┴─────────┘
```

- **三页 → 两页**：`ChatLandingPage` 删除，它的"按知识库开始 + 最近会话"变成 `/chat` 无会话时主栏的空态；`/chat/new` 重定向到 `/chat`
- **左栏**：知识库选择器 + 会话列表（按时间分组：今天 / 本周 / 更早），常驻可折叠
- **引用**：默认作为每条 assistant 消息下方的内联可展开来源条；宽屏可选钉住右栏（偏好存 localStorage）。现在的 `<1440px 变模态框、必须点按钮打开` 太隐蔽
- **Composer**：自动增高，`Enter` 发送 / `Shift+Enter` 换行，明确提示
- **标题**：点击即可就地编辑（现在是常驻输入框 + "改名"按钮挂在标题栏，D15）
- **归档/删除**：收进 header 的 `⋯` 菜单
- **恢复态文案（D9）**：行为逻辑完整保留（`pendingChatRequestStore` / `pendingRegenerationStore` / `clientRequestId` 对账 —— 这套幂等设计是对的，不动），只改呈现：从占满一屏的恢复卡片改为消息下方一行紧凑状态，并**自动检查 2 次**（间隔 2s / 5s）后才升级为需要用户显式确认。用户在 90% 的情况下不再看到"确认重新发送"这种选择。

### 3.6 `/search`

- 保留为命令面板的"查看全部"落地页
- 结果按类型分组显示；关键词高亮（客户端子串匹配，后端不返回 offset —— 记为接口缺口 G9）
- 现有的 URL 状态同步 + AbortSignal 逻辑正确，保留

### 3.7 `/tags`

- 结构基本正确，主要做视觉统一
- 新增「被 N 个知识库使用」列 —— **依赖接口缺口 G4**；接口补齐前该列显示 `—`，删除仍靠 `TAG_NOT_EMPTY` 兜底

---

## 4. 视觉语言重建

### 4.1 新的 CSS 结构

删除：`src/styles.css`(3726) · `styles/base.css` · `styles/components.css` · `styles/layouts.css` · `styles/macos.css` · `styles/premium.css`

新建：

```text
src/styles/
  tokens.css        设计令牌（含 dark mode），无 legacy 别名
  reset.css
  primitives.css    button / input / select / dialog / drawer / toast /
                    skeleton / table / pill / menu / tabs
  app-shell.css
  pages/
    home.css  library.css  documents.css  chat.css  search.css  tags.css  auth.css
```

规则：`pages/*.css` 之间不得互相引用选择器；所有跨页复用必须提升到 `primitives.css`。

### 4.2 视觉方向

| 维度 | 现在 | 新 |
|------|------|-----|
| 层级 | 毛玻璃 + `0 24px 64px` 大投影（macos.css）与扁平 1px 边框（premium.css）并存 | 统一：1px 边框建立层级，投影只用于浮层（dialog/drawer/menu/popover） |
| 密度 | 松散卡片堆叠，`--space-6: 32px` 到处用 | 紧凑企业工具密度；表格行高 44px，卡片内边距 16px |
| 强调色 | 蓝 `#087cf0`（macos）与绿 `#1f6b57`（premium）打架 | 单一强调色（保留绿 `#1f6b57` 作为品牌色），状态色只表达状态不做装饰 |
| 统计卡 | 带彩色图标块（`.stat-icon.blue/.green/.violet/.orange`） | 去掉装饰色块，数字本身是主体 |
| 字号 | 散落定义 | 6 级 type scale：11 / 12 / 13 / 15 / 20 / 28 |
| 深色模式 | 无 | tokens 层支持 `prefers-color-scheme` + 用户菜单手动切换 |

### 4.3 组件补全

现有 `components/ui/`：`Button` `IconButton` `Dialog` `OverflowMenu`。新增：
`Input` `Select` `Textarea` `Checkbox` `Tabs` `Pagination` `Badge` `Table` `Popover` `Drawer` `InlineEdit` `SegmentedControl`

（现在这些都是裸 `<input>` / `<select>` / `<table>` 加全局选择器样式，这正是 CSS 三层打架的根源。）

---

## 5. 状态管理重构

### 5.1 干掉全局互斥锁（D2）

新增 `hooks/useEntityMutation.ts`：

```ts
// 按实体 id 跟踪进行中的操作，而不是一把全局锁
const mutation = useEntityMutation();
mutation.isPending(item.id)    // 只有这一行禁用
mutation.run(item.id, () => favoriteKnowledgeBase(item.id))
```

规则：
- **筛选、排序、视图切换、分页、导航永远不禁用**
- 行操作只禁用该行
- 批量操作只禁用选中项 + 批量工具条
- 表单提交只禁用该表单

### 5.2 偏好本地化（D3）

| 偏好 | 现在 | 新 |
|------|------|-----|
| `viewMode` | `PUT /workspace-preference`（阻塞） | localStorage，立即生效 |
| `expandedCategoryIds` | 同上 | localStorage |
| `scope` / `sort` / `visibility` | 同上 | **URL query 参数**（可分享、前进后退可用） |

`PUT /workspace-preference` 仍在后台 fire-and-forget 调用以跨设备同步，但**永不阻塞 UI、永不把错误升级为页面级 alert**。

### 5.3 拆分巨型组件（D13）

```text
pages/KnowledgeBase/
  KnowledgeBaseListPage.tsx      ~180 行，只做布局与组合
  useKnowledgeBaseList.ts        数据 + 筛选 + 分页
  useCategoryTree.ts             分类 CRUD + 排序
  KnowledgeBaseTable.tsx
  KnowledgeBaseCards.tsx
  KnowledgeBaseToolbar.tsx
  categoryTreeUtils.ts           已有的纯函数（flatten/descendant/reorder，约 150 行）
```

### 5.4 消灭重复工具函数（D18）

新增 `utils/format.ts`：`formatDateTime` / `formatRelativeTime` / `formatBytes` / `formatNumber` / `formatScore`。
删除 6 处 `formatDateTime` 副本和 `KnowledgeBaseDetailPage.tsx:1184` 的 `documentStatusLabel` 副本（`documentDisplay.ts` 已有）。

---

## 6. 文件级改动清单

**删除**
- `src/styles.css`、`styles/{base,components,layouts,macos,premium}.css`
- `pages/Chat/ChatLandingPage.tsx`（+ `.test.tsx`）
- `pages/Documents/DocumentsLandingPage.tsx`（+ `.test.tsx`）
- `pages/KnowledgeBase/KnowledgeBaseSectionNav.tsx` 的 `qa` 项

**重写**
- `layouts/AppShell.tsx`、`components/navigation/PrimaryNav.tsx`、`components/WorkspaceShell.tsx`
- `router/index.tsx`（新路由 + 兼容重定向）
- `pages/Home/HomePage.tsx`
- `pages/KnowledgeBase/KnowledgeBaseListPage.tsx`（1971 → 拆分为 7 个文件）
- `pages/KnowledgeBase/KnowledgeBaseDetailPage.tsx`（1243 → 拆为 Overview / Settings 两个子页）
- `pages/Documents/DocumentsPage.tsx`（合并两页，接受 `scope` prop）
- `pages/Chat/ChatPage.tsx`（1399 → 拆为 ChatPage / ChatSessionRail / ChatThread / ChatComposer / ChatCitations）

**新增**
- `components/CommandPalette.tsx`
- `components/ui/{Input,Select,Textarea,Checkbox,Tabs,Pagination,Badge,Table,Popover,Drawer,InlineEdit,SegmentedControl}.tsx`
- `hooks/useEntityMutation.ts`、`hooks/useLocalPreference.ts`、`hooks/useUrlState.ts`
- `utils/format.ts`
- `styles/{tokens,reset,primitives,app-shell}.css` + `styles/pages/*.css`

**保留不动**（这些实现是对的）
- `api/client.ts`、`api/resources.ts`（仅按需增补）
- `store/tokenStore.ts`、`store/currentUserStore.ts`
- `pages/Chat/pendingChatRequestStore.ts`、`pendingRegenerationStore.ts`
- `pages/Documents/DocumentImportDialog.tsx`、`DocumentDetailDrawer.tsx`、`DocumentRecycleBinDrawer.tsx`、`DocumentProgress.tsx`、`documentDisplay.ts`
- `pages/KnowledgeBase/knowledgeBaseReadiness.ts`、`statsFormatting.ts`
- `components/feedback/*`
- `router/ProtectedRoute.tsx`

**必须同步修改（否则 `npm run build` 直接失败）**
- `scripts/verify-route-chunks.mjs:4-15` 硬编码了页面清单，删掉 `ChatLandingPage`、`DocumentsLandingPage` 后必须更新
- `tsconfig.app.json:21` `include: ["src"]` 会把 `*.test.tsx` 纳入 `tsc -b`

---

## 7. 测试与文档

你选择了"同步更新 spec 文档 + 新建缺失接口清单"，**没有**选择同步更新测试。这带来一个必须处理的后果：

`npm run build` = `tsc -b && vite build && verify:route-chunks`，而 `tsconfig.app.json` 把 `src/**/*.test.tsx` 纳入类型检查。删除组件会让构建直接失败。

处理方式：
1. `tsconfig.app.json` 增加 `"exclude": ["src/**/*.test.ts", "src/**/*.test.tsx"]`，让生产构建不再依赖测试文件的类型正确性（测试仍由 vitest 自己的 tsconfig 走）
2. **删除**已删除模块的测试文件（测试一个不存在的文件是死代码，不算"改测试"）
3. 其余测试保持原样，会因选择器/文案变化而失败。我会在完成后给出一份**失败测试清单**，说明每个需要怎么改，由你决定何时处理

如果你希望构建和测试都保持全绿，需要把"同步更新测试"加回范围 —— 大约会增加 40% 工作量。

**文档**
- 重写 `docs/10-frontend-spec.md`：新路由表、兼容重定向、新的页面行为约定
- 新建 `docs/14-frontend-api-gaps.md`：见下节
- `AGENTS.md` 的外部引用表增加 `docs/14`

---

## 8. 缺失接口清单（将写入 `docs/14-frontend-api-gaps.md`）

### P0 — 阻塞本次重设计

| ID | 缺口 | 阻塞什么 | 建议 |
|----|------|---------|------|
| G1 | `GET /chat/sessions` 无任何参数，不支持 `knowledgeBaseId` / `archived` / `q` / 分页；不返回 `knowledgeBaseName`、`messageCount`、`lastMessagePreview` | 聊天左栏必须全量拉取所有会话再在客户端分组过滤（`ChatPage.tsx:319-324`）；会话列表无法显示预览 | 增加 query 参数 + 响应字段 |
| G2 | 聊天无流式输出，`POST /chat/sessions/:id/messages` 阻塞返回完整答案 | 生成期间只能转圈，长回答体验差 | `Accept: text/event-stream` 或新增 `/messages/stream`（SSE） |
| G3 | 无 `POST /chat/sessions/:id/unarchive` | 归档是单向操作，用户归档后无法恢复 | 新增取消归档接口 |
| G4 | `GET /knowledge-base-tags` 不返回 `knowledgeBaseCount` | 标签页无法显示使用量；删除只能靠撞 `TAG_NOT_EMPTY` 试错 | 列表响应增加计数字段 |
| G5 | `GET /knowledge-base-categories` 不返回每个分类的 `knowledgeBaseCount` | 分类树无法显示计数，用户不知道点进去有没有内容 | 同上 |

### P1 — 明显影响体验

| ID | 缺口 | 阻塞什么 | 建议 |
|----|------|---------|------|
| G6 | 无系统能力接口 | 前端不知道 `RERANK_ENABLED` 状态、支持的文件类型、单文件大小上限（50 MiB 目前是前端硬编码） | `GET /system/capabilities` |
| G7 | 无 `PUT /documents/:id` | 无法重命名文档或在知识库间移动 | 新增 |
| G8 | 无法取消处理中的文档任务 | 误传大文件后只能等它跑完 | `POST /documents/:id/cancel` |
| G9 | `GET /search` 的 `snippet` 无高亮位置 | 前端只能做子串匹配高亮，对分词和大小写不准 | 返回 `highlights: [{start,end}]` |
| G10 | 无搜索建议接口 | ⌘K 命令面板只能直接打全量搜索，无法做轻量补全 | `GET /search/suggest?q=&limit=` |
| G11 | 无 `PUT /auth/me`、无改密码接口 | 用户菜单里没有"账户设置"可放 | 新增 |
| G12 | 无 `POST /knowledge-bases/batch-tag` | 批量操作支持收藏/移动/删除/恢复，唯独缺打标签 | 新增 |
| G13 | 无 `GET /knowledge-bases/:id/stats` | 知识库详情无法展示该库自身的浏览/问答趋势，只有全局统计 | 新增 |
| G14 | 上传无进度 | `POST /documents` 用 fetch 无法读上传进度；大文件上传期间用户不知道进展 | 前端改用 XHR 可解；若要断点续传则需分片接口 |

### P2 — 后续

| ID | 缺口 | 建议 |
|----|------|------|
| G15 | 会话 `DELETE` 是硬删除，无回收站 | 对齐知识库/文档的软删除模型 |
| G16 | 无消息反馈（👍/👎） | `POST /chat/messages/:id/feedback` |
| G17 | 首页要发 4 个请求并靠 `pageSize` 猜测 | `GET /home/summary` 聚合接口 |
| G18 | 无活动流 | `GET /activities` |
| G19 | 无导出（会话 / 搜索结果） | 新增 |
| G20 | `GET /knowledge-bases/:id/documents` 与 `GET /documents` 能力不对等（前者无任何 query 参数） | 重设计后前端统一走 `/documents`，此接口前端不再使用。建议补齐参数或明确标记为兼容接口 |

---

## 9. 实施顺序

1. **设计系统层**：tokens / reset / primitives + `components/ui/*` 补全（此时旧页面仍能跑，样式逐步接管）
2. **应用外壳**：AppShell / PrimaryNav / CommandPalette / 路由表 + 兼容重定向
3. **知识库列表**：拆分 + 去锁 + 偏好本地化（最大收益点）
4. **文档页合并**：两页并一页，改走 `GET /documents`
5. **知识库详情**：三 tab + 检索配置可编辑
6. **聊天**：两页 + 内联引用 + composer + 恢复态收敛
7. **首页 / 搜索 / 标签**
8. **清理**：删除旧 CSS、旧页面、更新 `verify-route-chunks.mjs`、`tsconfig.app.json`
9. **文档**：重写 `docs/10-frontend-spec.md`，新建 `docs/14-frontend-api-gaps.md`
10. **交付失败测试清单**

---

## 10. 验收

- [ ] `npm run build` 通过（含 `tsc -b`、`vite build`、`verify:route-chunks`）
- [ ] 6 个区域全部有一级导航入口，`active` 无伪装映射
- [ ] 收藏/删除单个知识库时，筛选、排序、视图切换、分页、导航均保持可用
- [ ] 切换卡片/列表视图、展开分类节点不产生阻塞式网络请求
- [ ] `/documents` 与 `/knowledge-bases/:id/documents` 由同一组件渲染，两者均走服务端筛选分页
- [ ] 旧深链接全部可用：`/chat/new?knowledgeBaseId=`、`?tab=overview|qa|settings`、`?intent=upload`、`?documentId=`、`?chunkId=`
- [ ] `⌘K` 在任意页面唤起命令面板并能导航到搜索结果
- [ ] 聊天 `Enter` 发送、`Shift+Enter` 换行，引用可在消息内联展开
- [ ] 无横向滚动：1440 / 1280 / 981 / 680 / 375 五个断点
- [ ] 键盘可完成：登录 → 新建知识库 → 导入文档 → 提问 → 查看引用
- [ ] `prefers-reduced-motion` 生效；深色模式可用
- [ ] `docs/10-frontend-spec.md` 与实现一致；`docs/14-frontend-api-gaps.md` 已建立
