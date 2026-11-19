import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLocation, useNavigate } from 'react-router-dom';

import { globalSearch } from '../../api/resources';
import { renderWithRouter } from '../../test/render';
import type { GlobalSearchResponse } from '../../types/api';
import { SearchPage } from './SearchPage';

vi.mock('../../api/resources', () => ({
  getCurrentUser: vi.fn().mockResolvedValue({ id: 'user-1', username: 'admin', displayName: '管理员' }),
  globalSearch: vi.fn(),
  logout: vi.fn(),
  searchSuggest: vi.fn().mockResolvedValue({ items: [] }),
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
const chunkResult = {
  type: 'chunk' as const,
  id: 'chunk-1',
  documentId: 'd1',
  knowledgeBaseId: 'kb1',
  knowledgeBaseName: '员工知识库',
  filename: 'handbook.pdf',
  title: '休假制度片段',
  snippet: '年假按照工作年限计算',
};

function searchResponse(
  items: GlobalSearchResponse['items'],
  total = items.length,
  page = 1,
  pageSize = 20,
): GlobalSearchResponse {
  return { items, total, page, pageSize };
}

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
  it('reads URL state and refetches from the server when the result type changes', async () => {
	mockedSearch
		.mockResolvedValueOnce({ items: [documentResult], total: 1, page: 1, pageSize: 20 })
		.mockResolvedValueOnce({ items: [knowledgeBaseResult], total: 1, page: 1, pageSize: 20 });
    const user = userEvent.setup();
    renderWithRouter(
      <><SearchPage /><RouterProbe /></>,
      ['/search?q=handbook&type=document&scope=owned'],
    );

    expect(screen.getByLabelText('搜索关键词')).toHaveValue('handbook');
    expect(await screen.findByText('员工手册文档')).toBeInTheDocument();
    expect(screen.queryByText('员工知识库结果')).not.toBeInTheDocument();
    expect(screen.getByRole('group', { name: '结果类型' })).toBeInTheDocument();
	expect(screen.getByRole('button', { name: '文档' })).toHaveAttribute('aria-pressed', 'true');
	expect(mockedSearch).toHaveBeenCalledWith({
		query: 'handbook', type: 'document', page: 1, pageSize: 20,
	}, expect.any(AbortSignal));

	await user.click(screen.getByRole('button', { name: '知识库' }));

	expect(screen.getByLabelText('当前位置')).toHaveTextContent('/search?q=handbook&type=knowledgeBase&scope=owned');
	expect(await screen.findByText('员工知识库结果')).toBeInTheDocument();
	expect(mockedSearch).toHaveBeenCalledTimes(2);
  });

	it('drives pagination from the URL and requests the next server page', async () => {
		mockedSearch
			.mockResolvedValueOnce({ items: [documentResult], total: 45, page: 2, pageSize: 20 })
			.mockResolvedValueOnce({ items: [documentResult], total: 45, page: 3, pageSize: 20 });
		const user = userEvent.setup();
		renderWithRouter(
			<><SearchPage /><RouterProbe /></>,
			['/search?q=policy&type=document&page=2'],
		);

		expect(await screen.findByRole('button', { name: '第 2 页' })).toHaveAttribute('aria-current', 'page');
		await user.click(screen.getByRole('button', { name: '下一页' }));

		expect(screen.getByLabelText('当前位置')).toHaveTextContent('/search?q=policy&type=document&page=3');
		await waitFor(() => expect(mockedSearch).toHaveBeenLastCalledWith({
			query: 'policy', type: 'document', page: 3, pageSize: 20,
		}, expect.any(AbortSignal)));
	});

  it('debounces typed queries with replace while preserving URL state', async () => {
    vi.useFakeTimers();
    mockedSearch.mockResolvedValue(searchResponse([]));
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
	expect(mockedSearch).toHaveBeenCalledWith({
		query: 'policy', type: 'document', page: 1, pageSize: 20,
	}, expect.any(AbortSignal));

    fireEvent.click(screen.getByRole('button', { name: '返回上一页' }));
    expect(screen.getByLabelText('当前位置')).toHaveTextContent('/before');
  });

  it('uses push for explicit submit and removes only an empty q', async () => {
    mockedSearch.mockResolvedValue(searchResponse([]));
    const user = userEvent.setup();
    renderWithRouter(
      <><SearchPage /><RouterProbe /></>,
      ['/before', '/search?q=old&type=document&scope=owned'],
    );
    // Two calls, not one: the empty result under `type=document` also triggers the
    // probe that checks whether other types have matches.
    await waitFor(() => expect(mockedSearch).toHaveBeenCalledTimes(2));
    const before = mockedSearch.mock.calls.length;

    await user.clear(screen.getByLabelText('搜索关键词'));
    await user.click(screen.getByRole('button', { name: '搜索' }));

    expect(screen.getByLabelText('当前位置')).toHaveTextContent('/search?type=document&scope=owned');
    // An empty q must not search at all, so the count is unchanged.
    expect(mockedSearch).toHaveBeenCalledTimes(before);
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
    await act(async () => second.resolve(searchResponse([{ ...documentResult, id: 'd2', title: '第二个结果' }])));
    expect(await screen.findByText('第二个结果')).toBeInTheDocument();

    await act(async () => first.resolve(searchResponse([{ ...documentResult, title: '过期结果' }])));
    expect(screen.queryByText('过期结果')).not.toBeInTheDocument();
    expect(screen.getByText('第二个结果')).toBeInTheDocument();
  });

  it('does not show an error or clear the latest result for AbortError', async () => {
    const first = deferred<GlobalSearchResponse>();
    const aborted = deferred<GlobalSearchResponse>();
    mockedSearch.mockReturnValueOnce(first.promise).mockReturnValueOnce(aborted.promise);
    renderWithRouter(<SearchPage />, ['/search?q=first']);
    await act(async () => first.resolve(searchResponse([documentResult])));
    expect(await screen.findByText('员工手册文档')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('搜索关键词'), { target: { value: 'second' } });
    fireEvent.click(screen.getByRole('button', { name: '搜索' }));
    await waitFor(() => expect(mockedSearch).toHaveBeenCalledTimes(2));
    await act(async () => aborted.reject(new DOMException('aborted', 'AbortError')));

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText('员工手册文档')).toBeInTheDocument();
  });

  it('falls back to all results for an invalid type', async () => {
    mockedSearch.mockResolvedValue(searchResponse([knowledgeBaseResult, documentResult]));
    renderWithRouter(<SearchPage />, ['/search?q=handbook&type=invalid']);

    expect(await screen.findByText('员工知识库结果')).toBeInTheDocument();
    expect(screen.getByText('员工手册文档')).toBeInTheDocument();
	expect(screen.getByRole('button', { name: '全部' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('links document and chunk results to their exact source', async () => {
    mockedSearch.mockResolvedValue(searchResponse([documentResult, chunkResult]));
    renderWithRouter(<SearchPage />, ['/search?q=policy']);

    expect(await screen.findByRole('link', { name: /员工手册文档/ })).toHaveAttribute(
      'href',
      '/knowledge-bases/kb1/documents?documentId=d1',
    );
    expect(screen.getByRole('link', { name: /休假制度片段/ })).toHaveAttribute(
      'href',
      '/knowledge-bases/kb1/documents?documentId=d1&chunkId=chunk-1',
    );
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
    await act(async () => retried.resolve(searchResponse([])));
    expect(await screen.findByRole('heading', { name: '没有匹配结果' })).toBeInTheDocument();
  });

  it('keeps one live status and announces search completion with the visible result count', async () => {
    const result = deferred<GlobalSearchResponse>();
	mockedSearch
		.mockReturnValueOnce(result.promise)
		.mockResolvedValueOnce(searchResponse([documentResult]));
    const user = userEvent.setup();
    renderWithRouter(<SearchPage />, ['/search?q=policy']);

    const region = screen.getByRole('region', { name: '搜索结果' });
    const status = screen.getByRole('status');
    expect(region).toHaveAttribute('aria-busy', 'true');
    expect(status).toHaveTextContent('正在搜索');
    expect(screen.getAllByRole('status')).toHaveLength(1);

    await act(async () => result.resolve(searchResponse([knowledgeBaseResult, documentResult])));
    await waitFor(() => expect(region).toHaveAttribute('aria-busy', 'false'));
    expect(status).toHaveTextContent('找到 2 条结果');

	await user.click(screen.getByRole('button', { name: '文档' }));
	await waitFor(() => expect(status).toHaveTextContent('找到 1 条结果'));
  });

  it('shows a helpful empty state before a query is entered', () => {
    renderWithRouter(<SearchPage />, ['/search']);

    expect(screen.getByRole('heading', { name: '输入关键词开始搜索' })).toBeInTheDocument();
    expect(mockedSearch).not.toHaveBeenCalled();
  });


});

/**
 * `searchGuidance` is unit-tested on its own; these cover the wiring the unit tests
 * cannot see -- when the probe request is allowed to happen, and what the offered
 * button actually does to the URL.
 */
describe('SearchPage empty-result guidance', () => {
  it('probes for other types when a filtered search comes back empty', async () => {
    mockedSearch.mockImplementation((params) =>
      Promise.resolve(params.type === 'all' ? searchResponse([chunkResult], 3) : searchResponse([])),
    );
    renderWithRouter(<SearchPage />, ['/search?q=policy&type=document']);

    // Waiting on the probe call, not on the title: `没有匹配的文档` is also the
    // pre-probe fallback title, so waiting for it resolves before the probe fires.
    await waitFor(() => expect(mockedSearch).toHaveBeenCalledWith(
      { query: 'policy', type: 'all', page: 1, pageSize: 1 },
      expect.any(AbortSignal),
    ));
    expect(await screen.findByText(/其他类型下有匹配结果/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '没有匹配的文档' })).toBeInTheDocument();
  });

  it('does not probe when the type filter is already all', async () => {
    mockedSearch.mockResolvedValue(searchResponse([]));
    renderWithRouter(<SearchPage />, ['/search?q=policy']);

    await screen.findByRole('heading', { name: '没有匹配结果' });
    // One call only: with no filter to blame there is nothing a probe could tell us.
    expect(mockedSearch).toHaveBeenCalledOnce();
  });

  it('does not probe when the search returned results', async () => {
    mockedSearch.mockResolvedValue(searchResponse([documentResult]));
    renderWithRouter(<SearchPage />, ['/search?q=policy&type=document']);

    await screen.findByText('员工手册文档');
    expect(mockedSearch).toHaveBeenCalledOnce();
  });

  it('keeps the guidance generic when the probe itself fails', async () => {
    mockedSearch.mockImplementation((params) =>
      params.type === 'all' ? Promise.reject(new Error('boom')) : Promise.resolve(searchResponse([])),
    );
    renderWithRouter(<SearchPage />, ['/search?q=policy&type=document']);

    await screen.findByRole('heading', { name: '没有匹配的文档' });
    await waitFor(() => expect(mockedSearch).toHaveBeenCalledTimes(2));

    // A failed probe must not surface as a search error, and must not let the page
    // claim other types have results.
    expect(screen.queryByText('搜索失败')).not.toBeInTheDocument();
    expect(screen.queryByText(/其他类型下有匹配结果/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '查看全部类型' })).toBeInTheDocument();
  });

  it('announces the specific reason rather than a generic one', async () => {
    mockedSearch.mockImplementation((params) =>
      Promise.resolve(params.type === 'all' ? searchResponse([chunkResult], 3) : searchResponse([])),
    );
    renderWithRouter(<SearchPage />, ['/search?q=policy&type=document']);

    await screen.findByRole('heading', { name: '没有匹配的文档' });
    // The live region has to say what the page says; announcing the generic text
    // while the screen shows a specific title tells a screen-reader user less than
    // everyone else gets.
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('没有匹配的文档'));
  });

  it('drops the previous probe answer before the next one lands', async () => {
    const secondProbe = deferred<GlobalSearchResponse>();
    let probes = 0;
    mockedSearch.mockImplementation((params) => {
      if (params.type === 'all' && params.pageSize === 1) {
        probes += 1;
        return probes === 1 ? Promise.resolve(searchResponse([chunkResult], 3)) : secondProbe.promise;
      }
      return Promise.resolve(searchResponse([]));
    });
    const user = userEvent.setup();
    renderWithRouter(<SearchPage />, ['/search?q=policy&type=document']);

    await screen.findByText(/其他类型下有匹配结果/);

    await user.clear(screen.getByLabelText('搜索关键词'));
    await user.type(screen.getByLabelText('搜索关键词'), 'unrelated');
    await user.click(screen.getByRole('button', { name: '搜索' }));
    await waitFor(() => expect(probes).toBe(2));

    // The second probe has not answered yet, so the page must not still be showing
    // the first query's conclusion about a different query's results.
    expect(screen.queryByText(/其他类型下有匹配结果/)).not.toBeInTheDocument();

    await act(async () => secondProbe.resolve(searchResponse([], 0)));
    expect(screen.queryByText(/其他类型下有匹配结果/)).not.toBeInTheDocument();
  });

  it('clears the type filter from the URL when the offered button is used', async () => {
    mockedSearch.mockImplementation((params) =>
      Promise.resolve(params.type === 'all' && params.pageSize === 1
        ? searchResponse([chunkResult], 3)
        : searchResponse([])),
    );
    const user = userEvent.setup();
    renderWithRouter(<><SearchPage /><RouterProbe /></>, ['/search?q=policy&type=document']);

    await screen.findByRole('heading', { name: '没有匹配的文档' });
    await user.click(screen.getByRole('button', { name: '查看全部类型' }));

    expect(screen.getByLabelText('当前位置')).toHaveTextContent('/search?q=policy');
    expect(screen.getByLabelText('当前位置')).not.toHaveTextContent('type=document');
  });

  it('rewrites both the URL and the input when a shorter query is offered', async () => {
    mockedSearch.mockResolvedValue(searchResponse([]));
    const user = userEvent.setup();
    renderWithRouter(<><SearchPage /><RouterProbe /></>, ['/search?q=%E5%B9%B4%E5%81%87%20%E7%94%B3%E8%AF%B7%E6%B5%81%E7%A8%8B']);

    await screen.findByRole('heading', { name: '没有匹配结果' });
    await user.click(screen.getByRole('button', { name: '改搜「申请流程」' }));

    await waitFor(() => expect(mockedSearch).toHaveBeenCalledWith(
      { query: '申请流程', type: 'all', page: 1, pageSize: 20 },
      expect.any(AbortSignal),
    ));
    // The box follows the URL, or the next Enter would re-run the old query. The
    // URL->draft effect also does this, so this asserts the end state, not who set it.
    expect(screen.getByLabelText('搜索关键词')).toHaveValue('申请流程');
    expect(screen.getByLabelText('当前位置')).toHaveTextContent('q=%E7%94%B3%E8%AF%B7%E6%B5%81%E7%A8%8B');
  });

  it('runs the offered query at once instead of waiting for the debounce', async () => {
    mockedSearch.mockResolvedValue(searchResponse([]));
    renderWithRouter(<SearchPage />, ['/search?q=%E5%B9%B4%E5%81%87%20%E7%94%B3%E8%AF%B7%E6%B5%81%E7%A8%8B']);
    await screen.findByRole('heading', { name: '没有匹配结果' });

    // fireEvent, not userEvent: userEvent's own waits need the clock, and the whole
    // point here is to never advance it.
    vi.useFakeTimers();
    mockedSearch.mockClear();
    fireEvent.click(screen.getByRole('button', { name: '改搜「申请流程」' }));

    // Without the explicit URL write the new query would still arrive, but only after
    // the 300ms draft debounce -- a button press should not feel like typing.
    await act(async () => undefined);
    expect(mockedSearch).toHaveBeenCalledWith(
      { query: '申请流程', type: 'all', page: 1, pageSize: 20 },
      expect.any(AbortSignal),
    );
  });
});
