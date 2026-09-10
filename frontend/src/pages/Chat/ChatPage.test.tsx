import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../api/client';
import {
  archiveChatSession,
  createChatSession,
  deleteChatSession,
  editChatMessage,
  getChatSession,
  getDocument,
  getDocumentPreview,
  getWorkspacePreference,
  listChatMessages,
  listChatSessions,
  listKnowledgeBaseCategories,
  listKnowledgeBases,
  regenerateChatMessage,
  setChatMessageFeedback,
  sendChatMessageStream as sendChatMessage,
  updateChatSessionTitle,
} from '../../api/resources';
import { renderWithRouter } from '../../test/render';
import type { ChatMessage, ChatSession, KnowledgeBase } from '../../types/api';
import { ChatPage } from './ChatPage';

vi.mock('../../api/resources', () => ({
  archiveChatSession: vi.fn(),
  createChatSession: vi.fn(),
  deleteChatSession: vi.fn(),
  editChatMessage: vi.fn(),
  exportChatSession: vi.fn(),
  getChatSession: vi.fn(),
  getDocument: vi.fn(),
  getDocumentPreview: vi.fn(),
  downloadDocument: vi.fn(),
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
vi.mock('../../utils/download', () => ({ downloadBlob: vi.fn() }));

const knowledgeBase = {
  id: 'kb1',
  name: '制度库',
  description: '制度说明',
  visibility: 'private',
  retrievalConfig: { vectorTopN: 30, rerankTopK: 5, scoreThreshold: 0.3, enableRerank: true },
  createdAt: '2026-07-01T00:00:00Z',
  updatedAt: '2026-07-01T00:00:00Z',
} satisfies KnowledgeBase;

const secondKnowledgeBase = {
  ...knowledgeBase,
  id: 'kb2',
  name: '产品库',
} satisfies KnowledgeBase;

const session = {
  id: 's1',
  knowledgeBaseId: knowledgeBase.id,
  title: '制度问答',
  createdAt: '2026-07-01T00:00:00Z',
  updatedAt: '2026-07-01T00:00:00Z',
  archivedAt: null,
} satisfies ChatSession;

const secondSession = {
  ...session,
  id: 's2',
  knowledgeBaseId: secondKnowledgeBase.id,
  title: '产品问答',
} satisfies ChatSession;

const secondSessionMessage = {
  id: 'm2',
  sessionId: secondSession.id,
  role: 'assistant',
  content: '产品会话回答',
  citations: [],
  createdAt: '2026-07-01T00:02:00Z',
} satisfies ChatMessage;

const firstSessionLateMessage = {
  id: 'm1',
  sessionId: session.id,
  role: 'assistant',
  content: '制度会话迟到回答',
  citations: [],
  createdAt: '2026-07-01T00:03:00Z',
} satisfies ChatMessage;

const historicalAnswers = [
  {
    id: 'assistant-old',
    sessionId: session.id,
    role: 'assistant',
    content: '旧回答',
    citations: [{
      documentId: 'doc-old',
      chunkId: 'chunk-old',
      filename: '旧制度.pdf',
      pageNumber: 2,
      content: '旧制度依据',
      vectorScore: 0.82,
      rerankScore: 0.91,
    }],
    createdAt: '2026-07-01T00:01:00Z',
  },
  {
    id: 'assistant-new',
    sessionId: session.id,
    role: 'assistant',
    content: '新回答',
    citations: [{
      documentId: 'doc-new',
      chunkId: 'chunk-new',
      filename: '新制度.pdf',
      pageNumber: 5,
      content: '新制度依据',
      vectorScore: 0.87,
      rerankScore: 0.95,
    }],
    createdAt: '2026-07-01T00:02:00Z',
  },
] satisfies ChatMessage[];

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
	window.localStorage.removeItem('rag.chat.pending-request:s1');
	window.localStorage.removeItem('rag.chat.pending-request:s2');
	window.localStorage.removeItem('rag.chat.pending-regeneration:s1');
	window.localStorage.removeItem('rag.chat.pending-regeneration:s2');
  Element.prototype.scrollTo = vi.fn();
  vi.mocked(listChatSessions).mockReset().mockResolvedValue({ items: [session] });
  vi.mocked(listKnowledgeBases).mockReset().mockResolvedValue({ items: [knowledgeBase] });
  vi.mocked(listKnowledgeBaseCategories).mockReset().mockResolvedValue({ items: [] });
  vi.mocked(getWorkspacePreference).mockReset().mockResolvedValue({
    viewMode: 'table', scope: 'all', sort: 'updatedAt_desc', visibility: 'all', expandedCategoryIds: [],
  });
  vi.mocked(getChatSession).mockReset().mockResolvedValue(session);
  vi.mocked(getDocument).mockReset().mockImplementation(async (id) => ({ id, knowledgeBaseId: 'kb1', filename: '新制度.pdf', fileType: 'pdf', fileSize: 1024, status: 'completed', errorMessage: null, createdAt: '', updatedAt: '' }));
  vi.mocked(getDocumentPreview).mockReset().mockResolvedValue({ id: 'doc-new', filename: '新制度.pdf', kind: 'text', fileType: 'pdf', contentType: 'text/plain', content: '新制度依据的完整原文', downloadUrl: '' });
  vi.mocked(listChatMessages).mockReset().mockResolvedValue({ items: [] });
  vi.mocked(sendChatMessage).mockReset();
  vi.mocked(archiveChatSession).mockReset();
  vi.mocked(createChatSession).mockReset();
  vi.mocked(deleteChatSession).mockReset();
  vi.mocked(editChatMessage).mockReset();
  vi.mocked(regenerateChatMessage).mockReset();
  vi.mocked(setChatMessageFeedback).mockReset();
  vi.mocked(updateChatSessionTitle).mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

function LocationProbe() {
  const location = useLocation();
  return <output aria-label="当前位置">{location.pathname}{location.search}</output>;
}

function LeaveChatButton() {
  const navigate = useNavigate();
  return <button type="button" onClick={() => navigate('/away')}>离开聊天</button>;
}

function ChatRouteControls() {
  const navigate = useNavigate();
  return (
    <>
      <button type="button" onClick={() => navigate('/chat/s2')}>强制切换产品会话</button>
      <button type="button" onClick={() => navigate('/chat/s1')}>强制切换制度会话</button>
    </>
  );
}

async function findSessionTitle(title: string) {
  return screen.findByText(title, { selector: '.ui-inline-edit__text' });
}

async function startSessionTitleEdit(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: '重命名会话' }));
  return screen.getByRole('textbox', { name: '重命名会话' });
}

async function openSessionActions(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: '会话操作' }));
  return screen.getByRole('menu', { name: '会话操作' });
}

async function clickSessionAction(user: ReturnType<typeof userEvent.setup>, action: string) {
  const menu = await openSessionActions(user);
  await user.click(within(menu).getByRole('menuitem', { name: action }));
}

async function finishAutomaticSendChecks() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000);
  });
  vi.useRealTimers();
}

async function submitWithAutomaticChecksPaused() {
  vi.useFakeTimers();
  fireEvent.click(screen.getByRole('button', { name: '发送' }));
  await vi.waitFor(() => {
    expect(screen.getByText('正在确认这条消息…')).toBeInTheDocument();
  }, {
    interval: 10,
    // The full suite runs many jsdom workers concurrently on Windows; keep the
    // assertion strict while allowing React enough wall-clock time to commit.
    timeout: 3_000,
  });
}

describe('ChatPage', () => {
  it('finds literal text across messages, cycles results and preserves the question draft', async () => {
    const user = userEvent.setup();
    vi.mocked(listChatMessages).mockResolvedValue({ items: [
      { ...historicalAnswers[0], id: 'question', role: 'user', content: '怎么使用 A+B？', citations: [] },
      { ...historicalAnswers[1], content: '示例：`a+b`。', citations: [] },
    ] });
    renderWithRouter(<Routes><Route path="/chat/:sessionId" element={<ChatPage />} /></Routes>, ['/chat/s1']);
    await screen.findByText('怎么使用 A+B？');
    const composer = screen.getByRole('textbox', { name: '输入问题' });
    await user.type(composer, '保留这个追问');
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true });
    const input = screen.getByRole('textbox', { name: '查找消息关键词' });
    expect(input).toHaveFocus();
    await user.type(input, 'a+b');
    expect(screen.getByText('1 / 2 条匹配消息')).toBeInTheDocument();
    expect(screen.getByRole('article', { name: '已定位消息' })).toHaveAttribute('id', 'chat-message-question');
    await user.keyboard('{Enter}');
    expect(screen.getByText('2 / 2 条匹配消息')).toBeInTheDocument();
    expect(screen.getByRole('article', { name: '已定位消息' })).toHaveAttribute('id', 'chat-message-assistant-new');
    await user.click(screen.getByRole('button', { name: '下一条匹配消息' }));
    expect(screen.getByText('1 / 2 条匹配消息')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '上一条匹配消息' }));
    expect(screen.getByText('2 / 2 条匹配消息')).toBeInTheDocument();
    await user.click(input);
    await user.clear(input);
    await user.type(input, '不存在');
    expect(screen.getByText('没有匹配消息')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '下一条匹配消息' })).toBeDisabled();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('region', { name: '会话内查找' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '查找会话消息' })).toHaveFocus();
    expect(composer).toHaveValue('保留这个追问');
  });

  it('waits for the thread before locating a deep-linked message instead of scrolling to the end', async () => {
    const pending = deferred<{ items: ChatMessage[] }>();
    vi.mocked(listChatMessages).mockReturnValue(pending.promise);
    renderWithRouter(<><Routes><Route path="/chat/:sessionId" element={<ChatPage />} /></Routes><LocationProbe /></>, ['/chat/s1?messageId=assistant-old']);
    expect(screen.queryByText('指定消息已不存在或不属于当前会话。')).not.toBeInTheDocument();
    await act(async () => pending.resolve({ items: historicalAnswers }));
    const located = await screen.findByRole('article', { name: '已定位消息' });
    expect(located).toHaveAttribute('id', 'chat-message-assistant-old');
    expect(located).toHaveFocus();
    expect(Element.prototype.scrollTo).toHaveBeenLastCalledWith(expect.objectContaining({ behavior: 'instant' }));
    expect(screen.getByLabelText('当前位置')).toHaveTextContent('messageId=assistant-old');
    await userEvent.setup().click(screen.getByRole('button', { name: '取消定位' }));
    expect(screen.queryByRole('article', { name: '已定位消息' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('当前位置')).not.toHaveTextContent('messageId=');
  });

  it('reports a missing target without fetching messages outside the current session', async () => {
    vi.mocked(listChatMessages).mockResolvedValue({ items: historicalAnswers });
    renderWithRouter(<Routes><Route path="/chat/:sessionId" element={<ChatPage />} /></Routes>, ['/chat/s1?messageId=other-session-message']);
    expect(await screen.findByText('指定消息已不存在或不属于当前会话。')).toBeInTheDocument();
    expect(screen.queryByRole('article', { name: '已定位消息' })).not.toBeInTheDocument();
    expect(listChatMessages).toHaveBeenCalledTimes(1);
    expect(listChatMessages).toHaveBeenCalledWith('s1');
  });

  it('clears conversation search when navigating to another session', async () => {
    const user = userEvent.setup();
    vi.mocked(getChatSession).mockImplementation(async (id) => id === 's1' ? session : secondSession);
    vi.mocked(listChatMessages).mockImplementation(async (id) => ({ items: id === 's1' ? historicalAnswers : [secondSessionMessage] }));
    renderWithRouter(<><Routes><Route path="/chat/:sessionId" element={<ChatPage />} /></Routes><ChatRouteControls /></>, ['/chat/s1']);
    await screen.findByText('旧回答');
    await user.click(screen.getByRole('button', { name: '查找会话消息' }));
    await user.type(screen.getByRole('textbox', { name: '查找消息关键词' }), '回答');
    await user.click(screen.getByRole('button', { name: '强制切换产品会话' }));
    await screen.findByText('产品会话回答');
    expect(screen.queryByRole('region', { name: '会话内查找' })).not.toBeInTheDocument();
    expect(screen.queryByRole('article', { name: '已定位消息' })).not.toBeInTheDocument();
  });

  it('locks other chat writes while an edited message is being saved', async () => {
    const editResult = deferred<{
      clientRequestId: string;
      userMessage: ChatMessage;
      assistantMessage: ChatMessage;
      answer: string;
      citations: [];
      rerankFallback: null;
    }>();
    const userMessage = {
      id: 'user-1',
      sessionId: session.id,
      role: 'user',
      content: '原问题',
      citations: [],
      createdAt: '2026-07-01T00:00:00Z',
    } satisfies ChatMessage;
    const assistantMessage = {
      id: 'assistant-1',
      sessionId: session.id,
      role: 'assistant',
      content: '原回答',
      citations: [],
      createdAt: '2026-07-01T00:01:00Z',
    } satisfies ChatMessage;
    vi.mocked(listChatMessages).mockResolvedValue({ items: [userMessage, assistantMessage] });
    vi.mocked(editChatMessage).mockReturnValue(editResult.promise);
    const user = userEvent.setup();

    renderWithRouter(
      <Routes><Route path="/chat/:sessionId" element={<ChatPage />} /></Routes>,
      ['/chat/s1'],
    );

    const composer = await screen.findByRole('textbox', { name: '输入问题' });
    await user.type(composer, '不能并发发送');
    await user.click(screen.getByRole('button', { name: '编辑消息' }));
    const editInput = screen.getByRole('textbox', { name: '编辑消息' });
    await user.clear(editInput);
    await user.type(editInput, '修改后的问题');
    await user.click(screen.getByRole('button', { name: '保存并重新生成' }));

    expect(editChatMessage).toHaveBeenCalledOnce();
    expect(composer).toBeDisabled();
    expect(screen.queryByRole('button', { name: '重新生成' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '编辑消息' })).not.toBeInTheDocument();
    fireEvent.submit(composer.closest('form')!);
    expect(sendChatMessage).not.toHaveBeenCalled();

    editResult.resolve({
      clientRequestId: 'edit-request',
      userMessage: { ...userMessage, content: '修改后的问题', clientRequestId: 'edit-request' },
      assistantMessage: {
        ...assistantMessage,
        id: 'assistant-edited',
        content: '修改后的回答',
        clientRequestId: 'edit-request',
      },
      answer: '修改后的回答',
      citations: [],
      rerankFallback: null,
    });

    expect(await screen.findByText('修改后的回答')).toBeInTheDocument();
    await waitFor(() => expect(composer).toBeEnabled());
  });

  it('does not load knowledge-base category workspace data', async () => {
    renderWithRouter(
      <Routes>
        <Route path="/chat/:sessionId" element={<ChatPage />} />
      </Routes>,
      ['/chat/s1'],
    );
    await findSessionTitle('制度问答');

    expect(listKnowledgeBaseCategories).not.toHaveBeenCalled();
    expect(getWorkspacePreference).not.toHaveBeenCalled();
  });

  it('retries a failed routed-session message load in place', async () => {
    vi.mocked(listChatMessages)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ items: historicalAnswers });
    const user = userEvent.setup();
    renderWithRouter(
      <Routes>
        <Route path="/chat/:sessionId" element={<ChatPage />} />
      </Routes>,
      ['/chat/s1'],
    );

    const errorText = await screen.findByText('消息加载失败');
    const status = errorText.closest('[role="status"]');
    expect(status).not.toBeNull();
    expect(screen.queryByText('选择一个知识库开始提问')).not.toBeInTheDocument();
    expect(screen.queryByText('当前知识库中未找到足够依据。')).not.toBeInTheDocument();
    await user.click(within(status!).getByRole('button', { name: '重试' }));

    await waitFor(() => expect(listChatMessages).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('新回答')).toBeInTheDocument();
  });

  it('keeps knowledge bases usable when the initial session list fails and retries only sessions', async () => {
    vi.mocked(listChatSessions)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ items: [session] });
    const user = userEvent.setup();
    renderWithRouter(
      <Routes>
        <Route path="/chat/:sessionId" element={<ChatPage />} />
      </Routes>,
      ['/chat/s1'],
    );

    expect(await screen.findByLabelText('当前知识库')).toHaveValue(knowledgeBase.id);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('会话列表加载失败');
    expect(screen.queryByText('当前知识库暂无会话。')).not.toBeInTheDocument();

    const sessionCallsBeforeRetry = vi.mocked(listChatSessions).mock.calls.length;
    const knowledgeBaseCallsBeforeRetry = vi.mocked(listKnowledgeBases).mock.calls.length;
    await user.click(within(alert).getByRole('button', { name: '重试' }));
    await waitFor(() => expect(vi.mocked(listChatSessions).mock.calls.length).toBeGreaterThan(sessionCallsBeforeRetry));
    expect(listKnowledgeBases).toHaveBeenCalledTimes(knowledgeBaseCallsBeforeRetry);
    expect(await screen.findByRole('link', { name: /制度问答/ })).toBeInTheDocument();
  });

  it('keeps sessions usable when the initial knowledge-base list fails and retries only knowledge bases', async () => {
    vi.mocked(listKnowledgeBases)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ items: [knowledgeBase] });
    const user = userEvent.setup();
    renderWithRouter(
      <Routes>
        <Route path="/chat/:sessionId" element={<ChatPage />} />
      </Routes>,
      ['/chat/s1'],
    );

    expect(await screen.findByRole('link', { name: /制度问答/ })).toBeInTheDocument();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('知识库列表加载失败');

    await waitFor(() => expect(listChatSessions).toHaveBeenLastCalledWith(expect.objectContaining({
      knowledgeBaseId: knowledgeBase.id,
    })));
    const sessionCallsBeforeRetry = vi.mocked(listChatSessions).mock.calls.length;
    await user.click(within(alert).getByRole('button', { name: '重试' }));
    await waitFor(() => expect(listKnowledgeBases).toHaveBeenCalledTimes(2));
    expect(listChatSessions).toHaveBeenCalledTimes(sessionCallsBeforeRetry);
    expect(await screen.findByLabelText('当前知识库')).toHaveValue(knowledgeBase.id);
  });

  it('switches the session rail to archived when opening an archived deep link', async () => {
    const archivedSession = { ...session, archivedAt: '2026-07-01T01:00:00Z' };
    vi.mocked(getChatSession).mockResolvedValue(archivedSession);
    vi.mocked(listChatSessions).mockResolvedValue({
      items: [archivedSession],
      total: 1,
      page: 1,
      pageSize: 50,
    });

    renderWithRouter(
      <Routes><Route path="/chat/:sessionId" element={<ChatPage />} /></Routes>,
      ['/chat/s1'],
    );

    await waitFor(() => expect(screen.getByRole('button', { name: '已归档' })).toHaveAttribute('aria-pressed', 'true'));
    // Any call, not the last one. The tab state above is what pins down where the rail
    // ended up; asserting on the *latest* call additionally requires that no unrelated
    // refresh lands afterwards, which is a race that has been seen to fail under load.
    expect(vi.mocked(listChatSessions).mock.calls.some(
      ([params]) => params?.archived === true,
    )).toBe(true);
  });

  it('does not refresh chat state after an in-flight send outlives the page', async () => {
    const sendResult = deferred<{ answer: string; citations: []; rerankFallback: null }>();
    vi.mocked(sendChatMessage).mockReturnValue(sendResult.promise);
    const user = userEvent.setup();
    renderWithRouter(
      <>
        <Routes>
          <Route path="/chat/:sessionId" element={<ChatPage />} />
          <Route path="/away" element={<div>已离开聊天</div>} />
        </Routes>
        <LeaveChatButton />
      </>,
      ['/chat/s1'],
    );

    const input = await screen.findByRole('textbox', { name: '输入问题' });
    await user.type(input, '离开前的问题');
    await user.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(sendChatMessage).toHaveBeenCalledOnce());
    await user.click(screen.getByRole('button', { name: '离开聊天' }));
    expect(await screen.findByText('已离开聊天')).toBeInTheDocument();

    await act(async () => {
      sendResult.resolve({ answer: '迟到回答', citations: [], rerankFallback: null });
      await Promise.resolve();
    });
    expect(listChatMessages).toHaveBeenCalledTimes(1);
  });

  it('does not let a late title response replace the session selected afterward', async () => {
    const titleResult = deferred<ChatSession>();
    const sameKnowledgeBaseSecondSession = {
      ...secondSession,
      knowledgeBaseId: knowledgeBase.id,
    };
    vi.mocked(updateChatSessionTitle).mockReturnValue(titleResult.promise);
    vi.mocked(listChatSessions).mockResolvedValue({ items: [session, sameKnowledgeBaseSecondSession] });
    vi.mocked(listKnowledgeBases).mockResolvedValue({ items: [knowledgeBase] });
    vi.mocked(getChatSession).mockImplementation((id) => Promise.resolve(
      id === sameKnowledgeBaseSecondSession.id ? sameKnowledgeBaseSecondSession : session,
    ));
    const user = userEvent.setup();
    renderWithRouter(
      <>
        <Routes>
          <Route path="/chat/:sessionId" element={<ChatPage />} />
        </Routes>
        <ChatRouteControls />
      </>,
      ['/chat/s1'],
    );

    const titleInput = await startSessionTitleEdit(user);
    await user.clear(titleInput);
    await user.type(titleInput, '迟到标题');
    await user.click(screen.getByRole('button', { name: '保存' }));
    await user.click(screen.getByRole('button', { name: '强制切换产品会话' }));
    await findSessionTitle('产品问答');

    titleResult.resolve({ ...session, title: '迟到标题' });
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole('link', { name: /迟到标题/ })).toBeInTheDocument();
    expect(screen.getByText('产品问答', { selector: '.ui-inline-edit__text' })).toBeInTheDocument();
  });

  it('announces the primary message loading state once without duplicating the rail skeleton', async () => {
    vi.mocked(listChatSessions).mockReturnValue(deferred<Awaited<ReturnType<typeof listChatSessions>>>().promise);
    vi.mocked(listChatMessages).mockReturnValue(deferred<Awaited<ReturnType<typeof listChatMessages>>>().promise);
    renderWithRouter(
      <Routes>
        <Route path="/chat/:sessionId" element={<ChatPage />} />
      </Routes>,
      ['/chat/s1'],
    );

    await waitFor(() => expect(screen.getByRole('status', { name: '正在加载' })).toBeInTheDocument());
    expect(screen.getAllByRole('status', { name: '正在加载' })).toHaveLength(1);
    expect(screen.queryByRole('status', { name: '正在加载会话' })).not.toBeInTheDocument();
  });

  it('exposes exactly one current session to assistive technology', async () => {
    vi.mocked(listChatSessions).mockResolvedValue({
      items: [session, { ...secondSession, knowledgeBaseId: knowledgeBase.id }],
    });
    renderWithRouter(
      <Routes>
        <Route path="/chat/:sessionId" element={<ChatPage />} />
      </Routes>,
      ['/chat/s1'],
    );

    const currentLink = await screen.findByRole('link', { name: /制度问答/ });
    const otherLink = screen.getByRole('link', { name: /产品问答/ });
    expect(currentLink).toHaveAttribute('aria-current', 'page');
    expect(otherLink).not.toHaveAttribute('aria-current');
  });

  it('keeps a failed archive error inside the confirmation dialog', async () => {
    vi.mocked(archiveChatSession).mockRejectedValue(
      new ApiError(500, { code: 'ARCHIVE_FAILED', message: '暂时无法归档会话' }),
    );
    const user = userEvent.setup();
    renderWithRouter(
      <Routes>
        <Route path="/chat/:sessionId" element={<ChatPage />} />
      </Routes>,
      ['/chat/s1'],
    );

    await findSessionTitle('制度问答');
    await clickSessionAction(user, '归档会话');
    const dialog = screen.getByRole('dialog', { name: '归档会话' });
    await user.click(within(dialog).getByRole('button', { name: '归档' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('暂时无法归档会话');
    expect(within(dialog).getByRole('button', { name: '归档' })).toBeEnabled();
    expect(screen.getByRole('dialog', { name: '归档会话' })).toBeInTheDocument();
  });

  it('commits a successful archive without depending on a follow-up session refresh', async () => {
    vi.mocked(archiveChatSession).mockResolvedValue({
      ...session,
      archivedAt: '2026-07-01T01:00:00Z',
    });
    vi.mocked(listChatSessions)
      .mockResolvedValueOnce({ items: [session] })
      .mockRejectedValueOnce(new Error('offline'));
    const user = userEvent.setup();
    renderWithRouter(
      <Routes>
        <Route path="/chat/:sessionId" element={<ChatPage />} />
      </Routes>,
      ['/chat/s1'],
    );

    await findSessionTitle('制度问答');
    await waitFor(() => expect(listChatSessions).toHaveBeenLastCalledWith(expect.objectContaining({
      knowledgeBaseId: knowledgeBase.id,
    })));
    const sessionCallsBeforeArchive = vi.mocked(listChatSessions).mock.calls.length;
    await clickSessionAction(user, '归档会话');
    await user.click(within(screen.getByRole('dialog', { name: '归档会话' })).getByRole('button', { name: '归档' }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: '归档会话' })).not.toBeInTheDocument());
    expect(screen.getByText(/已归档/, { selector: '.ui-badge' })).toBeInTheDocument();
    expect(listChatSessions).toHaveBeenCalledTimes(sessionCallsBeforeArchive);
  });

  it('does not let a pre-archive session-list response reinsert the archived session', async () => {
    const initialSessions = deferred<{ items: ChatSession[] }>();
    vi.mocked(listChatSessions).mockReturnValue(initialSessions.promise);
    vi.mocked(archiveChatSession).mockResolvedValue({
      ...session,
      archivedAt: '2026-07-01T01:00:00Z',
    });
    const user = userEvent.setup();
    renderWithRouter(
      <Routes>
        <Route path="/chat/:sessionId" element={<ChatPage />} />
      </Routes>,
      ['/chat/s1'],
    );

    await findSessionTitle('制度问答');
    await clickSessionAction(user, '归档会话');
    await user.click(within(screen.getByRole('dialog', { name: '归档会话' })).getByRole('button', { name: '归档' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '归档会话' })).not.toBeInTheDocument());

    await act(async () => {
      initialSessions.resolve({ items: [session] });
      await Promise.resolve();
    });
    expect(screen.queryByRole('link', { name: /制度问答/ })).not.toBeInTheDocument();
  });

  it('does not let a late archive response replace the session selected afterward', async () => {
    const archiveResult = deferred<ChatSession>();
    vi.mocked(archiveChatSession).mockReturnValue(archiveResult.promise);
    vi.mocked(listChatSessions).mockResolvedValue({ items: [session, secondSession] });
    vi.mocked(listKnowledgeBases).mockResolvedValue({ items: [knowledgeBase, secondKnowledgeBase] });
    vi.mocked(getChatSession).mockImplementation((id) => Promise.resolve(
      id === secondSession.id ? secondSession : session,
    ));
    const user = userEvent.setup();

    renderWithRouter(
      <>
        <Routes>
          <Route path="/chat/:sessionId" element={<ChatPage />} />
        </Routes>
        <ChatRouteControls />
      </>,
      ['/chat/s1'],
    );

    await findSessionTitle('制度问答');
    await clickSessionAction(user, '归档会话');
    await user.click(within(screen.getByRole('dialog', { name: '归档会话' })).getByRole('button', { name: '归档' }));
    fireEvent.click(screen.getByText('强制切换产品会话'));
    await findSessionTitle('产品问答');

    archiveResult.resolve({ ...session, archivedAt: '2026-07-01T01:00:00Z' });

    await waitFor(() => expect(archiveChatSession).toHaveBeenCalledWith(session.id));
    await waitFor(() => expect(screen.getByRole('button', { name: '会话操作' })).toBeEnabled());
    expect(screen.getByText('产品问答', { selector: '.ui-inline-edit__text' })).toBeInTheDocument();
  });

  it('does not navigate away when a deleted session is no longer active', async () => {
    const deleteResult = deferred<void>();
    vi.mocked(deleteChatSession).mockReturnValue(deleteResult.promise);
    vi.mocked(listChatSessions).mockResolvedValue({ items: [session, secondSession] });
    vi.mocked(listKnowledgeBases).mockResolvedValue({ items: [knowledgeBase, secondKnowledgeBase] });
    vi.mocked(getChatSession).mockImplementation((id) => Promise.resolve(
      id === secondSession.id ? secondSession : session,
    ));
    const user = userEvent.setup();

    renderWithRouter(
      <>
        <Routes>
          <Route path="/chat/:sessionId" element={<ChatPage />} />
        </Routes>
        <LocationProbe />
        <ChatRouteControls />
      </>,
      ['/chat/s1'],
    );

    await findSessionTitle('制度问答');
    await clickSessionAction(user, '删除会话');
    await user.click(within(screen.getByRole('dialog', { name: '删除会话' })).getByRole('button', { name: '删除' }));
    fireEvent.click(screen.getByText('强制切换产品会话'));
    await findSessionTitle('产品问答');
    const sessionCallsBeforeDeleteResolution = vi.mocked(listChatSessions).mock.calls.length;

    deleteResult.resolve();

    await waitFor(() => expect(deleteChatSession).toHaveBeenCalledWith(session.id));
    expect(listChatSessions).toHaveBeenCalledTimes(sessionCallsBeforeDeleteResolution);
    expect(screen.getByRole('status', { name: '当前位置' })).toHaveTextContent('/chat/s2');
  });

  it('keeps a failed delete error inside the confirmation dialog', async () => {
    vi.mocked(deleteChatSession).mockRejectedValue(
      new ApiError(500, { code: 'DELETE_FAILED', message: '暂时无法删除会话' }),
    );
    const user = userEvent.setup();
    renderWithRouter(
      <Routes>
        <Route path="/chat/:sessionId" element={<ChatPage />} />
      </Routes>,
      ['/chat/s1'],
    );

    await findSessionTitle('制度问答');
    await clickSessionAction(user, '删除会话');
    const dialog = screen.getByRole('dialog', { name: '删除会话' });
    await user.click(within(dialog).getByRole('button', { name: '删除' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('暂时无法删除会话');
    expect(within(dialog).getByRole('button', { name: '删除' })).toBeEnabled();
    expect(screen.getByRole('dialog', { name: '删除会话' })).toBeInTheDocument();
  });

  it('navigates away after a successful delete without depending on a follow-up session refresh', async () => {
    vi.mocked(deleteChatSession).mockResolvedValue(undefined);
    vi.mocked(listChatSessions)
      .mockResolvedValueOnce({ items: [session] })
      .mockRejectedValueOnce(new Error('offline'));
    const user = userEvent.setup();
    renderWithRouter(
      <>
        <Routes>
          <Route path="/chat/:sessionId" element={<ChatPage />} />
          <Route path="/chat" element={<div>聊天首页</div>} />
        </Routes>
        <LocationProbe />
      </>,
      ['/chat/s1'],
    );

    await findSessionTitle('制度问答');
    await waitFor(() => expect(listChatSessions).toHaveBeenLastCalledWith(expect.objectContaining({
      knowledgeBaseId: knowledgeBase.id,
    })));
    const sessionCallsBeforeDelete = vi.mocked(listChatSessions).mock.calls.length;
    await clickSessionAction(user, '删除会话');
    await user.click(within(screen.getByRole('dialog', { name: '删除会话' })).getByRole('button', { name: '删除' }));

    await waitFor(() => expect(screen.getByRole('status', { name: '当前位置' })).toHaveTextContent('/chat'));
    expect(listChatSessions).toHaveBeenCalledTimes(sessionCallsBeforeDelete);
  });

  it('lets the user inspect citations from any historical assistant answer', async () => {
    vi.mocked(listChatMessages).mockResolvedValue({ items: historicalAnswers });
    const user = userEvent.setup();

    renderWithRouter(
      <Routes>
        <Route path="/chat/:sessionId" element={<ChatPage />} />
      </Routes>,
      ['/chat/s1'],
    );

    const newAnswer = (await screen.findByText('新回答')).closest('article');
    const oldAnswer = screen.getByText('旧回答').closest('article');
    expect(newAnswer).not.toBeNull();
    expect(oldAnswer).not.toBeNull();

    await user.click(within(oldAnswer!).getByRole('button', { name: '1 条来源' }));
    expect(within(oldAnswer!).getByText('旧制度.pdf')).toBeInTheDocument();
    expect(within(newAnswer!).queryByText('新制度.pdf')).not.toBeInTheDocument();

    await user.click(within(newAnswer!).getByRole('button', { name: '1 条来源' }));
    expect(within(newAnswer!).getByText('新制度.pdf')).toBeInTheDocument();
  });

  it('saves feedback for different answers independently', async () => {
    vi.mocked(listChatMessages).mockResolvedValue({ items: historicalAnswers });
    const first = deferred<Awaited<ReturnType<typeof setChatMessageFeedback>>>();
    const second = deferred<Awaited<ReturnType<typeof setChatMessageFeedback>>>();
    vi.mocked(setChatMessageFeedback)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const user = userEvent.setup();

    renderWithRouter(
      <Routes>
        <Route path="/chat/:sessionId" element={<ChatPage />} />
      </Routes>,
      ['/chat/s1'],
    );

    const answers = await screen.findAllByRole('article');
    const oldAnswer = answers.find((item) => within(item).queryByText('旧回答'));
    const newAnswer = answers.find((item) => within(item).queryByText('新回答'));
    expect(oldAnswer).toBeTruthy();
    expect(newAnswer).toBeTruthy();

    await user.click(within(oldAnswer!).getByRole('button', { name: '标记回答有帮助' }));
    await user.click(within(newAnswer!).getByRole('button', { name: '标记回答没有帮助' }));
    await user.selectOptions(screen.getByRole('combobox', { name: '差评原因' }), 'missing_evidence');
    await user.click(screen.getByRole('button', { name: '保存反馈' }));

    expect(setChatMessageFeedback).toHaveBeenCalledTimes(2);
    expect(setChatMessageFeedback).toHaveBeenCalledWith(historicalAnswers[1].id, 'negative', { reason: 'missing_evidence', comment: '' });
    first.resolve({ messageId: historicalAnswers[0].id, rating: 'positive', updatedAt: '2026-08-17T00:00:00Z' });
    second.resolve({ messageId: historicalAnswers[1].id, rating: 'negative', updatedAt: '2026-08-17T00:00:01Z' });
  });

  it('does not force the message list to the bottom while the user reads history', async () => {
    vi.mocked(listChatMessages).mockResolvedValue({ items: historicalAnswers });
    const stream = deferred<Awaited<ReturnType<typeof sendChatMessage>>>();
    let handlers: { onDelta?: (text: string) => void } | undefined;
    vi.mocked(sendChatMessage).mockImplementation((_sessionId, _input, nextHandlers) => {
      handlers = nextHandlers;
      return stream.promise;
    });
    const user = userEvent.setup();

    renderWithRouter(
      <Routes>
        <Route path="/chat/:sessionId" element={<ChatPage />} />
      </Routes>,
      ['/chat/s1'],
    );
    const thread = (await screen.findByText('新回答')).closest('.chat-thread') as HTMLDivElement;
    Object.defineProperties(thread, {
      clientHeight: { configurable: true, value: 200 },
      scrollHeight: { configurable: true, value: 1000 },
      scrollTop: { configurable: true, value: 0, writable: true },
    });
    fireEvent.scroll(thread);
    vi.mocked(Element.prototype.scrollTo).mockClear();

    await user.type(screen.getByRole('textbox', { name: '输入问题' }), '继续追问');
    await user.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(handlers).toBeTruthy());
    act(() => handlers?.onDelta?.('第一段'));

    expect(Element.prototype.scrollTo).not.toHaveBeenCalled();
  });

  it('shows streaming citations before the assistant answer is complete', async () => {
    const stream = deferred<Awaited<ReturnType<typeof sendChatMessage>>>();
    let handlers: { onCitations?: (citations: ChatMessage['citations']) => void } | undefined;
    vi.mocked(sendChatMessage).mockImplementation((_sessionId, _input, nextHandlers) => {
      handlers = nextHandlers;
      return stream.promise;
    });
    const user = userEvent.setup();

    renderWithRouter(
      <Routes><Route path="/chat/:sessionId" element={<ChatPage />} /></Routes>,
      ['/chat/s1'],
    );
    await screen.findByText('新对话');
    await user.type(screen.getByRole('textbox', { name: '输入问题' }), '继续追问');
    await user.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(handlers).toBeTruthy());
    act(() => handlers?.onCitations?.([{
      documentId: 'doc-stream',
      chunkId: 'chunk-stream',
      filename: '流式来源.pdf',
      pageNumber: 3,
      content: '流式依据',
      vectorScore: 0.8,
      rerankScore: 0.9,
    }]));

    expect(await screen.findByText('流式来源.pdf')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '打开来源：流式来源.pdf，p.3' }));
    expect(await screen.findByRole('complementary', { name: '原文预览' })).toBeInTheDocument();
    expect(getDocument).toHaveBeenCalledWith('doc-stream');
    expect(screen.getByRole('button', { name: '停止生成' })).toBeEnabled();
  });

  it('loads more sessions after the first page', async () => {
    const firstPage = Array.from({ length: 50 }, (_, index) => ({ ...session, id: `s-${index}` }));
    const nextPage = { ...session, id: 's-50', title: '第 51 个会话' };
    vi.mocked(listChatSessions)
      .mockResolvedValueOnce({ items: firstPage, total: 51, page: 1, pageSize: 50 })
      .mockResolvedValueOnce({ items: [nextPage], total: 51, page: 2, pageSize: 50 });

    renderWithRouter(
      <Routes><Route path="/chat" element={<ChatPage />} /></Routes>,
      ['/chat'],
    );

    const loadMore = await screen.findByRole('button', { name: '加载更多会话' });
    await userEvent.setup().click(loadMore);
    await waitFor(() => expect(screen.getByText('第 51 个会话')).toBeInTheDocument());
    expect(vi.mocked(listChatSessions)).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2, pageSize: 50 }));
  });

  it('opens a source alongside the chat, preserves the draft and restores focus on close', async () => {
    vi.mocked(listChatMessages).mockResolvedValue({ items: historicalAnswers });
    const user = userEvent.setup();

    renderWithRouter(
      <><LocationProbe /><Routes>
        <Route path="/chat/:sessionId" element={<ChatPage />} />
      </Routes></>,
      ['/chat/s1'],
    );

    const answer = (await screen.findByText('新回答')).closest('article');
    const input = screen.getByRole('textbox', { name: '输入问题' });
    await user.type(input, '未发送的问题');
    await user.click(within(answer!).getByRole('button', { name: '1 条来源' }));

    const source = screen.getByRole('button', { name: '打开来源：新制度.pdf，p.5' });
    await user.click(source);
    expect(await screen.findByLabelText('文档原文')).toHaveTextContent('新制度依据的完整原文');
    expect(getDocument).toHaveBeenCalledWith('doc-new');
    expect(screen.getByLabelText('当前位置')).toHaveTextContent('/chat/s1');
    expect(input).toHaveValue('未发送的问题');
    await user.type(input, '，补充内容');
    await user.click(screen.getByRole('button', { name: '关闭原文预览' }));
    expect(screen.queryByRole('complementary', { name: '原文预览' })).not.toBeInTheDocument();
    expect(source).toHaveFocus();
    expect(input).toHaveValue('未发送的问题，补充内容');
  });

  it('closes the old source when switching to a session in another knowledge base', async () => {
    vi.mocked(listChatMessages).mockResolvedValue({ items: historicalAnswers });
    const user = userEvent.setup();
    renderWithRouter(<><ChatRouteControls /><Routes><Route path="/chat/:sessionId" element={<ChatPage />} /></Routes></>, ['/chat/s1']);
    const answer = (await screen.findByText('新回答')).closest('article');
    await user.click(within(answer!).getByRole('button', { name: '1 条来源' }));
    await user.click(screen.getByRole('button', { name: '打开来源：新制度.pdf，p.5' }));
    await screen.findByRole('complementary', { name: '原文预览' });
    vi.mocked(getChatSession).mockResolvedValue(secondSession);
    vi.mocked(listChatMessages).mockResolvedValue({ items: [secondSessionMessage] });
    await user.click(screen.getByRole('button', { name: '强制切换产品会话' }));
    await screen.findByText('产品会话回答');
    expect(screen.queryByRole('complementary', { name: '原文预览' })).not.toBeInTheDocument();
  });

  it('renders valid inline citations as source controls and keeps invalid markers as text', async () => {
    vi.mocked(listChatMessages).mockResolvedValue({
      items: [{
        ...historicalAnswers[1],
        content: '报销需要审批 [source:1]，无效引用保持原文 [source:0] [source:-1] [source:2]。',
      }],
    });
    const user = userEvent.setup();

    renderWithRouter(
      <Routes>
        <Route path="/chat/:sessionId" element={<ChatPage />} />
      </Routes>,
      ['/chat/s1'],
    );

    const sourceControl = await screen.findByRole('button', { name: '查看来源 1：新制度.pdf' });
    expect(screen.queryByRole('button', { name: /查看来源 0/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /查看来源 2/ })).not.toBeInTheDocument();
    expect(screen.getByText(/\[source:0\] \[source:-1\] \[source:2\]/)).toBeInTheDocument();

    await user.click(sourceControl);

    expect(screen.getByRole('article', { name: '来源 1：新制度.pdf' })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('button', { name: '1 条来源' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('renders a grouped source marker as separate validated source controls', async () => {
    vi.mocked(listChatMessages).mockResolvedValue({
      items: [{
        ...historicalAnswers[1],
        content: '原子性由多条依据共同支持 [source: 1, 1, 2]。',
        citations: [
          historicalAnswers[1].citations[0],
          {
            ...historicalAnswers[0].citations[0],
            filename: '事务日志.md',
          },
        ],
      }],
    });

    renderWithRouter(
      <Routes>
        <Route path="/chat/:sessionId" element={<ChatPage />} />
      </Routes>,
      ['/chat/s1'],
    );

    expect(await screen.findAllByRole('button', { name: '查看来源 1：新制度.pdf' })).toHaveLength(1);
    expect(screen.getByRole('button', { name: '查看来源 2：事务日志.md' })).toBeInTheDocument();
    expect(screen.queryByText('[source: 1, 1, 2]')).not.toBeInTheDocument();
  });

  it('keeps oversized grouped source markers as text even when numbers repeat', async () => {
    const oversizedMarker = `[source: ${Array.from({ length: 21 }, () => '1').join(', ')}]`;
    vi.mocked(listChatMessages).mockResolvedValue({
      items: [{
        ...historicalAnswers[1],
        content: `超长引用 ${oversizedMarker}。`,
      }],
    });

    renderWithRouter(
      <Routes>
        <Route path="/chat/:sessionId" element={<ChatPage />} />
      </Routes>,
      ['/chat/s1'],
    );

    expect(await screen.findByText(`超长引用 ${oversizedMarker}。`)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '查看来源 1：新制度.pdf' })).not.toBeInTheDocument();
  });

  it('collapses long source content and hides technical scores in retrieval details', async () => {
    const longContent = '制度依据'.repeat(80);
    vi.mocked(listChatMessages).mockResolvedValue({
      items: [{
        ...historicalAnswers[1],
        citations: [{
          ...historicalAnswers[1].citations[0],
          content: longContent,
          rerankScore: null,
        }],
      }],
    });
    const user = userEvent.setup();

    renderWithRouter(
      <Routes>
        <Route path="/chat/:sessionId" element={<ChatPage />} />
      </Routes>,
      ['/chat/s1'],
    );

    const answer = (await screen.findByText('新回答')).closest('article');
    await user.click(within(answer!).getByRole('button', { name: '1 条来源' }));
    const sourceCard = await screen.findByRole('article', { name: '来源 1：新制度.pdf' });
    expect(within(sourceCard).getByText(/…$/)).toBeInTheDocument();
    expect(within(sourceCard).getByText('完整摘录').closest('details')).not.toHaveAttribute('open');
    expect(within(sourceCard).getByText('检索详情').closest('details')).not.toHaveAttribute('open');
    expect(within(sourceCard).getByText(/精排相关度 无精排分/)).toBeInTheDocument();
  });

  it('keeps regeneration failures beside the affected answer and allows retrying', async () => {
    vi.mocked(listChatMessages).mockResolvedValue({ items: historicalAnswers });
    vi.mocked(regenerateChatMessage)
      .mockRejectedValueOnce(new ApiError(400, {
        code: 'CHAT_COMPLETION_FAILED',
        message: 'chat completion failed',
      }))
      .mockResolvedValueOnce({ message: historicalAnswers[1], rerankFallback: null });
    const user = userEvent.setup();

    renderWithRouter(
      <Routes>
        <Route path="/chat/:sessionId" element={<ChatPage />} />
      </Routes>,
      ['/chat/s1'],
    );

    const answer = (await screen.findByText('新回答')).closest('article');
    expect(answer).not.toBeNull();
    await user.click(within(answer!).getByRole('button', { name: '重新生成' }));

    const recovery = await within(answer!).findByRole('alert');
    expect(within(recovery).getByText('重新生成失败')).toBeInTheDocument();
    expect(within(recovery).getByText('回答生成失败，请稍后重试。')).toBeInTheDocument();
    expect(within(answer!).getByRole('button', { name: '重试' })).toBeInTheDocument();
    expect(within(answer!).queryByRole('button', { name: '重新生成' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('alert')).toHaveLength(1);

    await user.click(within(answer!).getByRole('button', { name: '重试' }));
    await waitFor(() => expect(regenerateChatMessage).toHaveBeenCalledTimes(2));
  });

  it('checks an uncertain regeneration result before allowing another write', async () => {
    const regeneratedAnswer = {
      ...historicalAnswers[1],
      id: 'assistant-after-unknown-result',
      content: '网络中断前已经生成的回答',
    } satisfies ChatMessage;
    vi.mocked(listChatMessages)
      .mockResolvedValueOnce({ items: historicalAnswers })
      .mockResolvedValueOnce({ items: [...historicalAnswers, regeneratedAnswer] });
    vi.mocked(regenerateChatMessage).mockRejectedValue(new Error('network disconnected'));
    const user = userEvent.setup();

    renderWithRouter(
      <Routes>
        <Route path="/chat/:sessionId" element={<ChatPage />} />
      </Routes>,
      ['/chat/s1'],
    );

    const answer = (await screen.findByText('新回答')).closest('article');
    await user.click(within(answer!).getByRole('button', { name: '重新生成' }));

    const recovery = await within(answer!).findByRole('status');
    expect(within(recovery).getByText('正在确认重新生成结果…')).toBeInTheDocument();
    expect(within(answer!).getByRole('button', { name: '再检查一次' })).toBeInTheDocument();
    expect(within(answer!).queryByRole('button', { name: '重试' })).not.toBeInTheDocument();
    expect(within(answer!).queryByRole('button', { name: '重新生成' })).not.toBeInTheDocument();
    expect(window.localStorage.getItem('rag.chat.pending-regeneration:s1')).not.toBeNull();

    await user.click(within(answer!).getByRole('button', { name: '再检查一次' }));

    expect(await screen.findByText('网络中断前已经生成的回答')).toBeInTheDocument();
    expect(regenerateChatMessage).toHaveBeenCalledTimes(1);
    expect(listChatMessages).toHaveBeenCalledTimes(2);
    expect(window.localStorage.getItem('rag.chat.pending-regeneration:s1')).toBeNull();
  });

  it('requires explicit confirmation before retrying after a check finds no new answer', async () => {
    const confirmedAnswer = {
      ...historicalAnswers[1],
      id: 'assistant-after-confirmed-retry',
      content: '用户确认后重新生成的回答',
    } satisfies ChatMessage;
    vi.mocked(listChatMessages)
      .mockResolvedValueOnce({ items: historicalAnswers })
      .mockResolvedValueOnce({ items: historicalAnswers });
    vi.mocked(regenerateChatMessage)
      .mockRejectedValueOnce(new Error('network disconnected'))
      .mockResolvedValueOnce({ message: confirmedAnswer, rerankFallback: null });
    const user = userEvent.setup();

    renderWithRouter(
      <Routes>
        <Route path="/chat/:sessionId" element={<ChatPage />} />
      </Routes>,
      ['/chat/s1'],
    );

    const answer = (await screen.findByText('新回答')).closest('article');
    await user.click(within(answer!).getByRole('button', { name: '重新生成' }));
    await user.click(await within(answer!).findByRole('button', { name: '再检查一次' }));

    expect(await within(answer!).findByRole('button', { name: '确认重新生成' })).toBeInTheDocument();
    expect(regenerateChatMessage).toHaveBeenCalledTimes(1);
    expect(JSON.parse(window.localStorage.getItem('rag.chat.pending-regeneration:s1') ?? '{}')).toMatchObject({
      checked: true,
    });

    await user.click(within(answer!).getByRole('button', { name: '确认重新生成' }));

    expect(await screen.findByText('用户确认后重新生成的回答')).toBeInTheDocument();
    expect(regenerateChatMessage).toHaveBeenCalledTimes(2);
    expect(window.localStorage.getItem('rag.chat.pending-regeneration:s1')).toBeNull();
  });

  it('persists regeneration protection before an in-flight request can outlive the page', async () => {
    const regeneration = deferred<Awaited<ReturnType<typeof regenerateChatMessage>>>();
    vi.mocked(listChatMessages).mockResolvedValue({ items: historicalAnswers });
    vi.mocked(regenerateChatMessage).mockReturnValue(regeneration.promise);
    const user = userEvent.setup();
    const view = renderWithRouter(
      <Routes>
        <Route path="/chat/:sessionId" element={<ChatPage />} />
      </Routes>,
      ['/chat/s1'],
    );

    const answer = (await screen.findByText('新回答')).closest('article');
    await user.click(within(answer!).getByRole('button', { name: '重新生成' }));

    expect(window.localStorage.getItem('rag.chat.pending-regeneration:s1')).not.toBeNull();
    view.unmount();
    await act(async () => {
      regeneration.reject(new Error('network disconnected after navigation'));
    });
    expect(window.localStorage.getItem('rag.chat.pending-regeneration:s1')).not.toBeNull();
  });

  it('does not start regeneration when browser storage cannot persist its recovery state', async () => {
    vi.mocked(listChatMessages).mockResolvedValue({ items: historicalAnswers });
    vi.mocked(regenerateChatMessage).mockResolvedValue({
      message: historicalAnswers[1],
      rerankFallback: null,
    });
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage unavailable');
    });
    const user = userEvent.setup();

    try {
      renderWithRouter(
        <Routes>
          <Route path="/chat/:sessionId" element={<ChatPage />} />
        </Routes>,
        ['/chat/s1'],
      );

      const answer = (await screen.findByText('新回答')).closest('article');
      await user.click(within(answer!).getByRole('button', { name: '重新生成' }));

      expect(regenerateChatMessage).not.toHaveBeenCalled();
      expect(await within(answer!).findByText('浏览器存储不可用，无法安全地重新生成。请检查隐私设置后重试。')).toBeInTheDocument();
    } finally {
      setItem.mockRestore();
    }
  });

  it('keeps regeneration protection when another session mutation wins the confirmation race', async () => {
    const archiveResult = deferred<ChatSession>();
    vi.mocked(listChatMessages).mockResolvedValue({ items: historicalAnswers });
    vi.mocked(archiveChatSession).mockReturnValue(archiveResult.promise);
    window.localStorage.setItem('rag.chat.pending-regeneration:s1', JSON.stringify({
      sessionId: 's1',
      messageId: historicalAnswers[1].id,
      baselineMessageIds: historicalAnswers.map((message) => message.id),
      checked: true,
      createdAt: '2026-07-01T00:03:00.000Z',
    }));
    const user = userEvent.setup();

    renderWithRouter(
      <Routes>
        <Route path="/chat/:sessionId" element={<ChatPage />} />
      </Routes>,
      ['/chat/s1'],
    );

    const answer = (await screen.findByText('新回答')).closest('article');
    const confirmRegeneration = await within(answer!).findByRole('button', { name: '确认重新生成' });
    await clickSessionAction(user, '归档会话');
    const archiveDialog = screen.getByRole('dialog', { name: '归档会话' });
    act(() => {
      fireEvent.click(within(archiveDialog).getByRole('button', { name: '归档' }));
      fireEvent.click(confirmRegeneration);
    });

    expect(regenerateChatMessage).not.toHaveBeenCalled();
    expect(window.localStorage.getItem('rag.chat.pending-regeneration:s1')).not.toBeNull();
    await act(async () => {
      archiveResult.resolve({ ...session, archivedAt: '2026-07-01T01:00:00Z' });
    });
  });

  it('does not offer a confirmed regeneration write for an archived session', async () => {
    const archivedSession = {
      ...session,
      archivedAt: '2026-07-01T01:00:00Z',
    } satisfies ChatSession;
    vi.mocked(getChatSession).mockResolvedValue(archivedSession);
    vi.mocked(listChatMessages).mockResolvedValue({ items: historicalAnswers });
    window.localStorage.setItem('rag.chat.pending-regeneration:s1', JSON.stringify({
      sessionId: 's1',
      messageId: historicalAnswers[1].id,
      baselineMessageIds: historicalAnswers.map((message) => message.id),
      checked: true,
      createdAt: '2026-07-01T00:03:00.000Z',
    }));

    renderWithRouter(
      <Routes>
        <Route path="/chat/:sessionId" element={<ChatPage />} />
      </Routes>,
      ['/chat/s1'],
    );

    const answer = (await screen.findByText('新回答')).closest('article');
    expect(await within(answer!).findByText('没有找到新的回答')).toBeInTheDocument();
    expect(within(answer!).queryByRole('button', { name: '确认重新生成' })).not.toBeInTheDocument();
    expect(window.localStorage.getItem('rag.chat.pending-regeneration:s1')).not.toBeNull();
  });

  it('restores uncertain regeneration protection after reloading a session', async () => {
    window.localStorage.setItem('rag.chat.pending-regeneration:s1', JSON.stringify({
      sessionId: 's1',
      messageId: historicalAnswers[1].id,
      baselineMessageIds: historicalAnswers.map((message) => message.id),
      createdAt: '2026-07-01T00:03:00.000Z',
    }));
    vi.mocked(listChatMessages).mockResolvedValue({ items: historicalAnswers });

    renderWithRouter(
      <Routes>
        <Route path="/chat/:sessionId" element={<ChatPage />} />
      </Routes>,
      ['/chat/s1'],
    );

    const answer = (await screen.findByText('新回答')).closest('article');
    expect(await within(answer!).findByText('正在确认重新生成结果…')).toBeInTheDocument();
    expect(within(answer!).getByRole('button', { name: '再检查一次' })).toBeInTheDocument();
    expect(within(answer!).queryByRole('button', { name: '重新生成' })).not.toBeInTheDocument();
  });

  it('clears a persisted regeneration check when the new answer is already present', async () => {
    const regeneratedAnswer = {
      ...historicalAnswers[1],
      id: 'assistant-persisted-regeneration',
      content: '刷新前已完成的重新生成回答',
    } satisfies ChatMessage;
    window.localStorage.setItem('rag.chat.pending-regeneration:s1', JSON.stringify({
      sessionId: 's1',
      messageId: historicalAnswers[1].id,
      baselineMessageIds: historicalAnswers.map((message) => message.id),
      createdAt: '2026-07-01T00:03:00.000Z',
    }));
    vi.mocked(listChatMessages).mockResolvedValue({
      items: [...historicalAnswers, regeneratedAnswer],
    });

    renderWithRouter(
      <Routes>
        <Route path="/chat/:sessionId" element={<ChatPage />} />
      </Routes>,
      ['/chat/s1'],
    );

    expect(await screen.findByText('刷新前已完成的重新生成回答')).toBeInTheDocument();
    await waitFor(() => {
      expect(window.localStorage.getItem('rag.chat.pending-regeneration:s1')).toBeNull();
    });
    expect(screen.queryByText('正在确认重新生成结果…')).not.toBeInTheDocument();
  });

  it('uses a successful regeneration response without requiring a message-list refresh', async () => {
    const regeneratedAnswer = {
      ...historicalAnswers[1],
      id: 'assistant-regenerated',
      content: '重新生成后的回答',
    } satisfies ChatMessage;
    vi.mocked(listChatMessages).mockResolvedValueOnce({ items: historicalAnswers });
    vi.mocked(regenerateChatMessage).mockResolvedValue({
      message: regeneratedAnswer,
      rerankFallback: null,
    });
    const user = userEvent.setup();

    renderWithRouter(
      <Routes>
        <Route path="/chat/:sessionId" element={<ChatPage />} />
      </Routes>,
      ['/chat/s1'],
    );

    const answer = (await screen.findByText('新回答')).closest('article');
    await user.click(within(answer!).getByRole('button', { name: '重新生成' }));

    expect(await screen.findByText('重新生成后的回答')).toBeInTheDocument();
    expect(listChatMessages).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '重试' })).not.toBeInTheDocument();
  });

  it('disables session mutations while the routed session detail is loading', async () => {
    const nextSession = deferred<ChatSession>();
    vi.mocked(listChatSessions).mockResolvedValue({ items: [session, secondSession] });
    vi.mocked(listKnowledgeBases).mockResolvedValue({ items: [knowledgeBase, secondKnowledgeBase] });
    vi.mocked(getChatSession).mockImplementation((id) => (
      id === secondSession.id ? nextSession.promise : Promise.resolve(session)
    ));
    const user = userEvent.setup();

    renderWithRouter(
      <>
        <Routes>
          <Route path="/chat/:sessionId" element={<ChatPage />} />
        </Routes>
        <ChatRouteControls />
      </>,
      ['/chat/s1'],
    );

    await findSessionTitle('制度问答');
    await user.click(screen.getByRole('button', { name: '强制切换产品会话' }));

    expect(screen.getByRole('textbox', { name: '输入问题' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: '重命名会话' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '会话操作' })).toBeDisabled();
  });

  it('closes a destructive confirmation when switching sessions', async () => {
    const nextSession = deferred<ChatSession>();
    vi.mocked(listChatSessions).mockResolvedValue({ items: [session, secondSession] });
    vi.mocked(listKnowledgeBases).mockResolvedValue({ items: [knowledgeBase, secondKnowledgeBase] });
    vi.mocked(getChatSession).mockImplementation((id) => (
      id === secondSession.id ? nextSession.promise : Promise.resolve(session)
    ));
    const user = userEvent.setup();

    renderWithRouter(
      <Routes>
        <Route path="/chat/:sessionId" element={<ChatPage />} />
      </Routes>,
      ['/chat/s1'],
    );

    await findSessionTitle('制度问答');
    await clickSessionAction(user, '删除会话');
    expect(screen.getByRole('dialog', { name: '删除会话' })).toHaveTextContent('制度问答');

    await user.selectOptions(screen.getByLabelText('当前知识库'), secondKnowledgeBase.id);

    expect(screen.queryByRole('dialog', { name: '删除会话' })).not.toBeInTheDocument();
  });

  it('hides citations from the previous session while the next session is loading', async () => {
    const nextSession = deferred<ChatSession>();
    const nextMessages = deferred<{ items: ChatMessage[] }>();
    vi.mocked(listChatSessions).mockResolvedValue({ items: [session, secondSession] });
    vi.mocked(listKnowledgeBases).mockResolvedValue({ items: [knowledgeBase, secondKnowledgeBase] });
    vi.mocked(getChatSession).mockImplementation((id) => (
      id === secondSession.id ? nextSession.promise : Promise.resolve(session)
    ));
    vi.mocked(listChatMessages).mockImplementation((id) => (
      id === secondSession.id ? nextMessages.promise : Promise.resolve({ items: historicalAnswers })
    ));
    const user = userEvent.setup();

    renderWithRouter(
      <>
        <Routes>
          <Route path="/chat/:sessionId" element={<ChatPage />} />
        </Routes>
        <ChatRouteControls />
      </>,
      ['/chat/s1'],
    );

    const answer = (await screen.findByText('新回答')).closest('article');
    await user.click(within(answer!).getByRole('button', { name: '1 条来源' }));
    expect(within(answer!).getByText('新制度.pdf')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '强制切换产品会话' }));

    expect(screen.queryByText('新制度.pdf')).not.toBeInTheDocument();
    expect(screen.queryByText('旧制度.pdf')).not.toBeInTheDocument();
  });

  it('locks chat navigation while a message is being sent', async () => {
    const sendResult = deferred<{ answer: string; citations: []; rerankFallback: null }>();
    const sameKnowledgeBaseSecondSession = {
      ...secondSession,
      knowledgeBaseId: knowledgeBase.id,
    };
    vi.mocked(listChatSessions).mockResolvedValue({ items: [session, sameKnowledgeBaseSecondSession] });
    vi.mocked(listKnowledgeBases).mockResolvedValue({ items: [knowledgeBase, secondKnowledgeBase] });
    vi.mocked(getChatSession).mockImplementation((id) => Promise.resolve(
      id === sameKnowledgeBaseSecondSession.id ? sameKnowledgeBaseSecondSession : session,
    ));
    vi.mocked(sendChatMessage).mockReturnValue(sendResult.promise);
    const user = userEvent.setup();

    renderWithRouter(
      <>
        <Routes>
          <Route path="/chat/:sessionId" element={<ChatPage />} />
        </Routes>
        <LocationProbe />
      </>,
      ['/chat/s1'],
    );

    const input = await screen.findByRole('textbox', { name: '输入问题' });
    await user.type(input, '制度会话问题');
    await user.click(screen.getByRole('button', { name: '发送' }));
    expect(await screen.findAllByText('制度会话问题')).toHaveLength(1);

    expect(screen.getByLabelText('当前知识库')).toBeDisabled();
    screen.getAllByRole('button', { name: '新建对话' }).forEach((button) => {
      expect(button).toBeDisabled();
    });
    const secondSessionLink = screen.getByRole('link', { name: /产品问答/ });
    expect(secondSessionLink).toHaveAttribute('aria-disabled', 'true');
    await user.click(secondSessionLink);
    expect(screen.getByRole('status', { name: '当前位置' })).toHaveTextContent('/chat/s1');

    sendResult.resolve({ answer: '制度会话回答', citations: [], rerankFallback: null });

    await waitFor(() => expect(secondSessionLink).not.toHaveAttribute('aria-disabled'));
    expect(screen.getByLabelText('当前知识库')).toBeEnabled();
  });

  it('synchronously blocks session mutations when a send starts', async () => {
    const sendResult = deferred<{ answer: string; citations: []; rerankFallback: null }>();
    vi.mocked(sendChatMessage).mockReturnValue(sendResult.promise);
    const user = userEvent.setup();
    renderWithRouter(
      <Routes>
        <Route path="/chat/:sessionId" element={<ChatPage />} />
      </Routes>,
      ['/chat/s1'],
    );

    const composer = await screen.findByRole('textbox', { name: '输入问题' });
    await user.type(composer, '不要和删除并发');
    const composerForm = composer.closest('form');
    const sessionMenu = await openSessionActions(user);
    const deleteButton = within(sessionMenu).getByRole('menuitem', { name: '删除会话' });
    expect(composerForm).not.toBeNull();
    await act(async () => {
      composerForm!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      deleteButton.click();
    });

    expect(sendChatMessage).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog', { name: '删除会话' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '重命名会话' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '会话操作' })).toBeDisabled();

    await act(async () => {
      sendResult.resolve({ answer: '回答', citations: [], rerankFallback: null });
      await Promise.resolve();
    });
  });

  it('synchronously blocks sending while a session mutation is pending', async () => {
    const titleResult = deferred<ChatSession>();
    vi.mocked(updateChatSessionTitle).mockReturnValue(titleResult.promise);
    const user = userEvent.setup();
    renderWithRouter(
      <Routes>
        <Route path="/chat/:sessionId" element={<ChatPage />} />
      </Routes>,
      ['/chat/s1'],
    );

    const titleInput = await startSessionTitleEdit(user);
    const composer = screen.getByRole('textbox', { name: '输入问题' });
    await user.clear(titleInput);
    await user.type(titleInput, '新标题');
    await user.type(composer, '不要和改名并发');
    const titleForm = titleInput.closest('form');
    const composerForm = composer.closest('form');
    expect(titleForm).not.toBeNull();
    expect(composerForm).not.toBeNull();
    await act(async () => {
      titleForm!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      composerForm!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(updateChatSessionTitle).toHaveBeenCalledOnce();
    expect(sendChatMessage).not.toHaveBeenCalled();
    expect(composer).toBeDisabled();

    await act(async () => {
      titleResult.resolve({ ...session, title: '新标题' });
      await Promise.resolve();
    });
  });

  it('locks chat navigation while a session title update is pending', async () => {
    const titleResult = deferred<ChatSession>();
    const sameKnowledgeBaseSecondSession = {
      ...secondSession,
      knowledgeBaseId: knowledgeBase.id,
    };
    vi.mocked(updateChatSessionTitle).mockReturnValue(titleResult.promise);
    vi.mocked(listChatSessions).mockResolvedValue({ items: [session, sameKnowledgeBaseSecondSession] });
    vi.mocked(listKnowledgeBases).mockResolvedValue({ items: [knowledgeBase, secondKnowledgeBase] });
    const user = userEvent.setup();
    renderWithRouter(
      <>
        <Routes><Route path="/chat/:sessionId" element={<ChatPage />} /></Routes>
        <LocationProbe />
      </>,
      ['/chat/s1'],
    );

    const titleInput = await startSessionTitleEdit(user);
    await user.clear(titleInput);
    await user.type(titleInput, '保存中的标题');
    await user.click(screen.getByRole('button', { name: '保存' }));

    const otherSession = screen.getByRole('link', { name: /产品问答/ });
    expect(otherSession).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByLabelText('当前知识库')).toBeDisabled();
    screen.getAllByRole('button', { name: '新建对话' }).forEach((button) => expect(button).toBeDisabled());
    await user.click(otherSession);
    expect(screen.getByRole('status', { name: '当前位置' })).toHaveTextContent('/chat/s1');

    titleResult.resolve({ ...session, title: '保存中的标题' });
    await waitFor(() => expect(otherSession).not.toHaveAttribute('aria-disabled'));
  });

  it('locks session mutations and navigation while an uncertain send is being checked', async () => {
    const checkResult = deferred<{ items: ChatMessage[] }>();
    const sameKnowledgeBaseSecondSession = {
      ...secondSession,
      knowledgeBaseId: knowledgeBase.id,
    };
    vi.mocked(listChatSessions).mockResolvedValue({ items: [session, sameKnowledgeBaseSecondSession] });
    vi.mocked(listKnowledgeBases).mockResolvedValue({ items: [knowledgeBase, secondKnowledgeBase] });
    vi.mocked(listChatMessages)
      .mockResolvedValueOnce({ items: [] })
      .mockResolvedValueOnce({ items: [] })
      .mockResolvedValueOnce({ items: [] })
      .mockReturnValueOnce(checkResult.promise);
    vi.mocked(sendChatMessage).mockRejectedValueOnce(new Error('network disconnected'));
    const user = userEvent.setup();
    renderWithRouter(
      <>
        <Routes><Route path="/chat/:sessionId" element={<ChatPage />} /></Routes>
        <LocationProbe />
      </>,
      ['/chat/s1'],
    );

    const composer = await screen.findByRole('textbox', { name: '输入问题' });
    await user.type(composer, '检查期间保持互斥');
    await submitWithAutomaticChecksPaused();
    expect(screen.getByText('正在确认这条消息…')).toBeInTheDocument();
    await finishAutomaticSendChecks();
    const checkButton = screen.getByRole('button', { name: '再检查一次' });
    const sessionActions = await openSessionActions(user);
    const deleteAction = within(sessionActions).getByRole('menuitem', { name: '删除会话' });
    act(() => {
      fireEvent.click(checkButton);
      fireEvent.click(deleteAction);
    });

    expect(screen.queryByRole('dialog', { name: '删除会话' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '重命名会话' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('当前知识库')).toBeDisabled();
    const otherSession = screen.getByRole('link', { name: /产品问答/ });
    expect(otherSession).toHaveAttribute('aria-disabled', 'true');
    await user.click(otherSession);
    expect(screen.getByRole('status', { name: '当前位置' })).toHaveTextContent('/chat/s1');

    checkResult.resolve({ items: [] });
    await waitFor(() => expect(otherSession).not.toHaveAttribute('aria-disabled'));
  });

  it('clears an uncertain send before composing in another session', async () => {
    vi.mocked(listChatSessions).mockResolvedValue({ items: [session, secondSession] });
    vi.mocked(listKnowledgeBases).mockResolvedValue({ items: [knowledgeBase, secondKnowledgeBase] });
    vi.mocked(getChatSession).mockImplementation((id) => Promise.resolve(
      id === secondSession.id ? secondSession : session,
    ));
    vi.mocked(sendChatMessage).mockRejectedValueOnce(new Error('network disconnected'));
    const user = userEvent.setup();

    renderWithRouter(
      <Routes>
        <Route path="/chat/:sessionId" element={<ChatPage />} />
      </Routes>,
      ['/chat/s1'],
    );

    const input = await screen.findByRole('textbox', { name: '输入问题' });
    await user.type(input, '制度库未知结果');
    await submitWithAutomaticChecksPaused();
    expect(screen.getByText('正在确认这条消息…')).toBeInTheDocument();
    vi.useRealTimers();

    await user.click(screen.getByRole('link', { name: /产品问答/ }));
    await findSessionTitle('产品问答');
    const nextInput = screen.getByRole('textbox', { name: '输入问题' });
    await user.type(nextInput, '产品库新问题');

    expect(screen.queryByRole('button', { name: '再检查一次' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '确认重新发送' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '发送' })).toBeEnabled();
  });

  it('labels a draft as a new conversation', async () => {
    renderWithRouter(
      <Routes>
        <Route path="/chat" element={<ChatPage />} />
      </Routes>,
      ['/chat?knowledgeBaseId=kb1'],
    );

    expect(await screen.findByText('新对话', { selector: '.chat-main__title-text' })).toBeInTheDocument();
  });

  it('opens a draft when creating another conversation from the chat page', async () => {
    const user = userEvent.setup();
    renderWithRouter(
      <>
        <Routes>
          <Route path="/chat" element={<ChatPage />} />
          <Route path="/chat/:sessionId" element={<ChatPage />} />
        </Routes>
        <LocationProbe />
      </>,
      ['/chat/s1'],
    );

    await user.click(await screen.findByRole('button', { name: '新建对话' }));

    expect(createChatSession).not.toHaveBeenCalled();
    expect(screen.getByRole('status', { name: '当前位置' })).toHaveTextContent('/chat?knowledgeBaseId=kb1');
  });

  it('opens a draft when switching to a knowledge base without sessions', async () => {
    vi.mocked(listKnowledgeBases).mockResolvedValue({ items: [knowledgeBase, secondKnowledgeBase] });
    const user = userEvent.setup();
    renderWithRouter(
      <>
        <Routes>
          <Route path="/chat" element={<ChatPage />} />
          <Route path="/chat/:sessionId" element={<ChatPage />} />
        </Routes>
        <LocationProbe />
      </>,
      ['/chat/s1'],
    );

    await user.selectOptions(await screen.findByLabelText('当前知识库'), 'kb2');

    expect(createChatSession).not.toHaveBeenCalled();
    expect(screen.getByRole('status', { name: '当前位置' })).toHaveTextContent('/chat?knowledgeBaseId=kb2');
  });

  it('keeps the typed draft when switching to a knowledge base with existing sessions', async () => {
    vi.mocked(listKnowledgeBases).mockResolvedValue({ items: [knowledgeBase, secondKnowledgeBase] });
    vi.mocked(listChatSessions).mockResolvedValue({ items: [session, secondSession] });
    const user = userEvent.setup();

    renderWithRouter(
      <>
        <Routes>
          <Route path="/chat" element={<ChatPage />} />
          <Route path="/chat/:sessionId" element={<ChatPage />} />
        </Routes>
        <LocationProbe />
      </>,
      ['/chat?knowledgeBaseId=kb1'],
    );

    const input = await screen.findByRole('textbox', { name: '输入问题' });
    await user.type(input, '请对比两份制度');
    await user.selectOptions(await screen.findByLabelText('当前知识库'), secondKnowledgeBase.id);

    expect(screen.getByRole('status', { name: '当前位置' })).toHaveTextContent('/chat?knowledgeBaseId=kb2');
    expect(screen.getByRole('textbox', { name: '输入问题' })).toHaveValue('请对比两份制度');
    expect(createChatSession).not.toHaveBeenCalled();
    expect(listChatMessages).not.toHaveBeenCalled();
  });

  it('creates a session only when the first draft question is submitted', async () => {
    vi.mocked(createChatSession).mockResolvedValue(session);
    vi.mocked(sendChatMessage).mockResolvedValue({ answer: '回答', citations: [], rerankFallback: null });
    const user = userEvent.setup();

    renderWithRouter(
      <Routes>
        <Route path="/chat" element={<ChatPage />} />
        <Route path="/chat/:sessionId" element={<ChatPage />} />
      </Routes>,
      ['/chat?knowledgeBaseId=kb1'],
    );

    const input = await screen.findByRole('textbox', { name: '输入问题' });
    expect(createChatSession).not.toHaveBeenCalled();

    await user.type(input, '第一次提问');
    await user.click(screen.getByRole('button', { name: '发送' }));

    await waitFor(() => expect(createChatSession).toHaveBeenCalledWith('kb1', ''));
    expect(sendChatMessage).toHaveBeenCalledWith('s1', expect.objectContaining({
      content: '第一次提问',
      clientRequestId: expect.any(String),
    }), expect.any(Object), expect.any(AbortSignal));
  });

  it('supports the static draft route used by the application router', async () => {
    vi.mocked(createChatSession).mockResolvedValue(session);
    vi.mocked(sendChatMessage).mockResolvedValue({ answer: '回答', citations: [], rerankFallback: null });
    const user = userEvent.setup();

    renderWithRouter(
      <Routes>
        <Route path="/chat" element={<ChatPage />} />
        <Route path="/chat/:sessionId" element={<ChatPage />} />
      </Routes>,
      ['/chat?knowledgeBaseId=kb1'],
    );

    const input = await screen.findByRole('textbox', { name: '输入问题' });
    expect(input).toBeEnabled();
    await user.type(input, '静态路由首问');
    await user.click(screen.getByRole('button', { name: '发送' }));

    await waitFor(() => expect(createChatSession).toHaveBeenCalledWith('kb1', ''));
    expect(sendChatMessage).toHaveBeenCalledWith('s1', expect.objectContaining({
      content: '静态路由首问',
      clientRequestId: expect.any(String),
    }), expect.any(Object), expect.any(AbortSignal));
  });

  it('keeps draft sessions focused on asking instead of disabled session management', async () => {
    renderWithRouter(
      <Routes>
        <Route path="/chat" element={<ChatPage />} />
      </Routes>,
      ['/chat?knowledgeBaseId=kb1'],
    );

    await screen.findByRole('textbox', { name: '输入问题' });
    expect(screen.queryByRole('button', { name: '重命名会话' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '会话操作' })).not.toBeInTheDocument();
  });

  it('synchronously locks a draft against duplicate submit events', async () => {
    const createResult = deferred<ChatSession>();
    vi.mocked(createChatSession).mockReturnValue(createResult.promise);
    vi.mocked(sendChatMessage).mockResolvedValue({ answer: '回答', citations: [], rerankFallback: null });
    const user = userEvent.setup();

    renderWithRouter(
      <Routes>
        <Route path="/chat" element={<ChatPage />} />
        <Route path="/chat/:sessionId" element={<ChatPage />} />
      </Routes>,
      ['/chat?knowledgeBaseId=kb1'],
    );

    const input = await screen.findByRole('textbox', { name: '输入问题' });
    await user.type(input, '只发送一次');
    const form = input.closest('form');
    expect(form).not.toBeNull();
    act(() => {
      form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(createChatSession).toHaveBeenCalledOnce();
    createResult.resolve(session);
    await waitFor(() => expect(sendChatMessage).toHaveBeenCalledOnce());
  });

  it('does not let a late draft creation take over after the user leaves', async () => {
    const createResult = deferred<ChatSession>();
    const createdSession = { ...session, id: 's-created', title: '迟到的新会话' };
    vi.mocked(createChatSession).mockReturnValue(createResult.promise);
    const user = userEvent.setup();

    renderWithRouter(
      <>
        <Routes>
          <Route path="/chat" element={<ChatPage />} />
          <Route path="/chat/:sessionId" element={<ChatPage />} />
          <Route path="/away" element={<div>已离开聊天</div>} />
        </Routes>
        <LocationProbe />
        <LeaveChatButton />
      </>,
      ['/chat?knowledgeBaseId=kb1'],
    );

    const input = await screen.findByRole('textbox', { name: '输入问题' });
    await user.type(input, '离开前的问题');
    await user.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(createChatSession).toHaveBeenCalledOnce());
    await user.click(screen.getByRole('button', { name: '离开聊天' }));
    await screen.findByText('已离开聊天');

    createResult.resolve(createdSession);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByRole('status', { name: '当前位置' })).toHaveTextContent('/away');
    expect(sendChatMessage).not.toHaveBeenCalled();
  });

  it('keeps the composer locked while the first draft question is still sending', async () => {
    const sendResult = deferred<{ answer: string; citations: []; rerankFallback: null }>();
    const sessionDetail = deferred<ChatSession>();
    vi.mocked(createChatSession).mockResolvedValue(session);
    vi.mocked(getChatSession).mockReturnValue(sessionDetail.promise);
    vi.mocked(sendChatMessage).mockReturnValue(sendResult.promise);
    const user = userEvent.setup();

    renderWithRouter(
      <Routes>
        <Route path="/chat" element={<ChatPage />} />
        <Route path="/chat/:sessionId" element={<ChatPage />} />
      </Routes>,
      ['/chat?knowledgeBaseId=kb1'],
    );

    const input = await screen.findByRole('textbox', { name: '输入问题' });
    await waitFor(() => expect(input).toBeEnabled());
    await user.type(input, '第一次提问');
    await user.click(screen.getByRole('button', { name: '发送' }));

    await waitFor(
      () => expect(sendChatMessage).toHaveBeenCalledWith('s1', expect.objectContaining({
        content: '第一次提问',
        clientRequestId: expect.any(String),
      }), expect.any(Object), expect.any(AbortSignal)),
      { timeout: 3000 },
    );
    sessionDetail.resolve(session);
    await findSessionTitle('制度问答');
    await waitFor(() => expect(listChatMessages).toHaveBeenCalledWith('s1'));
    expect(screen.getByRole('textbox', { name: '输入问题' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '停止生成' })).toBeEnabled();

    sendResult.resolve({ answer: '回答', citations: [], rerankFallback: null });
    await waitFor(() => expect(screen.getByRole('textbox', { name: '输入问题' })).toBeEnabled());
  });

  it('does not let the draft route load overwrite messages refreshed after sending', async () => {
    const routeMessages = deferred<{ items: ChatMessage[] }>();
    const sendResult = deferred<{ answer: string; citations: []; rerankFallback: null }>();
    const refreshedMessages = [{
      id: 'draft-answer',
      sessionId: session.id,
      role: 'assistant' as const,
      content: '首问完成后的回答',
      citations: [],
      createdAt: '2026-07-01T00:04:00Z',
    }];
    vi.mocked(createChatSession).mockResolvedValue(session);
    vi.mocked(sendChatMessage).mockReturnValue(sendResult.promise);
    vi.mocked(listChatMessages)
      .mockReturnValueOnce(routeMessages.promise)
      .mockResolvedValueOnce({ items: refreshedMessages });
    const user = userEvent.setup();

    renderWithRouter(
      <Routes>
        <Route path="/chat" element={<ChatPage />} />
        <Route path="/chat/:sessionId" element={<ChatPage />} />
      </Routes>,
      ['/chat?knowledgeBaseId=kb1'],
    );

    const input = await screen.findByRole('textbox', { name: '输入问题' });
    await user.type(input, '触发首问');
    await user.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(listChatMessages).toHaveBeenCalledTimes(1));

    sendResult.resolve({ answer: '首问完成后的回答', citations: [], rerankFallback: null });
    expect(await screen.findByText('首问完成后的回答')).toBeInTheDocument();
    expect(listChatMessages).toHaveBeenCalledTimes(2);

    await act(async () => {
      routeMessages.resolve({ items: [] });
      await Promise.resolve();
    });
    expect(screen.getByText('首问完成后的回答')).toBeInTheDocument();
  });

  it('keeps a failed question and provides a retry action', async () => {
    vi.mocked(sendChatMessage)
      .mockRejectedValueOnce(new ApiError(400, {
        code: 'CHAT_COMPLETION_FAILED',
        message: 'chat completion failed',
      }))
      .mockResolvedValueOnce({ answer: '回答', citations: [], rerankFallback: null });
    const user = userEvent.setup();

    renderWithRouter(
      <Routes>
        <Route path="/chat/:sessionId" element={<ChatPage />} />
      </Routes>,
      ['/chat/s1'],
    );

    const input = await screen.findByRole('textbox', { name: '输入问题' });
    await waitFor(() => expect(input).toBeEnabled());
    await user.type(input, '如何报销？');
    await user.click(screen.getByRole('button', { name: '发送' }));

    const conversation = screen.getByRole('region', { name: '问答会话' });
    expect(await within(conversation).findByRole('alert', undefined, { timeout: 3000 }))
      .toHaveTextContent('回答生成失败，请稍后重试。');
    expect(within(conversation).getAllByText('如何报销？')).toHaveLength(1);
    expect(within(conversation).getByRole('button', { name: '重试' })).toBeInTheDocument();
    expect(within(conversation).getByRole('button', { name: '修改问题' })).toBeInTheDocument();
    expect(input).toHaveValue('');

    await user.click(within(conversation).getByRole('button', { name: '重试' }));
    await waitFor(() => expect(sendChatMessage).toHaveBeenCalledTimes(2));
    expect(sendChatMessage).toHaveBeenNthCalledWith(2, 's1', expect.objectContaining({
      content: '如何报销？',
      clientRequestId: expect.any(String),
    }), expect.any(Object), expect.any(AbortSignal));
  });

  it('requires reconciliation before retrying an unknown network outcome', async () => {
    vi.mocked(sendChatMessage).mockRejectedValue(new Error('network disconnected'));
    const user = userEvent.setup();

    renderWithRouter(
      <Routes>
        <Route path="/chat/:sessionId" element={<ChatPage />} />
      </Routes>,
      ['/chat/s1'],
    );

    const input = await screen.findByRole('textbox', { name: '输入问题' });
    await user.type(input, '网络中断的问题');
    await submitWithAutomaticChecksPaused();

    const conversation = screen.getByRole('region', { name: '问答会话' });
    expect(within(conversation).getByText('正在确认这条消息…')).toBeInTheDocument();
    expect(within(conversation).getByLabelText('正在核对的问题')).toHaveTextContent('网络中断的问题');
    expect(within(conversation).getByLabelText('正在核对的问题').closest('.chat-msg--assistant')).not.toBeNull();
    expect(within(conversation).queryByText('网络中断的问题', { selector: '.chat-msg--user *' })).not.toBeInTheDocument();
    expect(within(conversation).queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '重试发送' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '再检查一次' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '确认重新发送' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled();
    expect(input).toHaveValue('');

    await finishAutomaticSendChecks();
    expect(within(conversation).getByRole('alert')).toHaveTextContent('没有找到这条消息');
    expect(within(conversation).getByLabelText('待确认的问题')).toHaveTextContent('网络中断的问题');
    expect(screen.getByRole('button', { name: '再检查一次' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '确认重新发送' })).toBeInTheDocument();
  });

  it('exposes the persistent session rail and inline source disclosure', async () => {
    vi.mocked(listChatMessages).mockResolvedValue({ items: historicalAnswers });
    const user = userEvent.setup();

    renderWithRouter(
      <Routes>
        <Route path="/chat/:sessionId" element={<ChatPage />} />
      </Routes>,
      ['/chat/s1'],
    );

    const sessionRail = await screen.findByRole('complementary', { name: '会话列表' });
    expect(await within(sessionRail).findByRole('link', { name: /制度问答/ })).toHaveAttribute('aria-current', 'page');

    const answer = (await screen.findByText('新回答')).closest('article');
    expect(within(answer!).queryByRole('article', { name: '来源 1：新制度.pdf' })).not.toBeInTheDocument();
    const sourceToggle = within(answer!).getByRole('button', { name: '1 条来源' });
    await user.click(sourceToggle);
    expect(within(answer!).getByRole('article', { name: '来源 1：新制度.pdf' })).toBeInTheDocument();
    expect(sourceToggle).toHaveAttribute('aria-expanded', 'true');
  });

  it('reconciles an uncertain draft only by its client request id', async () => {
    vi.mocked(sendChatMessage).mockRejectedValueOnce(new Error('network disconnected'));
    const user = userEvent.setup();

    renderWithRouter(
      <Routes>
        <Route path="/chat/:sessionId" element={<ChatPage />} />
      </Routes>,
      ['/chat/s1'],
    );

    const input = await screen.findByRole('textbox', { name: '输入问题' });
    await user.type(input, '已被服务端接收的问题');
    await submitWithAutomaticChecksPaused();
    expect(screen.getByText('正在确认这条消息…')).toBeInTheDocument();
	const firstPayload = vi.mocked(sendChatMessage).mock.calls[0]?.[1];
	expect(firstPayload).toEqual(expect.objectContaining({
		content: '已被服务端接收的问题',
		clientRequestId: expect.any(String),
	}));
	await finishAutomaticSendChecks();

    vi.mocked(listChatMessages).mockResolvedValueOnce({
      items: [{
		id: 'different-request',
		sessionId: 's1',
		role: 'user',
		content: '已被服务端接收的问题',
		clientRequestId: 'a42c85f7-18d3-4860-999c-7cf2ebcc22aa',
		citations: [],
		createdAt: '2026-07-01T00:01:00Z',
      }],
    });
    await user.click(screen.getByRole('button', { name: '再检查一次' }));
	expect(await screen.findByRole('alert')).toHaveTextContent('没有找到这条消息');
	expect(input).toHaveValue('');

	vi.mocked(listChatMessages).mockResolvedValueOnce({
		items: [{
			id: 'm1',
			sessionId: 's1',
			role: 'user',
			content: '已被服务端接收的问题',
			clientRequestId: firstPayload?.clientRequestId,
			citations: [],
			createdAt: '2026-07-01T00:01:00Z',
		}],
	});
	await user.click(screen.getByRole('button', { name: '再检查一次' }));

    await waitFor(() => expect(input).toHaveValue(''));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(sendChatMessage).toHaveBeenCalledTimes(1);
  });

  it('ignores a stale send-result check after leaving and returning to the same session', async () => {
    const staleCheck = deferred<{ items: ChatMessage[] }>();
    const freshMessage = {
      id: 'fresh-answer', sessionId: session.id, role: 'assistant' as const,
      content: '返回会话后的最新回答', citations: [], createdAt: '2026-07-01T00:04:00Z',
    };
    const staleMessage = {
      id: 'stale-answer', sessionId: session.id, role: 'assistant' as const,
      content: '旧检查结果', citations: [], createdAt: '2026-07-01T00:03:00Z',
    };
    let firstSessionLoads = 0;
    vi.mocked(listChatSessions).mockResolvedValue({ items: [session, secondSession] });
    vi.mocked(listKnowledgeBases).mockResolvedValue({
      items: [knowledgeBase, secondKnowledgeBase], total: 2, page: 1, pageSize: 100,
    });
    vi.mocked(getChatSession).mockImplementation(async (id) => (
      id === secondSession.id ? secondSession : session
    ));
    vi.mocked(listChatMessages).mockImplementation((id) => {
      if (id === secondSession.id) {
        return Promise.resolve({ items: [secondSessionMessage] });
      }
      firstSessionLoads += 1;
      if (firstSessionLoads === 1) return Promise.resolve({ items: [] });
      if (firstSessionLoads === 2 || firstSessionLoads === 3) return Promise.resolve({ items: [] });
      if (firstSessionLoads === 4) return staleCheck.promise;
      return Promise.resolve({ items: [freshMessage] });
    });
    vi.mocked(sendChatMessage).mockRejectedValueOnce(new Error('network disconnected'));
    const user = userEvent.setup();
    renderWithRouter(
      <>
        <Routes>
          <Route path="/chat/:sessionId" element={<ChatPage />} />
        </Routes>
        <ChatRouteControls />
      </>,
      ['/chat/s1'],
    );

    const input = await screen.findByRole('textbox', { name: '输入问题' });
    await user.type(input, '需要核对的问题');
    await submitWithAutomaticChecksPaused();
    expect(screen.getByText('正在确认这条消息…')).toBeInTheDocument();
    await finishAutomaticSendChecks();
    await user.click(screen.getByRole('button', { name: '再检查一次' }));
    await waitFor(() => expect(firstSessionLoads).toBe(4));

    await user.click(screen.getByRole('button', { name: '强制切换产品会话' }));
    await screen.findByText(secondSessionMessage.content);
    await user.click(screen.getByRole('button', { name: '强制切换制度会话' }));
    expect(await screen.findByText(freshMessage.content)).toBeInTheDocument();

    await act(async () => {
      staleCheck.resolve({ items: [staleMessage] });
      await Promise.resolve();
    });
    expect(screen.getByText(freshMessage.content)).toBeInTheDocument();
    expect(screen.queryByText(staleMessage.content)).not.toBeInTheDocument();
  });

  it('resends an uncertain question only after explicit confirmation', async () => {
    vi.mocked(sendChatMessage)
      .mockRejectedValueOnce(new Error('network disconnected'))
      .mockResolvedValueOnce({ answer: '回答', citations: [], rerankFallback: null });
    const user = userEvent.setup();

    renderWithRouter(
      <Routes>
        <Route path="/chat/:sessionId" element={<ChatPage />} />
      </Routes>,
      ['/chat/s1'],
    );

    const input = await screen.findByRole('textbox', { name: '输入问题' });
    await user.type(input, '需要确认重发的问题');
    await submitWithAutomaticChecksPaused();
    expect(sendChatMessage).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem('rag.chat.pending-request:s1')).not.toBeNull();
    expect(screen.getByText('正在确认这条消息…')).toBeInTheDocument();
    await finishAutomaticSendChecks();
    expect(screen.getByRole('button', { name: '确认重新发送' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '确认重新发送' }));

    await waitFor(() => expect(sendChatMessage).toHaveBeenCalledTimes(2));
	const firstPayload = vi.mocked(sendChatMessage).mock.calls[0]?.[1];
	const secondPayload = vi.mocked(sendChatMessage).mock.calls[1]?.[1];
	expect(firstPayload).toEqual(expect.objectContaining({ content: '需要确认重发的问题' }));
	expect(secondPayload).toEqual(firstPayload);
  });

	it('restores and reconciles a persisted uncertain request after reload', async () => {
		const clientRequestId = '1e6df43d-895b-4c50-a62c-e5cc6a8352a8';
		window.localStorage.setItem('rag.chat.pending-request:s1', JSON.stringify({
			sessionId: 's1',
			question: '刷新前的问题',
			clientRequestId,
			createdAt: '2026-07-01T00:00:00.000Z',
		}));
		vi.mocked(listChatMessages).mockResolvedValue({
			items: [{
				id: 'persisted-user-message',
				sessionId: 's1',
				role: 'user',
				content: '刷新前的问题',
				clientRequestId,
				citations: [],
				createdAt: '2026-07-01T00:01:00Z',
			}],
		});

		renderWithRouter(
			<Routes>
				<Route path="/chat/:sessionId" element={<ChatPage />} />
			</Routes>,
			['/chat/s1'],
		);

		await screen.findByText('刷新前的问题');
		await waitFor(() => {
			expect(window.localStorage.getItem('rag.chat.pending-request:s1')).toBeNull();
		});
		expect(screen.queryByText('发送结果暂时无法确认')).not.toBeInTheDocument();
	});
});
