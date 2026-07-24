import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Route, Routes, useLocation, useNavigate } from 'react-router-dom';

import { ApiError } from '../../api/client';
import { renderWithRouter } from '../../test/render';
import { ChatPage } from './ChatPage';

const api = vi.hoisted(() => ({
  archiveChatSession: vi.fn(),
  createChatSession: vi.fn(),
  deleteChatSession: vi.fn(),
  getChatSession: vi.fn(),
  getCurrentUser: vi.fn(),
  getWorkspacePreference: vi.fn(),
  listChatMessages: vi.fn(),
  listChatSessions: vi.fn(),
  listKnowledgeBaseCategories: vi.fn(),
  listKnowledgeBases: vi.fn(),
  regenerateChatMessage: vi.fn(),
  sendChatMessage: vi.fn(),
  updateChatSessionTitle: vi.fn(),
  logout: vi.fn(),
}));

vi.mock('../../api/resources', () => api);

const session = {
  id: 'session-1',
  knowledgeBaseId: 'kb-1',
  title: '制度问答',
  createdAt: '2026-07-01T00:00:00Z',
  updatedAt: '2026-07-01T00:00:00Z',
  archivedAt: null,
};
const knowledgeBase = {
  id: 'kb-1',
  name: '员工制度',
  description: '制度文档',
  retrievalConfig: { vectorTopN: 30, rerankTopK: 5, scoreThreshold: 0.3, enableRerank: true },
  createdAt: '2026-07-01T00:00:00Z',
  updatedAt: '2026-07-01T00:00:00Z',
};
const secondKnowledgeBase = {
  ...knowledgeBase,
  id: 'kb-2',
  name: '产品资料',
};
const messages = [
  { id: 'user-1', sessionId: 'session-1', role: 'user', content: '原问题', citations: [], createdAt: '2026-07-01T00:00:00Z' },
  { id: 'assistant-1', sessionId: 'session-1', role: 'assistant', content: '原回答', citations: [], createdAt: '2026-07-01T00:00:01Z' },
] as const;

function renderPage() {
  return renderWithRouter(
    <Routes>
      <Route element={<ChatPage />} path="/chat/:sessionId" />
    </Routes>,
    ['/chat/session-1'],
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function SessionNavigation() {
  const navigate = useNavigate();
  return <button onClick={() => navigate('/chat/session-2')} type="button">切换测试会话</button>;
}

function LocationProbe() {
  const location = useLocation();
  return <output aria-label="当前位置">{location.pathname}{location.search}</output>;
}

beforeEach(() => {
  Element.prototype.scrollTo = vi.fn();
  Object.values(api).forEach((mock) => mock.mockReset());
  api.getCurrentUser.mockResolvedValue({ id: 'user-1', username: 'admin', displayName: '管理员' });
  api.listChatSessions.mockResolvedValue({ items: [session] });
  api.listKnowledgeBases.mockResolvedValue({ items: [knowledgeBase] });
  api.listKnowledgeBaseCategories.mockResolvedValue({ items: [] });
  api.getWorkspacePreference.mockResolvedValue({
    viewMode: 'table', scope: 'all', sort: 'updatedAt_desc', visibility: 'all', expandedCategoryIds: [],
  });
  api.getChatSession.mockResolvedValue(session);
  api.listChatMessages.mockResolvedValue({ items: messages });
});

describe('ChatPage draft and recovery flows', () => {
  it('opens a draft instead of creating an empty session', async () => {
    const user = userEvent.setup();
    renderWithRouter(
      <>
        <Routes>
          <Route element={<ChatPage />} path="/chat/:sessionId" />
        </Routes>
        <LocationProbe />
      </>,
      ['/chat/session-1'],
    );

    await screen.findByText('原回答');
    await user.click(screen.getByRole('button', { name: '新建会话' }));

    expect(api.createChatSession).not.toHaveBeenCalled();
    expect(screen.getByRole('status', { name: '当前位置' })).toHaveTextContent(
      '/chat/new?knowledgeBaseId=kb-1',
    );
  });

  it('opens a draft when switching to a knowledge base without sessions', async () => {
    api.listKnowledgeBases.mockResolvedValue({ items: [knowledgeBase, secondKnowledgeBase] });
    const user = userEvent.setup();
    renderWithRouter(
      <>
        <Routes>
          <Route element={<ChatPage />} path="/chat/:sessionId" />
        </Routes>
        <LocationProbe />
      </>,
      ['/chat/session-1'],
    );

    await user.selectOptions(await screen.findByLabelText('当前知识库'), 'kb-2');

    expect(api.createChatSession).not.toHaveBeenCalled();
    expect(screen.getByRole('status', { name: '当前位置' })).toHaveTextContent(
      '/chat/new?knowledgeBaseId=kb-2',
    );
  });

  it('creates the first draft session on submit and keeps the send operation active across navigation', async () => {
    const createdSession = { ...session, title: '' };
    const submittedMessages = [
      ...messages,
      { ...messages[0], id: 'user-2', content: '第一次提问', createdAt: '2026-07-01T00:01:00Z' },
      { ...messages[1], id: 'assistant-2', content: '第一次回答', createdAt: '2026-07-01T00:01:01Z' },
    ];
    api.createChatSession.mockResolvedValue(createdSession);
    api.getChatSession.mockResolvedValue(createdSession);
    api.sendChatMessage.mockResolvedValue({ answer: '第一次回答', citations: [], rerankFallback: null });
    api.listChatMessages.mockResolvedValue({ items: submittedMessages });
    const user = userEvent.setup();

    renderWithRouter(
      <>
        <Routes>
          <Route element={<ChatPage />} path="/chat/:sessionId" />
        </Routes>
        <LocationProbe />
      </>,
      ['/chat/new?knowledgeBaseId=kb-1'],
    );

    const input = await screen.findByRole('textbox', { name: '继续追问当前知识库' });
    expect(api.createChatSession).not.toHaveBeenCalled();

    await user.type(input, '第一次提问');
    await user.click(screen.getByRole('button', { name: '发送' }));

    await waitFor(() => expect(api.createChatSession).toHaveBeenCalledWith('kb-1', ''));
    expect(api.sendChatMessage).toHaveBeenCalledWith('session-1', '第一次提问');
    await waitFor(() => expect(screen.getByRole('status', { name: '当前位置' })).toHaveTextContent('/chat/session-1'));
    expect(await screen.findByText('第一次回答')).toBeInTheDocument();
  });

  it('keeps a definite failed question editable and provides a retry action', async () => {
    api.sendChatMessage
      .mockRejectedValueOnce(new ApiError(500, {
        code: 'CHAT_COMPLETION_FAILED',
        message: 'chat completion failed',
      }))
      .mockResolvedValueOnce({ answer: '回答', citations: [], rerankFallback: null });
    const user = userEvent.setup();
    renderPage();

    const input = await screen.findByRole('textbox', { name: '继续追问当前知识库' });
    await user.type(input, '如何报销？');
    await user.click(screen.getByRole('button', { name: '发送' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('回答生成失败，请稍后重试。');
    expect(input).toHaveValue('如何报销？');

    await user.clear(input);
    await user.type(input, '修改后的问题');
    await user.click(screen.getByRole('button', { name: '重试发送' }));

    await waitFor(() => expect(api.sendChatMessage).toHaveBeenCalledTimes(2));
    expect(api.sendChatMessage).toHaveBeenNthCalledWith(2, 'session-1', '修改后的问题');
  });

  it('requires reconciliation before retrying an unknown network outcome', async () => {
    api.sendChatMessage.mockRejectedValue(new Error('network disconnected'));
    const user = userEvent.setup();
    renderPage();

    const input = await screen.findByRole('textbox', { name: '继续追问当前知识库' });
    await user.type(input, '网络中断的问题');
    await user.click(screen.getByRole('button', { name: '发送' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('发送结果暂时无法确认');
    expect(screen.queryByRole('button', { name: '重试发送' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '再次检查' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '确认重新发送' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled();
    expect(input).toBeEnabled();
    expect(input).toHaveValue('网络中断的问题');
  });

  it('clears an uncertain draft after reconciliation finds the submitted message', async () => {
    const submittedMessage = {
      ...messages[0],
      id: 'user-submitted',
      content: '已被服务端接收的问题',
      createdAt: '2026-07-01T00:01:00Z',
    };
    api.listChatMessages
      .mockResolvedValueOnce({ items: messages })
      .mockResolvedValueOnce({ items: [...messages, submittedMessage] });
    api.sendChatMessage.mockRejectedValueOnce(new Error('network disconnected'));
    const user = userEvent.setup();
    renderPage();

    const input = await screen.findByRole('textbox', { name: '继续追问当前知识库' });
    await user.type(input, '已被服务端接收的问题');
    await user.click(screen.getByRole('button', { name: '发送' }));
    await user.click(await screen.findByRole('button', { name: '再次检查' }));

    await waitFor(() => expect(input).toHaveValue(''));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(api.sendChatMessage).toHaveBeenCalledTimes(1);
  });

  it('resends an uncertain question only after explicit confirmation', async () => {
    api.sendChatMessage
      .mockRejectedValueOnce(new Error('network disconnected'))
      .mockResolvedValueOnce({ answer: '回答', citations: [], rerankFallback: null });
    const user = userEvent.setup();
    renderPage();

    const input = await screen.findByRole('textbox', { name: '继续追问当前知识库' });
    await user.type(input, '需要确认重发的问题');
    await user.click(screen.getByRole('button', { name: '发送' }));
    await user.click(await screen.findByRole('button', { name: '确认重新发送' }));

    await waitFor(() => expect(api.sendChatMessage).toHaveBeenCalledTimes(2));
    expect(api.sendChatMessage).toHaveBeenNthCalledWith(2, 'session-1', '需要确认重发的问题');
  });

  it('does not let a late reconciliation overwrite a newly selected session', async () => {
    const pendingCheck = deferred<{ items: Array<Record<string, unknown> & { role: string; content: string }> }>();
    const sessionTwo = { ...session, id: 'session-2', title: '第二个会话' };
    const sessionTwoMessages = [
      { ...messages[1], id: 'assistant-session-2', sessionId: 'session-2', content: '第二个会话回答' },
    ];
    let firstSessionListCount = 0;
    api.sendChatMessage.mockRejectedValueOnce(new Error('network disconnected'));
    api.getChatSession.mockImplementation((id: string) => Promise.resolve(id === 'session-2' ? sessionTwo : session));
    api.listChatMessages.mockImplementation((id: string) => {
      if (id === 'session-2') {
        return Promise.resolve({ items: sessionTwoMessages });
      }
      firstSessionListCount += 1;
      return firstSessionListCount === 1
        ? Promise.resolve({ items: messages })
        : pendingCheck.promise;
    });
    const user = userEvent.setup();
    renderWithRouter(
      <>
        <SessionNavigation />
        <Routes><Route element={<ChatPage />} path="/chat/:sessionId" /></Routes>
      </>,
      ['/chat/session-1'],
    );

    const input = await screen.findByRole('textbox', { name: '继续追问当前知识库' });
    await user.type(input, '待核查的问题');
    await user.click(screen.getByRole('button', { name: '发送' }));
    await user.click(await screen.findByRole('button', { name: '再次检查' }));
    await user.click(screen.getByRole('button', { name: '切换测试会话' }));
    expect(await screen.findByText('第二个会话回答')).toBeInTheDocument();

    await act(async () => pendingCheck.resolve({
      items: [...messages, { ...messages[0], id: 'late-user', content: '待核查的问题' }],
    }));

    await waitFor(() => expect(screen.getByText('第二个会话回答')).toBeInTheDocument());
    expect(screen.queryByText('原回答')).not.toBeInTheDocument();
  });
});

describe('ChatPage RAG actions', () => {
  it('switches citation details between assistant messages', async () => {
    const messagesWithCitations = [
      messages[0],
      {
        ...messages[1],
        content: '第一条回答',
        citations: [{
          documentId: 'document-old',
          chunkId: 'chunk-old',
          filename: '旧制度.md',
          pageNumber: 2,
          content: '旧制度正文',
          vectorScore: 0.81,
          rerankScore: 0.91,
        }],
      },
      { ...messages[0], id: 'user-2', content: '第二个问题', createdAt: '2026-07-01T00:00:02Z' },
      {
        ...messages[1],
        id: 'assistant-2',
        content: '第二条回答',
        createdAt: '2026-07-01T00:00:03Z',
        citations: [{
          documentId: 'document-new',
          chunkId: 'chunk-new',
          filename: '新制度.pdf',
          pageNumber: null,
          content: '新制度正文',
          vectorScore: 0.72,
          rerankScore: null,
        }],
      },
    ];
    api.listChatMessages.mockResolvedValue({ items: messagesWithCitations });
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('第二条回答');
    expect(screen.getByText(/新制度\.pdf/)).toBeInTheDocument();
    expect(screen.getByText('无页码')).toBeInTheDocument();
    expect(screen.getByText('新制度正文')).toBeInTheDocument();
    expect(screen.getByText('vector 0.72')).toBeInTheDocument();
    expect(screen.getByText('rerank 未精排')).toBeInTheDocument();
    expect(screen.queryByText(/旧制度\.md/)).not.toBeInTheDocument();

    const firstAnswerCitations = screen.getByRole('button', { name: '查看回答“第一条回答”的引用' });
    await user.click(firstAnswerCitations);

    expect(firstAnswerCitations).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText(/旧制度\.md/)).toBeInTheDocument();
    expect(screen.getByText('p.2')).toBeInTheDocument();
    expect(screen.getByText('旧制度正文')).toBeInTheDocument();
    expect(screen.getByText('vector 0.81')).toBeInTheDocument();
    expect(screen.getByText('rerank 0.91')).toBeInTheDocument();
    expect(screen.queryByText(/新制度\.pdf/)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '查看回答“第二条回答”的引用' }));
    expect(screen.getByText(/新制度\.pdf/)).toBeInTheDocument();
    expect(screen.queryByText(/旧制度\.md/)).not.toBeInTheDocument();
  });

  it('shows a sanitized fallback notice after sending a message', async () => {
    api.sendChatMessage.mockResolvedValue({
      answer: '降级回答',
      citations: [],
      rerankFallback: { used: true, reason: 'provider_unavailable' },
    });
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('原回答');
    await user.type(screen.getByLabelText('继续追问当前知识库'), '新的问题');
    await user.click(screen.getByRole('button', { name: '发送' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Rerank 服务暂不可用');
    expect(screen.queryByText('provider_unavailable')).not.toBeInTheDocument();
  });

  it('regenerates an assistant message and reloads the message list', async () => {
    const regenerated = { ...messages[1], id: 'assistant-2', content: '重新生成的回答' };
    api.regenerateChatMessage.mockResolvedValue({ message: regenerated, rerankFallback: null });
    api.listChatMessages
      .mockResolvedValueOnce({ items: messages })
      .mockResolvedValueOnce({ items: [...messages, regenerated] });
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('原回答');
    await user.click(screen.getByRole('button', { name: '重新生成回答' }));

    expect(api.regenerateChatMessage).toHaveBeenCalledWith('session-1', 'assistant-1');
    expect(await screen.findByText('重新生成的回答')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: '重新生成回答' })).toBeEnabled());
  });

  it('disables regeneration while a message send is in flight', async () => {
    const pendingSend = deferred<unknown>();
    api.sendChatMessage.mockReturnValue(pendingSend.promise);
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('原回答');
    await user.type(screen.getByLabelText('继续追问当前知识库'), '新的问题');
    await user.click(screen.getByRole('button', { name: '发送' }));

    expect(screen.getByRole('button', { name: '重新生成回答' })).toBeDisabled();
  });

  it('does not let an old session request overwrite the active session', async () => {
    const pendingSend = deferred<{ answer: string; citations: never[]; rerankFallback: null }>();
    const sessionTwo = { ...session, id: 'session-2', title: '第二个会话' };
    const sessionTwoMessages = [{ ...messages[1], id: 'assistant-session-2', sessionId: 'session-2', content: '第二个会话回答' }];
    api.sendChatMessage.mockReturnValue(pendingSend.promise);
    api.getChatSession.mockImplementation((id: string) => Promise.resolve(id === 'session-2' ? sessionTwo : session));
    api.listChatMessages.mockImplementation((id: string) => Promise.resolve({ items: id === 'session-2' ? sessionTwoMessages : messages }));
    const user = userEvent.setup();
    renderWithRouter(
      <>
        <SessionNavigation />
        <Routes><Route element={<ChatPage />} path="/chat/:sessionId" /></Routes>
      </>,
      ['/chat/session-1'],
    );

    await screen.findByText('原回答');
    await user.type(screen.getByLabelText('继续追问当前知识库'), '旧会话问题');
    await user.click(screen.getByRole('button', { name: '发送' }));
    await user.click(screen.getByRole('button', { name: '切换测试会话' }));
    expect(await screen.findByText('第二个会话回答')).toBeInTheDocument();

    await act(async () => pendingSend.resolve({ answer: '旧会话回答', citations: [], rerankFallback: null }));

    await waitFor(() => expect(screen.getByText('第二个会话回答')).toBeInTheDocument());
    expect(screen.queryByText('原回答')).not.toBeInTheDocument();
  });
});
