import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../api/client';
import {
  createChatSession,
  getChatSession,
  getWorkspacePreference,
  listChatMessages,
  listChatSessions,
  listKnowledgeBaseCategories,
  listKnowledgeBases,
  sendChatMessage,
} from '../../api/resources';
import { renderWithRouter } from '../../test/render';
import type { ChatSession, KnowledgeBase } from '../../types/api';
import { ChatPage } from './ChatPage';

vi.mock('../../api/resources', () => ({
  archiveChatSession: vi.fn(),
  createChatSession: vi.fn(),
  deleteChatSession: vi.fn(),
  getChatSession: vi.fn(),
  getWorkspacePreference: vi.fn(),
  listChatMessages: vi.fn(),
  listChatSessions: vi.fn(),
  listKnowledgeBaseCategories: vi.fn(),
  listKnowledgeBases: vi.fn(),
  logout: vi.fn(),
  sendChatMessage: vi.fn(),
  updateChatSessionTitle: vi.fn(),
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

beforeEach(() => {
  Element.prototype.scrollTo = vi.fn();
  vi.mocked(listChatSessions).mockReset().mockResolvedValue({ items: [session] });
  vi.mocked(listKnowledgeBases).mockReset().mockResolvedValue({ items: [knowledgeBase] });
  vi.mocked(listKnowledgeBaseCategories).mockReset().mockResolvedValue({ items: [] });
  vi.mocked(getWorkspacePreference).mockReset().mockResolvedValue({
    viewMode: 'table', scope: 'all', sort: 'updatedAt_desc', visibility: 'all', expandedCategoryIds: [],
  });
  vi.mocked(getChatSession).mockReset().mockResolvedValue(session);
  vi.mocked(listChatMessages).mockReset().mockResolvedValue({ items: [] });
  vi.mocked(sendChatMessage).mockReset();
  vi.mocked(createChatSession).mockReset();
});

function LocationProbe() {
  const location = useLocation();
  return <output aria-label="当前位置">{location.pathname}{location.search}</output>;
}

describe('ChatPage', () => {
  it('opens a draft when creating another session from the chat page', async () => {
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

    await user.click(await screen.findByRole('button', { name: '新建会话' }));

    expect(createChatSession).not.toHaveBeenCalled();
    expect(screen.getByRole('status', { name: '当前位置' })).toHaveTextContent('/chat/new?knowledgeBaseId=kb1');
  });

  it('opens a draft when switching to a knowledge base without sessions', async () => {
    vi.mocked(listKnowledgeBases).mockResolvedValue({ items: [knowledgeBase, secondKnowledgeBase] });
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

    await user.selectOptions(await screen.findByLabelText('当前知识库'), 'kb2');

    expect(createChatSession).not.toHaveBeenCalled();
    expect(screen.getByRole('status', { name: '当前位置' })).toHaveTextContent('/chat/new?knowledgeBaseId=kb2');
  });

  it('creates a session only when the first draft question is submitted', async () => {
    vi.mocked(createChatSession).mockResolvedValue(session);
    vi.mocked(sendChatMessage).mockResolvedValue({ answer: '回答', citations: [] });
    const user = userEvent.setup();

    renderWithRouter(
      <Routes>
        <Route path="/chat/:sessionId" element={<ChatPage />} />
      </Routes>,
      ['/chat/new?knowledgeBaseId=kb1'],
    );

    const input = await screen.findByRole('textbox', { name: '继续追问当前知识库' });
    expect(createChatSession).not.toHaveBeenCalled();

    await user.type(input, '第一次提问');
    await user.click(screen.getByRole('button', { name: '发送' }));

    await waitFor(() => expect(createChatSession).toHaveBeenCalledWith('kb1', ''));
    expect(sendChatMessage).toHaveBeenCalledWith('s1', '第一次提问');
  });

  it('keeps a failed question and provides a retry action', async () => {
    vi.mocked(sendChatMessage)
      .mockRejectedValueOnce(new ApiError(500, {
        code: 'CHAT_COMPLETION_FAILED',
        message: 'chat completion failed',
      }))
      .mockResolvedValueOnce({ answer: '回答', citations: [] });
    const user = userEvent.setup();

    renderWithRouter(
      <Routes>
        <Route path="/chat/:sessionId" element={<ChatPage />} />
      </Routes>,
      ['/chat/s1'],
    );

    const input = await screen.findByRole('textbox', { name: '继续追问当前知识库' });
    await user.type(input, '如何报销？');
    await user.click(screen.getByRole('button', { name: '发送' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('回答生成失败，请稍后重试。');
    expect(input).toHaveValue('如何报销？');

    await user.clear(input);
    await user.type(input, '修改后的问题');
    await user.click(screen.getByRole('button', { name: '重试发送' }));
    await waitFor(() => expect(sendChatMessage).toHaveBeenCalledTimes(2));
    expect(sendChatMessage).toHaveBeenNthCalledWith(2, 's1', '修改后的问题');
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

    const input = await screen.findByRole('textbox', { name: '继续追问当前知识库' });
    await user.type(input, '网络中断的问题');
    await user.click(screen.getByRole('button', { name: '发送' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('发送结果暂时无法确认');
    expect(screen.queryByRole('button', { name: '重试发送' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '再次检查' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '确认重新发送' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled();
    expect(input).toHaveValue('网络中断的问题');
  });

  it('clears an uncertain draft after the submitted message is found', async () => {
    vi.mocked(sendChatMessage).mockRejectedValueOnce(new Error('network disconnected'));
    const user = userEvent.setup();

    renderWithRouter(
      <Routes>
        <Route path="/chat/:sessionId" element={<ChatPage />} />
      </Routes>,
      ['/chat/s1'],
    );

    const input = await screen.findByRole('textbox', { name: '继续追问当前知识库' });
    await user.type(input, '已被服务端接收的问题');
    await user.click(screen.getByRole('button', { name: '发送' }));
    await screen.findByRole('button', { name: '再次检查' });

    vi.mocked(listChatMessages).mockResolvedValueOnce({
      items: [{
        id: 'm1',
        sessionId: 's1',
        role: 'user',
        content: '已被服务端接收的问题',
        citations: [],
        createdAt: '2026-07-01T00:01:00Z',
      }],
    });
    await user.click(screen.getByRole('button', { name: '再次检查' }));

    await waitFor(() => expect(input).toHaveValue(''));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(sendChatMessage).toHaveBeenCalledTimes(1);
  });

  it('resends an uncertain question only after explicit confirmation', async () => {
    vi.mocked(sendChatMessage)
      .mockRejectedValueOnce(new Error('network disconnected'))
      .mockResolvedValueOnce({ answer: '回答', citations: [] });
    const user = userEvent.setup();

    renderWithRouter(
      <Routes>
        <Route path="/chat/:sessionId" element={<ChatPage />} />
      </Routes>,
      ['/chat/s1'],
    );

    const input = await screen.findByRole('textbox', { name: '继续追问当前知识库' });
    await user.type(input, '需要确认重发的问题');
    await user.click(screen.getByRole('button', { name: '发送' }));
    await screen.findByRole('button', { name: '确认重新发送' });

    await user.click(screen.getByRole('button', { name: '确认重新发送' }));

    await waitFor(() => expect(sendChatMessage).toHaveBeenCalledTimes(2));
    expect(sendChatMessage).toHaveBeenNthCalledWith(2, 's1', '需要确认重发的问题');
  });
});
