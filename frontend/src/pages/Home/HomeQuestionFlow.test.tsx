import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import type { InitialEntry } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../api/client';
import {
  createChatSession, getChatSession, getCurrentUser, getHomeSummary,
  listActivities, listChatMessages, listChatSessions, listKnowledgeBases,
  sendChatMessageStream,
} from '../../api/resources';
import { chatDraftStore } from '../../store/chatDraftStore';
import { currentUserStore } from '../../store/currentUserStore';
import { tokenStore } from '../../store/tokenStore';
import { renderWithRouter } from '../../test/render';
import type { ChatMessage, ChatSession, HomeSummaryResponse, KnowledgeBase, SendChatMessageResponse } from '../../types/api';
import { ChatPage } from '../Chat/ChatPage';
import { chatDraftScope } from '../Chat/useChatDraft';
import { HomePage } from './HomePage';

vi.mock('../../api/resources', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../api/resources')>(),
  getCurrentUser: vi.fn(), getHomeSummary: vi.fn(), listActivities: vi.fn(),
  listKnowledgeBases: vi.fn(), listChatSessions: vi.fn(), getChatSession: vi.fn(),
  listChatMessages: vi.fn(), createChatSession: vi.fn(), sendChatMessageStream: vi.fn(),
}));

const question = '新员工入职需要准备哪些材料？';
const account = { id: 'home-user', username: 'fixture', displayName: '测试用户', role: 'user' as const };
const knowledgeBase: KnowledgeBase = {
  id: 'kb1', name: '员工手册', description: '制度资料', visibility: 'private',
  answerConfig: { systemPromptAddition: '', answerLanguage: 'auto', allowGeneralKnowledge: false, model: '' },
  retrievalConfig: { enableKeyword: true, vectorTopN: 30, rerankTopK: 5, scoreThreshold: 0.3, enableRerank: true },
  createdAt: '2026-11-22T00:00:00Z', updatedAt: '2026-11-22T00:00:00Z',
};
const session: ChatSession = {
  id: 'home-session', knowledgeBaseId: '', knowledgeBaseIds: [], scopeMode: 'auto',
  title: '入职材料', archivedAt: null, createdAt: knowledgeBase.createdAt, updatedAt: knowledgeBase.updatedAt,
};
const summary: HomeSummaryResponse = {
  period: 'month',
  stats: { period: 'month', knowledgeBases: { value: 1, changeRatio: 0 }, documents: { value: 1, changeRatio: 0 }, views: { value: 0, changeRatio: 0 }, questions: { value: 0, changeRatio: 0 } },
  knowledgeBases: [knowledgeBase], knowledgeBaseTotal: 1, documents: [], documentTotal: 1,
  processingDocumentTotal: 0, failedDocuments: [], failedDocumentTotal: 0, sessions: [], sessionTotal: 0,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function reply(requestId = 'home-request'): SendChatMessageResponse {
  const userMessage: ChatMessage = { id: 'home-question', sessionId: session.id, role: 'user', content: question, citations: [], clientRequestId: requestId, createdAt: session.createdAt };
  const assistantMessage: ChatMessage = { ...userMessage, id: 'home-answer', role: 'assistant', content: '请准备身份证和学历证明。' };
  return { clientRequestId: requestId, userMessage, assistantMessage, answer: assistantMessage.content, citations: [], rerankFallback: null };
}

function LocationProbe() {
  const location = useLocation();
  const navigate = useNavigate();
  return <>
    <output data-testid="location">{location.pathname}{location.search}</output>
    <output data-testid="navigation-state">{JSON.stringify(location.state)}</output>
    <button onClick={() => navigate('/away')} type="button">暂时离开</button>
    <button onClick={() => navigate(-1)} type="button">返回上一页</button>
  </>;
}

function renderFlow(entries: InitialEntry[] = ['/home']) {
  return renderWithRouter(<StrictMode><LocationProbe /><Routes>
    <Route path="/home" element={<HomePage />} />
    <Route path="/chat" element={<ChatPage />} />
    <Route path="/chat/:sessionId" element={<ChatPage />} />
    <Route path="/away" element={<p>其他页面</p>} />
  </Routes></StrictMode>, entries);
}

async function askFromHome(method: 'click' | 'enter' = 'click') {
  const user = userEvent.setup();
  const input = await screen.findByRole('textbox', { name: '向知识库提问' });
  await user.type(input, question);
  if (method === 'click') await user.click(screen.getByRole('button', { name: '提问' }));
  else await user.keyboard('{Enter}');
  return user;
}

beforeEach(async () => {
  currentUserStore.clear();
  chatDraftStore.clearAll();
  Element.prototype.scrollTo = vi.fn();
  vi.mocked(getCurrentUser).mockReset().mockResolvedValue(account);
  vi.mocked(getHomeSummary).mockReset().mockResolvedValue(summary);
  vi.mocked(listActivities).mockReset().mockResolvedValue({ items: [] });
  vi.mocked(listKnowledgeBases).mockReset().mockResolvedValue({ items: [knowledgeBase] });
  vi.mocked(listChatSessions).mockReset().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 50 });
  vi.mocked(getChatSession).mockReset().mockResolvedValue(session);
  vi.mocked(listChatMessages).mockReset().mockResolvedValue({ items: [] });
  vi.mocked(createChatSession).mockReset().mockResolvedValue(session);
  vi.mocked(sendChatMessageStream).mockReset().mockImplementation(async (_, request) => {
    const response = reply(request.clientRequestId);
    vi.mocked(listChatMessages).mockResolvedValue({ items: [response.userMessage, response.assistantMessage] });
    return response;
  });
  await currentUserStore.load(getCurrentUser);
});

describe('home question handoff', () => {
  it.each(['click', 'enter'] as const)('sends the home question once after %s and shows the answer', async (method) => {
    renderFlow();
    await askFromHome(method);
    expect(await screen.findByText('请准备身份证和学历证明。')).toBeInTheDocument();
    expect(createChatSession).toHaveBeenCalledExactlyOnceWith(undefined, '');
    expect(sendChatMessageStream).toHaveBeenCalledExactlyOnceWith(session.id, expect.objectContaining({ content: question, clientRequestId: expect.any(String) }), expect.any(Object), expect.any(AbortSignal));
    expect(screen.getByTestId('location')).toHaveTextContent('/chat/home-session');
    expect(screen.queryByRole('heading', { name: '今天，想从资料中了解什么？' })).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '输入问题' })).toHaveValue('');
  });

  it('shows the submitted question while waiting for knowledge bases, then starts once', async () => {
    const bases = deferred<{ items: KnowledgeBase[] }>();
    vi.mocked(listKnowledgeBases).mockReturnValue(bases.promise);
    renderFlow();
    await askFromHome();
    expect(await screen.findByText(question, { selector: 'p' })).toBeInTheDocument();
    expect(screen.getByText('正在准备对话…')).toBeInTheDocument();
    expect(screen.queryByText('还没有知识库。先创建一个知识库并导入文档。')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '今天，想从资料中了解什么？' })).not.toBeInTheDocument();
    expect(createChatSession).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: '输入问题' })).toBeDisabled();
    await act(async () => bases.resolve({ items: [knowledgeBase] }));
    expect(await screen.findByText('请准备身份证和学历证明。')).toBeInTheDocument();
    expect(sendChatMessageStream).toHaveBeenCalledTimes(1);
  });

  it.each(['empty', 'error'] as const)('keeps the question editable when knowledge bases are %s without sending after retry', async (mode) => {
    chatDraftStore.set(account.id, chatDraftScope(undefined, []), '之前的独立草稿');
    if (mode === 'empty') vi.mocked(listKnowledgeBases).mockResolvedValue({ items: [] });
    else vi.mocked(listKnowledgeBases).mockRejectedValue(new ApiError(429, { code: 'RATE_LIMITED', message: '知识库暂不可用' }));
    renderFlow();
    const user = await askFromHome();
    await waitFor(() => expect(screen.getByRole('textbox', { name: '输入问题' })).toHaveValue(question));
    expect(createChatSession).not.toHaveBeenCalled();
    expect(sendChatMessageStream).not.toHaveBeenCalled();
    expect(chatDraftStore.get(account.id, chatDraftScope(undefined, []))).toBe('之前的独立草稿');
    if (mode === 'error') {
      expect(screen.queryByText('还没有可提问的知识库')).not.toBeInTheDocument();
      expect(screen.getByRole('heading', { name: '知识库暂不可用' })).toBeInTheDocument();
      vi.mocked(listKnowledgeBases).mockResolvedValue({ items: [knowledgeBase] });
      await user.click(screen.getByRole('button', { name: '重试' }));
      await waitFor(() => expect(screen.getByRole('textbox', { name: '输入问题' })).toBeEnabled());
      expect(createChatSession).not.toHaveBeenCalled();
    }
  });

  it('keeps ordinary q deep links as editable prefills without creating a session', async () => {
    renderFlow([`/chat?q=${encodeURIComponent(question)}`]);
    await waitFor(() => expect(screen.getByRole('textbox', { name: '输入问题' })).toHaveValue(question));
    expect(screen.getByTestId('location')).toHaveTextContent('/chat');
    expect(screen.getByTestId('location')).not.toHaveTextContent('?q=');
    expect(createChatSession).not.toHaveBeenCalled();
    expect(sendChatMessageStream).not.toHaveBeenCalled();
  });

  it('sends only the home question and preserves a previous automatic draft', async () => {
    chatDraftStore.set(account.id, chatDraftScope(undefined, []), '上次还没写完的问题');
    renderFlow();
    await askFromHome();
    await screen.findByText('请准备身份证和学历证明。');
    expect(sendChatMessageStream).toHaveBeenCalledWith(session.id, expect.objectContaining({ content: question }), expect.any(Object), expect.any(AbortSignal));
    expect(chatDraftStore.get(account.id, chatDraftScope(undefined, []))).toBe('上次还没写完的问题');
  });

  it('does not replay a consumed home submission after remounting while preparation is pending', async () => {
    const bases = deferred<{ items: KnowledgeBase[] }>();
    vi.mocked(listKnowledgeBases).mockReturnValue(bases.promise);
    const view = renderFlow();
    await askFromHome();
    await waitFor(() => expect(screen.getByTestId('navigation-state')).not.toHaveTextContent('"question"'));
    const consumedState: unknown = JSON.parse(screen.getByTestId('navigation-state').textContent ?? 'null');
    view.unmount();
    renderFlow([{ pathname: '/chat', state: consumedState }]);
    await act(async () => bases.resolve({ items: [knowledgeBase] }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: '输入问题' })).toBeEnabled());
    expect(screen.getByRole('textbox', { name: '输入问题' })).toHaveValue(question);
    expect(createChatSession).not.toHaveBeenCalled();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '自动检索全部可访问知识库' }));
    expect(screen.getByRole('textbox', { name: '输入问题' })).toHaveValue(question);
    await user.click(screen.getByRole('button', { name: /员工手册.*制度资料/ }));
    expect(screen.getByRole('textbox', { name: '输入问题' })).toHaveValue(question);
    await user.click(screen.getByRole('button', { name: '自动检索全部可访问知识库' }));
    expect(screen.getByRole('textbox', { name: '输入问题' })).toHaveValue(question);
    expect(createChatSession).not.toHaveBeenCalled();
  });

  it('restores a consumed question on Back without treating it as a new submission', async () => {
    const bases = deferred<{ items: KnowledgeBase[] }>();
    vi.mocked(listKnowledgeBases).mockReturnValue(bases.promise);
    renderFlow();
    const user = await askFromHome();
    await waitFor(() => expect(screen.getByTestId('navigation-state')).not.toHaveTextContent('"question"'));
    await user.click(screen.getByRole('button', { name: '暂时离开' }));
    await user.click(screen.getByRole('button', { name: '返回上一页' }));
    await act(async () => bases.resolve({ items: [knowledgeBase] }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: '输入问题' })).toBeEnabled());
    expect(screen.getByRole('textbox', { name: '输入问题' })).toHaveValue(question);
    expect(createChatSession).not.toHaveBeenCalled();
  });

  it('discards a pending submission if the account changes before knowledge bases load', async () => {
    const bases = deferred<{ items: KnowledgeBase[] }>();
    vi.mocked(listKnowledgeBases).mockReturnValue(bases.promise);
    renderFlow();
    await askFromHome();
    vi.mocked(getCurrentUser).mockResolvedValue({ ...account, id: 'next-user', displayName: '新用户' });
    act(() => tokenStore.setToken('next-user-fixture'));
    await screen.findByRole('button', { name: '新用户' });
    await act(async () => bases.resolve({ items: [knowledgeBase] }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: '输入问题' })).toBeEnabled());
    expect(screen.getByRole('textbox', { name: '输入问题' })).toHaveValue('');
    expect(createChatSession).not.toHaveBeenCalled();
  });

  it('does not send under a new account when creation finishes after an account switch', async () => {
    const creation = deferred<ChatSession>();
    vi.mocked(createChatSession).mockReturnValue(creation.promise);
    chatDraftStore.set('next-user', chatDraftScope(undefined, []), '新账号的独立草稿');
    renderFlow();
    await askFromHome();
    await waitFor(() => expect(createChatSession).toHaveBeenCalledTimes(1));
    vi.mocked(getCurrentUser).mockResolvedValue({ ...account, id: 'next-user', displayName: '新用户' });
    act(() => tokenStore.setToken('next-user-fixture'));
    await screen.findByRole('button', { name: '新用户' });
    await waitFor(() => expect(screen.getByRole('textbox', { name: '输入问题' })).toBeEnabled());
    expect(screen.queryByText(question, { selector: 'p' })).not.toBeInTheDocument();
    await act(async () => creation.resolve(session));
    await waitFor(() => expect(screen.getByRole('textbox', { name: '输入问题' })).toBeEnabled());
    expect(sendChatMessageStream).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: '输入问题' })).toHaveValue('新账号的独立草稿');
    expect(chatDraftStore.get('next-user', chatDraftScope(undefined, []))).toBe('新账号的独立草稿');
    expect(screen.queryByText(question, { selector: 'p' })).not.toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('/chat');
  });

  it('keeps the first streaming delta through the draft-to-session navigation', async () => {
    const completion = deferred<SendChatMessageResponse>();
    let onDelta: ((text: string) => void) | undefined;
    vi.mocked(sendChatMessageStream).mockImplementation((_, _request, handlers) => {
      onDelta = handlers?.onDelta;
      onDelta?.('首段');
      return completion.promise;
    });
    renderFlow();
    await askFromHome();
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/chat/home-session'));
    expect(await screen.findByText('首段')).toBeInTheDocument();
    act(() => onDelta?.('后段'));
    expect(await screen.findByText('首段后段')).toBeInTheDocument();
    await act(async () => completion.resolve(reply()));
  });

  it('keeps a failed first question for manual recovery without sending on refresh', async () => {
    vi.mocked(createChatSession).mockRejectedValue(new Error('offline'));
    const view = renderFlow();
    await askFromHome();
    await screen.findByText('回答生成失败');
    expect(screen.getByRole('textbox', { name: '输入问题' })).toHaveValue(question);
    expect(createChatSession).toHaveBeenCalledTimes(1);
    expect(sendChatMessageStream).not.toHaveBeenCalled();
    const consumedState: unknown = JSON.parse(screen.getByTestId('navigation-state').textContent ?? 'null');
    view.unmount();
    renderFlow([{ pathname: '/chat', state: consumedState }]);
    await waitFor(() => expect(screen.getByRole('textbox', { name: '输入问题' })).toHaveValue(question));
    expect(createChatSession).toHaveBeenCalledTimes(1);
  });

  it('does not send a home intent belonging to a different account', async () => {
    renderFlow([{ pathname: '/chat', state: { homeQuestion: { id: 'old-entry', userId: 'other-user', question } } }]);
    await waitFor(() => expect(screen.getByRole('textbox', { name: '输入问题' })).toBeEnabled());
    expect(screen.getByRole('textbox', { name: '输入问题' })).toHaveValue('');
    expect(createChatSession).not.toHaveBeenCalled();
    expect(screen.queryByText(question)).not.toBeInTheDocument();
  });

  it.each([{ isComposing: true, keyCode: 13 }, { isComposing: false, keyCode: 229 }])('blocks IME confirmation Enter (%o) without navigating', async (keyboard) => {
    renderFlow();
    const input = await screen.findByRole('textbox', { name: '向知识库提问' });
    fireEvent.change(input, { target: { value: question } });
    const allowed = fireEvent.keyDown(input, { key: 'Enter', ...keyboard });
    expect(allowed).toBe(false);
    expect(screen.getByTestId('location')).toHaveTextContent('/home');
    expect(createChatSession).not.toHaveBeenCalled();
  });

  it('blocks form submission during active composition and accepts the completed question', async () => {
    renderFlow();
    const input = await screen.findByRole('textbox', { name: '向知识库提问' });
    fireEvent.change(input, { target: { value: question } });
    fireEvent.compositionStart(input);
    fireEvent.submit(input.closest('form')!);
    expect(screen.getByTestId('location')).toHaveTextContent('/home');
    fireEvent.compositionEnd(input);
    act(() => {
      fireEvent.submit(input.closest('form')!);
      fireEvent.submit(input.closest('form')!);
    });
    await screen.findByText('请准备身份证和学历证明。');
    expect(createChatSession).toHaveBeenCalledTimes(1);
    expect(sendChatMessageStream).toHaveBeenCalledTimes(1);
  });
});
