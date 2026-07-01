# Frontend Pages Design

## Objective

Implement the MVP frontend as a soft-contrast enterprise admin console for the existing RAG backend. The design covers login, knowledge base management, document management, and chat with citations.

## Approved Direction

Use the "A+C" direction approved in the visual companion:

- Base layout: enterprise admin workspace with a persistent navigation shell.
- Chat enhancement: a dedicated citations panel inspired by a research workbench.
- Visual tone: soft gray-blue surfaces, readable but not harsh contrast, light borders, restrained shadows, and 8px-or-smaller radius.
- Product stance: operational tool, not marketing page. No decorative hero, large promotional sections, or ornamental gradients.

## Design System

### Color

- Page background: soft gray-blue, approximately `#f4f6f8`.
- Primary surface: white or near-white, approximately `#ffffff` and `#fbfcfe`.
- Primary text: muted slate, approximately `#334155`.
- Heading text: softened navy slate, approximately `#2f3f55`.
- Secondary text: approximately `#64748b`.
- Primary action: muted blue, approximately `#4f7fd8`.
- Active navigation: medium blue, approximately `#3d5f9b`.
- Success status: soft green background with readable green text.
- Processing status: soft blue background with readable blue text.
- Failed status: soft red background with readable red text.

Contrast should remain accessible for text, but the interface must avoid stark pure black and bright white pairings over large areas.

### Typography

- Use the existing system font stack.
- Body text starts at 14-16px depending on density.
- Page titles use 23-26px, not hero-scale typography.
- Table headers use 12px semibold labels.
- Letter spacing remains `0`.

### Layout

- Desktop uses a persistent admin shell:
  - Left navigation column.
  - Top page context area inside the main content region.
  - Main workspace with cards, tables, or chat panes.
- Mobile and narrow tablet:
  - Navigation collapses into a compact top or stacked navigation.
  - Tables can become stacked record cards if needed.
  - Chat citations move below the relevant assistant answer or below the message list so citations are never hidden.

### Interaction

- Buttons and links have visible hover, active, focus, disabled, and loading states.
- Destructive actions require confirmation.
- Backend error `message` values are shown near the relevant action.
- Empty states include a clear next action.
- Loading states use inline text or skeleton-like surfaces rather than full-screen blocking spinners.

## Pages

### Login

Route: `/login`

The login page must use the same soft gray-blue enterprise style as the application shell, without a marketing hero. It should present:

- Product identity: "RAG Console" or "企业知识库问答".
- Username field with visible label and `autocomplete="username"`.
- Password field with visible label and `autocomplete="current-password"`.
- Submit button with a disabled loading state.
- Backend error message displayed near the form.
- A calm right-side or top-side product context panel on desktop, using concrete copy such as "连接知识库、文档处理与引用可追踪问答".

On successful login, save token and route to `/knowledge-bases`. On failed login, show backend message. On mobile, keep the form first and avoid split layouts that squeeze inputs.

### Knowledge Base List

Route: `/knowledge-bases`

The page should show:

- Breadcrumb/context: "首页 / 知识库".
- Title: "知识库".
- Supporting text: "管理当前账号拥有的知识库，上传资料后即可进入问答。"
- Primary action: "新建知识库".
- Summary cards for knowledge base count, completed document count, and default retrieval strategy.
- A table with columns:
  - 名称
  - 描述
  - 文档
  - 创建时间
  - 操作

Actions include detail, edit, and delete. Delete requires confirmation. Empty state should invite creating a knowledge base.

### Knowledge Base Detail

Route: `/knowledge-bases/:id`

The page should show:

- Knowledge base name and description.
- Retrieval configuration summary:
  - `vectorTopN`
  - `rerankTopK`
  - `scoreThreshold`
  - `enableRerank`
- Primary actions:
  - "文档管理"
  - "开始问答"
- Secondary action to return to list.

This page acts as the bridge between management and chat.

### Documents

Route: `/knowledge-bases/:id/documents`

The page should show:

- Breadcrumb/context: "知识库 / <name> / 文档管理".
- Title: "文档管理".
- Supporting text explaining `txt`, `md`, and `pdf` support.
- Upload area with a clear "选择文件" action.
- Document table with columns:
  - 文件名
  - 类型
  - 大小
  - 状态
  - 错误信息
  - 操作

Statuses:

- `uploaded`
- `parsing`
- `chunking`
- `embedding`
- `completed`
- `failed`

When any document is not `completed` or `failed`, poll every 3 seconds. Stop polling when all documents are terminal. Failed rows show `errorMessage`. Reprocess and delete actions are visible when valid.

### Chat

Route: `/chat/:sessionId`

The chat page uses a three-pane desktop layout:

- Left: session list for the current user.
- Center: message stream and input composer.
- Right: citations panel.

The center pane should show:

- Session title.
- Current knowledge base context.
- User and assistant messages.
- For assistant messages, a compact citation summary such as "引用 3 条 · 最高 rerankScore 0.93".
- Question input and send button with loading state.

The citations panel should show only citations returned by the backend. Each citation card must include:

- `filename`
- `pageNumber`
- `content`
- `vectorScore`
- `rerankScore`

If there are no citations, show: "当前知识库中未找到足够依据。" The UI must not hide citations or invent scores.

## API And Data Rules

- Keep API fields camelCase.
- Use the existing API base `/api/v1` and the existing token injection behavior.
- On 401, clear token and route to `/login`.
- Do not use fake data as a backend substitute in functional flows.
- If temporary visual placeholders are needed while wiring UI, they must be removed before claiming end-to-end completion.
- Public API, schema, default retrieval, and RAG behavior changes require doc updates; this design does not require backend schema changes.

## Accessibility And Responsiveness

- All form fields have visible labels.
- Buttons have at least 38px height on desktop and should remain touch-friendly on mobile.
- Focus states must be visible.
- Color is not the only status indicator; status text is always present.
- Mobile layout must avoid horizontal scrolling.
- Text should wrap within cards, buttons, and table/card rows.

## Implementation Scope

This design can be implemented in the existing React/Vite frontend. It may add frontend components, API helpers, and CSS, but it should not change backend behavior. It should preserve the existing route list:

- `/login`
- `/knowledge-bases`
- `/knowledge-bases/:id`
- `/knowledge-bases/:id/documents`
- `/chat/:sessionId`

## Verification

- `cd frontend; npm run build`
- Manual browser check of:
  - Login page
  - Knowledge base list
  - Knowledge base detail
  - Documents page
  - Chat page with citations panel
- Verify layout at desktop width and mobile width.
