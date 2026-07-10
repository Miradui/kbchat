# Frontend Foundation and Core Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish the tested frontend design system, responsive application shell, lazy routing, and optimized login, home, search, and tag-management pages without breaking current routes or API contracts.

**Architecture:** Keep the existing React/React Router stack and introduce a thin reusable UI layer instead of a component framework. Load the legacy stylesheet first, then add tokenized layer files as deterministic overrides; later phase plans will migrate knowledge-base, document, and chat styles out of the legacy file. Preserve `WorkspaceShell` as a compatibility adapter while moving global navigation into `AppShell`, so current uncommitted page work remains usable throughout the phase.

**Tech Stack:** React 19, TypeScript 5.9, React Router 7, Vite 7, lucide-react, Vitest, React Testing Library, user-event, jsdom, CSS custom properties.

---

## Scope boundary

This is the first independently shippable phase of the approved design in `docs/superpowers/specs/2026-07-10-frontend-comprehensive-optimization-design.md`. It completes the test foundation, semantic visual tokens, Button/IconButton, feedback, Toast, Dialog, the responsive six-item application shell, lazy routing, and the login, home, global-search, and tag-management slices.

Knowledge-base workspace/detail internals, global and knowledge-base document management, and chat/citations/Rerank-fallback behavior remain functional through `WorkspaceShell` but are not redesigned here. They require separate follow-on plans for: (1) knowledge-base workspace/detail, (2) document management, (3) chat/citations/Rerank fallback, and (4) confirmed lightweight backend-contract changes plus final cross-page QA. `Input`, `Select`, `Textarea`, `Badge`, `StatusBadge`, `PageHeader`, `Panel`, `Pagination`, and other primitives are intentionally deferred until one of those real page slices needs them; this keeps the first phase incremental rather than building unused abstractions.

## File responsibility map

**Create**

- `docs/superpowers/handoffs/2026-07-10-frontend-foundation-core-workspace.md` — isolated phase handoff that does not mix with the already-dirty root handoff.
- `frontend/src/test/setup.ts` — global test cleanup and jest-dom matchers.
- `frontend/src/test/render.tsx` — shared router- and toast-aware render helper.
- `frontend/src/store/tokenStore.test.ts` — test-harness smoke coverage.
- `frontend/src/utils/classNames.ts` and `frontend/src/utils/classNames.test.ts` — deterministic class-name composition and tests.
- `frontend/src/utils/errors.ts` and `frontend/src/utils/errors.test.ts` — backend-aware error text and tests.
- `frontend/src/components/ui/Button.tsx` and `frontend/src/components/ui/Button.test.tsx` — button variants/loading state and tests.
- `frontend/src/components/ui/IconButton.tsx` and `frontend/src/components/ui/IconButton.test.tsx` — accessible icon-only controls and tests.
- `frontend/src/components/ui/Dialog.tsx` and `frontend/src/components/ui/Dialog.test.tsx` — modal focus, keyboard, and restoration behavior.
- `frontend/src/components/feedback/EmptyState.tsx` — actionable empty state.
- `frontend/src/components/feedback/ErrorState.tsx` — retryable region error.
- `frontend/src/components/feedback/FeedbackStates.test.tsx` — empty/error state behavior.
- `frontend/src/components/feedback/ToastProvider.tsx` and `frontend/src/components/feedback/ToastProvider.test.tsx` — live-region notifications and timeout coverage.
- `frontend/src/components/navigation/PrimaryNav.tsx` and `frontend/src/components/navigation/PrimaryNav.test.tsx` — six-item active navigation and tests.
- `frontend/src/layouts/AppShell.tsx` and `frontend/src/layouts/AppShell.test.tsx` — global sidebar, mobile drawer, top bar, and shell tests.
- `frontend/src/router/index.test.tsx` — anonymous-route regression coverage.
- `frontend/src/pages/Login/LoginPage.test.tsx` — login behavior coverage.
- `frontend/src/pages/Home/homeData.ts` and `frontend/src/pages/Home/homeData.test.ts` — independently failing dashboard loads and tests.
- `frontend/src/pages/Home/HomePage.test.tsx` — partial-failure dashboard rendering coverage.
- `frontend/src/pages/Search/SearchPage.test.tsx` — URL-state and stale-request coverage.
- `frontend/src/pages/Tags/TagDialog.tsx` and `frontend/src/pages/Tags/TagDialog.test.tsx` — create/edit tag dialog and input-preservation coverage.
- `frontend/src/pages/Tags/TagsPage.test.tsx` — create/delete page integration coverage.
- `frontend/src/styles/index.css` — ordered stylesheet entrypoint.
- `frontend/src/styles/tokens.css` — semantic colors, spacing, radii, motion, scrim, and elevation.
- `frontend/src/styles/base.css` — typography, focus, and reduced-motion baseline.
- `frontend/src/styles/components.css` — primitives, feedback, dialog, and toast styles.
- `frontend/src/styles/layouts.css` — responsive application shell.
- `frontend/src/styles/pages/auth.css` — login overrides.
- `frontend/src/styles/pages/home.css` — dashboard overrides.
- `frontend/src/styles/pages/search.css` — search overrides.
- `frontend/src/styles/pages/tags.css` — tag-management overrides.

**Modify**

- `docs/10-frontend-spec.md` — document the public routes, shell, feedback, login, home, search, and tag behavior delivered by this phase.
- `frontend/package.json` and `frontend/package-lock.json` — approved dependencies and test scripts.
- `frontend/vite.config.ts` and `frontend/tsconfig.app.json` — Vitest/jsdom configuration.
- `frontend/src/main.tsx` — providers and layered stylesheet entrypoint.
- `frontend/src/App.tsx` — remove the obsolete nested main landmark.
- `frontend/src/router/index.tsx` — lazy pages and protected-route fallback.
- `frontend/src/api/resources.ts` — abortable global search.
- `frontend/src/components/ConfirmDialog.tsx` — compatibility wrapper over `Dialog`.
- `frontend/src/components/LoadingSkeleton.tsx` — accessible loading semantics.
- `frontend/src/components/WorkspaceShell.tsx` — compatibility adapter over `AppShell`.
- `frontend/src/pages/Login/LoginPage.tsx` — accessible login states.
- `frontend/src/pages/Home/HomePage.tsx` — resilient dashboard regions.
- `frontend/src/pages/Search/SearchPage.tsx` — URL filters and stale-request protection.
- `frontend/src/pages/Tags/TagsPage.tsx` — modal editing and localized mutation errors.
- `frontend/src/styles/index.css` and `frontend/src/styles/components.css` — incremental imports and shared component rules.

**Read but do not modify in this phase**

- `frontend/src/styles.css` remains the first, legacy stylesheet import; later page plans remove only rules proven migrated by passing tests.
- `frontend/src/pages/KnowledgeBase/KnowledgeBaseDetailPage.tsx`, `frontend/src/pages/Chat/ChatPage.tsx`, and `frontend/src/types/api.ts` contain pre-existing user work and must not be overwritten or staged by this plan.
- `docs/12-handoff.md` already contains unrelated unstaged backend work, so this phase records its handoff in the dedicated file listed above rather than editing or staging it.

### Task 1: Install and prove the frontend test harness

**Files:**
- Modify: `frontend/package.json`
- Modify: `frontend/package-lock.json`
- Modify: `frontend/vite.config.ts`
- Modify: `frontend/tsconfig.app.json`
- Create: `frontend/src/test/setup.ts`
- Create: `frontend/src/store/tokenStore.test.ts`

- [ ] **Step 1: Install the approved minimal dependencies**

Run from `frontend`:

~~~powershell
npm install lucide-react
npm install --save-dev vitest jsdom @testing-library/react @testing-library/jest-dom @testing-library/user-event
~~~

Expected: exit code 0; package lock changes; no large UI framework is added.

- [ ] **Step 2: Add test scripts**

Set the `scripts` object in `package.json` to:

~~~json
{
  "dev": "vite",
  "build": "tsc -b && vite build",
  "test": "vitest run",
  "test:watch": "vitest",
  "preview": "vite preview"
}
~~~

- [ ] **Step 3: Configure Vitest and jsdom**

Replace `frontend/vite.config.ts` with:

~~~ts
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    css: true,
    clearMocks: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
    },
  },
});
~~~

Add the following property inside `compilerOptions` in `frontend/tsconfig.app.json`:

~~~json
"types": ["vitest/globals", "@testing-library/jest-dom"]
~~~

- [ ] **Step 4: Add deterministic test cleanup**

Create `frontend/src/test/setup.ts`:

~~~ts
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});
~~~

- [ ] **Step 5: Add a harness smoke test**

Create `frontend/src/store/tokenStore.test.ts`:

~~~ts
import { describe, expect, it } from 'vitest';

import { tokenStore } from './tokenStore';

describe('tokenStore', () => {
  it('stores and clears the authentication token', () => {
    tokenStore.setToken('token-value');
    expect(tokenStore.getToken()).toBe('token-value');

    tokenStore.clearToken();
    expect(tokenStore.getToken()).toBeNull();
  });
});
~~~

- [ ] **Step 6: Run tests and build**

Run:

~~~powershell
npm test
npm run build
~~~

Expected: one test passes; TypeScript and Vite build pass.

- [ ] **Step 7: Commit the harness**

~~~powershell
git add frontend/package.json frontend/package-lock.json frontend/vite.config.ts frontend/tsconfig.app.json frontend/src/test/setup.ts frontend/src/store/tokenStore.test.ts
git commit -m "test(frontend): add component test harness"
~~~

### Task 2: Add shared class and error utilities with TDD

**Files:**
- Create: `frontend/src/utils/classNames.test.ts`
- Create: `frontend/src/utils/classNames.ts`
- Create: `frontend/src/utils/errors.test.ts`
- Create: `frontend/src/utils/errors.ts`

- [ ] **Step 1: Write failing utility tests**

Create `frontend/src/utils/classNames.test.ts`:

~~~ts
import { describe, expect, it } from 'vitest';

import { classNames } from './classNames';

describe('classNames', () => {
  it('joins truthy class names without leaking false values', () => {
    expect(classNames('button', false, undefined, 'primary', null)).toBe('button primary');
  });
});
~~~

Create `frontend/src/utils/errors.test.ts`:

~~~ts
import { describe, expect, it } from 'vitest';

import { ApiError } from '../api/client';
import { getErrorMessage } from './errors';

describe('getErrorMessage', () => {
  it('uses the backend message for ApiError', () => {
    const error = new ApiError(400, { code: 'INVALID_INPUT', message: '名称不能为空' });
    expect(getErrorMessage(error, '保存失败')).toBe('名称不能为空');
  });

  it('uses the supplied fallback for unknown errors', () => {
    expect(getErrorMessage(new Error('internal detail'), '保存失败')).toBe('保存失败');
  });
});
~~~

- [ ] **Step 2: Verify RED**

Run:

~~~powershell
npm test -- src/utils/classNames.test.ts src/utils/errors.test.ts
~~~

Expected: FAIL because `classNames.ts` and `errors.ts` do not exist.

- [ ] **Step 3: Implement the utilities**

Create `frontend/src/utils/classNames.ts`:

~~~ts
export function classNames(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ');
}
~~~

Create `frontend/src/utils/errors.ts`:

~~~ts
import { ApiError } from '../api/client';

export function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}
~~~

- [ ] **Step 4: Verify GREEN**

Run:

~~~powershell
npm test -- src/utils/classNames.test.ts src/utils/errors.test.ts
~~~

Expected: three tests pass (one class-name test and two error-message tests).

- [ ] **Step 5: Commit**

~~~powershell
git add frontend/src/utils
git commit -m "refactor(frontend): centralize UI utilities"
~~~

### Task 3: Build Button and IconButton primitives test-first

**Files:**
- Create: `frontend/src/components/ui/Button.test.tsx`
- Create: `frontend/src/components/ui/Button.tsx`
- Create: `frontend/src/components/ui/IconButton.test.tsx`
- Create: `frontend/src/components/ui/IconButton.tsx`
- Create: `frontend/src/styles/index.css`
- Create: `frontend/src/styles/tokens.css`
- Create: `frontend/src/styles/base.css`
- Create: `frontend/src/styles/components.css`
- Modify: `frontend/src/main.tsx`

- [ ] **Step 1: Write failing Button tests**

Create `frontend/src/components/ui/Button.test.tsx`:

~~~tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Button } from './Button';

describe('Button', () => {
  it('applies its semantic variant and handles clicks', async () => {
    const onClick = vi.fn();
    render(<Button variant="secondary" onClick={onClick}>保存</Button>);

    const button = screen.getByRole('button', { name: '保存' });
    expect(button).toHaveClass('ui-button--secondary');
    await userEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('announces loading and prevents repeated clicks', async () => {
    const onClick = vi.fn();
    render(<Button loading loadingLabel="保存中" onClick={onClick}>保存</Button>);

    const button = screen.getByRole('button', { name: '保存中' });
    expect(button).toBeDisabled();
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });
});
~~~

Create `frontend/src/components/ui/IconButton.test.tsx`:

~~~tsx
import { render, screen } from '@testing-library/react';
import { Search } from 'lucide-react';
import { describe, expect, it } from 'vitest';

import { IconButton } from './IconButton';

describe('IconButton', () => {
  it('uses one accessible label for name and tooltip', () => {
    render(<IconButton label="搜索"><Search aria-hidden="true" /></IconButton>);
    const button = screen.getByRole('button', { name: '搜索' });
    expect(button).toHaveAttribute('title', '搜索');
  });
});
~~~

- [ ] **Step 2: Verify RED**

Run:

~~~powershell
npm test -- src/components/ui/Button.test.tsx src/components/ui/IconButton.test.tsx
~~~

Expected: FAIL because both component modules are missing.

- [ ] **Step 3: Implement Button**

Create `frontend/src/components/ui/Button.tsx`:

~~~tsx
import { LoaderCircle } from 'lucide-react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

import { classNames } from '../../utils/classNames';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'link';

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  loading?: boolean;
  loadingLabel?: string;
  leadingIcon?: ReactNode;
};

export function Button({
  variant = 'primary',
  loading = false,
  loadingLabel = '处理中',
  leadingIcon,
  className,
  children,
  disabled,
  type = 'button',
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      className={classNames('ui-button', 'ui-button--' + variant, className)}
      disabled={disabled || loading}
      type={type}
    >
      {loading ? <LoaderCircle className="ui-button__spinner" aria-hidden="true" /> : leadingIcon}
      <span>{loading ? loadingLabel : children}</span>
    </button>
  );
}
~~~

- [ ] **Step 4: Implement IconButton**

Create `frontend/src/components/ui/IconButton.tsx`:

~~~tsx
import type { ButtonHTMLAttributes, ReactNode } from 'react';

import { classNames } from '../../utils/classNames';

type IconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label' | 'title'> & {
  label: string;
  children: ReactNode;
  tone?: 'default' | 'danger';
};

export function IconButton({
  label,
  children,
  tone = 'default',
  className,
  type = 'button',
  ...props
}: IconButtonProps) {
  return (
    <button
      {...props}
      aria-label={label}
      className={classNames('ui-icon-button', tone === 'danger' && 'ui-icon-button--danger', className)}
      title={label}
      type={type}
    >
      {children}
    </button>
  );
}
~~~

- [ ] **Step 5: Add the layered stylesheet entrypoint**

Create `frontend/src/styles/index.css`:

~~~css
@import '../styles.css';
@import './tokens.css';
@import './base.css';
@import './components.css';
~~~

Create `frontend/src/styles/tokens.css`:

~~~css
:root {
  --color-canvas: #f6f8fb;
  --color-surface: #ffffff;
  --color-surface-subtle: #f8fafc;
  --color-surface-hover: #f1f5f9;
  --color-border: #e2e8f0;
  --color-border-strong: #cbd5e1;
  --color-text: #0f172a;
  --color-text-secondary: #475569;
  --color-text-muted: #64748b;
  --color-text-inverse: #ffffff;
  --color-primary: #2563eb;
  --color-primary-hover: #1d4ed8;
  --color-primary-active: #1e40af;
  --color-primary-soft: #eff6ff;
  --color-success: #047857;
  --color-success-soft: #ecfdf5;
  --color-warning: #b45309;
  --color-warning-soft: #fffbeb;
  --color-danger: #b91c1c;
  --color-danger-hover: #991b1b;
  --color-danger-active: #7f1d1d;
  --color-danger-soft: #fef2f2;
  --color-scrim: rgb(15 23 42 / 48%);
  --focus-ring: 0 0 0 3px rgb(37 99 235 / 24%);
  --shadow-raised: 0 8px 24px rgb(15 23 42 / 9%);
  --shadow-overlay: 0 24px 64px rgb(15 23 42 / 18%);
  --radius-sm: 8px;
  --radius-md: 12px;
  --radius-pill: 999px;
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 24px;
  --space-6: 32px;
  --motion-fast: 160ms;
  --motion-normal: 220ms;
  --motion-ease: cubic-bezier(0.2, 0, 0, 1);
}
~~~

Create `frontend/src/styles/base.css`:

~~~css
html { color-scheme: light; }
body {
  color: var(--color-text);
  background: var(--color-canvas);
  font-family: Inter, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
  line-height: 1.5;
}
:where(button, a, input, textarea, select):focus-visible {
  outline: 0;
  box-shadow: var(--focus-ring);
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    scroll-behavior: auto !important;
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
~~~

Create `frontend/src/styles/components.css` with the primitive rules:

~~~css
.ui-button, .ui-icon-button {
  align-items: center;
  border: 1px solid transparent;
  display: inline-flex;
  justify-content: center;
  transition: background var(--motion-fast), border-color var(--motion-fast), color var(--motion-fast);
}
.ui-button {
  border-radius: var(--radius-sm);
  font-weight: 650;
  gap: var(--space-2);
  min-height: 40px;
  padding: 0 var(--space-4);
}
.ui-button--primary { background: var(--color-primary); color: var(--color-text-inverse); }
.ui-button--primary:hover { background: var(--color-primary-hover); }
.ui-button--primary:active { background: var(--color-primary-active); }
.ui-button--secondary { background: var(--color-surface); border-color: var(--color-border); color: var(--color-text-secondary); }
.ui-button--secondary:hover { background: var(--color-surface-hover); border-color: var(--color-border-strong); color: var(--color-text); }
.ui-button--ghost, .ui-button--link { background: transparent; color: var(--color-primary); }
.ui-button--ghost:hover, .ui-button--link:hover { background: var(--color-primary-soft); }
.ui-button--danger { background: var(--color-danger); color: var(--color-text-inverse); }
.ui-button--danger:hover { background: var(--color-danger-hover); }
.ui-button--danger:active { background: var(--color-danger-active); }
.ui-button:disabled, .ui-icon-button:disabled { cursor: not-allowed; opacity: .56; }
.ui-button__spinner { animation: ui-spin .8s linear infinite; height: 16px; width: 16px; }
.ui-icon-button {
  background: transparent;
  border-radius: var(--radius-sm);
  color: var(--color-text-secondary);
  min-height: 40px;
  min-width: 40px;
  padding: 8px;
}
.ui-icon-button:hover { background: var(--color-surface-hover); color: var(--color-text); }
.ui-icon-button--danger { color: var(--color-danger); }
.ui-icon-button--danger:hover { background: var(--color-danger-soft); color: var(--color-danger-hover); }
@keyframes ui-spin { to { transform: rotate(360deg); } }
@media (max-width: 680px) {
  .ui-button, .ui-icon-button { min-height: 44px; }
  .ui-icon-button { min-width: 44px; }
}
~~~

In `frontend/src/main.tsx`, replace the legacy stylesheet import with the layered entrypoint:

~~~tsx
import './styles/index.css';
~~~

Do not import `layouts.css` or page styles yet: Vite treats a missing CSS import as a build failure, so each later task appends its import only after creating that file.

- [ ] **Step 6: Verify GREEN and build**

Run:

~~~powershell
npm test -- src/components/ui/Button.test.tsx src/components/ui/IconButton.test.tsx
npm run build
~~~

Expected: all tests pass and the build succeeds.

- [ ] **Step 7: Commit**

~~~powershell
git add frontend/src/main.tsx frontend/src/components/ui frontend/src/styles frontend/src/utils/classNames.ts
git commit -m "feat(frontend): add design tokens and button primitives"
~~~

### Task 4: Add reusable feedback states and toast notifications

**Files:**
- Create: `frontend/src/components/feedback/FeedbackStates.test.tsx`
- Create: `frontend/src/components/feedback/EmptyState.tsx`
- Create: `frontend/src/components/feedback/ErrorState.tsx`
- Create: `frontend/src/components/feedback/ToastProvider.test.tsx`
- Create: `frontend/src/components/feedback/ToastProvider.tsx`
- Modify: `frontend/src/components/LoadingSkeleton.tsx`
- Modify: `frontend/src/styles/components.css`
- Modify: `frontend/src/main.tsx`

- [ ] **Step 1: Write failing feedback tests**

Create `frontend/src/components/feedback/FeedbackStates.test.tsx`:

~~~tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { EmptyState } from './EmptyState';
import { ErrorState } from './ErrorState';

describe('feedback states', () => {
  it('renders an actionable empty state', () => {
    render(<EmptyState title="暂无知识库" description="创建后即可上传文档" action={<button>新建知识库</button>} />);
    expect(screen.getByRole('heading', { name: '暂无知识库' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '新建知识库' })).toBeInTheDocument();
  });

  it('lets the user retry a failed region', async () => {
    const onRetry = vi.fn();
    render(<ErrorState title="加载失败" description="无法读取数据" onRetry={onRetry} />);
    await userEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
~~~

Create `frontend/src/components/feedback/ToastProvider.test.tsx`:

~~~tsx
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ToastProvider, useToast } from './ToastProvider';

function Probe() {
  const toast = useToast();
  return <button onClick={() => toast.success('保存成功')}>触发</button>;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('ToastProvider', () => {
  it('announces success feedback in a live region', async () => {
    render(<ToastProvider><Probe /></ToastProvider>);
    await userEvent.click(screen.getByRole('button', { name: '触发' }));
    expect(screen.getByRole('status')).toHaveTextContent('保存成功');
  });

  it('removes feedback after the visible interval', async () => {
    vi.useFakeTimers();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<ToastProvider><Probe /></ToastProvider>);

    await user.click(screen.getByRole('button', { name: '触发' }));
    act(() => vi.advanceTimersByTime(3500));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
~~~

- [ ] **Step 2: Verify RED**

Run:

~~~powershell
npm test -- src/components/feedback
~~~

Expected: FAIL because the feedback modules do not exist.

- [ ] **Step 3: Implement EmptyState and ErrorState**

Create `frontend/src/components/feedback/EmptyState.tsx`:

~~~tsx
import { Inbox } from 'lucide-react';
import type { ReactNode } from 'react';

export function EmptyState({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <section className="ui-empty-state">
      <Inbox aria-hidden="true" />
      <h2>{title}</h2>
      {description && <p>{description}</p>}
      {action}
    </section>
  );
}
~~~

Create `frontend/src/components/feedback/ErrorState.tsx`:

~~~tsx
import { CircleAlert } from 'lucide-react';

import { Button } from '../ui/Button';

export function ErrorState({ title, description, onRetry }: { title: string; description: string; onRetry?: () => void }) {
  return (
    <section className="ui-error-state" role="alert">
      <CircleAlert aria-hidden="true" />
      <h2>{title}</h2>
      <p>{description}</p>
      {onRetry && <Button variant="secondary" onClick={onRetry}>重试</Button>}
    </section>
  );
}
~~~

- [ ] **Step 4: Implement ToastProvider**

Create `frontend/src/components/feedback/ToastProvider.tsx`:

~~~tsx
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

type ToastTone = 'success' | 'error';
type ToastItem = { id: number; message: string; tone: ToastTone };
type ToastApi = { success: (message: string) => void; error: (message: string) => void };

const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const nextId = useRef(0);
  const timers = useRef(new Map<number, number>());
  const [items, setItems] = useState<ToastItem[]>([]);

  useEffect(() => () => {
    timers.current.forEach((timerId) => window.clearTimeout(timerId));
    timers.current.clear();
  }, []);

  const push = useCallback((message: string, tone: ToastTone) => {
    const id = ++nextId.current;
    setItems((current) => [...current, { id, message, tone }]);
    const timerId = window.setTimeout(() => {
      timers.current.delete(id);
      setItems((current) => current.filter((item) => item.id !== id));
    }, 3500);
    timers.current.set(id, timerId);
  }, []);

  const value = useMemo<ToastApi>(() => ({
    success: (message) => push(message, 'success'),
    error: (message) => push(message, 'error'),
  }), [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="ui-toast-region" aria-live="polite" aria-atomic="true">
        {items.map((item) => (
          <div className={'ui-toast ui-toast--' + item.tone} role="status" key={item.id}>
            {item.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const value = useContext(ToastContext);
  if (!value) throw new Error('useToast must be used inside ToastProvider');
  return value;
}
~~~

- [ ] **Step 5: Improve LoadingSkeleton semantics**

Replace `frontend/src/components/LoadingSkeleton.tsx` with:

~~~tsx
type LoadingSkeletonProps = {
  rows?: number;
  columns?: number;
  compact?: boolean;
};

export function LoadingSkeleton({ rows = 3, columns = 3, compact = false }: LoadingSkeletonProps) {
  return (
    <div
      aria-label="正在加载"
      aria-live="polite"
      className={compact ? 'skeleton-stack compact' : 'skeleton-stack'}
      role="status"
    >
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <div
          className="skeleton-row"
          key={rowIndex}
          style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
        >
          {Array.from({ length: columns }).map((__, columnIndex) => (
            <span className="skeleton-line" key={columnIndex} />
          ))}
        </div>
      ))}
    </div>
  );
}
~~~

- [ ] **Step 6: Mount the provider and add exact feedback CSS**

Replace `frontend/src/main.tsx` with:

~~~tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';

import { ToastProvider } from './components/feedback/ToastProvider';
import { router } from './router';
import './styles/index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
      <RouterProvider router={router} />
    </ToastProvider>
  </StrictMode>,
);
~~~

Append to `frontend/src/styles/components.css`:

~~~css
.ui-empty-state,
.ui-error-state {
  align-items: center;
  background: var(--color-surface-subtle);
  border: 1px dashed var(--color-border-strong);
  border-radius: var(--radius-md);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  justify-content: center;
  min-height: 180px;
  padding: var(--space-6);
  text-align: center;
}
.ui-error-state {
  background: var(--color-danger-soft);
  border-color: rgb(185 28 28 / 24%);
}
.ui-empty-state > svg,
.ui-error-state > svg { height: 28px; width: 28px; }
.ui-empty-state h2,
.ui-error-state h2 { font-size: 16px; margin: 0; }
.ui-empty-state p,
.ui-error-state p { color: var(--color-text-muted); margin: 0; max-width: 52ch; }
.ui-toast-region {
  display: grid;
  gap: var(--space-2);
  max-width: min(380px, calc(100vw - 32px));
  pointer-events: none;
  position: fixed;
  right: var(--space-4);
  top: var(--space-4);
  z-index: 80;
}
.ui-toast {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-left: 4px solid var(--color-success);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-overlay);
  color: var(--color-text);
  padding: 12px 16px;
}
.ui-toast--error { border-left-color: var(--color-danger); }
@media (max-width: 680px) {
  .ui-toast-region { left: 16px; max-width: none; right: 16px; }
}
~~~

- [ ] **Step 7: Verify GREEN and commit**

Run:

~~~powershell
npm test -- src/components/feedback
npm run build
~~~

Expected: feedback tests and build pass.

~~~powershell
git add frontend/src/components/feedback frontend/src/components/LoadingSkeleton.tsx frontend/src/main.tsx frontend/src/styles/components.css
git commit -m "feat(frontend): unify feedback states"
~~~

### Task 5: Replace the confirmation overlay with an accessible Dialog

**Files:**
- Create: `frontend/src/components/ui/Dialog.test.tsx`
- Create: `frontend/src/components/ui/Dialog.tsx`
- Modify: `frontend/src/components/ConfirmDialog.tsx`
- Modify: `frontend/src/styles/components.css`

- [ ] **Step 1: Write failing keyboard and focus tests**

Create `frontend/src/components/ui/Dialog.test.tsx`:

~~~tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Dialog } from './Dialog';

describe('Dialog', () => {
  it('traps focus, closes on Escape, and restores the opener', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const opener = document.createElement('button');
    opener.textContent = '打开';
    document.body.append(opener);
    opener.focus();

    const { rerender } = render(
      <Dialog open title="删除知识库" onClose={onClose}>
        <button>取消</button><button>删除</button>
      </Dialog>,
    );
    const cancel = screen.getByRole('button', { name: '取消' });
    const remove = screen.getByRole('button', { name: '删除' });
    expect(cancel).toHaveFocus();

    remove.focus();
    await user.tab();
    expect(cancel).toHaveFocus();

    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();

    rerender(<Dialog open={false} title="删除知识库" onClose={onClose}><button>取消</button></Dialog>);
    expect(opener).toHaveFocus();
    opener.remove();
  });
});
~~~

- [ ] **Step 2: Verify RED**

Run `npm test -- src/components/ui/Dialog.test.tsx`.

Expected: FAIL because `Dialog.tsx` is missing.

- [ ] **Step 3: Implement Dialog**

Create `frontend/src/components/ui/Dialog.tsx`:

~~~tsx
import { useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';

type DialogProps = {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
};

function getFocusable(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
  )).filter((element) => !element.hasAttribute('disabled') && element.getAttribute('aria-hidden') !== 'true');
}

export function Dialog({ open, title, description, onClose, children }: DialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    restoreFocusRef.current = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    if (panel) getFocusable(panel)[0]?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab' || !panel) return;
      const controls = getFocusable(panel);
      if (controls.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      restoreFocusRef.current?.focus();
    };
  }, [open]);

  if (!open) return null;
  return (
    <div
      className="ui-dialog-backdrop"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onCloseRef.current(); }}
    >
      <div
        aria-describedby={description ? descriptionId : undefined}
        aria-labelledby={titleId}
        aria-modal="true"
        className="ui-dialog"
        ref={panelRef}
        role="dialog"
        tabIndex={-1}
      >
        <h2 id={titleId}>{title}</h2>
        {description && <p id={descriptionId}>{description}</p>}
        {children}
      </div>
    </div>
  );
}
~~~

- [ ] **Step 4: Rebuild ConfirmDialog as a compatibility wrapper**

Replace `frontend/src/components/ConfirmDialog.tsx` with:

~~~tsx
import { Button } from './ui/Button';
import { Dialog } from './ui/Dialog';

type ConfirmDialogProps = {
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  busy?: boolean;
  error?: string;
  onCancel: () => void;
  onConfirm: () => void;
};

export function ConfirmDialog({
  title,
  description,
  confirmLabel = '确认',
  cancelLabel = '取消',
  busy = false,
  error,
  onCancel,
  onConfirm,
}: ConfirmDialogProps) {
  return (
    <Dialog open title={title} description={description} onClose={() => { if (!busy) onCancel(); }}>
      {error && <p className="ui-dialog__error" role="alert">{error}</p>}
      <div className="ui-dialog__actions">
        <Button variant="secondary" onClick={onCancel} disabled={busy}>{cancelLabel}</Button>
        <Button variant="danger" onClick={onConfirm} loading={busy} loadingLabel="处理中">{confirmLabel}</Button>
      </div>
    </Dialog>
  );
}
~~~

- [ ] **Step 5: Add dialog styles and verify**

Append to `frontend/src/styles/components.css`:

~~~css
.ui-dialog-backdrop {
  align-items: center;
  background: var(--color-scrim);
  display: flex;
  inset: 0;
  justify-content: center;
  padding: 16px;
  position: fixed;
  z-index: 70;
}
.ui-dialog {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-overlay);
  max-height: calc(100vh - 32px);
  max-width: 480px;
  overflow: auto;
  padding: var(--space-5);
  width: 100%;
}
.ui-dialog > h2 { font-size: 20px; margin: 0; }
.ui-dialog > p { color: var(--color-text-secondary); margin: var(--space-2) 0 0; }
.ui-dialog > .ui-dialog__error {
  background: var(--color-danger-soft);
  border-radius: var(--radius-sm);
  color: var(--color-danger);
  padding: 10px 12px;
}
.ui-dialog__actions {
  display: flex;
  gap: var(--space-3);
  justify-content: flex-end;
  margin-top: var(--space-5);
}
@media (max-width: 680px) {
  .ui-dialog { max-height: calc(100dvh - 32px); padding: var(--space-4); }
  .ui-dialog__actions { flex-direction: column-reverse; }
  .ui-dialog__actions .ui-button { width: 100%; }
}
~~~

Run:

~~~powershell
npm test -- src/components/ui/Dialog.test.tsx
npm run build
~~~

Expected: the Dialog test passes, focus returns to the opener, and the build succeeds.

- [ ] **Step 6: Commit**

~~~powershell
git add frontend/src/components/ui/Dialog* frontend/src/components/ConfirmDialog.tsx frontend/src/styles/components.css
git commit -m "feat(frontend): make confirmation dialogs accessible"
~~~

### Task 6: Build the responsive application shell

**Files:**
- Create: `frontend/src/test/render.tsx`
- Create: `frontend/src/components/navigation/PrimaryNav.test.tsx`
- Create: `frontend/src/components/navigation/PrimaryNav.tsx`
- Create: `frontend/src/layouts/AppShell.test.tsx`
- Create: `frontend/src/layouts/AppShell.tsx`
- Modify: `frontend/src/components/ui/IconButton.tsx`
- Modify: `frontend/src/components/WorkspaceShell.tsx`
- Create: `frontend/src/styles/layouts.css`
- Modify: `frontend/src/styles/index.css`

- [ ] **Step 1: Add a router- and toast-aware render helper**

Create `frontend/src/test/render.tsx`:

~~~tsx
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';

import { ToastProvider } from '../components/feedback/ToastProvider';

export function renderWithRouter(ui: ReactElement, initialEntries = ['/home']) {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={initialEntries}>{ui}</MemoryRouter>
    </ToastProvider>,
  );
}
~~~

- [ ] **Step 2: Write failing navigation and shell tests**

Create `frontend/src/components/navigation/PrimaryNav.test.tsx`:

~~~tsx
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { renderWithRouter } from '../../test/render';
import { PrimaryNav } from './PrimaryNav';

describe('PrimaryNav', () => {
  it('marks exactly one current destination and omits non-MVP permissions', () => {
    renderWithRouter(<PrimaryNav active="documents" onNavigate={() => undefined} />, ['/knowledge-bases/kb1/documents']);

    expect(screen.getByRole('link', { name: '文档管理' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getAllByRole('link').filter((link) => link.hasAttribute('aria-current'))).toHaveLength(1);
    expect(screen.queryByText('权限管理')).not.toBeInTheDocument();
  });
});
~~~

Create `frontend/src/layouts/AppShell.test.tsx`:

~~~tsx
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderWithRouter } from '../test/render';
import { AppShell } from './AppShell';

vi.mock('../api/resources', () => ({
  logout: vi.fn().mockResolvedValue(undefined),
}));

function stubMobileViewport() {
  const media = {
    matches: true,
    media: '(max-width: 980px)',
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn((_event: Event) => true),
  } as unknown as MediaQueryList;
  vi.stubGlobal('matchMedia', vi.fn(() => media));
}

function LocationProbe() {
  const location = useLocation();
  return <output aria-label="当前位置">{location.pathname + location.search}</output>;
}

afterEach(() => {
  document.body.style.overflow = '';
  vi.unstubAllGlobals();
});

describe('AppShell', () => {
  it('closes the mobile drawer with Escape, locks scroll, and restores focus', async () => {
    stubMobileViewport();
    const user = userEvent.setup();
    renderWithRouter(<AppShell active="home"><p>页面内容</p></AppShell>);

    const opener = screen.getByRole('button', { name: '打开主导航' });
    await user.click(opener);

    const navigation = screen.getByRole('navigation', { name: '主导航' });
    expect(navigation.closest('aside')).toHaveClass('is-open');
    expect(screen.getByRole('button', { name: '关闭主导航' })).toHaveFocus();
    expect(document.body.style.overflow).toBe('hidden');

    await user.keyboard('{Escape}');
    expect(screen.getByRole('navigation', { name: '主导航', hidden: true }).closest('aside')).not.toHaveClass('is-open');
    expect(document.body.style.overflow).toBe('');
    expect(opener).toHaveFocus();
  });

  it('keeps global search and account actions when page context is present', async () => {
    const user = userEvent.setup();
    renderWithRouter(
      <>
        <AppShell active="knowledge-bases" topbarContent={<span>知识库上下文</span>}><p>页面内容</p></AppShell>
        <LocationProbe />
      </>,
    );

    expect(screen.getByText('知识库上下文')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '退出登录' })).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: '全局搜索' }), 'handbook{Enter}');
    expect(screen.getByLabelText('当前位置')).toHaveTextContent('/search?q=handbook');
  });
});
~~~

- [ ] **Step 3: Verify RED**

Run:

~~~powershell
npm test -- src/components/navigation src/layouts
~~~

Expected: FAIL because `PrimaryNav` and `AppShell` do not exist.

- [ ] **Step 4: Implement deterministic six-item navigation**

Create `frontend/src/components/navigation/PrimaryNav.tsx`:

~~~tsx
import { FileText, Home, Library, MessageSquareText, Search, Tags } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Link } from 'react-router-dom';

export type AppSection = 'home' | 'knowledge-bases' | 'documents' | 'chat' | 'search' | 'tags';

const items: Array<{ to: string; label: string; section: AppSection; icon: LucideIcon }> = [
  { to: '/home', label: '首页', section: 'home', icon: Home },
  { to: '/knowledge-bases', label: '知识库', section: 'knowledge-bases', icon: Library },
  { to: '/documents', label: '文档管理', section: 'documents', icon: FileText },
  { to: '/chat', label: '问答管理', section: 'chat', icon: MessageSquareText },
  { to: '/search', label: '全局搜索', section: 'search', icon: Search },
  { to: '/tags', label: '标签管理', section: 'tags', icon: Tags },
];

export function PrimaryNav({ active, onNavigate }: { active: AppSection; onNavigate: () => void }) {
  return (
    <nav className="primary-nav" aria-label="主导航">
      {items.map(({ to, label, section, icon: Icon }) => {
        const current = active === section;
        return (
          <Link
            aria-current={current ? 'page' : undefined}
            className={current ? 'primary-nav__item is-active' : 'primary-nav__item'}
            key={to}
            onClick={onNavigate}
            to={to}
          >
            <Icon aria-hidden="true" />
            <span>{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
~~~

The explicit `active` section avoids two current links on `/knowledge-bases/:id/documents`: that page belongs to document management even though its URL starts with `/knowledge-bases`.

- [ ] **Step 5: Implement AppShell with a constrained mobile drawer**

Create `frontend/src/layouts/AppShell.tsx`:

~~~tsx
import { LogOut, Menu, Search, X } from 'lucide-react';
import { FormEvent, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';

import { logout } from '../api/resources';
import { PrimaryNav } from '../components/navigation/PrimaryNav';
import type { AppSection } from '../components/navigation/PrimaryNav';
import { IconButton } from '../components/ui/IconButton';
import { tokenStore } from '../store/tokenStore';

export type { AppSection } from '../components/navigation/PrimaryNav';

export type AppShellProps = {
  active: AppSection;
  contextSidebar?: ReactNode;
  topbarContent?: ReactNode;
  children: ReactNode;
};

function mediaMatches(query: string): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
}

function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(
    'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])',
  )).filter((element) => !element.hasAttribute('disabled') && element.getAttribute('aria-hidden') !== 'true');
}

const sectionLabels: Record<AppSection, string> = {
  home: '首页',
  'knowledge-bases': '知识库',
  documents: '文档管理',
  chat: '问答管理',
  search: '全局搜索',
  tags: '标签管理',
};

export function AppShell({ active, contextSidebar, topbarContent, children }: AppShellProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(() => mediaMatches('(max-width: 980px)'));
  const [searchDraft, setSearchDraft] = useState('');
  const sidebarRef = useRef<HTMLElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const drawerWasOpen = useRef(false);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(max-width: 980px)');
    const update = () => setIsMobile(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname, location.search]);

  useEffect(() => {
    if (!isMobile) setDrawerOpen(false);
  }, [isMobile]);

  useEffect(() => {
    if (!isMobile) {
      drawerWasOpen.current = false;
      return;
    }
    if (drawerOpen) {
      drawerWasOpen.current = true;
      closeButtonRef.current?.focus();
    } else if (drawerWasOpen.current) {
      drawerWasOpen.current = false;
      menuButtonRef.current?.focus();
    }
  }, [drawerOpen, isMobile]);

  useEffect(() => {
    if (!isMobile || !drawerOpen) return;
    const sidebar = sidebarRef.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        setDrawerOpen(false);
        return;
      }
      if (event.key !== 'Tab' || !sidebar) return;
      const controls = getFocusable(sidebar);
      if (controls.length === 0) return;
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [drawerOpen, isMobile]);

  function handleSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const query = searchDraft.trim();
    navigate(query ? `/search?q=${encodeURIComponent(query)}` : '/search');
  }

  async function handleLogout() {
    try {
      await logout();
    } catch {
      // Local logout must still complete when the remote session is already unavailable.
    } finally {
      tokenStore.clearToken();
      navigate('/login', { replace: true });
    }
  }

  const drawerHidden = isMobile && !drawerOpen;

  return (
    <section className="app-layout" data-active={active}>
      <aside
        aria-hidden={drawerHidden || undefined}
        className={drawerOpen ? 'app-sidebar is-open' : 'app-sidebar'}
        inert={drawerHidden || undefined}
        ref={sidebarRef}
      >
        <div className="app-sidebar__brand-row">
          <Link className="app-brand" to="/home" onClick={() => setDrawerOpen(false)}>RAG Console</Link>
          <IconButton ref={closeButtonRef} className="app-drawer-close" label="关闭主导航" onClick={() => setDrawerOpen(false)}>
            <X aria-hidden="true" />
          </IconButton>
        </div>
        <PrimaryNav active={active} onNavigate={() => setDrawerOpen(false)} />
        {contextSidebar && <div className="app-context-sidebar">{contextSidebar}</div>}
      </aside>

      {isMobile && drawerOpen && (
        <button aria-hidden="true" className="app-drawer-backdrop" onClick={() => setDrawerOpen(false)} tabIndex={-1} type="button" />
      )}

      <div className="app-main" inert={(isMobile && drawerOpen) || undefined}>
        <header className="app-topbar">
          <IconButton ref={menuButtonRef} className="app-menu-button" label="打开主导航" onClick={() => setDrawerOpen(true)}>
            <Menu aria-hidden="true" />
          </IconButton>
          <div className="app-topbar__context">{topbarContent ?? sectionLabels[active]}</div>
          <form className="app-global-search" onSubmit={handleSearch}>
            <Search aria-hidden="true" />
            <label className="sr-only" htmlFor="app-global-search">全局搜索</label>
            <input
              id="app-global-search"
              placeholder="搜索知识库、文档和内容"
              value={searchDraft}
              onChange={(event) => setSearchDraft(event.target.value)}
            />
          </form>
          <div className="app-account-actions" aria-label="账户操作">
            <span>当前用户</span>
            <IconButton label="退出登录" onClick={() => void handleLogout()}>
              <LogOut aria-hidden="true" />
            </IconButton>
          </div>
        </header>
        <main className="app-content">{children}</main>
      </div>
    </section>
  );
}
~~~

Replace `frontend/src/components/ui/IconButton.tsx` with the ref-forwarding equivalent required for focus restoration:

~~~tsx
import { forwardRef } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

import { classNames } from '../../utils/classNames';

type IconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label' | 'title'> & {
  label: string;
  children: ReactNode;
  tone?: 'default' | 'danger';
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton({
  label,
  children,
  tone = 'default',
  className,
  type = 'button',
  ...props
}, ref) {
  return (
    <button
      {...props}
      aria-label={label}
      className={classNames('ui-icon-button', tone === 'danger' && 'ui-icon-button--danger', className)}
      ref={ref}
      title={label}
      type={type}
    >
      {children}
    </button>
  );
});
~~~

- [ ] **Step 6: Replace WorkspaceShell with the complete compatibility adapter**

Replace `frontend/src/components/WorkspaceShell.tsx` in full:

~~~tsx
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Pencil, Plus, Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';

import { AppShell } from '../layouts/AppShell';
import type { AppSection } from '../layouts/AppShell';
import type { KnowledgeBaseCategory } from '../types/api';
import { IconButton } from './ui/IconButton';

type WorkspaceShellProps = {
  active: AppSection;
  categories?: KnowledgeBaseCategory[];
  categoryFilter?: string;
  expandedIds?: string[];
  categoryWorkingId?: string | null;
  onCreateCategory?: (parentId?: string) => void;
  onDeleteCategory?: (category: KnowledgeBaseCategory) => void;
  onEditCategory?: (category: KnowledgeBaseCategory) => void;
  onMoveCategory?: (categoryId: string, direction: 'up' | 'down') => void;
  onSelectCategory?: (categoryId: string) => void;
  onToggleExpanded?: (categoryId: string) => void;
  topbar?: ReactNode;
  children: ReactNode;
};

export function WorkspaceShell({
  active,
  categories = [],
  categoryFilter = '',
  expandedIds = [],
  categoryWorkingId = null,
  onCreateCategory,
  onDeleteCategory,
  onEditCategory,
  onMoveCategory,
  onSelectCategory,
  onToggleExpanded,
  topbar: _legacyTopbar,
  children,
}: WorkspaceShellProps) {
  const hasCategoryWorkspace = active === 'knowledge-bases' && Boolean(
    onCreateCategory || onDeleteCategory || onEditCategory || onMoveCategory || onSelectCategory || onToggleExpanded,
  );

  const knowledgeBaseContext = hasCategoryWorkspace ? (
    <section className="category-context" aria-label="知识库分类">
      <div className="category-context__header">
        <strong>知识库分类</strong>
        {onCreateCategory && (
          <IconButton label="新增根分类" onClick={() => onCreateCategory()}>
            <Plus aria-hidden="true" />
          </IconButton>
        )}
      </div>
      <div className="category-tree">
        {categories.length === 0 ? (
          <p className="muted-text">暂无分类</p>
        ) : categories.map((category) => (
          <CategoryNode
            category={category}
            categoryFilter={categoryFilter}
            expandedIds={expandedIds}
            key={category.id}
            level={0}
            workingId={categoryWorkingId}
            onCreateCategory={onCreateCategory}
            onDeleteCategory={onDeleteCategory}
            onEditCategory={onEditCategory}
            onMoveCategory={onMoveCategory}
            onSelectCategory={onSelectCategory}
            onToggleExpanded={onToggleExpanded}
          />
        ))}
      </div>
    </section>
  ) : undefined;

  return (
    <AppShell active={active} contextSidebar={knowledgeBaseContext}>
      {children}
    </AppShell>
  );
}

function CategoryNode({
  category,
  categoryFilter,
  expandedIds,
  level,
  workingId,
  onCreateCategory,
  onDeleteCategory,
  onEditCategory,
  onMoveCategory,
  onSelectCategory,
  onToggleExpanded,
}: {
  category: KnowledgeBaseCategory;
  categoryFilter: string;
  expandedIds: string[];
  level: number;
  workingId: string | null;
  onCreateCategory?: (parentId?: string) => void;
  onDeleteCategory?: (category: KnowledgeBaseCategory) => void;
  onEditCategory?: (category: KnowledgeBaseCategory) => void;
  onMoveCategory?: (categoryId: string, direction: 'up' | 'down') => void;
  onSelectCategory?: (categoryId: string) => void;
  onToggleExpanded?: (categoryId: string) => void;
}) {
  const hasChildren = Boolean(category.children?.length);
  const expanded = !hasChildren || expandedIds.includes(category.id);

  return (
    <div className="category-node">
      <div
        className={categoryFilter === category.id ? 'category-row active' : 'category-row'}
        style={{ paddingLeft: 8 + level * 16 }}
      >
        {hasChildren && onToggleExpanded ? (
          <IconButton
            aria-expanded={expanded}
            className="category-tree__toggle"
            label={expanded ? `折叠 ${category.name}` : `展开 ${category.name}`}
            onClick={() => onToggleExpanded(category.id)}
          >
            {expanded ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
          </IconButton>
        ) : (
          <span className="category-tree__spacer" aria-hidden="true" />
        )}

        <button
          className="category-name"
          disabled={!onSelectCategory}
          onClick={() => onSelectCategory?.(category.id)}
          type="button"
        >
          {category.name}
        </button>

        <div className="category-actions">
          {onCreateCategory && (
            <IconButton label={`新增 ${category.name} 子分类`} onClick={() => onCreateCategory(category.id)}>
              <Plus aria-hidden="true" />
            </IconButton>
          )}
          {onEditCategory && (
            <IconButton label={`编辑 ${category.name}`} onClick={() => onEditCategory(category)}>
              <Pencil aria-hidden="true" />
            </IconButton>
          )}
          {onMoveCategory && (
            <>
              <IconButton
                disabled={workingId === category.id}
                label={`${category.name} 上移`}
                onClick={() => onMoveCategory(category.id, 'up')}
              >
                <ArrowUp aria-hidden="true" />
              </IconButton>
              <IconButton
                disabled={workingId === category.id}
                label={`${category.name} 下移`}
                onClick={() => onMoveCategory(category.id, 'down')}
              >
                <ArrowDown aria-hidden="true" />
              </IconButton>
            </>
          )}
          {onDeleteCategory && (
            <IconButton label={`删除 ${category.name}`} tone="danger" onClick={() => onDeleteCategory(category)}>
              <Trash2 aria-hidden="true" />
            </IconButton>
          )}
        </div>
      </div>

      {expanded && category.children?.map((child) => (
        <CategoryNode
          category={child}
          categoryFilter={categoryFilter}
          expandedIds={expandedIds}
          key={child.id}
          level={level + 1}
          workingId={workingId}
          onCreateCategory={onCreateCategory}
          onDeleteCategory={onDeleteCategory}
          onEditCategory={onEditCategory}
          onMoveCategory={onMoveCategory}
          onSelectCategory={onSelectCategory}
          onToggleExpanded={onToggleExpanded}
        />
      ))}
    </div>
  );
}
~~~

The `_legacyTopbar` parameter intentionally remains in the prop contract but is not rendered. Its only current caller duplicates a global search, placeholder notification/help controls, and logout; rendering it inside `AppShell` would produce two global toolbars. Future page context belongs in `AppShell.topbarContent`, while all existing page titles remain in the page content and continue to compile unchanged.

- [ ] **Step 7: Implement responsive shell CSS and import it**

Create `frontend/src/styles/layouts.css`:

~~~css
.sr-only {
  clip: rect(0 0 0 0);
  clip-path: inset(50%);
  height: 1px;
  overflow: hidden;
  position: absolute;
  white-space: nowrap;
  width: 1px;
}
.app-layout {
  background: var(--color-canvas);
  display: grid;
  grid-template-columns: 248px minmax(0, 1fr);
  min-height: 100vh;
  overflow-x: clip;
  width: 100%;
}
.app-sidebar {
  align-self: start;
  background: var(--color-surface);
  border-right: 1px solid var(--color-border);
  height: 100vh;
  min-width: 0;
  overflow-y: auto;
  padding: 16px 12px;
  position: sticky;
  top: 0;
  z-index: 50;
}
.app-sidebar__brand-row { align-items: center; display: flex; justify-content: space-between; min-height: 48px; padding: 0 8px 12px; }
.app-brand { color: var(--color-text); font-size: 17px; font-weight: 750; text-decoration: none; }
.primary-nav { display: grid; gap: 4px; }
.primary-nav__item {
  align-items: center;
  border-radius: var(--radius-sm);
  color: var(--color-text-secondary);
  display: flex;
  gap: 12px;
  min-height: 44px;
  padding: 0 12px;
  text-decoration: none;
}
.primary-nav__item > svg { height: 18px; width: 18px; }
.primary-nav__item:hover { background: var(--color-surface-hover); color: var(--color-text); }
.primary-nav__item.is-active { background: var(--color-primary-soft); color: var(--color-primary); font-weight: 650; }
.app-context-sidebar { border-top: 1px solid var(--color-border); margin-top: 16px; padding-top: 16px; }
.app-main { min-width: 0; }
.app-topbar {
  align-items: center;
  background: rgb(255 255 255 / 94%);
  border-bottom: 1px solid var(--color-border);
  display: flex;
  gap: 16px;
  height: 64px;
  justify-content: space-between;
  padding: 0 24px;
  position: sticky;
  top: 0;
  z-index: 30;
}
.app-topbar__context { color: var(--color-text-secondary); flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.app-global-search { align-items: center; display: flex; flex: 1 1 360px; max-width: 620px; min-width: 160px; position: relative; }
.app-global-search > svg { color: var(--color-text-muted); height: 18px; left: 12px; position: absolute; width: 18px; }
.app-global-search input { min-height: 40px; min-width: 0; padding-left: 40px; width: 100%; }
.app-account-actions { align-items: center; color: var(--color-text-secondary); display: flex; flex: 0 0 auto; gap: 8px; }
.app-content { min-width: 0; padding: 24px clamp(24px, 3vw, 32px) 40px; }
.app-menu-button,
.app-drawer-close { display: none; }
.app-drawer-backdrop { display: none; }
.category-context__header { align-items: center; display: flex; justify-content: space-between; padding: 0 4px 8px; }
.category-tree { display: grid; gap: 2px; }
.category-tree__spacer,
.category-tree__toggle { height: 32px; min-height: 32px; min-width: 32px; width: 32px; }
.category-actions .ui-icon-button { height: 28px; min-height: 28px; min-width: 28px; padding: 5px; width: 28px; }
.category-actions .ui-icon-button > svg,
.category-tree__toggle > svg { height: 16px; width: 16px; }
@media (max-width: 1279px) and (min-width: 981px) {
  .app-layout { grid-template-columns: 224px minmax(0, 1fr); }
  .app-account-actions > span { display: none; }
}
@media (max-width: 980px) {
  .app-layout { display: block; }
  .app-sidebar {
    bottom: 0;
    box-shadow: var(--shadow-overlay);
    height: auto;
    left: 0;
    overflow-y: auto;
    position: fixed;
    top: 0;
    transform: translateX(-105%);
    transition: transform var(--motion-normal) var(--motion-ease);
    width: min(320px, calc(100vw - 48px));
  }
  .app-sidebar.is-open { transform: translateX(0); }
  .app-menu-button,
  .app-drawer-close { display: inline-flex; flex: 0 0 auto; }
  .app-drawer-backdrop {
    background: var(--color-scrim);
    border: 0;
    display: block;
    inset: 0;
    padding: 0;
    position: fixed;
    z-index: 40;
  }
  .app-topbar__context,
  .app-account-actions > span { display: none; }
  .app-content { padding-left: 24px; padding-right: 24px; }
}
@media (max-width: 680px) {
  .app-topbar { gap: 8px; padding: 0 16px; }
  .app-content { padding: 16px 16px 32px; }
  .app-global-search { min-width: 0; }
}
~~~

Append this import to `frontend/src/styles/index.css` after `components.css`:

~~~css
@import './layouts.css';
~~~

- [ ] **Step 8: Verify GREEN and the compatibility build**

Run:

~~~powershell
npm test -- src/components/navigation src/layouts
npm run build
~~~

Expected: the navigation and shell tests pass; every existing page compiles through the complete compatibility adapter; Escape restores drawer focus; the closed mobile sidebar is absent from the accessibility tree; and the production build succeeds.

- [ ] **Step 9: Commit**

~~~powershell
git add frontend/src/test/render.tsx frontend/src/components/navigation frontend/src/layouts frontend/src/components/WorkspaceShell.tsx frontend/src/components/ui/IconButton.tsx frontend/src/styles/layouts.css frontend/src/styles/index.css
git commit -m "feat(frontend): add responsive application shell"
~~~

### Task 7: Lazy-load route pages and test authentication routing

**Files:**
- Create: `frontend/src/router/index.test.tsx`
- Modify: `frontend/src/router/index.tsx`
- Modify: `frontend/src/App.tsx`

- [ ] **Step 1: Write a failing ProtectedRoute test**

Create `frontend/src/router/index.test.tsx`:

~~~tsx
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { tokenStore } from '../store/tokenStore';
import { ProtectedRoute } from './index';

describe('ProtectedRoute', () => {
  it('redirects anonymous users to login', () => {
    tokenStore.clearToken();
    render(
      <MemoryRouter initialEntries={['/home']}>
        <Routes>
          <Route path="/login" element={<h1>登录</h1>} />
          <Route element={<ProtectedRoute />}>
            <Route path="/home" element={<h1>首页</h1>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { name: '登录' })).toBeInTheDocument();
  });
});
~~~

- [ ] **Step 2: Verify RED**

Run `npm test -- src/router/index.test.tsx`.

Expected: FAIL because `ProtectedRoute` is not exported.

- [ ] **Step 3: Remove the obsolete nested main landmark**

Replace `frontend/src/App.tsx` with:

~~~tsx
import { Outlet } from 'react-router-dom';

export function App() {
  return <Outlet />;
}
~~~

The page-level `AppShell` now owns the sole `<main>` landmark for authenticated pages.

- [ ] **Step 4: Export ProtectedRoute and lazy-load every route page**

Replace `frontend/src/router/index.tsx` with:

~~~tsx
import { lazy, Suspense } from 'react';
import type { ReactNode } from 'react';
import { createBrowserRouter, Navigate, Outlet } from 'react-router-dom';

import { App } from '../App';
import { LoadingSkeleton } from '../components/LoadingSkeleton';
import { tokenStore } from '../store/tokenStore';

const LoginPage = lazy(() => import('../pages/Login/LoginPage').then((module) => ({ default: module.LoginPage })));
const HomePage = lazy(() => import('../pages/Home/HomePage').then((module) => ({ default: module.HomePage })));
const KnowledgeBaseListPage = lazy(() => import('../pages/KnowledgeBase/KnowledgeBaseListPage').then((module) => ({ default: module.KnowledgeBaseListPage })));
const KnowledgeBaseDetailPage = lazy(() => import('../pages/KnowledgeBase/KnowledgeBaseDetailPage').then((module) => ({ default: module.KnowledgeBaseDetailPage })));
const DocumentsLandingPage = lazy(() => import('../pages/Documents/DocumentsLandingPage').then((module) => ({ default: module.DocumentsLandingPage })));
const DocumentsPage = lazy(() => import('../pages/Documents/DocumentsPage').then((module) => ({ default: module.DocumentsPage })));
const ChatLandingPage = lazy(() => import('../pages/Chat/ChatLandingPage').then((module) => ({ default: module.ChatLandingPage })));
const ChatPage = lazy(() => import('../pages/Chat/ChatPage').then((module) => ({ default: module.ChatPage })));
const SearchPage = lazy(() => import('../pages/Search/SearchPage').then((module) => ({ default: module.SearchPage })));
const TagsPage = lazy(() => import('../pages/Tags/TagsPage').then((module) => ({ default: module.TagsPage })));

function RoutePage({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={<div className="route-loading"><LoadingSkeleton rows={5} columns={3} /></div>}>
      {children}
    </Suspense>
  );
}

export function ProtectedRoute() {
  if (!tokenStore.getToken()) {
    return <Navigate to="/login" replace />;
  }
  return <Outlet />;
}

export const router = createBrowserRouter([
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <Navigate to="/home" replace /> },
      { path: 'login', element: <RoutePage><LoginPage /></RoutePage> },
      {
        element: <ProtectedRoute />,
        children: [
          { path: 'home', element: <RoutePage><HomePage /></RoutePage> },
          { path: 'knowledge-bases', element: <RoutePage><KnowledgeBaseListPage /></RoutePage> },
          { path: 'knowledge-bases/:id', element: <RoutePage><KnowledgeBaseDetailPage /></RoutePage> },
          { path: 'knowledge-bases/:id/documents', element: <RoutePage><DocumentsPage /></RoutePage> },
          { path: 'documents', element: <RoutePage><DocumentsLandingPage /></RoutePage> },
          { path: 'chat', element: <RoutePage><ChatLandingPage /></RoutePage> },
          { path: 'chat/:sessionId', element: <RoutePage><ChatPage /></RoutePage> },
          { path: 'search', element: <RoutePage><SearchPage /></RoutePage> },
          { path: 'tags', element: <RoutePage><TagsPage /></RoutePage> },
        ],
      },
      { path: '*', element: <Navigate to="/home" replace /> },
    ],
  },
]);
~~~

Do not rename, remove, or add routes in this phase.

- [ ] **Step 5: Verify tests and chunk output**

Run:

~~~powershell
npm test -- src/router/index.test.tsx
npm run build
~~~

Expected: the redirect test passes; TypeScript succeeds; Vite output contains separate JavaScript chunks for route pages instead of one page-only main bundle.

- [ ] **Step 6: Commit**

~~~powershell
git add frontend/src/router frontend/src/App.tsx
git commit -m "perf(frontend): lazy load route pages"
~~~

### Task 8: Optimize the login experience test-first

**Files:**
- Create: `frontend/src/pages/Login/LoginPage.test.tsx`
- Modify: `frontend/src/pages/Login/LoginPage.tsx`
- Create: `frontend/src/styles/pages/auth.css`
- Modify: `frontend/src/styles/index.css`

- [ ] **Step 1: Write failing login behavior tests**

Create `frontend/src/pages/Login/LoginPage.test.tsx`:

~~~tsx
import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Route, Routes } from 'react-router-dom';

import { ApiError } from '../../api/client';
import { login } from '../../api/resources';
import { renderWithRouter } from '../../test/render';
import type { LoginResponse } from '../../types/api';
import { LoginPage } from './LoginPage';

vi.mock('../../api/resources', () => ({ login: vi.fn() }));
const mockedLogin = vi.mocked(login);

function renderLogin() {
  return renderWithRouter(
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/home" element={<h1>首页</h1>} />
    </Routes>,
    ['/login'],
  );
}

beforeEach(() => mockedLogin.mockReset());

describe('LoginPage', () => {
  it('toggles password visibility without hiding its label', async () => {
    const user = userEvent.setup();
    renderLogin();
    const password = screen.getByLabelText('密码');
    expect(password).toHaveAttribute('type', 'password');
    await user.click(screen.getByRole('button', { name: '显示密码' }));
    expect(password).toHaveAttribute('type', 'text');
  });

  it('prevents repeat submit and navigates to home after success', async () => {
    let resolveLogin!: (value: LoginResponse) => void;
    mockedLogin.mockReturnValue(new Promise((resolve) => { resolveLogin = resolve; }));
    const user = userEvent.setup();
    renderLogin();
    await user.type(screen.getByLabelText('用户名'), 'admin');
    await user.type(screen.getByLabelText('密码'), 'secret');
    await user.click(screen.getByRole('button', { name: '登录' }));
    expect(screen.getByRole('button', { name: '登录中' })).toBeDisabled();

    await act(async () => resolveLogin({
      token: 'token-value',
      user: { id: 'u1', username: 'admin', displayName: '管理员' },
    }));
    expect(await screen.findByRole('heading', { name: '首页' })).toBeInTheDocument();
  });

  it('shows the backend error and moves focus to the summary', async () => {
    mockedLogin.mockRejectedValue(new ApiError(401, { code: 'INVALID_CREDENTIALS', message: '用户名或密码错误' }));
    const user = userEvent.setup();
    renderLogin();
    await user.type(screen.getByLabelText('用户名'), 'admin');
    await user.type(screen.getByLabelText('密码'), 'bad');
    await user.click(screen.getByRole('button', { name: '登录' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('用户名或密码错误');
    expect(alert).toHaveFocus();
  });
});
~~~

- [ ] **Step 2: Verify RED**

Run `npm test -- src/pages/Login/LoginPage.test.tsx`.

Expected: FAIL because the password toggle, loading button primitive, and focused alert are absent.

- [ ] **Step 3: Implement accessible login states**

Replace `frontend/src/pages/Login/LoginPage.tsx` with:

~~~tsx
import { Eye, EyeOff } from 'lucide-react';
import { FormEvent, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { login } from '../../api/resources';
import { Button } from '../../components/ui/Button';
import { IconButton } from '../../components/ui/IconButton';
import { tokenStore } from '../../store/tokenStore';
import { getErrorMessage } from '../../utils/errors';

export function LoginPage() {
  const navigate = useNavigate();
  const errorRef = useRef<HTMLParagraphElement>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setError('');
    setSubmitting(true);
    try {
      const response = await login(username, password);
      tokenStore.setToken(response.token);
      navigate('/home', { replace: true });
    } catch (caught) {
      setError(getErrorMessage(caught, '登录失败，请稍后重试'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="auth-page">
      <aside className="auth-context" aria-label="产品说明">
        <div>
          <p className="eyebrow">RAG Console</p>
          <h1>让企业知识可检索、可问答、可追溯</h1>
          <p>统一管理知识库与文档处理流程，并通过真实 citations 追踪答案依据。</p>
        </div>
        <ul>
          <li>知识库与文档集中管理</li>
          <li>检索、Rerank 与问答链路清晰可见</li>
          <li>答案引用只来自实际进入 Prompt 的内容</li>
        </ul>
      </aside>

      <form className="auth-panel" onSubmit={handleSubmit}>
        <header>
          <p className="eyebrow">欢迎回来</p>
          <h2>登录企业知识库</h2>
          <p className="page-description">使用已配置的账户继续进入工作台。</p>
        </header>

        <div className="auth-field">
          <label htmlFor="login-username">用户名</label>
          <input
            autoComplete="username"
            disabled={submitting}
            id="login-username"
            required
            value={username}
            onChange={(event) => setUsername(event.target.value)}
          />
        </div>

        <div className="auth-field">
          <label htmlFor="login-password">密码</label>
          <div className="password-field">
            <input
              autoComplete="current-password"
              disabled={submitting}
              id="login-password"
              required
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            <IconButton
              disabled={submitting}
              label={showPassword ? '隐藏密码' : '显示密码'}
              onClick={() => setShowPassword((visible) => !visible)}
            >
              {showPassword ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
            </IconButton>
          </div>
        </div>

        {error && <p className="auth-error" ref={errorRef} role="alert" tabIndex={-1}>{error}</p>}

        <Button className="auth-submit" loading={submitting} loadingLabel="登录中" type="submit">
          登录
        </Button>
      </form>
    </section>
  );
}
~~~

- [ ] **Step 4: Add auth page styles and import them**

Create `frontend/src/styles/pages/auth.css`:

~~~css
.auth-page {
  align-items: center;
  background: var(--color-canvas);
  display: grid;
  gap: clamp(40px, 7vw, 96px);
  grid-template-columns: minmax(0, 1fr) minmax(320px, 440px);
  min-height: 100dvh;
  padding: clamp(24px, 6vw, 80px);
}
.auth-context { color: var(--color-text-secondary); max-width: 620px; }
.auth-context h1 { color: var(--color-text); font-size: clamp(32px, 4vw, 52px); line-height: 1.12; margin: 8px 0 20px; }
.auth-context p { font-size: 17px; max-width: 58ch; }
.auth-context ul { display: grid; gap: 12px; margin: 28px 0 0; padding-left: 20px; }
.auth-panel {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-raised);
  display: grid;
  gap: 20px;
  padding: clamp(24px, 4vw, 40px);
  width: 100%;
}
.auth-panel h2 { font-size: 26px; margin: 4px 0; }
.auth-field { display: grid; gap: 8px; }
.auth-field > label { color: var(--color-text-secondary); font-size: 14px; font-weight: 650; }
.auth-field input { min-height: 44px; width: 100%; }
.password-field { align-items: center; display: grid; grid-template-columns: minmax(0, 1fr) 44px; }
.password-field input { border-bottom-right-radius: 0; border-top-right-radius: 0; }
.password-field .ui-icon-button { border: 1px solid var(--color-border); border-left: 0; border-bottom-left-radius: 0; border-top-left-radius: 0; }
.auth-error { background: var(--color-danger-soft); border-radius: var(--radius-sm); color: var(--color-danger); margin: 0; padding: 10px 12px; }
.auth-submit { width: 100%; }
@media (max-width: 680px) {
  .auth-page { display: flex; min-height: 100dvh; padding: 24px 16px; }
  .auth-context { display: none; }
  .auth-panel { margin: auto; max-width: 440px; }
}
@media (max-height: 560px) {
  .auth-page { align-items: start; }
}
~~~

Append to `frontend/src/styles/index.css` after `layouts.css`:

~~~css
@import './pages/auth.css';
~~~

- [ ] **Step 5: Verify GREEN and commit**

Run:

~~~powershell
npm test -- src/pages/Login/LoginPage.test.tsx
npm run build
~~~

Expected: all three login tests pass and the production build succeeds.

~~~powershell
git add frontend/src/pages/Login frontend/src/styles/pages/auth.css frontend/src/styles/index.css
git commit -m "feat(frontend): improve accessible login flow"
~~~

### Task 9: Make the home dashboard resilient by region

**Files:**
- Create: `frontend/src/pages/Home/homeData.test.ts`
- Create: `frontend/src/pages/Home/homeData.ts`
- Create: `frontend/src/pages/Home/HomePage.test.tsx`
- Modify: `frontend/src/pages/Home/HomePage.tsx`
- Create: `frontend/src/styles/pages/home.css`
- Modify: `frontend/src/styles/index.css`

- [ ] **Step 1: Write a failing partial-failure loader test**

Create `frontend/src/pages/Home/homeData.test.ts`:

~~~ts
import { describe, expect, it, vi } from 'vitest';

import type { ChatSession, GlobalDocumentItem, KnowledgeBase } from '../../types/api';
import { loadHomeDashboard } from './homeData';

const knowledgeBase = {
  id: 'kb1', name: '员工手册', description: '', visibility: 'private',
  retrievalConfig: { vectorTopN: 20, rerankTopK: 5, scoreThreshold: 0.2, enableRerank: true },
  createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-02T00:00:00Z',
} satisfies KnowledgeBase;
const document = {
  id: 'd1', knowledgeBaseId: 'kb1', knowledgeBaseName: '员工手册', filename: 'handbook.pdf',
  fileType: 'pdf', fileSize: 120, status: 'completed', errorMessage: null, createdAt: '2026-07-02T00:00:00Z',
} satisfies GlobalDocumentItem;
const session = {
  id: 's1', knowledgeBaseId: 'kb1', title: '休假制度',
  createdAt: '2026-07-02T00:00:00Z', updatedAt: '2026-07-02T01:00:00Z',
} satisfies ChatSession;

describe('loadHomeDashboard', () => {
  it('keeps successful regions when stats fail', async () => {
    const result = await loadHomeDashboard({
      loadStats: vi.fn().mockRejectedValue(new Error('offline')),
      loadKnowledgeBases: vi.fn().mockResolvedValue({ items: [knowledgeBase], total: 1, page: 1, pageSize: 5 }),
      loadDocuments: vi.fn().mockResolvedValue({ items: [document], total: 1, page: 1, pageSize: 5 }),
      loadSessions: vi.fn().mockResolvedValue({ items: [session] }),
    });

    expect(result.stats).toEqual({ data: null, error: '统计加载失败' });
    expect(result.knowledgeBases.data).toEqual([knowledgeBase]);
    expect(result.documents.data).toEqual([document]);
    expect(result.sessions.data).toEqual([session]);
  });
});
~~~

- [ ] **Step 2: Verify RED**

Run `npm test -- src/pages/Home/homeData.test.ts`.

Expected: FAIL because `homeData.ts` does not exist.

- [ ] **Step 3: Implement independent dashboard loading with correct API response mapping**

Create `frontend/src/pages/Home/homeData.ts`:

~~~ts
import {
  getKnowledgeBaseStats,
  listChatSessions,
  listGlobalDocuments,
  listKnowledgeBases,
} from '../../api/resources';
import type {
  ChatSession,
  ChatSessionListResponse,
  GlobalDocumentItem,
  GlobalDocumentListResponse,
  KnowledgeBase,
  KnowledgeBaseListResponse,
  KnowledgeBaseStatsResponse,
} from '../../types/api';

export type HomeSection<T> = { data: T; error: string };
export type HomeDashboardData = {
  stats: HomeSection<KnowledgeBaseStatsResponse | null>;
  knowledgeBases: HomeSection<KnowledgeBase[]>;
  documents: HomeSection<GlobalDocumentItem[]>;
  sessions: HomeSection<ChatSession[]>;
};
export type HomeSources = {
  loadStats: () => Promise<KnowledgeBaseStatsResponse>;
  loadKnowledgeBases: () => Promise<KnowledgeBaseListResponse>;
  loadDocuments: () => Promise<GlobalDocumentListResponse>;
  loadSessions: () => Promise<ChatSessionListResponse>;
};

const defaultSources: HomeSources = {
  loadStats: () => getKnowledgeBaseStats('month'),
  loadKnowledgeBases: () => listKnowledgeBases({ sort: 'updatedAt_desc', pageSize: 5 }),
  loadDocuments: () => listGlobalDocuments({ sort: 'updatedAt_desc', pageSize: 5 }),
  loadSessions: () => listChatSessions(),
};

function resolveSection<T, R>(
  result: PromiseSettledResult<T>,
  fallback: R,
  failure: string,
  select: (value: T) => R,
): HomeSection<R> {
  return result.status === 'fulfilled'
    ? { data: select(result.value), error: '' }
    : { data: fallback, error: failure };
}

export async function loadHomeDashboard(sources: HomeSources = defaultSources): Promise<HomeDashboardData> {
  const [stats, knowledgeBases, documents, sessions] = await Promise.allSettled([
    sources.loadStats(),
    sources.loadKnowledgeBases(),
    sources.loadDocuments(),
    sources.loadSessions(),
  ]);

  return {
    stats: resolveSection(stats, null, '统计加载失败', (value) => value),
    knowledgeBases: resolveSection(knowledgeBases, [], '最近知识库加载失败', (value) => value.items),
    documents: resolveSection(documents, [], '文档动态加载失败', (value) => value.items),
    sessions: resolveSection(sessions, [], '最近会话加载失败', (value) => value.items),
  };
}
~~~

This corrects the earlier draft error: the three list APIs resolve response objects and must be mapped through `.items`; they do not resolve arrays directly.

- [ ] **Step 4: Write the page-level failing test**

Create `frontend/src/pages/Home/HomePage.test.tsx`:

~~~tsx
import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithRouter } from '../../test/render';
import type { KnowledgeBase } from '../../types/api';
import { loadHomeDashboard } from './homeData';
import { HomePage } from './HomePage';

vi.mock('./homeData', () => ({ loadHomeDashboard: vi.fn() }));
const mockedLoad = vi.mocked(loadHomeDashboard);

const knowledgeBase = {
  id: 'kb1', name: '员工手册', description: '制度资料', visibility: 'private',
  retrievalConfig: { vectorTopN: 20, rerankTopK: 5, scoreThreshold: 0.2, enableRerank: true },
  createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-02T00:00:00Z',
} satisfies KnowledgeBase;

beforeEach(() => mockedLoad.mockReset());

describe('HomePage', () => {
  it('renders successful regions beside a failed document region', async () => {
    mockedLoad.mockResolvedValue({
      stats: { data: null, error: '' },
      knowledgeBases: { data: [knowledgeBase], error: '' },
      documents: { data: [], error: '文档动态加载失败' },
      sessions: { data: [], error: '' },
    });
    renderWithRouter(<HomePage />);

    expect(await screen.findByText('员工手册')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('文档动态加载失败');
  });
});
~~~

Run `npm test -- src/pages/Home/HomePage.test.tsx`.

Expected: FAIL because the current page blanks all regions behind one `Promise.all` error.

- [ ] **Step 5: Refactor HomePage around the region model**

Replace `frontend/src/pages/Home/HomePage.tsx` with:

~~~tsx
import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { EmptyState } from '../../components/feedback/EmptyState';
import { ErrorState } from '../../components/feedback/ErrorState';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';
import { WorkspaceShell } from '../../components/WorkspaceShell';
import type { GlobalDocumentItem } from '../../types/api';
import { loadHomeDashboard } from './homeData';
import type { HomeDashboardData } from './homeData';

export function HomePage() {
  const [dashboard, setDashboard] = useState<HomeDashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    loadHomeDashboard()
      .then((data) => { if (active) setDashboard(data); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [reloadKey]);

  const sessions = useMemo(
    () => [...(dashboard?.sessions.data ?? [])]
      .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime())
      .slice(0, 5),
    [dashboard?.sessions.data],
  );
  const documents = dashboard?.documents.data ?? [];
  const failedDocuments = documents.filter((document) => document.status === 'failed');
  const processingDocuments = documents.filter((document) => !['completed', 'failed'].includes(document.status));
  const retry = () => setReloadKey((value) => value + 1);

  return (
    <WorkspaceShell active="home">
      <div className="home-dashboard-page">
        <header className="page-header workspace-heading">
          <div>
            <p className="eyebrow">工作概览</p>
            <h1>工作台首页</h1>
            <p className="page-description">查看知识资产、处理任务和最近问答，不让单个接口故障阻塞整个页面。</p>
          </div>
        </header>

        <section className="home-quick-actions" aria-label="快捷入口">
          <QuickAction title="新建知识库" description="进入知识库工作台创建并配置检索。" to="/knowledge-bases" />
          <QuickAction title="导入文档" description="选择目标知识库并上传资料。" to="/documents" />
          <QuickAction title="开始问答" description="选择知识库继续或创建会话。" to="/chat" />
        </section>

        {loading || !dashboard ? (
          <LoadingSkeleton rows={5} columns={4} />
        ) : (
          <>
            {dashboard.stats.error ? (
              <ErrorState title="统计加载失败" description={dashboard.stats.error} onRetry={retry} />
            ) : (
              <section className="home-stat-grid" aria-label="关键统计">
                <StatCard label="知识库总数" value={dashboard.stats.data?.knowledgeBases.value ?? dashboard.knowledgeBases.data.length} />
                <StatCard label="文档总数" value={dashboard.stats.data?.documents.value ?? documents.length} />
                <StatCard label="近期处理中 / 失败" value={`${processingDocuments.length} / ${failedDocuments.length}`} />
                <StatCard label="活跃会话" value={dashboard.sessions.data.length} />
              </section>
            )}

            <div className="home-overview-grid">
              <DashboardRegion title="最近知识库" href="/knowledge-bases" error={dashboard.knowledgeBases.error} onRetry={retry}>
                {dashboard.knowledgeBases.data.length === 0 ? (
                  <EmptyState title="还没有知识库" description="创建知识库后即可导入文档。" />
                ) : dashboard.knowledgeBases.data.map((item) => (
                  <Link className="home-list-row" key={item.id} to={`/knowledge-bases/${item.id}`}>
                    <strong>{item.name}</strong>
                    <small>{item.description || '未填写描述'} · {formatDateTime(item.updatedAt)}</small>
                  </Link>
                ))}
              </DashboardRegion>

              <DashboardRegion title="最近会话" href="/chat" error={dashboard.sessions.error} onRetry={retry}>
                {sessions.length === 0 ? (
                  <EmptyState title="还没有问答会话" description="选择知识库开始第一次问答。" />
                ) : sessions.map((session) => (
                  <Link className="home-list-row" key={session.id} to={`/chat/${session.id}`}>
                    <strong>{session.title || '未命名会话'}</strong>
                    <small>{formatDateTime(session.updatedAt)}</small>
                  </Link>
                ))}
              </DashboardRegion>

              <DashboardRegion title="文档处理动态" href="/documents" error={dashboard.documents.error} onRetry={retry}>
                {documents.length === 0 ? (
                  <EmptyState title="还没有文档" description="导入文档后可在这里查看处理状态。" />
                ) : documents.map((document) => <DocumentActivity document={document} key={document.id} />)}
              </DashboardRegion>

              <section className="home-panel home-failure-panel" aria-labelledby="failed-documents-title">
                <header><h2 id="failed-documents-title">失败任务</h2></header>
                {failedDocuments.length === 0 ? (
                  <EmptyState title="暂无失败任务" description="最近文档处理状态正常。" />
                ) : failedDocuments.map((document) => (
                  <Link className="home-list-row" key={document.id} to={`/knowledge-bases/${document.knowledgeBaseId}/documents`}>
                    <strong>{document.filename}</strong>
                    <small>{document.errorMessage || '处理失败，请进入文档管理查看详情'}</small>
                  </Link>
                ))}
              </section>
            </div>
          </>
        )}
      </div>
    </WorkspaceShell>
  );
}

function QuickAction({ title, description, to }: { title: string; description: string; to: string }) {
  return <Link className="home-quick-action" to={to}><strong>{title}</strong><span>{description}</span></Link>;
}

function StatCard({ label, value }: { label: string; value: number | string }) {
  return <article className="home-stat-card"><span>{label}</span><strong>{value}</strong></article>;
}

function DashboardRegion({ title, href, error, onRetry, children }: {
  title: string; href: string; error: string; onRetry: () => void; children: ReactNode;
}) {
  return (
    <section className="home-panel">
      <header><h2>{title}</h2><Link to={href}>查看全部</Link></header>
      {error ? <ErrorState title={error} description="请重试该区域，其他区域不受影响。" onRetry={onRetry} /> : children}
    </section>
  );
}

function DocumentActivity({ document }: { document: GlobalDocumentItem }) {
  return (
    <Link className="home-list-row" to={`/knowledge-bases/${document.knowledgeBaseId}/documents`}>
      <strong>{document.filename}</strong>
      <small>{document.knowledgeBaseName} · {document.status} · {formatDateTime(document.updatedAt ?? document.createdAt)}</small>
    </Link>
  );
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .format(new Date(value));
}
~~~


- [ ] **Step 6: Add responsive dashboard CSS and import it**

Create `frontend/src/styles/pages/home.css`:

~~~css
.home-dashboard-page { display: grid; gap: 24px; }
.home-quick-actions { display: grid; gap: 16px; grid-template-columns: repeat(3, minmax(0, 1fr)); }
.home-quick-action,
.home-stat-card,
.home-panel { background: var(--color-surface); border: 1px solid var(--color-border); border-radius: var(--radius-md); }
.home-quick-action { color: var(--color-text); display: grid; gap: 6px; min-height: 112px; padding: 20px; text-decoration: none; }
.home-quick-action:hover { border-color: var(--color-primary); box-shadow: var(--shadow-raised); }
.home-quick-action span { color: var(--color-text-secondary); }
.home-stat-grid { display: grid; gap: 16px; grid-template-columns: repeat(4, minmax(0, 1fr)); }
.home-stat-card { display: grid; gap: 6px; padding: 18px 20px; }
.home-stat-card span { color: var(--color-text-muted); font-size: 14px; }
.home-stat-card strong { font-size: 28px; }
.home-overview-grid { display: grid; gap: 20px; grid-template-columns: repeat(2, minmax(0, 1fr)); }
.home-panel { min-width: 0; padding: 20px; }
.home-panel > header { align-items: center; display: flex; justify-content: space-between; margin-bottom: 12px; }
.home-panel h2 { font-size: 17px; margin: 0; }
.home-list-row { border-top: 1px solid var(--color-border); color: var(--color-text); display: grid; gap: 3px; padding: 12px 0; text-decoration: none; }
.home-list-row:first-of-type { border-top: 0; }
.home-list-row small { color: var(--color-text-muted); overflow-wrap: anywhere; }
.home-failure-panel { align-self: start; }
@media (max-width: 980px) {
  .home-quick-actions { grid-template-columns: 1fr; }
  .home-stat-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .home-overview-grid { grid-template-columns: 1fr; }
}
@media (max-width: 520px) {
  .home-stat-grid { grid-template-columns: 1fr; }
  .home-panel { padding: 16px; }
}
~~~

Append to `frontend/src/styles/index.css` after `auth.css`:

~~~css
@import './pages/home.css';
~~~

- [ ] **Step 7: Verify GREEN and commit**

Run:

~~~powershell
npm test -- src/pages/Home
npm run build
~~~

Expected: both home tests pass, the page keeps successful regions visible during partial failure, and the build succeeds.

~~~powershell
git add frontend/src/pages/Home frontend/src/styles/pages/home.css frontend/src/styles/index.css
git commit -m "feat(frontend): make dashboard loads resilient"
~~~

### Task 10: Add debounced, abortable URL-driven global search

**Files:**
- Create: `frontend/src/pages/Search/SearchPage.test.tsx`
- Modify: `frontend/src/api/resources.ts`
- Modify: `frontend/src/pages/Search/SearchPage.tsx`
- Create: `frontend/src/styles/pages/search.css`
- Modify: `frontend/src/styles/index.css`

- [ ] **Step 1: Write failing URL-state, debounce, and race tests**

Create `frontend/src/pages/Search/SearchPage.test.tsx`:

~~~tsx
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLocation } from 'react-router-dom';

import { globalSearch } from '../../api/resources';
import { renderWithRouter } from '../../test/render';
import type { GlobalSearchResponse } from '../../types/api';
import { SearchPage } from './SearchPage';

vi.mock('../../api/resources', () => ({ globalSearch: vi.fn() }));
const mockedSearch = vi.mocked(globalSearch);

function LocationProbe() {
  const location = useLocation();
  return <output aria-label="当前位置">{location.pathname + location.search}</output>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => mockedSearch.mockReset());
afterEach(() => vi.useRealTimers());

describe('SearchPage', () => {
  it('reads query/type from the URL, filters results, and writes type changes back', async () => {
    mockedSearch.mockResolvedValue({ items: [
      { type: 'knowledgeBase', id: 'kb1', knowledgeBaseId: 'kb1', knowledgeBaseName: '员工知识库', title: '员工知识库结果', snippet: '制度' },
      { type: 'document', id: 'd1', documentId: 'd1', knowledgeBaseId: 'kb1', knowledgeBaseName: '员工知识库', filename: 'handbook.pdf', title: '员工手册文档', snippet: '休假制度' },
    ] });
    const user = userEvent.setup();
    renderWithRouter(<><SearchPage /><LocationProbe /></>, ['/search?q=handbook&type=document']);

    expect(screen.getByLabelText('搜索关键词')).toHaveValue('handbook');
    expect(await screen.findByText('员工手册文档')).toBeInTheDocument();
    expect(screen.queryByText('员工知识库结果')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '文档 1' })).toHaveAttribute('aria-pressed', 'true');

    await user.click(screen.getByRole('button', { name: '知识库 1' }));
    expect(screen.getByLabelText('当前位置')).toHaveTextContent('/search?q=handbook&type=knowledgeBase');
  });

  it('debounces typed queries into the URL before searching', async () => {
    vi.useFakeTimers();
    mockedSearch.mockResolvedValue({ items: [] });
    renderWithRouter(<><SearchPage /><LocationProbe /></>, ['/search']);

    fireEvent.change(screen.getByLabelText('搜索关键词'), { target: { value: 'policy' } });
    act(() => vi.advanceTimersByTime(299));
    expect(screen.getByLabelText('当前位置')).toHaveTextContent('/search');
    expect(mockedSearch).not.toHaveBeenCalled();

    await act(async () => vi.advanceTimersByTime(1));
    expect(screen.getByLabelText('当前位置')).toHaveTextContent('/search?q=policy');
    expect(mockedSearch).toHaveBeenCalledWith('policy', expect.any(AbortSignal));
  });

  it('ignores an older request that resolves after the latest query', async () => {
    const first = deferred<GlobalSearchResponse>();
    const second = deferred<GlobalSearchResponse>();
    mockedSearch.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const user = userEvent.setup();
    renderWithRouter(<SearchPage />, ['/search?q=first']);
    await waitFor(() => expect(mockedSearch).toHaveBeenCalledTimes(1));

    const input = screen.getByLabelText('搜索关键词');
    await user.clear(input);
    await user.type(input, 'second');
    await user.click(screen.getByRole('button', { name: '搜索' }));
    await waitFor(() => expect(mockedSearch).toHaveBeenCalledTimes(2));

    await act(async () => second.resolve({ items: [
      { type: 'document', id: 'd2', documentId: 'd2', knowledgeBaseId: 'kb1', knowledgeBaseName: '知识库', title: '第二个结果', snippet: 'latest' },
    ] }));
    expect(await screen.findByText('第二个结果')).toBeInTheDocument();

    await act(async () => first.resolve({ items: [
      { type: 'document', id: 'd1', documentId: 'd1', knowledgeBaseId: 'kb1', knowledgeBaseName: '知识库', title: '过期结果', snippet: 'stale' },
    ] }));
    expect(screen.queryByText('过期结果')).not.toBeInTheDocument();
    expect(screen.getByText('第二个结果')).toBeInTheDocument();
  });
});
~~~

- [ ] **Step 2: Verify RED**

Run `npm test -- src/pages/Search/SearchPage.test.tsx`.

Expected: FAIL because the current page has no type filter or short debounce and does not pass an AbortSignal.

- [ ] **Step 3: Make the resource function abortable**

Change only the existing `globalSearch` export in `frontend/src/api/resources.ts` to:

~~~ts
export function globalSearch(query: string, signal?: AbortSignal): Promise<GlobalSearchResponse> {
  return apiRequest<GlobalSearchResponse>(withQuery('/search', { q: query }), { signal });
}
~~~

No `api/client.ts` change is needed: `RequestOptions` extends `RequestInit` and the request function already spreads `options` into `fetch`.

- [ ] **Step 4: Replace SearchPage with URL-driven, abort-safe state**

Replace `frontend/src/pages/Search/SearchPage.tsx` with:

~~~tsx
import { Search } from 'lucide-react';
import { FormEvent, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { globalSearch } from '../../api/resources';
import { EmptyState } from '../../components/feedback/EmptyState';
import { ErrorState } from '../../components/feedback/ErrorState';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';
import { WorkspaceShell } from '../../components/WorkspaceShell';
import { Button } from '../../components/ui/Button';
import type { GlobalSearchResult, GlobalSearchResultType } from '../../types/api';
import { getErrorMessage } from '../../utils/errors';

type SearchType = 'all' | GlobalSearchResultType;
const SEARCH_DEBOUNCE_MS = 300;
const typeOptions: Array<{ value: SearchType; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'knowledgeBase', label: '知识库' },
  { value: 'document', label: '文档' },
  { value: 'chunk', label: '内容片段' },
];

function readType(value: string | null): SearchType {
  return typeOptions.some((option) => option.value === value) ? value as SearchType : 'all';
}

export function SearchPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const submittedQuery = searchParams.get('q')?.trim() ?? '';
  const selectedType = readType(searchParams.get('type'));
  const [draft, setDraft] = useState(submittedQuery);
  const [items, setItems] = useState<GlobalSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => setDraft(submittedQuery), [submittedQuery]);

  useEffect(() => {
    const query = draft.trim();
    if (query === submittedQuery) return;
    const timer = window.setTimeout(() => {
      setSearchParams((current) => {
        const next = new URLSearchParams(current);
        if (query) next.set('q', query);
        else next.delete('q');
        return next;
      }, { replace: true });
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [draft, setSearchParams, submittedQuery]);

  useEffect(() => {
    if (!submittedQuery) {
      setItems([]);
      setError('');
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    setError('');
    globalSearch(submittedQuery, controller.signal)
      .then((response) => {
        if (!controller.signal.aborted) setItems(response.items);
      })
      .catch((caught) => {
        const aborted = controller.signal.aborted || (caught instanceof DOMException && caught.name === 'AbortError');
        if (!aborted) {
          setItems([]);
          setError(getErrorMessage(caught, '全局搜索失败'));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [submittedQuery, reloadKey]);

  const counts = useMemo(() => items.reduce<Record<SearchType, number>>((result, item) => {
    result.all += 1;
    result[item.type] += 1;
    return result;
  }, { all: 0, knowledgeBase: 0, document: 0, chunk: 0 }), [items]);
  const visibleItems = selectedType === 'all' ? items : items.filter((item) => item.type === selectedType);

  function writeParams(query: string, type: SearchType) {
    const next = new URLSearchParams();
    if (query) next.set('q', query);
    if (type !== 'all') next.set('type', type);
    setSearchParams(next);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    writeParams(draft.trim(), selectedType);
  }

  return (
    <WorkspaceShell active="search">
      <div className="search-page">
        <header className="page-header workspace-heading">
          <div><h1>全局搜索</h1><p className="page-description">搜索当前用户可访问的知识库、文档和内容片段。</p></div>
        </header>

        <form className="search-command" onSubmit={handleSubmit}>
          <Search aria-hidden="true" />
          <label className="sr-only" htmlFor="global-search-query">搜索关键词</label>
          <input
            id="global-search-query"
            placeholder="输入知识库、文件名或内容关键词"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <Button type="submit">搜索</Button>
        </form>

        <div className="search-type-tabs" aria-label="结果类型">
          {typeOptions.map((option) => (
            <button
              aria-pressed={selectedType === option.value}
              className={selectedType === option.value ? 'is-active' : ''}
              key={option.value}
              onClick={() => writeParams(submittedQuery, option.value)}
              type="button"
            >
              {option.label} {counts[option.value]}
            </button>
          ))}
        </div>

        <section className="search-results" aria-labelledby="search-results-title">
          <header><h2 id="search-results-title">搜索结果</h2><span>{submittedQuery ? `关键词：${submittedQuery}` : '等待输入关键词'}</span></header>
          {loading ? (
            <LoadingSkeleton rows={5} columns={3} />
          ) : error ? (
            <ErrorState title="搜索失败" description={error} onRetry={() => setReloadKey((value) => value + 1)} />
          ) : !submittedQuery ? (
            <EmptyState title="输入关键词开始搜索" description="可搜索知识库名称、文件名与内容片段。" />
          ) : visibleItems.length === 0 ? (
            <EmptyState title="没有匹配结果" description="尝试更短的关键词或切换结果类型。" />
          ) : (
            <div className="search-result-list">
              {visibleItems.map((item) => <SearchResult item={item} key={`${item.type}-${item.id}`} />)}
            </div>
          )}
        </section>
      </div>
    </WorkspaceShell>
  );
}

function SearchResult({ item }: { item: GlobalSearchResult }) {
  const href = item.type === 'knowledgeBase'
    ? `/knowledge-bases/${item.knowledgeBaseId}`
    : `/knowledge-bases/${item.knowledgeBaseId}/documents`;
  const label = item.type === 'knowledgeBase' ? '知识库' : item.type === 'document' ? '文档' : '内容片段';
  return (
    <Link className="search-result-row" to={href}>
      <span className="search-result-type">{label}</span>
      <span><strong>{item.title}</strong><small>{item.knowledgeBaseName}{item.filename ? ` · ${item.filename}` : ''}</small></span>
      <p>{item.snippet || '暂无摘要'}</p>
    </Link>
  );
}
~~~

The `.then` aborted check is required even in addition to `AbortController`: it protects tests and adapters whose mocked promise does not actively reject on abort.

- [ ] **Step 5: Add search CSS and import it**

Create `frontend/src/styles/pages/search.css`:

~~~css
.search-page { display: grid; gap: 20px; }
.search-command { align-items: center; display: grid; grid-template-columns: minmax(0, 1fr) auto; margin: 0 auto; max-width: 820px; position: relative; width: 100%; }
.search-command > svg { color: var(--color-text-muted); left: 14px; position: absolute; }
.search-command input { min-height: 44px; padding-left: 44px; }
.search-command .ui-button { border-bottom-left-radius: 0; border-top-left-radius: 0; }
.search-type-tabs { display: flex; flex-wrap: wrap; gap: 8px; }
.search-type-tabs button { background: var(--color-surface); border: 1px solid var(--color-border); border-radius: 999px; color: var(--color-text-secondary); min-height: 40px; padding: 0 14px; }
.search-type-tabs button.is-active { background: var(--color-primary-soft); border-color: rgb(37 99 235 / 34%); color: var(--color-primary); }
.search-results { background: var(--color-surface); border: 1px solid var(--color-border); border-radius: var(--radius-md); padding: 20px; }
.search-results > header { align-items: center; display: flex; justify-content: space-between; margin-bottom: 8px; }
.search-results h2 { font-size: 18px; margin: 0; }
.search-results > header span { color: var(--color-text-muted); }
.search-result-list { display: grid; }
.search-result-row { border-top: 1px solid var(--color-border); color: var(--color-text); display: grid; gap: 10px 16px; grid-template-columns: 80px minmax(180px, .6fr) minmax(220px, 1fr); padding: 16px 0; text-decoration: none; }
.search-result-row:first-child { border-top: 0; }
.search-result-row small { color: var(--color-text-muted); display: block; margin-top: 3px; }
.search-result-row p { color: var(--color-text-secondary); margin: 0; overflow-wrap: anywhere; }
.search-result-type { color: var(--color-primary); font-size: 13px; font-weight: 650; }
@media (max-width: 680px) {
  .search-command { grid-template-columns: 1fr; }
  .search-command .ui-button { grid-column: 1 / -1; margin-top: 8px; width: 100%; }
  .search-result-row { grid-template-columns: 1fr; }
  .search-results { padding: 16px; }
  .search-results > header { align-items: flex-start; flex-direction: column; gap: 4px; }
}
~~~

Append to `frontend/src/styles/index.css` after `home.css`:

~~~css
@import './pages/search.css';
~~~

- [ ] **Step 6: Verify GREEN and commit**

Run:

~~~powershell
npm test -- src/pages/Search/SearchPage.test.tsx
npm run build
~~~

Expected: all three search tests pass, typing updates `q` only after 300ms of inactivity, stale results cannot overwrite the latest query, and the build succeeds.

~~~powershell
git add frontend/src/api/resources.ts frontend/src/pages/Search frontend/src/styles/pages/search.css frontend/src/styles/index.css
git commit -m "feat(frontend): make global search URL driven"
~~~

### Task 11: Move tag editing into a focused dialog

**Files:**
- Create: `frontend/src/pages/Tags/TagDialog.test.tsx`
- Create: `frontend/src/pages/Tags/TagDialog.tsx`
- Create: `frontend/src/pages/Tags/TagsPage.test.tsx`
- Modify: `frontend/src/pages/Tags/TagsPage.tsx`
- Create: `frontend/src/styles/pages/tags.css`
- Modify: `frontend/src/styles/index.css`

- [ ] **Step 1: Write the failing dialog preservation test**

Create `frontend/src/pages/Tags/TagDialog.test.tsx`:

~~~tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../api/client';
import { TagDialog } from './TagDialog';

describe('TagDialog', () => {
  it('keeps the edited value and shows the backend message after failure', async () => {
    const onSubmit = vi.fn().mockRejectedValue(
      new ApiError(409, { code: 'TAG_EXISTS', message: '标签名称已存在' }),
    );
    const user = userEvent.setup();
    render(<TagDialog open initialName="旧名称" title="编辑标签" onClose={vi.fn()} onSubmit={onSubmit} />);

    const input = screen.getByLabelText('标签名称');
    await user.clear(input);
    await user.type(input, '替换名称');
    await user.click(screen.getByRole('button', { name: '保存标签' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('标签名称已存在');
    expect(input).toHaveValue('替换名称');
  });
});
~~~

- [ ] **Step 2: Verify RED**

Run `npm test -- src/pages/Tags/TagDialog.test.tsx`.

Expected: FAIL because `TagDialog` does not exist.

- [ ] **Step 3: Implement TagDialog with field-linked errors**

Create `frontend/src/pages/Tags/TagDialog.tsx`:

~~~tsx
import { FormEvent, useEffect, useId, useState } from 'react';

import { Button } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';
import { getErrorMessage } from '../../utils/errors';

export type TagDialogProps = {
  open: boolean;
  initialName: string;
  title: string;
  onClose: () => void;
  onSubmit: (name: string) => Promise<void>;
};

export function TagDialog({ open, initialName, title, onClose, onSubmit }: TagDialogProps) {
  const errorId = useId();
  const [name, setName] = useState(initialName);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setName(initialName);
      setError('');
    }
  }, [initialName, open]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError('请输入标签名称');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      await onSubmit(trimmedName);
      onClose();
    } catch (caught) {
      setError(getErrorMessage(caught, '标签保存失败'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} title={title} description="标签可在知识库创建和编辑时绑定。" onClose={() => { if (!submitting) onClose(); }}>
      <form className="tag-dialog-form" onSubmit={handleSubmit}>
        <label htmlFor="tag-name">标签名称</label>
        <input
          aria-describedby={error ? errorId : undefined}
          aria-invalid={Boolean(error)}
          id="tag-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        {error && <p className="field-error" id={errorId} role="alert">{error}</p>}
        <div className="ui-dialog__actions">
          <Button variant="secondary" disabled={submitting} onClick={onClose}>取消</Button>
          <Button loading={submitting} loadingLabel="保存中" type="submit">保存标签</Button>
        </div>
      </form>
    </Dialog>
  );
}
~~~

- [ ] **Step 4: Write page integration tests before refactoring**

Create `frontend/src/pages/Tags/TagsPage.test.tsx`:

~~~tsx
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../api/client';
import {
  createKnowledgeBaseTag,
  deleteKnowledgeBaseTag,
  listKnowledgeBaseTags,
  updateKnowledgeBaseTag,
} from '../../api/resources';
import { renderWithRouter } from '../../test/render';
import type { KnowledgeBaseTag } from '../../types/api';
import { TagsPage } from './TagsPage';

vi.mock('../../api/resources', () => ({
  createKnowledgeBaseTag: vi.fn(),
  deleteKnowledgeBaseTag: vi.fn(),
  listKnowledgeBaseTags: vi.fn(),
  updateKnowledgeBaseTag: vi.fn(),
}));

const existing = {
  id: 't1', name: '制度', createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-01T00:00:00Z',
} satisfies KnowledgeBaseTag;
const created = {
  id: 't2', name: '产品', createdAt: '2026-07-02T00:00:00Z', updatedAt: '2026-07-02T00:00:00Z',
} satisfies KnowledgeBaseTag;

beforeEach(() => {
  vi.mocked(listKnowledgeBaseTags).mockReset().mockResolvedValue({ items: [existing] });
  vi.mocked(createKnowledgeBaseTag).mockReset().mockResolvedValue(created);
  vi.mocked(updateKnowledgeBaseTag).mockReset();
  vi.mocked(deleteKnowledgeBaseTag).mockReset();
});

describe('TagsPage', () => {
  it('creates a tag in a dialog while retaining the existing table', async () => {
    const user = userEvent.setup();
    renderWithRouter(<TagsPage />);
    expect(await screen.findByText('制度')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '新建标签' }));
    await user.type(screen.getByLabelText('标签名称'), '产品');
    await user.click(screen.getByRole('button', { name: '保存标签' }));

    expect(await screen.findByText('产品')).toBeInTheDocument();
    expect(screen.getByText('制度')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('标签创建成功');
  });

  it('keeps the row and confirm dialog after a failed delete', async () => {
    vi.mocked(deleteKnowledgeBaseTag).mockRejectedValue(
      new ApiError(409, { code: 'TAG_NOT_EMPTY', message: '标签仍被知识库引用' }),
    );
    const user = userEvent.setup();
    renderWithRouter(<TagsPage />);
    expect(await screen.findByText('制度')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '删除 制度' }));

    const dialog = screen.getByRole('dialog', { name: '删除标签' });
    await user.click(within(dialog).getByRole('button', { name: '删除' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('标签仍被知识库引用');
    expect(screen.getByText('制度')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: '删除标签' })).toBeInTheDocument();
  });
});
~~~

Run `npm test -- src/pages/Tags/TagsPage.test.tsx`.

Expected: FAIL because the current page uses an inline form, reloads after save, and exposes a generic delete button name.

- [ ] **Step 5: Refactor TagsPage around local row updates and shared feedback**

Replace `frontend/src/pages/Tags/TagsPage.tsx` with:

~~~tsx
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import {
  createKnowledgeBaseTag,
  deleteKnowledgeBaseTag,
  listKnowledgeBaseTags,
  updateKnowledgeBaseTag,
} from '../../api/resources';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { EmptyState } from '../../components/feedback/EmptyState';
import { ErrorState } from '../../components/feedback/ErrorState';
import { useToast } from '../../components/feedback/ToastProvider';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';
import { WorkspaceShell } from '../../components/WorkspaceShell';
import { Button } from '../../components/ui/Button';
import { IconButton } from '../../components/ui/IconButton';
import type { KnowledgeBaseTag } from '../../types/api';
import { getErrorMessage } from '../../utils/errors';
import { TagDialog } from './TagDialog';

type EditorState = { tag?: KnowledgeBaseTag } | null;

export function TagsPage() {
  const toast = useToast();
  const [tags, setTags] = useState<KnowledgeBaseTag[]>([]);
  const [editor, setEditor] = useState<EditorState>(null);
  const [deleteTarget, setDeleteTarget] = useState<KnowledgeBaseTag | null>(null);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [deleteError, setDeleteError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError('');
    listKnowledgeBaseTags()
      .then((response) => { if (active) setTags(response.items); })
      .catch((caught) => { if (active) setLoadError(getErrorMessage(caught, '标签加载失败')); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [reloadKey]);

  const visibleTags = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase();
    return [...tags]
      .filter((tag) => !keyword || tag.name.toLocaleLowerCase().includes(keyword))
      .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
  }, [query, tags]);

  async function saveTag(name: string) {
    if (editor?.tag) {
      const updated = await updateKnowledgeBaseTag(editor.tag.id, { name });
      setTags((items) => items.map((item) => item.id === updated.id ? updated : item));
      toast.success('标签更新成功');
    } else {
      const created = await createKnowledgeBaseTag({ name });
      setTags((items) => [created, ...items]);
      toast.success('标签创建成功');
    }
  }

  async function deleteTag() {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError('');
    try {
      await deleteKnowledgeBaseTag(deleteTarget.id);
      setTags((items) => items.filter((item) => item.id !== deleteTarget.id));
      setDeleteTarget(null);
      toast.success('标签删除成功');
    } catch (caught) {
      setDeleteError(getErrorMessage(caught, '标签删除失败'));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <WorkspaceShell active="tags">
      <div className="tags-page">
        <header className="page-header workspace-heading tags-header">
          <div><h1>标签管理</h1><p className="page-description">维护知识库可绑定的标签。</p></div>
          <Button leadingIcon={<Plus aria-hidden="true" />} onClick={() => setEditor({})}>新建标签</Button>
        </header>

        <div className="tags-toolbar">
          <label className="sr-only" htmlFor="tag-search">搜索标签</label>
          <input id="tag-search" placeholder="搜索标签名称" value={query} onChange={(event) => setQuery(event.target.value)} />
          <span>{visibleTags.length} 个标签</span>
        </div>

        {loading ? (
          <LoadingSkeleton rows={5} columns={3} />
        ) : loadError ? (
          <ErrorState title="标签加载失败" description={loadError} onRetry={() => setReloadKey((value) => value + 1)} />
        ) : visibleTags.length === 0 ? (
          <EmptyState title="没有匹配的标签" description="调整关键词，或创建一个新标签。" />
        ) : (
          <div className="tags-table-wrap">
            <table className="tags-table">
              <thead><tr><th>名称</th><th>更新时间</th><th>操作</th></tr></thead>
              <tbody>
                {visibleTags.map((tag) => (
                  <tr key={tag.id}>
                    <td data-label="名称"><strong>{tag.name}</strong></td>
                    <td data-label="更新时间">{formatDateTime(tag.updatedAt)}</td>
                    <td data-label="操作">
                      <div className="tags-row-actions">
                        <IconButton label={`编辑 ${tag.name}`} onClick={() => setEditor({ tag })}><Pencil aria-hidden="true" /></IconButton>
                        <IconButton label={`删除 ${tag.name}`} tone="danger" onClick={() => { setDeleteError(''); setDeleteTarget(tag); }}><Trash2 aria-hidden="true" /></IconButton>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <TagDialog
          initialName={editor?.tag?.name ?? ''}
          onClose={() => setEditor(null)}
          onSubmit={saveTag}
          open={editor !== null}
          title={editor?.tag ? '编辑标签' : '新建标签'}
        />

        {deleteTarget && (
          <ConfirmDialog
            busy={deleting}
            confirmLabel="删除"
            description={`确认删除“${deleteTarget.name}”？如果仍被知识库引用，后端会拒绝删除。`}
            error={deleteError}
            onCancel={() => { setDeleteError(''); setDeleteTarget(null); }}
            onConfirm={() => void deleteTag()}
            title="删除标签"
          />
        )}
      </div>
    </WorkspaceShell>
  );
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .format(new Date(value));
}
~~~

- [ ] **Step 6: Add tag page CSS and import it**

Create `frontend/src/styles/pages/tags.css`:

~~~css
.tags-page { display: grid; gap: 20px; }
.tags-header { align-items: center; display: flex; justify-content: space-between; }
.tags-toolbar { align-items: center; display: flex; gap: 12px; justify-content: space-between; }
.tags-toolbar input { max-width: 360px; min-height: 40px; width: 100%; }
.tags-toolbar span { color: var(--color-text-muted); white-space: nowrap; }
.field-error { color: var(--color-danger); margin: 0; }
.tags-table-wrap { background: var(--color-surface); border: 1px solid var(--color-border); border-radius: var(--radius-md); overflow-x: auto; }
.tags-table { border-collapse: collapse; min-width: 620px; width: 100%; }
.tags-table th,
.tags-table td { border-bottom: 1px solid var(--color-border); padding: 14px 16px; text-align: left; }
.tags-table th { color: var(--color-text-muted); font-size: 13px; font-weight: 650; }
.tags-table tbody tr:last-child td { border-bottom: 0; }
.tags-row-actions { display: flex; gap: 4px; justify-content: flex-end; }
.tag-dialog-form { display: grid; gap: 10px; margin-top: 20px; }
.tag-dialog-form > label { color: var(--color-text-secondary); font-size: 14px; font-weight: 650; }
.tag-dialog-form > input { min-height: 44px; }
@media (max-width: 680px) {
  .tags-header { align-items: stretch; flex-direction: column; gap: 16px; }
  .tags-toolbar { align-items: stretch; flex-direction: column; }
  .tags-toolbar input { max-width: none; min-height: 44px; }
  .tags-table-wrap { background: transparent; border: 0; overflow: visible; }
  .tags-table,
  .tags-table tbody,
  .tags-table tr,
  .tags-table td { display: block; min-width: 0; width: 100%; }
  .tags-table thead { display: none; }
  .tags-table tr { background: var(--color-surface); border: 1px solid var(--color-border); border-radius: var(--radius-md); margin-bottom: 12px; padding: 8px 12px; }
  .tags-table td { align-items: center; border: 0; display: flex; justify-content: space-between; padding: 8px 0; }
  .tags-table td::before { color: var(--color-text-muted); content: attr(data-label); font-size: 13px; }
  .tags-row-actions { min-height: 44px; }
}
~~~

Append to `frontend/src/styles/index.css` after `search.css`:

~~~css
@import './pages/tags.css';
~~~

- [ ] **Step 7: Verify GREEN and commit**

Run:

~~~powershell
npm test -- src/pages/Tags
npm run build
~~~

Expected: TagDialog and TagsPage tests pass, failed mutations preserve user input/data, delete errors remain visible inside the open confirmation dialog, and the build succeeds.

~~~powershell
git add frontend/src/pages/Tags frontend/src/styles/pages/tags.css frontend/src/styles/index.css
git commit -m "feat(frontend): streamline tag management"
~~~

### Task 12: Phase regression, accessibility smoke check, and isolated handoff

**Files:**
- Modify: `docs/10-frontend-spec.md`
- Create: `docs/superpowers/handoffs/2026-07-10-frontend-foundation-core-workspace.md`
- Read only: `docs/12-handoff.md`

- [ ] **Step 1: Run the complete frontend suite**

From the repository root:

~~~powershell
cd frontend
npm test
npm run build
~~~

Expected: Vitest reports zero failed tests; TypeScript and Vite exit 0; the Vite output contains route-level JavaScript chunks.

- [ ] **Step 2: Run backend regression tests**

~~~powershell
cd ../backend
go test ./...
~~~

Expected: all Go packages pass. This phase does not modify backend code or migrations; if this command fails, diagnose the failure without staging or reverting the existing backend work.

- [ ] **Step 3: Start both real development services for the smoke check**

In terminal A, from the repository root:

~~~powershell
cd backend
go run ./cmd/server
~~~

In terminal B, from the repository root:

~~~powershell
cd frontend
npm run dev -- --host 127.0.0.1 --port 5173
~~~

Expected: the backend listens on its configured local address and Vite serves `http://127.0.0.1:5173`. Use the locally seeded account to authenticate, but do not copy credentials or any root `.env` value into logs, screenshots, commits, or the handoff.

- [ ] **Step 4: Complete the responsive and keyboard browser smoke matrix**

Open `http://127.0.0.1:5173` in a normal browser and perform every row below at 1440px, 1280px, 768px, and 375px viewport widths:

1. Clear the token through the app's logout action; opening `/home` redirects to `/login`.
2. Reach every login field and control with Tab, toggle password visibility, submit with Enter, and confirm successful login opens `/home`.
3. Confirm the six navigation items are present, only one is current, “权限管理” is absent, and no full-page horizontal scrollbar appears.
4. At 768px and 375px, open the navigation drawer, confirm focus enters it, cycle forward and backward with Tab, close it with Escape, and confirm focus returns to the opener.
5. Submit `handbook` from the top-bar search and confirm the URL becomes `/search?q=handbook`.
6. Refresh `/search?q=handbook&type=document`; confirm the query and document filter survive, then type a new query and confirm the URL/search update only after the 300ms debounce while results remain type-filtered.
7. On `/home`, confirm the quick actions and each dashboard region reserve space while loading; use browser request blocking for `/api/v1/knowledge-bases/stats*`, refresh once, and confirm the remaining successful regions stay visible with a retryable stats error.
8. On `/tags`, open create/edit dialogs, confirm initial focus, close with Escape, reopen, and verify the table remains present. Do not create destructive test data during this smoke pass.
9. Open at least one existing knowledge-base, document, and chat route to confirm each still renders through `WorkspaceShell`.
10. Keep the browser console open throughout and confirm there are no React key warnings, console errors, unhandled rejections, or failed same-origin asset requests.

Expected: all ten checks pass at the applicable widths. Convert every discovered behavior defect into a failing automated test before changing implementation code, then rerun Steps 1–4.

- [ ] **Step 5: Replace the public frontend behavior spec with the current route and shell contract**

Replace `docs/10-frontend-spec.md` with:

~~~~markdown
# 前端规范

前端使用 React，目标是克制、清晰的现代企业后台知识库与聊天问答系统。MVP 不做营销首页，不引入大型 UI 框架。

## 页面清单

~~~text
/login
/home
/knowledge-bases
/knowledge-bases/:id
/knowledge-bases/:id/documents
/documents
/chat
/chat/:sessionId
/search
/tags
~~~

除 `/login` 外的页面都需要 token；匿名访问受保护路由时跳转 `/login`。

## 全局应用外壳

1. 左侧主导航固定包含：首页、知识库、文档管理、问答管理、全局搜索、标签管理。
2. 不展示不属于 MVP 的“权限管理”和无功能系统设置占位项。
3. 顶栏统一展示当前页面上下文、全局搜索入口、当前用户提示和退出登录。
4. 知识库分类树只在支持分类操作的知识库工作台显示，不在首页、文档、聊天、搜索和标签页面重复显示。
5. `>= 1280px` 使用完整侧栏，`981–1279px` 使用紧凑侧栏，`<= 980px` 使用导航抽屉，`<= 680px` 使用 16px 内容边距和移动端触控尺寸。
6. 任一断点不得出现整页横向滚动；导航抽屉打开时锁定背景滚动并约束焦点，Escape 关闭后恢复触发按钮焦点。

## 登录页

功能：

1. 用户名和密码使用可见标签。
2. 支持显示/隐藏密码。
3. 提交期间禁用字段和按钮，避免重复登录请求。
4. 登录失败展示后端 `message`，并把焦点移动到错误摘要。

验收：

~~~text
登录成功后保存 token
跳转到 /home
登录失败显示后端 message
全流程可用键盘完成
~~~

## 首页

1. 展示新建知识库、导入文档和开始问答快捷入口。
2. 统计、最近知识库、最近文档和最近会话独立加载；单个接口失败不得清空其他成功区域。
3. 加载时使用预留空间的 Skeleton；区域失败时提供局部重试。
4. 展示处理中与失败文档摘要，不伪造后端状态。

## 知识库列表页

1. 展示当前用户知识库。
2. 创建、编辑和删除知识库。
3. 删除前需要确认。
4. 支持分类筛选并进入知识库详情。
5. 第一阶段仅通过新应用外壳保持现有功能；工作台内部视觉与交互在后续切片优化。

## 知识库详情页

1. 展示知识库名称、描述和 `retrievalConfig`。
2. 提供文档管理与聊天问答入口。
3. 第一阶段仅保持路由和应用外壳兼容；详情内部在后续切片优化。

默认 `retrievalConfig`：

~~~json
{
  "vectorTopN": 30,
  "rerankTopK": 5,
  "scoreThreshold": 0.3,
  "enableRerank": true
}
~~~

## 文档管理页

1. 上传 `txt`、`md`、`pdf`。
2. 展示文件类型、大小、状态和错误信息。
3. 删除和重新处理文档。
4. 存在未完成文档时每 3 秒刷新；全部为 `completed` 或 `failed` 后停止轮询。
5. 第一阶段仅保持全局与知识库文档路由兼容；列表、任务进度和移动端布局在后续切片优化。

后端状态：

~~~text
uploaded
parsing
chunking
embedding
completed
failed
~~~

## 聊天问答页

1. 展示会话、消息、问题输入和发送状态。
2. assistant 回答必须展示真实 citations；无引用时展示“当前知识库中未找到足够依据。”
3. citations 至少展示 `filename`、`pageNumber`、`content`、`vectorScore` 和 `rerankScore`。
4. 第一阶段仅保持 `/chat` 与 `/chat/:sessionId` 路由兼容；会话、重试、重新生成、citations 和 Rerank fallback 在后续切片优化。

## 全局搜索页

1. 关键词保存在 URL 的 `q` 参数，结果类型保存在 `type` 参数。
2. 支持全部、知识库、文档和内容片段筛选；刷新和前进/后退后状态不丢失。
3. 输入停止 300ms 后以 replace 模式同步 `q`，显式提交立即同步；查询变化时中止过期请求，并防止忽略 AbortSignal 的旧 Promise 覆盖新结果。
4. 明确展示加载、空结果、错误和局部重试状态。

## 标签管理页

1. 列表支持名称筛选和移动端字段标注卡片布局。
2. 新建和编辑在共享 Dialog 中完成；失败后保留输入并展示后端 `message`。
3. 创建和更新成功后局部更新列表，不重新加载整表。
4. 删除前确认；删除失败时保留原行和确认框，并在确认框内展示后端错误。
5. 成功操作通过全局 Toast 通知。

## 全局反馈与可访问性

1. Button、IconButton、EmptyState、ErrorState、LoadingSkeleton、Dialog 和 Toast 使用统一语义样式。
2. 图标按钮必须同时提供 `aria-label` 与 tooltip，不使用字符或英文占位图标。
3. Dialog 支持 Escape、焦点约束、背景滚动锁定和焦点恢复。
4. 所有交互控件保留明显 `:focus-visible`；关键移动端触控目标不低于 44px。
5. 支持 `prefers-reduced-motion`；成功、警告和危险状态不能只依赖颜色表达。

## API 与代码约束

1. token 保存在 token store；API 请求统一注入 `Authorization: Bearer <token>`。
2. 401 时清理 token 并跳转登录页；错误反馈优先使用后端 `message`。
3. 页面级筛选优先写入 URL；可过期请求通过 `AbortSignal` 取消。
4. 路由页面使用 `React.lazy` 分包；`App.tsx` 只承载 Outlet，不堆叠页面实现。
5. `resources.ts` 保持兼容导出；API 字段使用 camelCase，不伪造文档状态、检索分数、Rerank 状态或 citations。
6. 知识库、文档和聊天内部优化必须分别测试并按后续计划渐进实施。
~~~~

Expected: the document now lists every existing route, records `/home` as the login destination, and clearly separates this phase from the deferred knowledge-base, document, and chat slices.

- [ ] **Step 6: Create an isolated phase handoff without touching the dirty root handoff**

Create `docs/superpowers/handoffs/2026-07-10-frontend-foundation-core-workspace.md`:

~~~markdown
# Frontend Foundation and Core Workspace Handoff

## Delivered scope

- Added Vitest, React Testing Library, user-event, jsdom, and shared test setup/render helpers.
- Added semantic visual tokens, layered CSS, Button, IconButton, EmptyState, ErrorState, LoadingSkeleton, Toast, Dialog, and ConfirmDialog compatibility.
- Added the six-item desktop sidebar and `<= 980px` keyboard-accessible navigation drawer with focus restoration and background scroll lock.
- Centralized page context, global search, account/logout actions, and kept knowledge-base categories scoped to the knowledge-base workspace.
- Lazy-loaded all existing route pages and retained anonymous-user redirects.
- Optimized login, home, debounced global search, and tag management with tested loading, empty, error, success, race, and localized mutation-failure behavior.
- Made `globalSearch(query, signal?)` abortable without changing the backend API contract.

## Verification evidence

- `cd frontend; npm test` passed before this handoff was committed.
- `cd frontend; npm run build` passed and emitted route-level chunks.
- `cd backend; go test ./...` passed without frontend-phase backend changes.
- Browser smoke checks passed at 1440px, 1280px, 768px, and 375px with keyboard navigation and no console errors.

## Deferred work

1. Knowledge-base workspace and detail internals, including remaining legacy styles.
2. Global and knowledge-base document management, processing progress, polling, retry, and mobile layouts.
3. Chat sessions, message actions, input behavior, citations, no-citation states, and visible `rerankFallback` handling.
4. Only the backend fields or query parameters confirmed missing during those slices; no migration unless separately approved.
5. Final authenticated cross-page regression and responsive QA after all slices land.

## Workspace safety

`docs/12-handoff.md` was deliberately not edited or staged because it already carried unrelated backend/Rerank handoff changes. This dedicated record keeps the frontend phase independently reviewable. No root `.env` values are recorded here.
~~~

- [ ] **Step 7: Stage and verify only the two documentation files**

From the repository root:

~~~powershell
git add -- docs/10-frontend-spec.md docs/superpowers/handoffs/2026-07-10-frontend-foundation-core-workspace.md
$expected = @(
  'docs/10-frontend-spec.md',
  'docs/superpowers/handoffs/2026-07-10-frontend-foundation-core-workspace.md'
)
$actual = @(git diff --cached --name-only)
$delta = @(Compare-Object -ReferenceObject $expected -DifferenceObject $actual)
if ($delta.Count -ne 0) {
  $delta | Format-Table
  throw 'Unexpected staged files; stop before committing.'
}
git diff --cached --check
git status --short
~~~

Expected: the staged-name comparison and whitespace check exit successfully; exactly the two expected documentation paths are staged. Existing backend, chat, knowledge-base-detail, root stylesheet, type, and root-handoff modifications remain unstaged.

- [ ] **Step 8: Commit the verified phase handoff**

~~~powershell
git commit -m "docs: record frontend foundation phase"
~~~

Expected: the commit succeeds with only the public frontend spec and isolated phase handoff.

## Completion criteria

This phase is complete only when:

1. `npm test` and `npm run build` pass with zero failures.
2. `go test ./...` passes.
3. The six-item global navigation, global search, account actions, and current-page context work at desktop and mobile widths.
4. The mobile drawer constrains focus, closes with Escape, restores focus, locks background scroll, and never causes full-page horizontal overflow.
5. The permissions/system placeholders and global category tree are absent outside the knowledge-base workspace.
6. Login, home, search, and tags meet the approved feedback, URL-state, mutation, and accessibility rules.
7. Existing knowledge-base, document, and chat routes still compile and open through `WorkspaceShell`.
8. Existing uncommitted work has not been reverted, overwritten, or accidentally committed.
9. `docs/10-frontend-spec.md` and the isolated phase handoff describe the delivered behavior without quoting secrets.
10. No claim is made that knowledge-base, document, chat, lightweight backend-contract, or final cross-page optimization is finished; each remains a separately planned phase.
