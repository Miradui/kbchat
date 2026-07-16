import { act, screen } from '@testing-library/react';
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

	  expect(await screen.findByText('retrying.pdf')).toBeInTheDocument();
	  expect(screen.getByText('75%')).toBeInTheDocument();
	  expect(screen.getByText('重试 2 / 5')).toBeInTheDocument();
	  expect(screen.getByText(/下次重试/)).toBeInTheDocument();
	  expect(screen.getByText('PDF 解析失败')).toBeInTheDocument();
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
