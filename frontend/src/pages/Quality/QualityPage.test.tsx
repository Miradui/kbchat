import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ToastProvider } from '../../components/feedback/ToastProvider';
import { renderWithRouter } from '../../test/render';
import type {
  ChatKnowledgeGapListResponse,
  ChatQualityFeedbackListResponse,
  ChatQualityOverview,
  ChatUsageResponse,
  KnowledgeBase,
} from '../../types/api';
import { QualityPage } from './QualityPage';
import { getChatUsage, getCurrentUser } from '../../api/resources';
import { currentUserStore } from '../../store/currentUserStore';

vi.mock('../../api/resources', () => ({
  getChatQualityOverview: vi.fn(),
  getChatUsage: vi.fn(),
  getCurrentUser: vi.fn(),
  listChatKnowledgeGaps: vi.fn(),
  listKnowledgeBases: vi.fn(),
  listNegativeChatFeedback: vi.fn(),
  logout: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(() => {
  currentUserStore.clear();
  vi.mocked(getCurrentUser).mockReset().mockResolvedValue({ id: 'user-1', username: 'admin', displayName: '管理员', role: 'admin' });
  vi.mocked(getChatUsage).mockReset().mockImplementation(async (params) => (params?.groupBy === 'model' ? usageByModel : params?.groupBy === 'purpose' ? usageByPurpose : usageByDay));
});

const usageByDay: ChatUsageResponse = {
  from: '2026-09-15T00:00:00Z', to: '2026-09-21T23:59:59Z', groupBy: 'day',
  items: [
    { groupKey: '2026-09-15', groupLabel: '2026-09-15', promptTokens: 1000, completionTokens: 200, totalTokens: 1200, calls: 3, estimatedCost: null },
    // 09-16 and 09-17 are deliberately absent: the chart must fill them with zero.
    { groupKey: '2026-09-18', groupLabel: '2026-09-18', promptTokens: 4000, completionTokens: 800, totalTokens: 4800, calls: 9, estimatedCost: null },
  ],
  totalPromptTokens: 5000, totalCompletionTokens: 1000, totalTokens: 6000,
  pricingConfigured: false, estimatedCost: null, unpricedModels: [],
};

const usageByModel: ChatUsageResponse = {
  from: '2026-09-15T00:00:00Z', to: '2026-09-21T23:59:59Z', groupBy: 'model',
  items: [
    { groupKey: 'gpt-4o-mini', groupLabel: 'gpt-4o-mini', promptTokens: 4000, completionTokens: 800, totalTokens: 4800, calls: 9, estimatedCost: 0.0123 },
    { groupKey: 'local-llm', groupLabel: 'local-llm', promptTokens: 1000, completionTokens: 200, totalTokens: 1200, calls: 3, estimatedCost: null },
  ],
  totalPromptTokens: 5000, totalCompletionTokens: 1000, totalTokens: 6000,
  pricingConfigured: true, estimatedCost: 0.0123, unpricedModels: ['local-llm'],
};

const usageByPurpose: ChatUsageResponse = {
  from: '2026-09-15T00:00:00Z', to: '2026-09-21T23:59:59Z', groupBy: 'purpose',
  items: [
    { groupKey: 'answer', groupLabel: '', promptTokens: 4000, completionTokens: 800, totalTokens: 4800, calls: 9, estimatedCost: null },
    { groupKey: 'intent', groupLabel: '', promptTokens: 900, completionTokens: 100, totalTokens: 1000, calls: 9, estimatedCost: null },
    { groupKey: 'future-purpose', groupLabel: '', promptTokens: 100, completionTokens: 100, totalTokens: 200, calls: 1, estimatedCost: null },
  ],
  totalPromptTokens: 5000, totalCompletionTokens: 1000, totalTokens: 6000,
  pricingConfigured: false, estimatedCost: null, unpricedModels: [],
};

const overview: ChatQualityOverview = {
  period: 'month', startAt: '2026-08-01T00:00:00Z', endAt: '2026-08-19T00:00:00Z',
  answerCount: 10, feedbackCount: 6, positiveFeedbackCount: 4, negativeFeedbackCount: 2,
  knowledgeAnswerCount: 6, withoutCitationsCount: 3, unclassifiedAnswerCount: 0,
  feedbackCoverage: 0.6, positiveRate: 2 / 3, withoutCitationsRate: 0.5,
};

const knowledgeBase: KnowledgeBase = {answerConfig: { systemPromptAddition: '', answerLanguage: 'auto' as const, allowGeneralKnowledge: false, model: '' },
  id: 'kb-1', name: '产品知识库', description: '', retrievalConfig: {enableKeyword: true,
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function createSources() {  return {
    loadOverview: vi.fn().mockResolvedValue(overview),
    loadFeedback: vi.fn().mockResolvedValue(feedback),
    loadKnowledgeGaps: vi.fn().mockResolvedValue(gaps),
    loadKnowledgeBases: vi.fn().mockResolvedValue([knowledgeBase]),
    loadEvaluationCases: vi.fn().mockResolvedValue([]),
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
    expect(within(feedbackPanel).getByRole('link', { name: /查看会话/ })).toHaveAttribute('href', '/chat/session-1?messageId=message-1');
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

  it('drops the previous range while the newly filtered data loads', async () => {
    const user = userEvent.setup();
    const sources = createSources();
    const pending = deferred<ChatQualityOverview>();
    renderWithRouter(<QualityPage sources={sources} />, ['/quality']);
    await screen.findByText('60%');

    sources.loadOverview.mockReturnValueOnce(pending.promise);
    await user.selectOptions(screen.getByRole('combobox', { name: '质量知识库' }), 'kb-1');

    // A panel only shows its skeleton when it has no data, so leaving the old rows
    // in place presented the previous range's numbers as the new filter's answer.
    await waitFor(() => expect(screen.queryByText('60%')).not.toBeInTheDocument());
    await act(async () => { pending.resolve(overview); });
    expect(await screen.findByText('60%')).toBeInTheDocument();
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

  it('offers every knowledge gap as a prefilled test question', async () => {
    const user = userEvent.setup();
    const sources = createSources();
    renderWithRouter(<QualityPage sources={sources} />, ['/quality']);
    const gapList = await screen.findByLabelText('知识缺口列表');

    for (const question of ['支持跨境退货吗？', '运费怎么算？', '帮我伪造一份合同', '发票要求']) {
      const row = within(gapList).getByText(question).closest('article') as HTMLElement;
      expect(within(row).getByRole('button', { name: '保存为测试问题' })).toBeEnabled();
    }

    const cluster = within(gapList).getByText('发票要求').closest('article') as HTMLElement;
    await user.click(within(cluster).getByRole('button', { name: '保存为测试问题' }));
    expect(sources.loadEvaluationCases).toHaveBeenCalledWith('kb-1');
    const dialog = await screen.findByRole('dialog', { name: '保存测试问题' });
    expect(within(dialog).getByRole('textbox', { name: '测试问题' })).toHaveValue('发票要求');
  });

  it('says a gap question is already in the test set instead of opening a duplicate', async () => {
    const user = userEvent.setup();
    const sources = createSources();
    sources.loadEvaluationCases.mockResolvedValue([{
      id: 'case-1', knowledgeBaseId: 'kb-1', question: '  支持跨境退货吗？ ', expectedAnswer: '', requiredKeywords: [], requireCitation: true,
      createdAt: '2026-08-12T00:00:00Z', updatedAt: '2026-08-12T00:00:00Z',
    }]);
    renderWithRouter(<QualityPage sources={sources} />, ['/quality']);
    const gapList = await screen.findByLabelText('知识缺口列表');
    const row = within(gapList).getByText('支持跨境退货吗？').closest('article') as HTMLElement;

    await user.click(within(row).getByRole('button', { name: '保存为测试问题' }));

    expect(await within(row).findByRole('status')).toHaveTextContent('该问题已在此知识库的测试集中');
    expect(screen.queryByRole('dialog', { name: '保存测试问题' })).not.toBeInTheDocument();
  });

  it('directs ordinary users to an administrator instead of the restricted diagnostics page', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue({ id: 'reader', username: 'reader', displayName: '普通用户', role: 'user' });
    renderWithRouter(<QualityPage sources={createSources()} />, ['/quality']);
    const gapList = await screen.findByLabelText('知识缺口列表');
    const failed = within(gapList).getByText('运费怎么算？').closest('article') as HTMLElement;
    await waitFor(() => expect(within(failed).getByText(/请联系系统管理员/)).toBeInTheDocument());
    expect(within(failed).queryByRole('link', { name: /查看系统状态/ })).not.toBeInTheDocument();
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

  describe('usage tab', () => {
    it('fetches the last 7 days by day and renders totals, a chart and the table', async () => {
      renderWithRouter(<QualityPage sources={createSources()} />, ['/quality?tab=usage']);

      const chart = await screen.findByRole('img', { name: /token 用量折线图/ });
      expect(chart).toHaveAccessibleName(expect.stringContaining('峰值 4,800 tokens（2026-09-18）'));
      expect(vi.mocked(getChatUsage)).toHaveBeenLastCalledWith(expect.objectContaining({ groupBy: 'day', from: expect.any(String), to: expect.any(String) }));
      expect(vi.mocked(getChatUsage)).toHaveBeenLastCalledWith(expect.not.objectContaining({ knowledgeBaseId: expect.anything() }));

      const totals = screen.getByRole('group', { name: '用量总计' });
      expect(within(totals).getByText('5,000')).toBeInTheDocument();
      expect(within(totals).getByText('1,000')).toBeInTheDocument();
      expect(within(totals).getByText('6,000')).toBeInTheDocument();
      // 调用次数 is the sum of the rows, which the server does not total.
      expect(within(totals).getByText('12')).toBeInTheDocument();
      expect(within(totals).queryByText('估算成本')).not.toBeInTheDocument();
      expect(screen.getByText('未配置 MODEL_PRICING，仅显示 token 数')).toBeInTheDocument();

      // The chart and table fill the missing days so the line is continuous.
      const table = screen.getByRole('table');
      expect(within(table).getAllByRole('row')).toHaveLength(1 + 7);
      expect(within(table).getByRole('cell', { name: '2026-09-16' })).toBeInTheDocument();
      expect(within(table).getByRole('cell', { name: '4,800' })).toBeInTheDocument();
    });

    it('passes the knowledge base filter through to the usage request', async () => {
      renderWithRouter(<QualityPage sources={createSources()} />, ['/quality?tab=usage&knowledgeBaseId=kb-1']);
      await screen.findByRole('img', { name: /token 用量折线图/ });
      expect(vi.mocked(getChatUsage)).toHaveBeenLastCalledWith(expect.objectContaining({ groupBy: 'day', knowledgeBaseId: 'kb-1' }));
    });

    it('refetches by model and shows the cost column with the unpriced note', async () => {
      const user = userEvent.setup();
      renderWithRouter(<QualityPage sources={createSources()} />, ['/quality?tab=usage']);
      await screen.findByRole('img', { name: /token 用量折线图/ });

      await user.click(within(screen.getByRole('group', { name: '分组' })).getByRole('button', { name: '按模型' }));

      await waitFor(() => expect(vi.mocked(getChatUsage)).toHaveBeenLastCalledWith(expect.objectContaining({ groupBy: 'model' })));
      const table = await screen.findByRole('table');
      await within(table).findByRole('columnheader', { name: '估算成本' });
      expect(within(table).getByRole('columnheader', { name: '名称' })).toBeInTheDocument();
      expect(within(table).getByRole('cell', { name: 'gpt-4o-mini' })).toBeInTheDocument();
      expect(within(table).getByRole('cell', { name: '0.0123' })).toBeInTheDocument();
      // A model without a price shows a dash, never 0.
      expect(within(table).getByRole('cell', { name: '—' })).toBeInTheDocument();
      expect(screen.queryByRole('img', { name: /token 用量折线图/ })).not.toBeInTheDocument();

      const totals = screen.getByRole('group', { name: '用量总计' });
      expect(within(totals).getByText('估算成本')).toBeInTheDocument();
      expect(within(totals).getByText('0.0123')).toBeInTheDocument();
      expect(screen.getByText(/以下模型未配置价格.*local-llm/)).toBeInTheDocument();
      expect(screen.queryByText('未配置 MODEL_PRICING，仅显示 token 数')).not.toBeInTheDocument();
    });

    it('groups by purpose with readable labels', async () => {
      const user = userEvent.setup();
      renderWithRouter(<QualityPage sources={createSources()} />, ['/quality?tab=usage']);
      await screen.findByRole('img', { name: /token 用量折线图/ });

      await user.click(within(screen.getByRole('group', { name: '分组' })).getByRole('button', { name: '按用途' }));

      await waitFor(() => expect(vi.mocked(getChatUsage)).toHaveBeenLastCalledWith(expect.objectContaining({ groupBy: 'purpose' })));
      const table = await screen.findByRole('table');
      expect(await within(table).findByRole('cell', { name: '回答生成' })).toBeInTheDocument();
      expect(within(table).getByRole('cell', { name: '意图分类' })).toBeInTheDocument();
      // An unknown purpose from a newer server still shows its key.
      expect(within(table).getByRole('cell', { name: 'future-purpose' })).toBeInTheDocument();
    });

    it('refetches when the range preset changes', async () => {
      const user = userEvent.setup();
      renderWithRouter(<QualityPage sources={createSources()} />, ['/quality?tab=usage']);
      await screen.findByRole('img', { name: /token 用量折线图/ });
      const [firstCall] = vi.mocked(getChatUsage).mock.calls.at(-1) ?? [];

      await user.click(screen.getByRole('button', { name: '最近 30 天' }));

      await waitFor(() => expect(vi.mocked(getChatUsage).mock.calls.length).toBeGreaterThan(1));
      const [lastCall] = vi.mocked(getChatUsage).mock.calls.at(-1) ?? [];
      expect(lastCall?.groupBy).toBe('day');
      expect(Date.parse(lastCall?.from ?? '')).toBeLessThan(Date.parse(firstCall?.from ?? ''));
    });

    it('shows the error state when the usage request fails and supports retry', async () => {
      vi.mocked(getChatUsage).mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(usageByDay);
      const user = userEvent.setup();
      renderWithRouter(<QualityPage sources={createSources()} />, ['/quality?tab=usage']);
      expect(await screen.findByRole('alert')).toHaveTextContent('用量统计加载失败');
      await user.click(screen.getByRole('button', { name: '重试' }));
      expect(await screen.findByRole('img', { name: /token 用量折线图/ })).toBeInTheDocument();
    });

    it('supports keyboard navigation across daily chart points', async () => {
      const user = userEvent.setup();
      renderWithRouter(<QualityPage sources={createSources()} />, ['/quality?tab=usage']);
      const chart = await screen.findByRole('img', { name: /token 用量折线图/ });
      chart.focus();
      await user.keyboard('{ArrowRight}');
      expect(screen.getByText(/次调用/)).toBeInTheDocument();
      await user.keyboard('{Escape}');
      expect(screen.queryByText(/次调用/)).not.toBeInTheDocument();
    });

    it('shows an empty state when no usage was recorded', async () => {
      vi.mocked(getChatUsage).mockResolvedValue({ ...usageByDay, items: [], totalPromptTokens: 0, totalCompletionTokens: 0, totalTokens: 0 });
      renderWithRouter(<QualityPage sources={createSources()} />, ['/quality?tab=usage']);
      expect(await screen.findByText('暂无用量数据')).toBeInTheDocument();
      expect(screen.queryByRole('img', { name: /token 用量折线图/ })).not.toBeInTheDocument();
    });
  });
});
