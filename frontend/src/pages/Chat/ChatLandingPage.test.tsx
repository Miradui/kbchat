import { StrictMode } from 'react';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { listChatSessions, listKnowledgeBases } from '../../api/resources';
import { ToastProvider } from '../../components/feedback/ToastProvider';
import { renderWithRouter } from '../../test/render';
import type { ChatSession, KnowledgeBase } from '../../types/api';
import { ChatLandingPage } from './ChatLandingPage';

vi.mock('../../api/resources', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../api/resources')>(),
  getWorkspacePreference: vi.fn().mockResolvedValue({
    viewMode: 'table', scope: 'all', sort: 'updatedAt_desc', visibility: 'all', expandedCategoryIds: [],
  }),
  listChatSessions: vi.fn(),
  listKnowledgeBaseCategories: vi.fn().mockResolvedValue({ items: [] }),
  listKnowledgeBases: vi.fn(),
  logout: vi.fn(),
}));

const knowledgeBase = {
  id: 'kb1',
  name: '制度库',
  description: '制度说明',
  visibility: 'private',
  retrievalConfig: { vectorTopN: 30, rerankTopK: 5, scoreThreshold: 0.3, enableRerank: true },
  createdAt: '2026-07-01T00:00:00Z',
  updatedAt: '2026-07-01T00:00:00Z',
} satisfies KnowledgeBase;

const session = {
  id: 'session1',
  knowledgeBaseId: knowledgeBase.id,
  title: '请假制度',
  createdAt: '2026-07-01T00:00:00Z',
  updatedAt: '2026-07-02T00:00:00Z',
  archivedAt: null,
} satisfies ChatSession;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

beforeEach(() => {
  vi.mocked(listKnowledgeBases).mockReset().mockResolvedValue({ items: [knowledgeBase] });
  vi.mocked(listChatSessions).mockReset().mockResolvedValue({ items: [session] });
});

function renderPage() {
  return renderWithRouter(
    <Routes>
      <Route path="/chat" element={<ChatLandingPage />} />
    </Routes>,
    ['/chat'],
  );
}

describe('ChatLandingPage', () => {
  it('uses AI Q&A language and separates continuing from starting a conversation', async () => {
    renderPage();

    expect(await screen.findByRole('heading', { name: 'AI 问答' })).toBeInTheDocument();
    const row = await screen.findByRole('article', { name: '制度库' });
    expect(within(row).getByRole('link', { name: '继续最近会话' })).toHaveAttribute('href', '/chat/session1');
    expect(within(row).getByRole('link', { name: '新建对话' })).toHaveAttribute(
      'href',
      '/chat/new?knowledgeBaseId=kb1',
    );
  });

  it('keeps the recent-session action state explicit while sessions are loading', async () => {
    const pendingSessions = deferred<{ items: ChatSession[] }>();
    vi.mocked(listChatSessions).mockReturnValue(pendingSessions.promise);
    renderPage();

    const row = await screen.findByRole('article', { name: '制度库' });
    expect(within(row).getByText('会话加载中')).toBeInTheDocument();
    expect(within(screen.getByText('会话').parentElement!).getByText('--')).toBeInTheDocument();
    expect(within(screen.getByText('可继续会话知识库').parentElement!).getByText('--')).toBeInTheDocument();
    expect(within(row).getByRole('link', { name: '新建对话' })).toHaveAttribute(
      'href',
      '/chat/new?knowledgeBaseId=kb1',
    );
    expect(within(row).queryByRole('status')).not.toBeInTheDocument();
  });

  it('shows an unknown knowledge-base metric while knowledge bases are unavailable', async () => {
    vi.mocked(listKnowledgeBases).mockRejectedValue(new Error('offline'));
    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent('知识库加载失败');
    expect(within(screen.getByText('知识库', { selector: '.stat-card > span' }).parentElement!).getByText('--')).toBeInTheDocument();
  });

  it('keeps knowledge bases usable when recent sessions fail and retries only sessions', async () => {
    const firstSessions = deferred<{ items: ChatSession[] }>();
    vi.mocked(listChatSessions)
      .mockReturnValueOnce(firstSessions.promise)
      .mockResolvedValueOnce({ items: [session] });
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByText('制度库')).toBeInTheDocument();
    await act(async () => {
      firstSessions.reject(new Error('offline'));
      await Promise.resolve();
    });

    const error = await screen.findByRole('alert');
    expect(error).toHaveTextContent('最近会话加载失败');
    expect(within(screen.getByRole('article', { name: '制度库' })).getByText('最近会话不可用')).toBeInTheDocument();
    expect(within(screen.getByRole('article', { name: '制度库' })).getByRole('link', { name: '新建对话' })).toHaveAttribute(
      'href',
      '/chat/new?knowledgeBaseId=kb1',
    );

    await user.click(within(error).getByRole('button', { name: '重试最近会话' }));
    await waitFor(() => expect(listChatSessions).toHaveBeenCalledTimes(2));
    expect(listKnowledgeBases).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole('link', { name: '请假制度' })).toBeInTheDocument();
    expect(screen.queryByText('最近会话不可用')).not.toBeInTheDocument();
  });

  it('ignores a stale session response after Strict Mode restarts the request', async () => {
    const first = deferred<{ items: ChatSession[] }>();
    const second = deferred<{ items: ChatSession[] }>();
    const latestSession = { ...session, id: 'session2', title: '最新会话' };
    vi.mocked(listChatSessions)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    render(
      <StrictMode>
        <ToastProvider>
          <MemoryRouter initialEntries={['/chat']}>
            <ChatLandingPage />
          </MemoryRouter>
        </ToastProvider>
      </StrictMode>,
    );

    await waitFor(() => expect(listChatSessions).toHaveBeenCalledTimes(2));
    await act(async () => second.resolve({ items: [latestSession] }));
    expect(await screen.findByRole('link', { name: '最新会话' })).toBeInTheDocument();

    await act(async () => first.resolve({ items: [session] }));
    expect(screen.getByRole('link', { name: '最新会话' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '请假制度' })).not.toBeInTheDocument();
  });
});
