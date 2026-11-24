import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';

import {
  getChatSession,
  getCurrentUser,
  getDocument,
  getDocumentPreview,
  listChatMessages,
  listChatSessions,
  listKnowledgeBases,
} from '../../api/resources';
import { currentUserStore } from '../../store/currentUserStore';
import { renderWithRouter } from '../../test/render';
import { ChatPage } from './ChatPage';

const messageBubbleSpy = vi.hoisted(() => vi.fn());

vi.mock('./ChatMessage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ChatMessage')>();
  const { memo } = await import('react');
  const SpyBubble = memo((props: Parameters<typeof actual.MessageBubble>[0]) => {
    messageBubbleSpy(props.message.id);
    return <actual.MessageBubble {...props} />;
  });
  return { ...actual, MessageBubble: SpyBubble };
});

vi.mock('../../api/resources', () => ({
  getDocumentVersionStatus: vi.fn().mockResolvedValue({ items: [] }),
  getCurrentUser: vi.fn().mockResolvedValue({ id: 'user1', username: 'fixture', displayName: '测试用户', role: 'user' }),
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
  searchChatMessages: vi.fn(),
  listChatSessions: vi.fn(),
  listKnowledgeBaseCategories: vi.fn(),
  listKnowledgeBases: vi.fn(),
  listGlobalDocuments: vi.fn(),
  logout: vi.fn(),
  regenerateChatMessage: vi.fn(),
  setChatMessageFeedback: vi.fn(),
  sendChatMessageStream: vi.fn(),
  unarchiveChatSession: vi.fn(),
  updateChatSessionTitle: vi.fn(),
}));

beforeEach(() => {
  Element.prototype.scrollTo = vi.fn();
  currentUserStore.clear();
  messageBubbleSpy.mockClear();
  vi.mocked(getCurrentUser).mockResolvedValue({ id: 'user1', username: 'fixture', displayName: '测试用户', role: 'user' });
  vi.mocked(listKnowledgeBases).mockResolvedValue({
    items: [{
      id: 'kb1',
      name: '制度库',
      description: '制度说明',
      createdAt: '2026-07-01T00:00:00Z',
      updatedAt: '2026-07-02T00:00:00Z',
      retrievalConfig: { vectorTopN: 20, rerankTopK: 5, scoreThreshold: 0.2, enableRerank: true, enableKeyword: true },
      answerConfig: { systemPromptAddition: '', answerLanguage: 'auto', allowGeneralKnowledge: false, model: '' },
    }],
  });
  const session = {
    id: 's1',
    knowledgeBaseId: 'kb1',
    title: '报销咨询',
    createdAt: '2026-07-01T00:00:00Z',
    updatedAt: '2026-07-02T00:00:00Z',
    archivedAt: null,
  };
  vi.mocked(listChatSessions).mockResolvedValue({ items: [session], total: 1, page: 1, pageSize: 50 });
  vi.mocked(getChatSession).mockResolvedValue(session);
  const citation = {
    documentId: 'doc-1',
    chunkId: 'chunk-1',
    filename: '差旅制度.md',
    content: '住宿上限 600 元。',
    pageNumber: null,
    vectorScore: 0.9,
    rerankScore: 0.95,
  };
  vi.mocked(listChatMessages).mockResolvedValue({
    items: [
      { id: 'm1', sessionId: 's1', role: 'user', content: '报销标准是什么？', citations: [], createdAt: '2026-07-02T00:00:00Z' },
      { id: 'm2', sessionId: 's1', role: 'assistant', content: '住宿上限 600 元。[source:1]', citations: [citation], answerStatus: 'answered', createdAt: '2026-07-02T00:00:01Z' },
    ],
  });
  vi.mocked(getDocument).mockResolvedValue({
    id: 'doc-1',
    knowledgeBaseId: 'kb1',
    filename: '差旅制度.md',
    fileType: 'md',
    fileSize: 100,
    status: 'completed',
    errorMessage: null,
    createdAt: '',
    updatedAt: '',
  });
  vi.mocked(getDocumentPreview).mockResolvedValue({
    id: 'doc-1',
    filename: '差旅制度.md',
    kind: 'text',
    fileType: 'md',
    contentType: 'text/plain',
    content: '原文：住宿上限 600 元。',
    downloadUrl: '',
  });
});

it('does not re-render existing message bubbles while typing and still opens citations with message context', async () => {
  const user = userEvent.setup();
  renderWithRouter(
    <Routes><Route path="/chat/:sessionId" element={<ChatPage />} /></Routes>,
    ['/chat/s1'],
  );

  await screen.findByText(/住宿上限 600 元/);
  const input = screen.getByRole('textbox', { name: '输入问题' });
  await waitFor(() => expect(input).not.toBeDisabled());

  const rendersBeforeTyping = messageBubbleSpy.mock.calls.length;
  expect(rendersBeforeTyping).toBeGreaterThan(0);

  await user.type(input, '打字不应该重渲染历史消息');
  expect(input).toHaveValue('打字不应该重渲染历史消息');
  expect(messageBubbleSpy).toHaveBeenCalledTimes(rendersBeforeTyping);

  await user.click(screen.getByRole('button', { name: '查看来源 1：差旅制度.md' }));
  expect(await screen.findByText('原文：', { exact: false })).toBeInTheDocument();
  expect(getDocumentPreview).toHaveBeenCalledWith('doc-1');
});
