import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getChatSession,
  getWorkspacePreference,
  listChatMessages,
  listChatSessions,
  listKnowledgeBaseCategories,
  listKnowledgeBases,
  sendChatMessageStream as sendChatMessage,
} from '../../api/resources';
import { renderWithRouter } from '../../test/render';
import type { ChatMessage, ChatSession, KnowledgeBase } from '../../types/api';
import { ChatPage } from './ChatPage';

vi.mock('../../api/resources', () => ({
  getCurrentUser: vi.fn().mockResolvedValue({ id: 'user1', username: 'fixture', displayName: '测试用户', role: 'user' }),
  archiveChatSession: vi.fn(),
  createChatSession: vi.fn(),
  deleteChatSession: vi.fn(),
  editChatMessage: vi.fn(),
  exportChatSession: vi.fn(),
  getChatSession: vi.fn(),
  getWorkspacePreference: vi.fn(),
  listChatMessages: vi.fn(),
  listChatSessions: vi.fn(),
  listKnowledgeBaseCategories: vi.fn(),
  listKnowledgeBases: vi.fn(),
  logout: vi.fn(),
  regenerateChatMessage: vi.fn(),
  setChatMessageFeedback: vi.fn(),
  sendChatMessageStream: vi.fn(),
  updateChatSessionTitle: vi.fn(),
}));

const knowledgeBase = {answerConfig: { systemPromptAddition: '', answerLanguage: 'auto' as const, allowGeneralKnowledge: false, model: '' },
  id: 'kb1',
  name: '制度库',
  description: '制度说明',
  visibility: 'private',
  retrievalConfig: {enableKeyword: true,  vectorTopN: 30, rerankTopK: 5, scoreThreshold: 0.3, enableRerank: true },
  createdAt: '2026-07-01T00:00:00Z',
  updatedAt: '2026-07-01T00:00:00Z',
} satisfies KnowledgeBase;

const session = {
  id: 's1',
  title: '新对话',
  knowledgeBaseId: 'kb1',
  archivedAt: null,
  createdAt: '2026-07-02T00:00:00Z',
  updatedAt: '2026-07-02T00:00:00Z',
} as unknown as ChatSession;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  // jsdom has no scrollTo, and ChatPage scrolls the thread on every message change.
  Element.prototype.scrollTo = vi.fn();
  vi.mocked(listKnowledgeBases).mockResolvedValue({ items: [knowledgeBase], total: 1, page: 1, pageSize: 50 });
  vi.mocked(listKnowledgeBaseCategories).mockResolvedValue({ items: [] });
  vi.mocked(listChatSessions).mockResolvedValue({ items: [session], total: 1, page: 1, pageSize: 50 });
  vi.mocked(getChatSession).mockResolvedValue(session);
  vi.mocked(listChatMessages).mockResolvedValue({ items: [] });
  vi.mocked(getWorkspacePreference).mockResolvedValue({ viewMode: 'table', scope: 'all', sort: 'updatedAt_desc', visibility: 'all', expandedCategoryIds: [] });
});

/**
 * The hook decides what to say; this checks the page actually says it. Both halves are
 * needed: a correct hook wired to nothing announces nothing, and the region has to be
 * in the tree before its text changes, which is a property of the page and not the hook.
 */
describe('ChatPage stream announcement', () => {
  async function startStream() {
    const stream = deferred<Awaited<ReturnType<typeof sendChatMessage>>>();
    let handlers: Parameters<typeof sendChatMessage>[2] | undefined;
    vi.mocked(sendChatMessage).mockImplementation((_sessionId, _input, nextHandlers, signal) => {
      handlers = nextHandlers;
      // Reject on abort, as a real aborted request does. Stopping only produces a
      // stopped stream once the request actually settles, so a mock that ignores the
      // signal leaves the page generating forever and the stop is never observable.
      signal?.addEventListener('abort', () => stream.reject(new DOMException('Aborted', 'AbortError')));
      return stream.promise;
    });
    const user = userEvent.setup();

    renderWithRouter(
      <Routes><Route path="/chat/:sessionId" element={<ChatPage />} /></Routes>,
      ['/chat/s1'],
    );
    await screen.findByText('新对话');
    await user.type(screen.getByRole('textbox', { name: '输入问题' }), '年假怎么算');
    await user.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(handlers).toBeTruthy());
    return { handlers: handlers!, stream };
  }

  function region() {
    return screen.getByRole('status');
  }

  it('has exactly one polite region for progress', async () => {
    renderWithRouter(
      <Routes><Route path="/chat/:sessionId" element={<ChatPage />} /></Routes>,
      ['/chat/s1'],
    );
    await screen.findByText('新对话');

    // getByRole throws when there is more than one, which is the assertion: two polite
    // regions racing over the same event is how a reader hears it twice, or neither.
    expect(region()).toHaveTextContent('');
  });

  it('is already in the tree before there is anything to announce', async () => {
    renderWithRouter(
      <Routes><Route path="/chat/:sessionId" element={<ChatPage />} /></Routes>,
      ['/chat/s1'],
    );

    // A region that appears together with its text is announced unreliably, so its
    // presence while idle is the property that matters, not its contents.
    expect(await screen.findByRole('status')).toBeInTheDocument();
  });

  it('announces retrieval, then generation, then completion', async () => {
    const { handlers, stream } = await startStream();

    await waitFor(() => expect(region()).toHaveTextContent('正在检索知识库…'));

    act(() => handlers.onDelta?.('每年五天'));
    await waitFor(() => expect(region()).toHaveTextContent('正在生成回答…'));

    // A real completion, not `undefined`: resolving with nothing makes the thread treat
    // the send as unconfirmed and mount a second status region for reconciliation, which
    // is a different behaviour than the one under test.
    const assistantMessage = {
      id: 'a1',
      sessionId: 's1',
      role: 'assistant',
      content: '每年五天',
      citations: [],
      feedback: null,
      createdAt: '2026-07-02T00:01:00Z',
    } as unknown as ChatMessage;
    const userMessage = { ...assistantMessage, id: 'u1', role: 'user', content: '年假怎么算' } as ChatMessage;
    vi.mocked(listChatMessages).mockResolvedValue({
      items: [userMessage, assistantMessage],
    });
    await act(async () => {
      stream.resolve({
        clientRequestId: 'req-1',
        userMessage,
        assistantMessage,
        answer: '每年五天',
        citations: [],
        rerankFallback: null,
      });
    });

    await waitFor(() => expect(region()).toHaveTextContent('回答完成'));
  });

  it('never announces the answer text itself', async () => {
    const { handlers } = await startStream();

    act(() => handlers.onDelta?.('年假按入职年限计算'));
    await waitFor(() => expect(region()).toHaveTextContent('正在生成回答…'));

    // The answer is already readable in the document; announcing tokens would talk over
    // the reader continuously.
    expect(region()).not.toHaveTextContent('年假按入职年限计算');
  });

  it('announces a stop from the one region, not from the stop notice too', async () => {
    const { handlers } = await startStream();
    act(() => handlers.onDelta?.('每年'));
    await waitFor(() => expect(region()).toHaveTextContent('正在生成回答…'));

    await userEvent.setup().click(screen.getByRole('button', { name: '停止生成' }));

    // The visible stop notice used to be a second polite region. Both would have fired
    // on the same event, so this asserts the count in the state where they overlapped --
    // the idle check above cannot see it, because the notice is not mounted then.
    await waitFor(() => expect(region()).toHaveTextContent('已停止生成'));
    expect(screen.getAllByRole('status')).toHaveLength(1);
  });

  it('treats citations arriving as the start of generation', async () => {
    const { handlers } = await startStream();

    act(() => handlers.onCitations?.([{
      documentId: 'doc-1',
      chunkId: 'chunk-1',
      filename: '制度.pdf',
      pageNumber: 2,
      content: '依据',
      vectorScore: 0.8,
      rerankScore: 0.9,
    }]));

    await waitFor(() => expect(region()).toHaveTextContent('正在生成回答…'));
  });
});
