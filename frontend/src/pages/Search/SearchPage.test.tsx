import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLocation, useNavigate } from 'react-router-dom';

import { globalSearch } from '../../api/resources';
import { renderWithRouter } from '../../test/render';
import type { GlobalSearchResponse } from '../../types/api';
import { SearchPage } from './SearchPage';

vi.mock('../../api/resources', () => ({
  globalSearch: vi.fn(),
  logout: vi.fn(),
}));

const mockedSearch = vi.mocked(globalSearch);
const knowledgeBaseResult = {
  type: 'knowledgeBase' as const,
  id: 'kb1',
  knowledgeBaseId: 'kb1',
  knowledgeBaseName: '员工知识库',
  title: '员工知识库结果',
  snippet: '制度',
};
const documentResult = {
  type: 'document' as const,
  id: 'd1',
  documentId: 'd1',
  knowledgeBaseId: 'kb1',
  knowledgeBaseName: '员工知识库',
  filename: 'handbook.pdf',
  title: '员工手册文档',
  snippet: '休假制度',
};

function RouterProbe() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output aria-label="当前位置">{location.pathname + location.search}</output>
      <button onClick={() => navigate(-1)} type="button">返回上一页</button>
    </>
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  mockedSearch.mockReset();
});

afterEach(() => vi.useRealTimers());

describe('SearchPage', () => {
  it('reads URL state, filters locally, preserves other params, and does not refetch for type changes', async () => {
    mockedSearch.mockResolvedValue({ items: [knowledgeBaseResult, documentResult] });
    const user = userEvent.setup();
    renderWithRouter(
      <><SearchPage /><RouterProbe /></>,
      ['/search?q=handbook&type=document&scope=owned'],
    );

    expect(screen.getByLabelText('搜索关键词')).toHaveValue('handbook');
    expect(await screen.findByText('员工手册文档')).toBeInTheDocument();
    expect(screen.queryByText('员工知识库结果')).not.toBeInTheDocument();
    expect(screen.getByRole('group', { name: '结果类型' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '文档 1' })).toHaveAttribute('aria-pressed', 'true');

    await user.click(screen.getByRole('button', { name: '知识库 1' }));

    expect(screen.getByLabelText('当前位置')).toHaveTextContent('/search?q=handbook&type=knowledgeBase&scope=owned');
    expect(await screen.findByText('员工知识库结果')).toBeInTheDocument();
    expect(mockedSearch).toHaveBeenCalledOnce();
  });

  it('debounces typed queries with replace while preserving URL state', async () => {
    vi.useFakeTimers();
    mockedSearch.mockResolvedValue({ items: [] });
    renderWithRouter(
      <><SearchPage /><RouterProbe /></>,
      ['/before', '/search?type=document&scope=owned'],
    );

    fireEvent.change(screen.getByLabelText('搜索关键词'), { target: { value: 'policy' } });
    act(() => vi.advanceTimersByTime(299));
    expect(screen.getByLabelText('当前位置')).toHaveTextContent('/search?type=document&scope=owned');
    expect(mockedSearch).not.toHaveBeenCalled();

    await act(async () => vi.advanceTimersByTime(1));
    expect(screen.getByLabelText('当前位置')).toHaveTextContent('/search?type=document&scope=owned&q=policy');
    expect(mockedSearch).toHaveBeenCalledWith('policy', expect.any(AbortSignal));

    fireEvent.click(screen.getByRole('button', { name: '返回上一页' }));
    expect(screen.getByLabelText('当前位置')).toHaveTextContent('/before');
  });

  it('uses push for explicit submit and removes only an empty q', async () => {
    mockedSearch.mockResolvedValue({ items: [] });
    const user = userEvent.setup();
    renderWithRouter(
      <><SearchPage /><RouterProbe /></>,
      ['/before', '/search?q=old&type=document&scope=owned'],
    );
    await waitFor(() => expect(mockedSearch).toHaveBeenCalledOnce());

    await user.clear(screen.getByLabelText('搜索关键词'));
    await user.click(screen.getByRole('button', { name: '搜索' }));

    expect(screen.getByLabelText('当前位置')).toHaveTextContent('/search?type=document&scope=owned');
    expect(mockedSearch).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button', { name: '返回上一页' }));
    expect(screen.getByLabelText('当前位置')).toHaveTextContent('/search?q=old&type=document&scope=owned');
  });

  it('aborts the previous signal and ignores a stale response', async () => {
    const first = deferred<GlobalSearchResponse>();
    const second = deferred<GlobalSearchResponse>();
    mockedSearch.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    renderWithRouter(<SearchPage />, ['/search?q=first']);
    await waitFor(() => expect(mockedSearch).toHaveBeenCalledOnce());
    const firstSignal = mockedSearch.mock.calls[0]?.[1];

    fireEvent.change(screen.getByLabelText('搜索关键词'), { target: { value: 'second' } });
    fireEvent.click(screen.getByRole('button', { name: '搜索' }));
    await waitFor(() => expect(mockedSearch).toHaveBeenCalledTimes(2));

    expect(firstSignal).toBeInstanceOf(AbortSignal);
    expect(firstSignal?.aborted).toBe(true);
    await act(async () => second.resolve({ items: [{ ...documentResult, id: 'd2', title: '第二个结果' }] }));
    expect(await screen.findByText('第二个结果')).toBeInTheDocument();

    await act(async () => first.resolve({ items: [{ ...documentResult, title: '过期结果' }] }));
    expect(screen.queryByText('过期结果')).not.toBeInTheDocument();
    expect(screen.getByText('第二个结果')).toBeInTheDocument();
  });

  it('does not show an error or clear the latest result for AbortError', async () => {
    const first = deferred<GlobalSearchResponse>();
    const aborted = deferred<GlobalSearchResponse>();
    mockedSearch.mockReturnValueOnce(first.promise).mockReturnValueOnce(aborted.promise);
    renderWithRouter(<SearchPage />, ['/search?q=first']);
    await act(async () => first.resolve({ items: [documentResult] }));
    expect(await screen.findByText('员工手册文档')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('搜索关键词'), { target: { value: 'second' } });
    fireEvent.click(screen.getByRole('button', { name: '搜索' }));
    await waitFor(() => expect(mockedSearch).toHaveBeenCalledTimes(2));
    await act(async () => aborted.reject(new DOMException('aborted', 'AbortError')));

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText('员工手册文档')).toBeInTheDocument();
  });

  it('falls back to all results for an invalid type', async () => {
    mockedSearch.mockResolvedValue({ items: [knowledgeBaseResult, documentResult] });
    renderWithRouter(<SearchPage />, ['/search?q=handbook&type=invalid']);

    expect(await screen.findByText('员工知识库结果')).toBeInTheDocument();
    expect(screen.getByText('员工手册文档')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '全部 2' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('normalizes whitespace-only q without dropping other URL state', async () => {
    renderWithRouter(
      <><SearchPage /><RouterProbe /></>,
      ['/search?q=%20%20&type=document&scope=owned'],
    );

    await waitFor(() => expect(screen.getByLabelText('当前位置')).toHaveTextContent('/search?type=document&scope=owned'));
    expect(mockedSearch).not.toHaveBeenCalled();
  });

  it('announces loading and supports retry after a search error', async () => {
    const failed = deferred<GlobalSearchResponse>();
    const retried = deferred<GlobalSearchResponse>();
    mockedSearch.mockReturnValueOnce(failed.promise).mockReturnValueOnce(retried.promise);
    const user = userEvent.setup();
    renderWithRouter(<SearchPage />, ['/search?q=policy']);

    expect(await screen.findByRole('status')).toHaveAccessibleName('正在加载');
    await act(async () => failed.reject(new Error('offline')));
    expect(await screen.findByRole('alert')).toHaveTextContent('全局搜索失败');

    await user.click(screen.getByRole('button', { name: '重试' }));
    expect(mockedSearch).toHaveBeenCalledTimes(2);
    await act(async () => retried.resolve({ items: [] }));
    expect(await screen.findByRole('heading', { name: '没有匹配结果' })).toBeInTheDocument();
  });

  it('shows a helpful empty state before a query is entered', () => {
    renderWithRouter(<SearchPage />, ['/search']);

    expect(screen.getByRole('heading', { name: '输入关键词开始搜索' })).toBeInTheDocument();
    expect(mockedSearch).not.toHaveBeenCalled();
  });
});
