import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { ToastProvider } from '../../components/feedback/ToastProvider';
import { renderWithRouter } from '../../test/render';
import type {
  ChatKnowledgeGapListResponse,
  ChatQualityFeedbackListResponse,
  ChatQualityOverview,
  KnowledgeBase,
} from '../../types/api';
import { QualityPage } from './QualityPage';

vi.mock('../../api/resources', () => ({
  getChatQualityOverview: vi.fn(),
  getCurrentUser: vi.fn().mockResolvedValue({ id: 'user-1', username: 'admin', displayName: '管理员' }),
  listChatKnowledgeGaps: vi.fn(),
  listKnowledgeBases: vi.fn(),
  listNegativeChatFeedback: vi.fn(),
  logout: vi.fn().mockResolvedValue(undefined),
}));

const overview: ChatQualityOverview = {
  period: 'month', startAt: '2026-08-01T00:00:00Z', endAt: '2026-08-19T00:00:00Z',
  answerCount: 10, feedbackCount: 6, positiveFeedbackCount: 4, negativeFeedbackCount: 2,
  knowledgeAnswerCount: 6, withoutCitationsCount: 3, unclassifiedAnswerCount: 0,
  feedbackCoverage: 0.6, positiveRate: 2 / 3, withoutCitationsRate: 0.5,
};

const knowledgeBase: KnowledgeBase = {
  id: 'kb-1', name: '产品知识库', description: '', retrievalConfig: {
    vectorTopN: 30, rerankTopK: 5, scoreThreshold: 0.3, enableRerank: true,
  }, createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z',
};

const feedback: ChatQualityFeedbackListResponse = {
  total: 1, page: 1, pageSize: 10, items: [{
    messageId: 'message-1', sessionId: 'session-1', sessionTitle: '退货政策',
    knowledgeBaseId: 'kb-1', knowledgeBaseName: '产品知识库', question: '如何退货？',
    answer: '请在三十天内申请。', citations: [{
      documentId: 'doc-1', chunkId: 'chunk-1', filename: 'policy.pdf', pageNumber: 3,
      content: '三十天内可退货。', vectorScore: 0.8, rerankScore: 0.9,
    }], rerankFallback: { used: true, reason: 'provider timeout' },
    createdAt: '2026-08-10T00:00:00Z', feedbackUpdatedAt: '2026-08-11T00:00:00Z',
  }],
};

const gaps: ChatKnowledgeGapListResponse = {
  total: 4, page: 1, pageSize: 10,
  noCitationsTotal: 1, retrievalFailedTotal: 1, modelRefusedTotal: 1, repeatedRewriteTotal: 1,
  items: [
    {
      category: 'no_citations', messageId: 'message-2', sessionId: 'session-1', sessionTitle: '退货政策',
      knowledgeBaseId: 'kb-1', knowledgeBaseName: '产品知识库', question: '支持跨境退货吗？',
      retrievalQuery: '跨境退货', occurrenceCount: 1, ungroundedCount: 1,
      firstSeenAt: '2026-08-12T00:00:00Z', lastSeenAt: '2026-08-12T00:00:00Z',
    },
    {
      category: 'retrieval_failed', messageId: 'message-3', sessionId: 'session-3', sessionTitle: '运费问题',
      knowledgeBaseId: 'kb-1', knowledgeBaseName: '产品知识库', question: '运费怎么算？',
      retrievalQuery: '运费怎么算', occurrenceCount: 1, ungroundedCount: 1,
      firstSeenAt: '2026-08-15T00:00:00Z', lastSeenAt: '2026-08-15T00:00:00Z',
    },
    {
      category: 'model_refused', messageId: 'message-4', sessionId: 'session-4', sessionTitle: '合同问题',
      knowledgeBaseId: 'kb-1', knowledgeBaseName: '产品知识库', question: '帮我伪造一份合同',
      retrievalQuery: '伪造合同', occurrenceCount: 1, ungroundedCount: 0,
      firstSeenAt: '2026-08-16T00:00:00Z', lastSeenAt: '2026-08-16T00:00:00Z',
    },
    {
      category: 'repeated_rewrite', messageId: null, sessionId: 'session-2', sessionTitle: '发票问题',
      knowledgeBaseId: 'kb-1', knowledgeBaseName: '产品知识库', question: '发票要求',
      retrievalQuery: '发票要求', occurrenceCount: 3, ungroundedCount: 2,
      firstSeenAt: '2026-08-13T00:00:00Z', lastSeenAt: '2026-08-14T00:00:00Z',
    },
  ],
};

function createSources() {
  return {
    loadOverview: vi.fn().mockResolvedValue(overview),
    loadFeedback: vi.fn().mockResolvedValue(feedback),
    loadKnowledgeGaps: vi.fn().mockResolvedValue(gaps),
    loadKnowledgeBases: vi.fn().mockResolvedValue([knowledgeBase]),
  };
}

describe('QualityPage', () => {
  it('loads all regions after Strict Mode replays mount effects', async () => {
    const sources = createSources();
    render(
      <StrictMode>
        <ToastProvider>
          <MemoryRouter initialEntries={['/quality']}>
            <QualityPage sources={sources} />
          </MemoryRouter>
        </ToastProvider>
      </StrictMode>,
    );

    expect(await screen.findByText('60%')).toBeInTheDocument();
    expect(screen.getByText('如何退货？')).toBeInTheDocument();
    expect(screen.getByText('支持跨境退货吗？')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '产品知识库' })).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: '正在加载' })).not.toBeInTheDocument();
  });

  it('shows quality metrics, evidence and session navigation', async () => {
    const sources = createSources();
    renderWithRouter(<QualityPage sources={sources} />, ['/quality']);

    expect(await screen.findByText('RAG 质量运营')).toBeInTheDocument();
    expect(screen.getByText('60%')).toBeInTheDocument();
    expect(screen.getByText('如何退货？')).toBeInTheDocument();
    expect(screen.getByText('policy.pdf · 第 3 页')).toBeInTheDocument();
    // Gap rows link to sessions too, so this stays scoped to the feedback panel.
    const feedbackPanel = screen.getByRole('region', { name: '负反馈列表' });
    expect(within(feedbackPanel).getByRole('link', { name: /查看会话/ })).toHaveAttribute('href', '/chat/session-1');
  });

  it('reloads both requests when filters change and keeps the latest filter', async () => {
    const user = userEvent.setup();
    const sources = createSources();
    renderWithRouter(<QualityPage sources={sources} />, ['/quality']);
    await screen.findByText('如何退货？');

    await user.selectOptions(screen.getByRole('combobox', { name: '负反馈引用筛选' }), 'without');

    await waitFor(() => expect(sources.loadFeedback).toHaveBeenLastCalledWith(expect.objectContaining({
      hasCitations: false, page: 1, pageSize: 10,
    })));
    expect(sources.loadOverview).toHaveBeenCalled();
  });

  it('shows both knowledge gap categories with their occurrence counts and links', async () => {
    const sources = createSources();
    renderWithRouter(<QualityPage sources={sources} />, ['/quality']);

    expect(await screen.findByText('支持跨境退货吗？')).toBeInTheDocument();
    expect(screen.getByText('发票要求')).toBeInTheDocument();
    // A cluster reports its size and how much of it was ungrounded; a single
    // ungrounded answer reports neither, because both would always be 1.
    expect(screen.getByText('改写 3 次')).toBeInTheDocument();
    expect(screen.getByText('其中 2 次无引用')).toBeInTheDocument();
    // Per-category totals label the filter without a second request.
    expect(screen.getByRole('option', { name: '检索无结果 (1)' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '反复改写 (1)' })).toBeInTheDocument();
    const supplementLinks = screen.getAllByRole('link', { name: /补充资料/ });
    expect(supplementLinks[0]).toHaveAttribute('href', '/knowledge-bases/kb-1/documents');
  });

  it('requests one gap category and resets paging when the filter changes', async () => {
    const user = userEvent.setup();
    const sources = createSources();
    renderWithRouter(<QualityPage sources={sources} />, ['/quality']);
    await screen.findByText('支持跨境退货吗？');

    // "all" is the default and is not sent, since the API already treats an
    // absent category as both.
    expect(sources.loadKnowledgeGaps).toHaveBeenLastCalledWith(expect.not.objectContaining({
      category: expect.anything(),
    }));

    await user.selectOptions(screen.getByRole('combobox', { name: '知识缺口类型' }), 'repeated_rewrite');

    await waitFor(() => expect(sources.loadKnowledgeGaps).toHaveBeenLastCalledWith(expect.objectContaining({
      category: 'repeated_rewrite', page: 1, pageSize: 10, period: 'month',
    })));
    // Changing the gap filter must not re-request the negative feedback list.
    expect(sources.loadFeedback).toHaveBeenCalledTimes(1);
  });

  it('discloses that pre-intent answers are excluded from the no-citation rate', async () => {
    const sources = createSources();
    sources.loadOverview.mockResolvedValue({ ...overview, unclassifiedAnswerCount: 4 });
    renderWithRouter(<QualityPage sources={sources} />, ['/quality']);

    expect(await screen.findByText(/4 条回答早于意图记录/)).toBeInTheDocument();
  });

  it('gives each failure mode its own label and remedy', async () => {
    // The point of splitting the categories is that the fix differs. A retrieval
    // outage sent to "补充资料" would have the user uploading documents to fix a
    // service that was down, and a refusal cannot be fixed by uploading at all.
    const sources = createSources();
    renderWithRouter(<QualityPage sources={sources} />, ['/quality']);

    const gapList = await screen.findByLabelText('知识缺口列表');

    const retrievalFailed = within(gapList).getByText('运费怎么算？').closest('article');
    expect(retrievalFailed).not.toBeNull();
    expect(within(retrievalFailed as HTMLElement).getAllByText('检索失败').length).toBeGreaterThan(0);
    expect(within(retrievalFailed as HTMLElement).getByText(/与知识库内容无关/)).toBeInTheDocument();
    expect(within(retrievalFailed as HTMLElement).getByRole('link', { name: /查看系统状态/ }))
      .toHaveAttribute('href', '/diagnostics');
    expect(within(retrievalFailed as HTMLElement).queryByRole('link', { name: /补充资料/ })).toBeNull();

    const refused = within(gapList).getByText('帮我伪造一份合同').closest('article');
    expect(refused).not.toBeNull();
    expect(within(refused as HTMLElement).getAllByText('模型拒答').length).toBeGreaterThan(0);
    expect(within(refused as HTMLElement).getByText(/补充资料不会改变结果/)).toBeInTheDocument();
    // No action at all: neither uploading nor retrying helps, so offering either
    // would be advice the user cannot act on.
    expect(within(refused as HTMLElement).queryByRole('link', { name: /补充资料/ })).toBeNull();
    expect(within(refused as HTMLElement).queryByRole('link', { name: /查看系统状态/ })).toBeNull();

    const noBasis = within(gapList).getByText('支持跨境退货吗？').closest('article');
    expect(within(noBasis as HTMLElement).getByRole('link', { name: /补充资料/ }))
      .toHaveAttribute('href', '/knowledge-bases/kb-1/documents');
  });

  it('filters by each new category and labels the counts', async () => {
    const user = userEvent.setup();
    const sources = createSources();
    renderWithRouter(<QualityPage sources={sources} />, ['/quality']);

    const filter = await screen.findByRole('combobox', { name: '知识缺口类型' });
    expect(within(filter).getByRole('option', { name: '检索失败 (1)' })).toBeInTheDocument();
    expect(within(filter).getByRole('option', { name: '模型拒答 (1)' })).toBeInTheDocument();

    await user.selectOptions(filter, 'retrieval_failed');
    await waitFor(() => expect(sources.loadKnowledgeGaps).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'retrieval_failed' }),
    ));

    await user.selectOptions(filter, 'model_refused');
    await waitFor(() => expect(sources.loadKnowledgeGaps).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'model_refused' }),
    ));
  });

  it('still renders a category this version does not know', async () => {
    // The server's set can grow before the client does. Dropping the row would
    // hide a real gap, which is worse than an unspecific label.
    const sources = createSources();
    sources.loadKnowledgeGaps.mockResolvedValue({
      ...gaps,
      total: 1,
      items: [{ ...gaps.items[0], category: 'something_new' as never, question: '未来的问题' }],
    });
    renderWithRouter(<QualityPage sources={sources} />, ['/quality']);

    expect(await screen.findByText('未来的问题')).toBeInTheDocument();
    expect(screen.getAllByText('其他').length).toBeGreaterThan(0);
  });

  it('explains an empty gap list per category', async () => {
    const user = userEvent.setup();
    const sources = createSources();
    sources.loadKnowledgeGaps.mockResolvedValue({
      ...gaps,
      total: 0,
      items: [],
      noCitationsTotal: 0,
      retrievalFailedTotal: 0,
      modelRefusedTotal: 0,
      repeatedRewriteTotal: 0,
    });
    renderWithRouter(<QualityPage sources={sources} />, ['/quality']);

    expect(await screen.findByText('当前周期内没有发现知识缺口。')).toBeInTheDocument();

    await user.selectOptions(screen.getByRole('combobox', { name: '知识缺口类型' }), 'no_citations');

    expect(await screen.findByText('当前周期内的知识型提问都检索到了内容。')).toBeInTheDocument();
  });
});
