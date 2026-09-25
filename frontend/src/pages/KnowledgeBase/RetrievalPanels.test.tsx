import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ToastProvider } from '../../components/feedback/ToastProvider';
import { renderWithRouter } from '../../test/render';
import type { KnowledgeBase } from '../../types/api';
import { RetrievalConfigForm } from './RetrievalConfigForm';
import { RetrievalTestPanel } from './RetrievalTestPanel';

const resources = vi.hoisted(() => ({ updateKnowledgeBase: vi.fn(), searchKnowledgeBase: vi.fn() }));
vi.mock('../../api/resources', () => resources);
const capabilities = vi.hoisted(() => ({ rerankEnabled: true, keywordSearchEnabled: true, retrieval: { maxVectorTopN: 100, maxRerankTopK: 20 } }));
vi.mock('../../hooks/useSystemCapabilities', () => ({
  useSystemCapabilities: () => capabilities,
}));

const knowledgeBase: KnowledgeBase = {answerConfig: { systemPromptAddition: '', answerLanguage: 'auto' as const, allowGeneralKnowledge: false, model: '' },
  id: 'kb1', name: '检索验收', description: '', visibility: 'private', effectiveRole: 'owner',
  retrievalConfig: { vectorTopN: 30, rerankTopK: 5, scoreThreshold: 0.3, enableRerank: true, enableKeyword: true },
  createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.resetAllMocks();
  capabilities.keywordSearchEnabled = true;
});

describe('RetrievalConfigForm', () => {
  it('locks the form and deduplicates submission, retaining the failed draft until reset', async () => {
    const user = userEvent.setup();
    const pending = deferred<KnowledgeBase>();
    resources.updateKnowledgeBase.mockReturnValue(pending.promise);
    renderWithRouter(<RetrievalConfigForm knowledgeBase={knowledgeBase} onUpdated={vi.fn()} />);
    const input = screen.getByRole('spinbutton', { name: '向量召回数量' });
    fireEvent.change(input, { target: { value: '31' } });
    act(() => {
      fireEvent.submit(input.closest('form')!);
      fireEvent.submit(input.closest('form')!);
    });
    expect(resources.updateKnowledgeBase).toHaveBeenCalledOnce();
    for (const field of screen.getAllByRole('spinbutton')) expect(field).toBeDisabled();
    for (const checkbox of screen.getAllByRole('checkbox')) expect(checkbox).toBeDisabled();
    expect(screen.getByRole('button', { name: '重置' })).toBeDisabled();
    await act(async () => pending.reject(new Error('保存暂不可用')));
    expect(screen.getByRole('alert')).toHaveTextContent('检索配置保存失败');
    expect(input).toBeEnabled();
    expect(input).toHaveValue(31);
    await user.click(screen.getByRole('button', { name: '重置' }));
    expect(input).toHaveValue(30);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('saves the submitted config once and ignores completion after leaving the page', async () => {
    const pending = deferred<KnowledgeBase>();
    const onUpdated = vi.fn();
    resources.updateKnowledgeBase.mockReturnValue(pending.promise);
    const view = render(<ToastProvider><RetrievalConfigForm knowledgeBase={knowledgeBase} onUpdated={onUpdated} /></ToastProvider>);
    const input = screen.getByRole('spinbutton', { name: '向量召回数量' });
    fireEvent.change(input, { target: { value: '31' } });
    fireEvent.submit(input.closest('form')!);
    expect(resources.updateKnowledgeBase).toHaveBeenCalledWith('kb1', expect.objectContaining({ retrievalConfig: { ...knowledgeBase.retrievalConfig, vectorTopN: 31 } }));
    view.unmount();
    await act(async () => pending.resolve({ ...knowledgeBase, retrievalConfig: { ...knowledgeBase.retrievalConfig, vectorTopN: 31 } }));
    expect(onUpdated).not.toHaveBeenCalled();
    expect(screen.queryByText('检索配置已保存')).not.toBeInTheDocument();
  });

  it('saves the keyword recall toggle and explains the fusion threshold when rerank is off', async () => {
    const user = userEvent.setup();
    resources.updateKnowledgeBase.mockResolvedValue(knowledgeBase);
    renderWithRouter(<RetrievalConfigForm knowledgeBase={knowledgeBase} onUpdated={vi.fn()} />);
    const keywordToggle = screen.getByRole('checkbox', { name: /启用关键词召回/ });
    expect(keywordToggle).toBeChecked();
    expect(screen.queryByText(/融合分/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: /启用精排/ }));
    expect(screen.getByText(/最低相关度按两路融合分/)).toBeInTheDocument();
    await user.click(keywordToggle);
    expect(screen.queryByText(/融合分/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '保存配置' }));
    expect(resources.updateKnowledgeBase).toHaveBeenCalledWith('kb1', expect.objectContaining({
      retrievalConfig: { ...knowledgeBase.retrievalConfig, enableRerank: false, enableKeyword: false },
    }));
  });

  it('warns when the server has keyword recall switched off globally', () => {
    capabilities.keywordSearchEnabled = false;
    renderWithRouter(<RetrievalConfigForm knowledgeBase={knowledgeBase} onUpdated={vi.fn()} />);
    expect(screen.getByRole('status')).toHaveTextContent('KEYWORD_SEARCH_ENABLED=false');
  });
});

describe('RetrievalTestPanel', () => {
  it('separates loading, error, and successful empty results and supports retry', async () => {
    const user = userEvent.setup();
    const pending = deferred<{ items: [] }>();
    resources.searchKnowledgeBase.mockReturnValueOnce(pending.promise).mockResolvedValue({ items: [] });
    render(<RetrievalTestPanel knowledgeBase={knowledgeBase} />);
    await user.type(screen.getByRole('searchbox'), '报销规定');
    act(() => {
      fireEvent.submit(screen.getByRole('search'));
      fireEvent.submit(screen.getByRole('search'));
    });
    expect(resources.searchKnowledgeBase).toHaveBeenCalledOnce();
    expect(screen.getByRole('status')).toHaveTextContent('正在检索相关片段');
    expect(screen.queryByRole('heading', { name: '还没有检索' })).not.toBeInTheDocument();
    await act(async () => pending.reject(new Error('检索暂不可用')));
    expect(screen.getByRole('alert')).toHaveTextContent('知识库内检索失败');
    expect(screen.getByRole('searchbox')).toHaveValue('报销规定');
    expect(screen.queryByRole('heading', { name: /还没有检索|没有召回结果/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '检索' }));
    expect(await screen.findByRole('heading', { name: '没有召回结果' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('clears state on a library change and an old failure cannot end the new search', async () => {
    const user = userEvent.setup();
    const oldSearch = deferred<{ items: [] }>();
    const nextSearch = deferred<{ items: [] }>();
    resources.searchKnowledgeBase.mockReturnValueOnce(oldSearch.promise).mockReturnValueOnce(nextSearch.promise);
    const view = render(<RetrievalTestPanel knowledgeBase={knowledgeBase} />);
    await user.type(screen.getByRole('searchbox'), '旧库问题');
    await user.click(screen.getByRole('button', { name: '检索' }));
    view.rerender(<RetrievalTestPanel knowledgeBase={{ ...knowledgeBase, id: 'kb2' }} />);
    expect(screen.getByRole('searchbox')).toHaveValue('');
    expect(screen.getByRole('heading', { name: '还没有检索' })).toBeInTheDocument();
    await user.type(screen.getByRole('searchbox'), '新库问题');
    await user.click(screen.getByRole('button', { name: '检索' }));
    await act(async () => oldSearch.reject(new Error('旧库请求失败')));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('正在检索相关片段');
    expect(screen.getByRole('button', { name: '检索中' })).toBeDisabled();
    await act(async () => nextSearch.resolve({ items: [] }));
    expect(screen.getByRole('heading', { name: '没有召回结果' })).toBeInTheDocument();
    expect(resources.searchKnowledgeBase).toHaveBeenLastCalledWith('kb2', expect.objectContaining({ query: '新库问题' }));
  });

  it('forwards enableKeyword and renders the keyword and fusion debug stages verbatim', async () => {
    const user = userEvent.setup();
    resources.searchKnowledgeBase.mockResolvedValue({
      items: [{ chunkId: 'c2', documentId: 'd1', filename: 'faq.md', content: '错误码 E-4021', pageNumber: null, vectorScore: 0, keywordScore: 0.42, rerankScore: 0.9 }],
      rerankFallback: null,
      debug: {
        query: 'E-4021',
        vectorStage: { status: 'completed', items: [{ chunkId: 'c1', documentId: 'd1', filename: 'faq.md', content: '向量片段', pageNumber: null, vectorScore: 0.8, rank: 1 }] },
        keywordStage: { status: 'completed', items: [{ chunkId: 'c2', documentId: 'd1', filename: 'faq.md', content: '错误码 E-4021', pageNumber: 3, keywordScore: 0.42, rank: 1 }] },
        fusionStage: { status: 'completed', items: [
          { chunkId: 'c1', pageNumber: null, vectorRank: 1, keywordRank: null, fusionScore: 0.5, vectorScore: 0.8, keywordScore: null, rank: 1 },
          { chunkId: 'c2', pageNumber: 3, vectorRank: null, keywordRank: 1, fusionScore: 0.5, vectorScore: 0, keywordScore: 0.42, rank: 2 },
        ] },
        rerankStage: { status: 'completed', input: [{ chunkId: 'c1', pageNumber: null, rank: 1 }, { chunkId: 'c2', pageNumber: 3, rank: 2 }], output: [{ chunkId: 'c2', pageNumber: 3, rerankScore: 0.9, rank: 1 }] },
        finalStage: { items: [{ chunkId: 'c2', pageNumber: 3, vectorScore: 0, keywordScore: 0.42, fusionScore: 0.5, rerankScore: 0.9, rank: 1 }] },
        rerankFallback: null,
      },
    });
    render(<RetrievalTestPanel knowledgeBase={knowledgeBase} />);
    await user.click(screen.getByRole('checkbox', { name: '显示调试信息' }));
    await user.type(screen.getByRole('searchbox'), 'E-4021');
    await user.click(screen.getByRole('button', { name: '检索' }));
    expect(resources.searchKnowledgeBase).toHaveBeenCalledWith('kb1', expect.objectContaining({ enableKeyword: true, debug: true }));
    const debug = await screen.findByRole('region', { name: '检索调试信息' });
    expect(debug).toHaveTextContent('关键词召回 (已完成 · 1)');
    expect(debug).toHaveTextContent('融合 (已融合 · 2)');
    expect(debug).toHaveTextContent('向量第 1 · 关键词第 —');
    expect(debug).toHaveTextContent('向量第 — · 关键词第 1');
    expect(debug).toHaveTextContent('关键词 0.42');
    expect(screen.getByText(/相关度 0\.00.*关键词 0\.42.*精排/)).toBeInTheDocument();
  });

  it('marks keyword recall as disabled and fusion as skipped when the library turned it off', async () => {
    const user = userEvent.setup();
    resources.searchKnowledgeBase.mockResolvedValue({
      items: [],
      rerankFallback: null,
      debug: {
        query: 'q',
        vectorStage: { status: 'completed', items: [] },
        keywordStage: { status: 'disabled', items: [] },
        fusionStage: { status: 'skipped', items: [] },
        rerankStage: { status: 'disabled', input: [], output: [] },
        finalStage: { items: [] },
        rerankFallback: null,
      },
    });
    render(<RetrievalTestPanel knowledgeBase={{ ...knowledgeBase, retrievalConfig: { ...knowledgeBase.retrievalConfig, enableKeyword: false } }} />);
    await user.click(screen.getByRole('checkbox', { name: '显示调试信息' }));
    await user.type(screen.getByRole('searchbox'), 'q');
    await user.click(screen.getByRole('button', { name: '检索' }));
    expect(resources.searchKnowledgeBase).toHaveBeenCalledWith('kb1', expect.objectContaining({ enableKeyword: false }));
    const debug = await screen.findByRole('region', { name: '检索调试信息' });
    expect(debug).toHaveTextContent('该知识库未启用关键词召回');
    expect(debug).toHaveTextContent('精排输入即向量召回结果');
  });
});
