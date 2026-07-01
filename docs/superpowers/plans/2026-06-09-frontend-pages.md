# Frontend Pages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the approved soft-contrast enterprise frontend for login, knowledge bases, documents, and chat citations using the existing React/Vite app.

**Architecture:** Keep the existing routes and API client. Add focused API wrappers, shared layout/components, and page-specific implementations that call real backend endpoints. Use CSS tokens in `frontend/src/styles.css` for the gray-blue visual system.

**Tech Stack:** React 19, React Router 7, TypeScript, Vite, CSS, existing Fetch API client.

---

## Files

- Modify: `frontend/src/styles.css` for design tokens, shell, tables, forms, chat, responsive rules.
- Modify: `frontend/src/types/api.ts` for backend response types.
- Create: `frontend/src/api/resources.ts` for typed API functions.
- Create: `frontend/src/components/AppLayout.tsx` for protected page shell.
- Create: `frontend/src/components/ConfirmDialog.tsx` for destructive confirmations.
- Modify: `frontend/src/App.tsx` to keep route outlet only.
- Modify: `frontend/src/router/index.tsx` to wrap protected pages in app shell.
- Modify: `frontend/src/pages/Login/LoginPage.tsx` for approved login UI.
- Modify: `frontend/src/pages/KnowledgeBase/KnowledgeBaseListPage.tsx` for real list/create/edit/delete UI.
- Modify: `frontend/src/pages/KnowledgeBase/KnowledgeBaseDetailPage.tsx` for detail, config, document/chat entry.
- Modify: `frontend/src/pages/Documents/DocumentsPage.tsx` for upload/list/poll/reprocess/delete UI.
- Modify: `frontend/src/pages/Chat/ChatPage.tsx` for sessions/messages/input/citations panel.

## Tasks

### Task 1: Shared Types And API Wrappers

- [ ] Add API response types for users, knowledge bases, documents, chat sessions, messages, and citations.
- [ ] Add functions for login-adjacent data, knowledge base CRUD, document upload/list/reprocess/delete, chat session list/create, message list/send.
- [ ] Keep multipart upload compatible with existing `apiRequest` FormData handling.

### Task 2: Visual System And App Shell

- [ ] Replace the current minimal CSS with soft gray-blue tokens, reusable buttons, form fields, tables, status pills, cards, and responsive rules.
- [ ] Add `AppLayout` with muted left navigation, active route state, account area, and logout action.
- [ ] Wrap protected routes with `AppLayout` while leaving `/login` outside the shell.

### Task 3: Login Page

- [ ] Preserve current login behavior: submit to `/auth/login`, save token, navigate to `/knowledge-bases`, show backend errors.
- [ ] Apply approved soft enterprise login layout.
- [ ] Include username/password labels, loading state, and concrete product context copy.

### Task 4: Knowledge Base Pages

- [ ] Implement list loading, summary cards, create/edit form, delete confirmation, and backend error display.
- [ ] Implement detail loading with retrieval config cards.
- [ ] Add document management and chat entry actions.

### Task 5: Documents Page

- [ ] Load documents for the current knowledge base.
- [ ] Upload `txt`, `md`, and `pdf` via FormData.
- [ ] Show status, file type, size, error message, reprocess, and delete.
- [ ] Poll every 3 seconds while any document is not `completed` or `failed`.

### Task 6: Chat Page

- [ ] Load sessions and current session messages.
- [ ] Allow creating a new session when entering from a knowledge base detail page.
- [ ] Send user questions and append assistant answer with citations.
- [ ] Show a right citations panel with filename, page number, content, vector score, and rerank score.
- [ ] Show the required no-citations text when citations are empty.

### Task 7: Verification

- [ ] Run `cd frontend; npm run build`.
- [ ] Start frontend dev server on `127.0.0.1:5173`.
- [ ] Inspect desktop and mobile screenshots for login, knowledge base list/detail, documents, and chat.
- [ ] Fix TypeScript, layout overlap, hidden citations, or too-high contrast issues found during verification.
