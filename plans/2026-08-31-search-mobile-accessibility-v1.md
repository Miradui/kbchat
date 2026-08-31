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

3. [x] **结果定位**：chunk 深链打开抽屉后滚动到命中片段并把焦点放在它上面。
   `prefers-reduced-motion` 时不做平滑滚动。
   *Affected*：`frontend/src/pages/Documents/DocumentDetailDrawer.tsx`。

4. [x] **触摸目标**：移动端断点下把可点击控件抬到 `--touch`（44px），覆盖按钮、图标按钮、
   分段控件、复选框、分页、菜单项。桌面端保持 34px 不变——指针精度不同，一律 44px 会让
   桌面界面变松散。
   *Affected*：新增 `frontend/src/styles/touch.css`（最后导入）、`styles/touch.test.ts`、
   `styles/index.css`、`styles/pages/library.css`。没有改 `primitives.css`：把移动端专属
   规则单独放一个文件，桌面基线就仍是一处可读的定义；`tokens.css:101` 已有 `--touch: 44px`，
   不需要新变量。
   顺带修掉一个断点漏洞：分类树行内操作按钮 24px 且靠 hover 才显形，library.css 只在自己的
   680px 断点下还原，于是 681–980px 的触屏上又小又看不见——这几条规则一并搬到 `touch.css`。
   表格复选框只抬到 22px：原生复选框的对勾会填满给定尺寸，`accent-color` 也没法让对勾在大
   方框里保持小巧，要做到真正 44px 得给 input 套一层带尺寸的 label，那是四张表格的结构改动，
   不在这一轮范围内。
   `touch.css` 不自带任何新 class，所以拼错的选择器就是一条静默失效的规则（初稿写了根本不
   存在的 `.ui-field--inline`）。`touch.test.ts` 守住这点：每个 class 必须在别处有定义或被
   组件用到、任何声明都不许逃出媒体查询、导入必须留在最后。
   未验证：真机与真实触摸输入——尺寸靠样式表审查断言，没有在硬件上量过。

5. [x] **移动端输入**：搜索框加 `enterKeyHint="search"`、`autoComplete="off"`、
   `autoCapitalize="off"`、`autoCorrect="off"`；聊天输入框 `enterKeyHint="send"`。
   复核软键盘弹出时输入框不被遮挡。
   *Affected*：`frontend/src/components/ui/Field.tsx`、`components/ui/Field.test.tsx`、
   `components/CommandPalette.tsx`(+test)、`pages/Chat/ChatComposer.tsx`(+test)、
   `pages/Search/SearchCombobox.tsx`、`styles/app-shell.css`、`styles/viewport-units.test.ts`。
   四个提示放在共享的 `SearchInput` 上，不逐个调用点重复——全项目七处搜索框都是它。属性写在
   展开运算符之前，调用点仍可覆盖。搜索 combobox 里第 1 项留下的重复副本删掉了，它原有的测试
   照样通过，这才说明默认值真的生效了。命令面板保留自己的裸 `<input>`（要带面板自己的布局和
   combobox 接线），所以自己设这四个属性，并补了测试锁住这处分叉。
   软键盘遮挡：布局本来就是 `dvh`，键盘弹出会跟着收缩，只有命令面板搜索框上方的 padding 用了
   `vh`——下方面板从底部被压缩，顶部却仍死撑最多 140px 空白。改成 `dvh`，并加
   `viewport-units.test.ts` 守住这个约定（`vw` 故意不管：横向不受键盘和地址栏影响，侧栏宽度
   用 `vw` 是对的）。
   顺带补了 ChatComposer 的单测：Enter 发送、Shift+Enter 不发送、IME 组词中的 Enter 不发送
   （中文选词不能顺手把消息发出去）。这些逻辑早就有，但只能透过整个 ChatPage 触发，回归时会
   表现成一个看起来无关的页面失败。
   未验证：真机——软键盘实际画出哪个按键、以及键盘是否真的没挡住输入框，都得上硬件看。

6. [x] **长引用布局**：文件名单行截断加 `title`，页码不被挤掉，移动端引用卡片改为纵向排列。
   *Affected*：`frontend/src/styles/pages/chat.css`、`pages/Chat/ChatMessage.tsx`、
   新增 `pages/Chat/CitationCard.test.tsx`。
   截断本来就有（`.ui-truncate`），缺的是 `title`：指针用户看不到被省略号吃掉的部分。读屏本来
   就没问题——卡片自己的 `aria-label` 和链接的 `aria-label` 都带完整文件名，所以这个缺口一直
   看不出来。两个分支都补了 `title`，包括没有链接的那个分支（那里连链接的 `aria-label` 也没
   有，`title` 是唯一还带着完整名字的东西）。
   移动端：表头原本把序号+文件名+页码挤在一行，手机上文件名只剩几十像素就开始截断。现在整行
   `flex-wrap`，页码换到自己一行、文件名拿满宽度，并缩进对齐到文件名而不是与它无关的序号下面。
   用 `flex-wrap` 而不是纵向排列，是为了让序号留在文件名旁边——编号引用要能扫读。序号宽度抽成
   `--source-index-size`，因为移动端缩进必须和它完全一致，两处写死的字面量早晚会各自漂走。
   页码本来就是 `flex: 0 0 auto`，从没被挤掉过；现在由测试钉住，不再只是个巧合。
   未验证：换行后的实际排版要真机看——jsdom 不做布局也不解析媒体查询，这里是从 CSS 推的。

7. [x] **流式播报**：一个常驻 live region，只播报阶段变化（正在检索 → 正在生成 → 完成 /
   已停止 / 失败），不播报 token。错误用 `role="alert"`，进度用 `role="status"`。
   *Affected*：新增 `frontend/src/pages/Chat/useStreamAnnouncement.ts`(+test)、
   `pages/Chat/ChatPage.tsx`、新增 `pages/Chat/ChatPage.announce.test.tsx`。
   原来读屏只听得到第一个阶段：进度文案确实带了 `role="status"`，但它待在「回答一到就被替换掉」
   的那个分支里，第一个 token 落地就卸载了——听不到「正在生成」，也听不到「完成」。停止提示是
   第二个 polite region，所以一次停止可能播两遍，也可能两个抢在一起谁都没播。
   现在页面顶部一个常驻 polite region，由 `useStreamAnnouncement` 推导阶段
   （retrieving / generating / stopped / failed）并只播报阶段之间的跳转。三点理由：常驻是因为
   「带着文案一起出现」的 live region 播报不可靠，必须是内容变而区域不变；播阶段不播内容是因为
   挂在回答上会逐 token 播报，而那些文字本来就在文档里读得到；「完成」是从活动阶段跳回 idle
   而不是独立阶段，因为线程状态里没有「刚结束」这个信号——`sending` 只是变成 false。顺带也让
   「关掉失败提示」回到 idle 时保持安静，而不是对一个失败的回答宣布「回答完成」。
   失败在这个区域里不出声：失败提示本身是 `role="alert"`（assertive，会自己播），再播一遍就是
   说两次。原来那两处 role 都摘了，可见文案一字未动。
   挂载守卫不是 dep 数组的冗余：effect 在挂载时也会跑，此时 phase 与 ref 相等，没有守卫的话
   「挂载进一个正在进行的流」会在出现的瞬间就播报——重挂载或 strict-mode 双渲染都会踩到。这是
   变异测试查出来的，原来的测试只覆盖了以 idle 挂载，而那种情况下两者等价。
   另外停止测试的 mock 现在会在 abort 信号触发时 reject（真实请求就是这样）。忽略信号的 mock
   会让页面永远停在「正在生成」，因为只有请求真正落定才会记下 stoppedStream。
   未验证：NVDA / VoiceOver——真实读屏到底念出什么、节奏是否舒服，都得上硬件。

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
