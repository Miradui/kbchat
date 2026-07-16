import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../api/client';
import { renderWithRouter } from '../../test/render';
import { DocumentsLandingPage } from './DocumentsLandingPage';

const api = vi.hoisted(() => ({
  batchDeleteDocuments: vi.fn(),
  batchReprocessDocuments: vi.fn(),
  getWorkspacePreference: vi.fn(),
  listGlobalDocuments: vi.fn(),
  listKnowledgeBaseCategories: vi.fn(),
  listKnowledgeBases: vi.fn(),
  logout: vi.fn(),
  uploadGlobalDocument: vi.fn(),
}));

vi.mock('../../api/resources', () => api);

beforeEach(() => {
  Object.values(api).forEach((mock) => mock.mockReset());
  api.listKnowledgeBases.mockResolvedValue({ items: [knowledgeBase] });
  api.listKnowledgeBaseCategories.mockResolvedValue({ items: [] });
  api.getWorkspacePreference.mockResolvedValue({
    viewMode: 'table', scope: 'all', sort: 'updatedAt_desc', visibility: 'all', expandedCategoryIds: [],
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('DocumentsLandingPage loading', () => {
	it('shows processing progress, retry details, and failure reasons in the ledger', async () => {
	  api.listGlobalDocuments.mockResolvedValue({
		items: [
		  {
			...documentItem('retrying.pdf', 'embedding'),
			jobStatus: 'pending',
			progress: 75,
			stage: 'embedding',
			retryCount: 2,
			maxRetries: 5,
			nextRetryAt: '2026-07-01T08:30:00Z',
		  },
		  {
			...documentItem('failed.pdf', 'failed'),
			jobStatus: 'failed',
			progress: 100,
			stage: 'failed',
			retryCount: 5,
			maxRetries: 5,
			errorMessage: 'PDF 解析失败',
		  },
		],
		total: 2,
		page: 1,
		pageSize: 20,
	  });

	  renderWithRouter(<DocumentsLandingPage />, ['/documents']);

	  const retryingRow = (await screen.findByText('retrying.pdf')).closest('tr');
	  const failedRow = screen.getByText('failed.pdf').closest('tr');
	  if (!retryingRow || !failedRow) throw new Error('document rows were not rendered');
	  expect(within(retryingRow).getByText('75%')).toBeInTheDocument();
	  expect(within(retryingRow).getByText('重试 2 / 5')).toBeInTheDocument();
	  expect(within(retryingRow).getByText(/下次重试/)).toBeInTheDocument();
	  expect(within(retryingRow).queryByText('PDF 解析失败')).not.toBeInTheDocument();
	  expect(within(failedRow).getByText('100%')).toBeInTheDocument();
	  expect(within(failedRow).getByText('重试 5 / 5')).toBeInTheDocument();
	  expect(within(failedRow).getByText('PDF 解析失败')).toBeInTheDocument();
	});

  it('polls while the current page contains a processing document', async () => {
    let poll: (() => void) | undefined;
    const realSetInterval = window.setInterval.bind(window);
    vi.spyOn(window, 'setInterval').mockImplementation((handler, timeout, ...args) => {
      if (timeout === 3000) {
        poll = handler as () => void;
        return 1;
      }
      return realSetInterval(handler, timeout, ...args);
    });
    api.listGlobalDocuments
      .mockResolvedValueOnce(documentResponse(documentItem('processing.pdf', 'embedding')))
      .mockResolvedValueOnce(documentResponse(documentItem('completed.pdf', 'completed')));

    renderWithRouter(<DocumentsLandingPage />, ['/documents']);

    expect(await screen.findByText('processing.pdf')).toBeInTheDocument();
    expect(window.setInterval).toHaveBeenCalledWith(expect.any(Function), 3000);
    if (!poll) throw new Error('poll callback was not registered');

    await act(async () => poll?.());

    expect(await screen.findByText('completed.pdf')).toBeInTheDocument();
    expect(screen.queryByText('processing.pdf')).not.toBeInTheDocument();
  });

  it('keeps an upload error visible after a successful status poll', async () => {
	let poll: (() => void) | undefined;
	const realSetInterval = window.setInterval.bind(window);
	vi.spyOn(window, 'setInterval').mockImplementation((handler, timeout, ...args) => {
	  if (timeout === 3000) {
		poll = handler as () => void;
		return 1;
	  }
	  return realSetInterval(handler, timeout, ...args);
	});
	api.listGlobalDocuments
	  .mockResolvedValueOnce(documentResponse(documentItem('processing.pdf', 'embedding')))
	  .mockResolvedValueOnce(documentResponse(documentItem('processing.pdf', 'embedding')));
	api.uploadGlobalDocument.mockRejectedValue(new ApiError(400, {
	  code: 'DOCUMENT_UPLOAD_FAILED',
	  message: '上传内容无效',
	  details: {},
	}));
	const user = userEvent.setup();
	const { container } = renderWithRouter(<DocumentsLandingPage />, ['/documents']);

	expect(await screen.findByText('processing.pdf')).toBeInTheDocument();
	const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]');
	if (!fileInput) throw new Error('file input was not rendered');
	await user.upload(fileInput, new File(['broken'], 'broken.pdf', { type: 'application/pdf' }));
	expect(await screen.findByText('上传内容无效')).toBeInTheDocument();
	if (!poll) throw new Error('poll callback was not registered');

	await act(async () => poll?.());

	expect(screen.getByText('上传内容无效')).toBeInTheDocument();
  });

  it('reports a manual refresh failure without an unhandled rejection', async () => {
	api.listGlobalDocuments
	  .mockResolvedValueOnce(documentResponse(documentItem('manual.pdf', 'completed')))
	  .mockRejectedValueOnce(new ApiError(503, {
		code: 'SERVICE_UNAVAILABLE',
		message: '刷新服务暂不可用',
		details: {},
	  }));
	const user = userEvent.setup();

	renderWithRouter(<DocumentsLandingPage />, ['/documents']);
	expect(await screen.findByText('manual.pdf')).toBeInTheDocument();
	await user.click(screen.getByRole('button', { name: '刷新' }));

	expect(await screen.findByRole('alert')).toHaveTextContent('刷新服务暂不可用');
  });

  it('replaces an old action error with the explicit refresh result', async () => {
	api.listGlobalDocuments
	  .mockResolvedValueOnce(documentResponse(documentItem('manual.pdf', 'completed')))
	  .mockRejectedValueOnce(new ApiError(503, {
		code: 'SERVICE_UNAVAILABLE',
		message: '刷新服务暂不可用',
		details: {},
	  }));
	api.uploadGlobalDocument.mockRejectedValue(new ApiError(400, {
	  code: 'DOCUMENT_UPLOAD_FAILED',
	  message: '上传内容无效',
	  details: {},
	}));
	const user = userEvent.setup();
	const { container } = renderWithRouter(<DocumentsLandingPage />, ['/documents']);

	expect(await screen.findByText('manual.pdf')).toBeInTheDocument();
	const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]');
	if (!fileInput) throw new Error('file input was not rendered');
	await user.upload(fileInput, new File(['broken'], 'broken.pdf', { type: 'application/pdf' }));
	expect(await screen.findByRole('alert')).toHaveTextContent('上传内容无效');
	await user.click(screen.getByRole('button', { name: '刷新' }));

	expect(await screen.findByRole('alert')).toHaveTextContent('刷新服务暂不可用');
	expect(screen.queryByText('上传内容无效')).not.toBeInTheDocument();
  });

  it('clears an old action error after an explicit refresh succeeds', async () => {
	api.listGlobalDocuments
	  .mockResolvedValueOnce(documentResponse(documentItem('manual.pdf', 'completed')))
	  .mockResolvedValueOnce(documentResponse(documentItem('manual.pdf', 'completed')));
	api.uploadGlobalDocument.mockRejectedValue(new ApiError(400, {
	  code: 'DOCUMENT_UPLOAD_FAILED',
	  message: '上传内容无效',
	  details: {},
	}));
	const user = userEvent.setup();
	const { container } = renderWithRouter(<DocumentsLandingPage />, ['/documents']);

	expect(await screen.findByText('manual.pdf')).toBeInTheDocument();
	const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]');
	if (!fileInput) throw new Error('file input was not rendered');
	await user.upload(fileInput, new File(['broken'], 'broken.pdf', { type: 'application/pdf' }));
	expect(await screen.findByRole('alert')).toHaveTextContent('上传内容无效');
	await user.click(screen.getByRole('button', { name: '刷新' }));

	expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('disables explicit refresh while the request is pending', async () => {
	const refresh = deferred<ReturnType<typeof documentResponse>>();
	api.listGlobalDocuments
	  .mockResolvedValueOnce(documentResponse(documentItem('manual.pdf', 'completed')))
	  .mockReturnValueOnce(refresh.promise);
	const user = userEvent.setup();

	renderWithRouter(<DocumentsLandingPage />, ['/documents']);
	expect(await screen.findByText('manual.pdf')).toBeInTheDocument();
	const refreshButton = screen.getByRole('button', { name: '刷新' });
	await user.click(refreshButton);

	expect(screen.getByRole('button', { name: '刷新中...' })).toBeDisabled();
	expect(api.listGlobalDocuments).toHaveBeenCalledTimes(2);
	await act(async () => refresh.resolve(documentResponse(documentItem('manual.pdf', 'completed'))));
	expect(screen.getByRole('button', { name: '刷新' })).toBeEnabled();
  });

  it('does not let a status poll supersede an explicit refresh', async () => {
    let poll: (() => void) | undefined;
    const realSetInterval = window.setInterval.bind(window);
    vi.spyOn(window, 'setInterval').mockImplementation((handler, timeout, ...args) => {
      if (timeout === 3000) {
        poll = handler as () => void;
        return 1;
      }
      return realSetInterval(handler, timeout, ...args);
    });
    const refresh = deferred<ReturnType<typeof documentResponse>>();
    api.listGlobalDocuments
      .mockResolvedValueOnce(documentResponse(documentItem('processing.pdf', 'embedding')))
      .mockReturnValueOnce(refresh.promise)
      .mockResolvedValueOnce(documentResponse(documentItem('poll.pdf', 'completed')));
    const user = userEvent.setup();

    renderWithRouter(<DocumentsLandingPage />, ['/documents']);
    expect(await screen.findByText('processing.pdf')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '刷新' }));
    if (!poll) throw new Error('poll callback was not registered');

    await act(async () => poll?.());
    expect(api.listGlobalDocuments).toHaveBeenCalledTimes(2);
    await act(async () => refresh.resolve(documentResponse(documentItem('completed.pdf', 'completed'))));
    expect(await screen.findByText('completed.pdf')).toBeInTheDocument();
    expect(screen.queryByText('poll.pdf')).not.toBeInTheDocument();
  });

  it('labels the upload target selector', async () => {
	api.listGlobalDocuments.mockResolvedValue(documentResponse(documentItem('manual.pdf', 'completed')));

	renderWithRouter(<DocumentsLandingPage />, ['/documents']);

	expect(await screen.findByRole('combobox', { name: '上传目标' })).toBeInTheDocument();
  });

  it('identifies the document targeted by each row action', async () => {
    api.listGlobalDocuments.mockResolvedValue({
      items: [documentItem('manual.pdf', 'completed'), documentItem('policy.md', 'completed')],
      total: 2,
      page: 1,
      pageSize: 20,
    });

    renderWithRouter(<DocumentsLandingPage />, ['/documents']);

    expect(await screen.findByRole('button', { name: '查看 manual.pdf' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '查看 policy.md' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '进入 manual.pdf 的处理页' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '进入 policy.md 的处理页' })).toBeInTheDocument();
  });

  it('distinguishes a successful upload from a following refresh failure', async () => {
	api.listGlobalDocuments
	  .mockResolvedValueOnce(documentResponse(documentItem('manual.pdf', 'completed')))
	  .mockRejectedValueOnce(new Error('network unavailable'));
	api.uploadGlobalDocument.mockResolvedValue(undefined);
	const user = userEvent.setup();
	const { container } = renderWithRouter(<DocumentsLandingPage />, ['/documents']);

	expect(await screen.findByText('manual.pdf')).toBeInTheDocument();
	const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]');
	if (!fileInput) throw new Error('file input was not rendered');
	await user.upload(fileInput, new File(['content'], 'new.pdf', { type: 'application/pdf' }));

	expect(await screen.findByRole('alert')).toHaveTextContent('文档已上传，但列表刷新失败');
	expect(screen.queryByText('全局上传失败')).not.toBeInTheDocument();
  });

  it('does not consume a document response after unmount', async () => {
	const response = deferred<ReturnType<typeof documentResponse>>();
	api.listGlobalDocuments.mockReturnValueOnce(response.promise);
	let itemReads = 0;
	const staleResponse = {
	  get items() {
		itemReads += 1;
		return [documentItem('stale.pdf', 'completed')];
	  },
	  total: 1,
	  page: 1,
	  pageSize: 20,
	};
	const { unmount } = renderWithRouter(<DocumentsLandingPage />, ['/documents']);

	unmount();
	await act(async () => response.resolve(staleResponse));

	expect(itemReads).toBe(0);
  });

  it('ignores an older document response after filters change', async () => {
    const first = deferred<ReturnType<typeof documentResponse>>();
    const second = deferred<ReturnType<typeof documentResponse>>();
    api.listGlobalDocuments.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const user = userEvent.setup();

    renderWithRouter(<DocumentsLandingPage />, ['/documents']);
    await user.selectOptions(screen.getByLabelText('状态筛选'), 'completed');

    await act(async () => second.resolve(documentResponse(documentItem('new-filter.pdf', 'completed'))));
    expect(await screen.findByText('new-filter.pdf')).toBeInTheDocument();
    await act(async () => first.resolve(documentResponse(documentItem('old-filter.pdf', 'uploaded'))));

    expect(screen.getByText('new-filter.pdf')).toBeInTheDocument();
    expect(screen.queryByText('old-filter.pdf')).not.toBeInTheDocument();
  });
});

const knowledgeBase = {
  id: 'kb-1', name: '员工制度', description: '', visibility: 'private',
  retrievalConfig: { vectorTopN: 30, rerankTopK: 5, scoreThreshold: 0.3, enableRerank: true },
  createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-01T00:00:00Z',
};

function documentItem(filename: string, status: 'uploaded' | 'embedding' | 'completed' | 'failed') {
  return {
    id: filename,
    knowledgeBaseId: 'kb-1',
    knowledgeBaseName: '员工制度',
    filename,
    fileType: 'pdf',
    fileSize: 1024,
    status,
    errorMessage: null,
    createdAt: '2026-07-01T00:00:00Z',
    updatedAt: '2026-07-01T00:00:00Z',
  };
}

function documentResponse(item: ReturnType<typeof documentItem>) {
  return { items: [item], total: 1, page: 1, pageSize: 20 };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
