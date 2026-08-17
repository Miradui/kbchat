import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { exportChatSession, setChatMessageFeedback } from '../../api/resources';
import { ToastProvider } from '../../components/feedback/ToastProvider';
import { downloadBlob } from '../../utils/download';
import { ChatPage } from './ChatPage';

const threadMocks = vi.hoisted(() => ({
  hasPendingWrite: vi.fn(() => false),
  updateMessageFeedback: vi.fn(),
}));

vi.mock('../../api/resources', () => ({
  archiveChatSession: vi.fn(),
  deleteChatSession: vi.fn(),
  exportChatSession: vi.fn(),
  setChatMessageFeedback: vi.fn(),
  unarchiveChatSession: vi.fn(),
  updateChatSessionTitle: vi.fn(),
}));
vi.mock('../../utils/download', () => ({ downloadBlob: vi.fn() }));
vi.mock('../../layouts/AppShell', () => ({
  AppShell: ({ children, topbarActions }: { children: ReactNode; topbarActions?: ReactNode }) => (
    <><div>{topbarActions}</div>{children}</>
  ),
}));
vi.mock('../../hooks/useMediaQuery', () => ({ useMediaQuery: () => false }));
vi.mock('./ChatSessionRail', () => ({ ChatSessionRail: () => null }));
vi.mock('./ChatComposer', () => ({ ChatComposer: () => null }));
vi.mock('./useChatSessions', () => ({
  useChatSessions: () => ({
    sessions: [],
    sessionTotal: 0,
    knowledgeBases: [{ id: 'kb-1', name: '制度库', description: '' }],
    mergeSession: vi.fn(),
    removeSession: vi.fn(),
    reloadSessions: vi.fn().mockResolvedValue(undefined),
    sessionsError: '',
    sessionsLoading: false,
    knowledgeBasesLoading: false,
  }),
}));
vi.mock('./useChatThread', () => ({
  useChatThread: () => ({
    session: {
      id: 'session-1',
      knowledgeBaseId: 'kb-1',
      title: '退货/政策',
      createdAt: '2026-08-10T00:00:00Z',
      updatedAt: '2026-08-10T00:00:00Z',
      archivedAt: null,
    },
    setSession: vi.fn(),
    messages: [{
      id: 'assistant-1',
      sessionId: 'session-1',
      role: 'assistant',
      content: '回答内容',
      citations: [],
      feedback: null,
      createdAt: '2026-08-10T00:00:01Z',
    }],
    loading: false,
    loadError: '',
    sending: false,
    pendingQuestion: '',
    failedSend: null,
    unconfirmedSend: null,
    needsResendDecision: false,
    regeneration: null,
    regeneratingId: null,
    rerankFallback: null,
    streamingAnswer: '',
    streamingCitations: [],
    reload: vi.fn(),
    send: vi.fn(),
    checkSendNow: vi.fn(),
    regenerate: vi.fn(),
    checkRegeneration: vi.fn(),
    updateMessageFeedback: threadMocks.updateMessageFeedback,
    dismissFailedSend: vi.fn(),
    hasPendingWrite: threadMocks.hasPendingWrite,
  }),
}));

function renderChatPage() {
  return render(
    <MemoryRouter initialEntries={['/chat/session-1']}>
      <ToastProvider>
        <Routes><Route element={<ChatPage />} path="/chat/:sessionId" /></Routes>
      </ToastProvider>
    </MemoryRouter>,
  );
}

describe('ChatPage gap actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    threadMocks.hasPendingWrite.mockReturnValue(false);
    Element.prototype.scrollTo = vi.fn();
  });

  it('downloads the current session as Markdown from the overflow menu', async () => {
    const blob = new Blob(['markdown'], { type: 'text/markdown' });
    vi.mocked(exportChatSession).mockResolvedValue(blob);
    const user = userEvent.setup();
    renderChatPage();

    await user.click(screen.getByRole('button', { name: '会话操作' }));
    await user.click(screen.getByRole('menuitem', { name: '导出会话' }));

    await waitFor(() => expect(exportChatSession).toHaveBeenCalledWith('session-1'));
    expect(downloadBlob).toHaveBeenCalledWith(blob, '退货_政策.md');
  });

  it('persists answer feedback and updates only that message', async () => {
    const feedback = {
      messageId: 'assistant-1',
      rating: 'positive' as const,
      updatedAt: '2026-08-10T00:02:00Z',
    };
    vi.mocked(setChatMessageFeedback).mockResolvedValue(feedback);
    const user = userEvent.setup();
    renderChatPage();

    await user.click(screen.getByRole('button', { name: '标记回答有帮助' }));

    await waitFor(() => expect(setChatMessageFeedback).toHaveBeenCalledWith('assistant-1', 'positive'));
    expect(threadMocks.updateMessageFeedback).toHaveBeenCalledWith('assistant-1', feedback);
    expect(await screen.findByText('已记录“有帮助”')).toBeInTheDocument();
  });
});
