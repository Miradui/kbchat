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
vi.mock('../../hooks/useSystemCapabilities', () => ({
  useSystemCapabilities: () => ({ rerankEnabled: true, retrieval: { maxVectorTopN: 100, maxRerankTopK: 20 } }),
}));

const knowledgeBase: KnowledgeBase = {
  id: 'kb1', name: '检索验收', description: '', visibility: 'private', effectiveRole: 'owner',
  retrievalConfig: { vectorTopN: 30, rerankTopK: 5, scoreThreshold: 0.3, enableRerank: true },
  createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

beforeEach(() => vi.resetAllMocks());

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
    expect(screen.getByRole('checkbox')).toBeDisabled();
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
    await user.click(screen.getByRole('button', { name: '检索', exact: true }));
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
    await user.click(screen.getByRole('button', { name: '检索', exact: true }));
    view.rerender(<RetrievalTestPanel knowledgeBase={{ ...knowledgeBase, id: 'kb2' }} />);
    expect(screen.getByRole('searchbox')).toHaveValue('');
    expect(screen.getByRole('heading', { name: '还没有检索' })).toBeInTheDocument();
    await user.type(screen.getByRole('searchbox'), '新库问题');
    await user.click(screen.getByRole('button', { name: '检索', exact: true }));
    await act(async () => oldSearch.reject(new Error('旧库请求失败')));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('正在检索相关片段');
    expect(screen.getByRole('button', { name: '检索中' })).toBeDisabled();
    await act(async () => nextSearch.resolve({ items: [] }));
    expect(screen.getByRole('heading', { name: '没有召回结果' })).toBeInTheDocument();
    expect(resources.searchKnowledgeBase).toHaveBeenLastCalledWith('kb2', expect.objectContaining({ query: '新库问题' }));
  });
});
