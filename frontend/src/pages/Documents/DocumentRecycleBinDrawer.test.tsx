import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../api/client';
import { renderWithRouter } from '../../test/render';
import { DocumentRecycleBinDrawer } from './DocumentRecycleBinDrawer';

const api = vi.hoisted(() => ({
  batchRestoreDocuments: vi.fn(),
  deleteDocumentPermanently: vi.fn(),
  emptyDocumentRecycleBin: vi.fn(),
  listDocumentRecycleBin: vi.fn(),
  restoreDocument: vi.fn(),
}));

vi.mock('../../api/resources', () => api);

beforeEach(() => {
  Object.values(api).forEach((mock) => mock.mockReset());
});

afterEach(() => {
  document.body.style.overflow = '';
  document.getElementById('recycle-drawer-opener')?.remove();
});

describe('DocumentRecycleBinDrawer', () => {
  it('uses modal focus, Escape, scroll lock, and focus restoration', async () => {
    api.listDocumentRecycleBin.mockResolvedValue(recycleResponse([]));
    const opener = document.createElement('button');
    opener.id = 'recycle-drawer-opener';
    document.body.append(opener);
    opener.focus();
    const onClose = vi.fn();
    const user = userEvent.setup();

    const rendered = renderWithRouter(
      <DocumentRecycleBinDrawer onChanged={vi.fn()} onClose={onClose} />,
    );

    expect(screen.getByRole('button', { name: '关闭' })).toHaveFocus();
    expect(document.body.style.overflow).toBe('hidden');
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);

    rendered.unmount();
    expect(document.body.style.overflow).toBe('');
    expect(opener).toHaveFocus();
  });

  it('distinguishes a successful restore from a following refresh failure', async () => {
    api.listDocumentRecycleBin
      .mockResolvedValueOnce({ items: [recycledDocument], total: 1, page: 1, pageSize: 20 })
      .mockRejectedValueOnce(new ApiError(503, {
        code: 'SERVICE_UNAVAILABLE',
        message: '刷新服务暂不可用',
        details: {},
      }));
    api.restoreDocument.mockResolvedValue(undefined);
    const onChanged = vi.fn();
    const user = userEvent.setup();

    renderWithRouter(<DocumentRecycleBinDrawer onChanged={onChanged} onClose={vi.fn()} />);
    expect(await screen.findByText('manual.pdf')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '恢复 manual.pdf' }));

    expect(await screen.findByText('文档已恢复，但回收站刷新失败：刷新服务暂不可用')).toBeInTheDocument();
    expect(screen.queryByText('文档恢复失败')).not.toBeInTheDocument();
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('reports a manual refresh failure', async () => {
    api.listDocumentRecycleBin
      .mockResolvedValueOnce(recycleResponse([recycledDocument]))
      .mockRejectedValueOnce(new ApiError(503, {
        code: 'SERVICE_UNAVAILABLE',
        message: '刷新服务暂不可用',
        details: {},
      }));
    const user = userEvent.setup();

    renderWithRouter(<DocumentRecycleBinDrawer onChanged={vi.fn()} onClose={vi.fn()} />);
    expect(await screen.findByText('manual.pdf')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '刷新' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('刷新服务暂不可用');
  });

  it('ignores an older page response after returning to the first page', async () => {
    const secondPage = deferred<ReturnType<typeof recycleResponse>>();
    const firstPage = deferred<ReturnType<typeof recycleResponse>>();
    api.listDocumentRecycleBin
      .mockResolvedValueOnce(recycleResponse([recycledDocument], 21))
      .mockReturnValueOnce(secondPage.promise)
      .mockReturnValueOnce(firstPage.promise);
    const user = userEvent.setup();

    renderWithRouter(<DocumentRecycleBinDrawer onChanged={vi.fn()} onClose={vi.fn()} />);
    expect(await screen.findByText('manual.pdf')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '›' }));
    await user.click(screen.getByRole('button', { name: '‹' }));

    await act(async () => firstPage.resolve(recycleResponse([{ ...recycledDocument, id: 'new', name: 'new.pdf' }], 21)));
    expect(await screen.findByText('new.pdf')).toBeInTheDocument();
    await act(async () => secondPage.resolve(recycleResponse([{ ...recycledDocument, id: 'old', name: 'old.pdf' }], 21)));
    expect(screen.getByText('new.pdf')).toBeInTheDocument();
    expect(screen.queryByText('old.pdf')).not.toBeInTheDocument();
  });

  it('does not consume a recycle response after unmount', async () => {
    const response = deferred<ReturnType<typeof recycleResponse>>();
    api.listDocumentRecycleBin.mockReturnValueOnce(response.promise);
    let itemReads = 0;
    const staleResponse = {
      get items() {
        itemReads += 1;
        return [recycledDocument];
      },
      total: 1,
      page: 1,
      pageSize: 20,
    };
    const { unmount } = renderWithRouter(
      <DocumentRecycleBinDrawer onChanged={vi.fn()} onClose={vi.fn()} />,
    );

    unmount();
    await act(async () => response.resolve(staleResponse));

    expect(itemReads).toBe(0);
  });

  it('identifies the document targeted by each row action', async () => {
    api.listDocumentRecycleBin.mockResolvedValue(recycleResponse([
      recycledDocument,
      { ...recycledDocument, id: 'doc-2', name: 'policy.md' },
    ]));

    renderWithRouter(<DocumentRecycleBinDrawer onChanged={vi.fn()} onClose={vi.fn()} />);

    expect(await screen.findByRole('button', { name: '恢复 manual.pdf' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '恢复 policy.md' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '永久删除 manual.pdf' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '永久删除 policy.md' })).toBeInTheDocument();
  });

  it('locks all recycle actions while a restore is pending', async () => {
    const restore = deferred<void>();
    api.listDocumentRecycleBin.mockResolvedValue(recycleResponse([
      recycledDocument,
      { ...recycledDocument, id: 'doc-2', name: 'policy.md' },
    ], 21));
    api.restoreDocument.mockReturnValueOnce(restore.promise);
    const user = userEvent.setup();

    renderWithRouter(<DocumentRecycleBinDrawer onChanged={vi.fn()} onClose={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: '恢复 manual.pdf' }));

    expect(screen.getByRole('button', { name: '正在恢复 manual.pdf' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '恢复 policy.md' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '永久删除 manual.pdf' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '恢复本页' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '清空回收站' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '刷新' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '关闭' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '›' })).toBeDisabled();

    await act(async () => restore.resolve());
    expect(screen.getByRole('button', { name: '关闭' })).toBeEnabled();
  });

  it('does not refresh or notify after a pending mutation unmounts', async () => {
    const restore = deferred<void>();
    api.listDocumentRecycleBin.mockResolvedValue(recycleResponse([recycledDocument]));
    api.restoreDocument.mockReturnValueOnce(restore.promise);
    const onChanged = vi.fn();
    const user = userEvent.setup();
    const rendered = renderWithRouter(
      <DocumentRecycleBinDrawer onChanged={onChanged} onClose={vi.fn()} />,
    );
    await user.click(await screen.findByRole('button', { name: '恢复 manual.pdf' }));

    rendered.unmount();
    await act(async () => restore.resolve());

    expect(onChanged).not.toHaveBeenCalled();
    expect(api.listDocumentRecycleBin).toHaveBeenCalledTimes(1);
  });

  it('returns to the last valid page after removing its final item', async () => {
    const lastPageDocument = { ...recycledDocument, id: 'last', name: 'last.pdf' };
    const remainingDocument = { ...recycledDocument, id: 'remaining', name: 'remaining.pdf' };
    const firstPage = deferred<ReturnType<typeof recycleResponse>>();
    api.listDocumentRecycleBin
      .mockResolvedValueOnce(recycleResponse([recycledDocument], 21))
      .mockResolvedValueOnce(recycleResponse([lastPageDocument], 21))
      .mockResolvedValueOnce(recycleResponse([], 20))
      .mockReturnValueOnce(firstPage.promise);
    api.restoreDocument.mockResolvedValue(undefined);
    const user = userEvent.setup();

    renderWithRouter(<DocumentRecycleBinDrawer onChanged={vi.fn()} onClose={vi.fn()} />);
    expect(await screen.findByText('manual.pdf')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '›' }));
    expect(await screen.findByText('last.pdf')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '恢复 last.pdf' }));

    await waitFor(() => expect(api.listDocumentRecycleBin).toHaveBeenCalledTimes(4));
    expect(screen.queryByText('last.pdf')).not.toBeInTheDocument();
    expect(api.restoreDocument).toHaveBeenCalledTimes(1);

    await act(async () => firstPage.resolve(recycleResponse([remainingDocument], 20)));
    expect(await screen.findByText('remaining.pdf')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '1' })).toHaveClass('active-page');
    expect(screen.queryByText('文档回收站为空。')).not.toBeInTheDocument();
  });

  it('does not expose removed last-page items when the fallback page fails to load', async () => {
    const lastPageDocument = { ...recycledDocument, id: 'last', name: 'last.pdf' };
    api.listDocumentRecycleBin
      .mockResolvedValueOnce(recycleResponse([recycledDocument], 21))
      .mockResolvedValueOnce(recycleResponse([lastPageDocument], 21))
      .mockResolvedValueOnce(recycleResponse([], 20))
      .mockRejectedValueOnce(new ApiError(503, {
        code: 'SERVICE_UNAVAILABLE',
        message: '第一页暂不可用',
        details: {},
      }));
    api.restoreDocument.mockResolvedValue(undefined);
    const user = userEvent.setup();

    renderWithRouter(<DocumentRecycleBinDrawer onChanged={vi.fn()} onClose={vi.fn()} />);
    expect(await screen.findByText('manual.pdf')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '›' }));
    expect(await screen.findByText('last.pdf')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '恢复 last.pdf' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('第一页暂不可用');
    expect(screen.queryByText('last.pdf')).not.toBeInTheDocument();
    expect(api.restoreDocument).toHaveBeenCalledTimes(1);
  });
});

const recycledDocument = {
  resourceType: 'document' as const,
  id: 'doc-1',
  name: 'manual.pdf',
  knowledgeBaseId: 'kb-1',
  knowledgeBaseName: '员工制度',
  deletedAt: '2026-07-01T00:00:00Z',
};

function recycleResponse(items: typeof recycledDocument[], total = items.length) {
  return { items, total, page: 1, pageSize: 20 };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
