# P2 搜索、移动端与无障碍

路线图交付（`docs/15-product-improvement-roadmap.md`）：

1. 完善搜索建议、结果定位和无结果建议。
2. 验证触摸目标、移动端输入法、软键盘和长引用布局。
3. 流式回答、进度和错误状态使用克制的 live region 播报。
4. 键盘操作后恢复合理焦点，弹窗和抽屉关闭时返回触发元素。

## 现状（开工前的实地核对）

已经具备，本轮不重做：

- 搜索页有 300ms 防抖、服务端返回的高亮区间（不在客户端重新匹配）、按类型分组、
  `role="status"` 的状态播报、URL 归一化与深链。
- `GET /search/suggest` 已存在，`components/CommandPalette.tsx` 在用。
- 聊天输入框已处理 IME：`event.nativeEvent.isComposing` 时不发送。
- `useModalFocus.ts` 已实现模态栈、背景 inert、焦点陷阱与关闭后回到触发元素。
- `Popover` 与 `OverflowMenu` 的 Escape 和选中路径都回焦到触发按钮。
- 表格在 760px 以下改为卡片布局，引用卡片正文有 `word-break: break-word`。

确认缺口，本轮要补：

- **搜索页没有建议。** `searchSuggest` 只有命令面板在用，搜索页要手动敲完再回车。
- **无结果只有一句通用文案**（「尝试更短的关键词，或切换结果类型」），不看实际查询。
- **chunk 深链只标记不定位。** `DocumentDetailDrawer` 给命中的 chunk 加 `is-source`
  类和「引用来源」徽标，但不滚动到它，长文档里用户得自己找。
- **`--touch: 44px` 几乎没用上。** 只有 `rail__item` / `rail__cta` / `rail__user` /
  `cat-tree__toggle` / `cat-tree__name` 五处；`--control-h` 是 34px，移动端按钮和图标
  按钮都低于 44px。
- **流式播报会在第一个 token 落地时消失。** `role="status"` 挂在占位文案上，一旦
  `streamingAnswer` 有值整个分支被替换，live region 从 DOM 移除后不再播报——检索、生成、
  完成三个阶段只有第一个能被听到。
- **移动端输入属性缺失。** 除登录和账号弹窗外没有 `autoComplete`、`enterKeyHint`、
  `inputMode`；搜索框在移动端软键盘上的确认键是换行而不是搜索。
- **长文件名可能溢出。** `.chat-source__link` 有 `min-width: 0` 但没有 `overflow`
  与 `text-overflow`。

## 任务

1. [x] **搜索页建议**：输入时调 `searchSuggest`，作为 combobox 下拉呈现，键盘上下选择、
   Enter 直达结果、Escape 收起。请求用 `AbortController` 取消，避免慢响应覆盖新输入。
   *Affected*：`frontend/src/pages/Search/SearchPage.tsx`、`styles/pages/search.css`。

2. [x] **无结果建议按查询给**：区分「查询过长」「有引号或符号」「切到某类型后为空但全部
   类型有结果」三种情况，给出对应的下一步；只在能确定时给，拿不准就沿用通用文案。
   *Affected*：`frontend/src/pages/Search/SearchPage.tsx`、新增 `searchGuidance.ts` 与测试。

3. [ ] **结果定位**：chunk 深链打开抽屉后滚动到命中片段并把焦点放在它上面。
   `prefers-reduced-motion` 时不做平滑滚动。
   *Affected*：`frontend/src/pages/Documents/DocumentDetailDrawer.tsx`。

4. [ ] **触摸目标**：移动端断点下把可点击控件抬到 `--touch`（44px），覆盖按钮、图标按钮、
   分段控件、复选框、分页、菜单项。桌面端保持 34px 不变——指针精度不同，一律 44px 会让
   桌面界面变松散。
   *Affected*：`frontend/src/styles/primitives.css`、`styles/tokens.css`（如需新增断点变量）。

5. [ ] **移动端输入**：搜索框加 `enterKeyHint="search"`、`autoComplete="off"`、
   `autoCapitalize="off"`、`autoCorrect="off"`；聊天输入框 `enterKeyHint="send"`。
   复核软键盘弹出时输入框不被遮挡。
   *Affected*：`frontend/src/components/ui/Field.tsx`、`pages/Chat/ChatComposer.tsx`、
   `pages/Search/SearchPage.tsx`、`components/CommandPalette.tsx`。

6. [ ] **长引用布局**：文件名单行截断加 `title`，页码不被挤掉，移动端引用卡片改为纵向排列。
   *Affected*：`frontend/src/styles/pages/chat.css`、`pages/Chat/ChatMessage.tsx`。

7. [ ] **流式播报**：一个常驻 live region，只播报阶段变化（正在检索 → 正在生成 → 完成 /
   已停止 / 失败），不播报 token。错误用 `role="alert"`，进度用 `role="status"`。
   *Affected*：`frontend/src/pages/Chat/ChatPage.tsx`，可能抽出 `useStreamAnnouncement.ts`。

8. [ ] **焦点复核与补齐**：逐个走查 Dialog、Drawer、Popover、OverflowMenu、InlineEdit
   的关闭路径；已经正确的写测试锁住，缺的补上。列表行删除后焦点落到相邻行而不是 body。
   *Affected*：`frontend/src/components/ui/`、相关页面。

9. [ ] **文档**：`10-frontend-spec.md` 记录搜索建议契约、触摸目标口径、live region 约束、
   焦点归还规则；路线图收尾；handoff 记录刻意偏离与未验证项。
   *Affected*：`docs/10-frontend-spec.md`、`docs/15-product-improvement-roadmap.md`、
   `docs/12-handoff.md`。

## 边界

- 不引入无障碍测试库以外的新依赖；断言用现有的 vitest + testing-library。
- 不改后端：`/search/suggest` 已满足需要。
- 真机与读屏软件（NVDA / VoiceOver）无法在本环境验证，只能保证语义正确，实测记为未验证项。
