import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  batchRestoreDocuments,
  deleteDocumentPermanently,
  emptyDocumentRecycleBin,
  listDocumentRecycleBin,
  restoreDocument,
} from '../../api/resources';
import { renderWithRouter } from '../../test/render';
import { DocumentRecycleBinDrawer } from './DocumentRecycleBinDrawer';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

vi.mock('../../api/resources', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../api/resources')>(),
  batchRestoreDocuments: vi.fn(),
  deleteDocumentPermanently: vi.fn(),
  emptyDocumentRecycleBin: vi.fn(),
  listDocumentRecycleBin: vi.fn(),
  restoreDocument: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(batchRestoreDocuments).mockReset().mockResolvedValue({ processedCount: 1 });
  vi.mocked(deleteDocumentPermanently).mockReset().mockResolvedValue(undefined);
  vi.mocked(emptyDocumentRecycleBin).mockReset().mockResolvedValue(undefined);
  vi.mocked(restoreDocument).mockReset().mockResolvedValue(undefined);
  vi.mocked(listDocumentRecycleBin).mockReset().mockResolvedValue({
    items: [], total: 0, page: 1, pageSize: 20,
  });
});

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>打开回收站</button>
      {open && <DocumentRecycleBinDrawer onChanged={() => undefined} onClose={() => setOpen(false)} />}
    </>
  );
}

describe('DocumentRecycleBinDrawer', () => {
  it('constrains focus, closes with Escape, and restores its opener', async () => {
    const user = userEvent.setup();
    renderWithRouter(<Harness />);
    const opener = screen.getByRole('button', { name: '打开回收站' });

    await user.click(opener);
    const dialog = await screen.findByRole('dialog', { name: '文档回收站' });
    expect(dialog.closest('.ui-drawer-backdrop')?.parentElement).toBe(document.body);
    await waitFor(() => expect(dialog).toContainElement(document.activeElement as HTMLElement));
    expect(document.body).toHaveStyle({ overflow: 'hidden' });

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: '文档回收站' })).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
    expect(document.body).not.toHaveStyle({ overflow: 'hidden' });
  });

  it('announces asynchronous load failures', async () => {
    vi.mocked(listDocumentRecycleBin).mockRejectedValue(new Error('offline'));
    const user = userEvent.setup();
    renderWithRouter(<Harness />);
    await user.click(screen.getByRole('button', { name: '打开回收站' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('文档回收站加载失败');
    expect(screen.queryByText('文档回收站为空。')).not.toBeInTheDocument();
    expect(within(alert).getByRole('button', { name: '重试' })).toBeInTheDocument();
  });

  it('keeps a manual refresh failure handled inside the drawer', async () => {
    vi.mocked(listDocumentRecycleBin)
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(new Error('still offline'));
    const user = userEvent.setup();
    renderWithRouter(<Harness />);
    await user.click(screen.getByRole('button', { name: '打开回收站' }));

    await screen.findByRole('alert');
    await user.click(screen.getByRole('button', { name: '重试' }));

    await waitFor(() => expect(listDocumentRecycleBin).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('alert')).toHaveTextContent('文档回收站加载失败');
  });

  it('does not let an older page response overwrite the current page', async () => {
    const olderPage = deferred<Awaited<ReturnType<typeof listDocumentRecycleBin>>>();
    const currentPage = deferred<Awaited<ReturnType<typeof listDocumentRecycleBin>>>();
    vi.mocked(listDocumentRecycleBin)
      .mockResolvedValueOnce({
        items: [{ resourceType: 'document', id: 'page1', name: '第一页.pdf', deletedAt: '2026-07-01T00:00:00Z' }],
        total: 41,
        page: 1,
        pageSize: 20,
      })
      .mockReturnValueOnce(olderPage.promise)
      .mockReturnValueOnce(currentPage.promise);
    const user = userEvent.setup();
    renderWithRouter(<Harness />);
    await user.click(screen.getByRole('button', { name: '打开回收站' }));
    expect(await screen.findByText('第一页.pdf')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '下一页' }));
    await waitFor(() => expect(listDocumentRecycleBin).toHaveBeenCalledTimes(2));
    await user.click(screen.getByRole('button', { name: '上一页' }));
    await waitFor(() => expect(listDocumentRecycleBin).toHaveBeenCalledTimes(3));

    currentPage.resolve({
      items: [{ resourceType: 'document', id: 'current', name: '当前页.pdf', deletedAt: '2026-07-02T00:00:00Z' }],
      total: 41,
      page: 1,
      pageSize: 20,
    });
    expect(await screen.findByText('当前页.pdf')).toBeInTheDocument();
    olderPage.resolve({
      items: [{ resourceType: 'document', id: 'old', name: '迟到页.pdf', deletedAt: '2026-07-03T00:00:00Z' }],
      total: 41,
      page: 2,
      pageSize: 20,
    });

    await waitFor(() => expect(screen.getByText('当前页.pdf')).toBeInTheDocument());
    expect(screen.queryByText('迟到页.pdf')).not.toBeInTheDocument();
  });

  it('locks batch mutations while keeping pagination available during a restore', async () => {
    const restoreResult = deferred<void>();
    vi.mocked(restoreDocument).mockReturnValue(restoreResult.promise);
    vi.mocked(listDocumentRecycleBin).mockResolvedValue({
      items: [{ resourceType: 'document', id: 'doc1', name: '制度.pdf', deletedAt: '2026-07-01T00:00:00Z' }],
      total: 21,
      page: 1,
      pageSize: 20,
    });
    const user = userEvent.setup();
    renderWithRouter(<Harness />);
    await user.click(screen.getByRole('button', { name: '打开回收站' }));
    await user.click(await screen.findByRole('button', { name: '恢复' }));

    expect(screen.getByRole('button', { name: '恢复本页' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '清空' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '下一页' })).toBeEnabled();

    restoreResult.resolve();
    await waitFor(() => expect(restoreDocument).toHaveBeenCalledWith('doc1'));
  });

  it('locks the active row and batch controls without freezing other rows', async () => {
    const restoreResult = deferred<void>();
    vi.mocked(restoreDocument).mockReturnValue(restoreResult.promise);
    vi.mocked(listDocumentRecycleBin).mockResolvedValue({
      items: [
        { resourceType: 'document', id: 'doc1', name: '制度.pdf', deletedAt: '2026-07-01T00:00:00Z' },
        { resourceType: 'document', id: 'doc2', name: '流程.pdf', deletedAt: '2026-07-02T00:00:00Z' },
      ],
      total: 21,
      page: 1,
      pageSize: 20,
    });
    const user = userEvent.setup();
    renderWithRouter(<Harness />);
    await user.click(screen.getByRole('button', { name: '打开回收站' }));
    const firstItem = (await screen.findByText('制度.pdf')).closest('article')!;
    const secondItem = screen.getByText('流程.pdf').closest('article')!;
    await user.click(within(firstItem).getByRole('button', { name: '恢复' }));

    expect(within(firstItem).getByRole('button', { name: '恢复中' })).toBeDisabled();
    expect(within(firstItem).getByRole('button', { name: '永久删除' })).toBeDisabled();
    expect(within(secondItem).getByRole('button', { name: '恢复' })).toBeEnabled();
    expect(within(secondItem).getByRole('button', { name: '永久删除' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '恢复本页' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '清空' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '关闭' })).toBeEnabled();

    restoreResult.resolve();
    await waitFor(() => expect(restoreDocument).toHaveBeenCalledWith('doc1'));
  });

  it('announces a successful single restore', async () => {
    vi.mocked(listDocumentRecycleBin).mockResolvedValue({
      items: [{ resourceType: 'document', id: 'doc1', name: '制度.pdf', deletedAt: '2026-07-01T00:00:00Z' }],
      total: 1, page: 1, pageSize: 20,
    });
    const user = userEvent.setup();
    renderWithRouter(<Harness />);
    await user.click(screen.getByRole('button', { name: '打开回收站' }));
    await user.click(await screen.findByRole('button', { name: '恢复' }));

    expect(await within(screen.getByRole('region', { name: '通知' })).findByRole('status'))
      .toHaveTextContent('文档恢复成功');
  });

  it('announces a successful page restore', async () => {
    vi.mocked(listDocumentRecycleBin).mockResolvedValue({
      items: [{ resourceType: 'document', id: 'doc1', name: '制度.pdf', deletedAt: '2026-07-01T00:00:00Z' }],
      total: 1, page: 1, pageSize: 20,
    });
    const user = userEvent.setup();
    renderWithRouter(<Harness />);
    await user.click(screen.getByRole('button', { name: '打开回收站' }));
    await user.click(await screen.findByRole('button', { name: '恢复本页' }));

    expect(await within(screen.getByRole('region', { name: '通知' })).findByRole('status'))
      .toHaveTextContent('本页文档已恢复');
  });

  it('announces successful permanent deletion and emptying', async () => {
    vi.mocked(listDocumentRecycleBin).mockResolvedValue({
      items: [{ resourceType: 'document', id: 'doc1', name: '制度.pdf', deletedAt: '2026-07-01T00:00:00Z' }],
      total: 1, page: 1, pageSize: 20,
    });
    const user = userEvent.setup();
    renderWithRouter(<Harness />);
    await user.click(screen.getByRole('button', { name: '打开回收站' }));
    await user.click(await screen.findByRole('button', { name: '永久删除' }));
    await user.click(within(screen.getByRole('dialog', { name: '永久删除文档' })).getByRole('button', { name: '永久删除' }));
    expect(await within(screen.getByRole('region', { name: '通知' })).findByRole('status'))
      .toHaveTextContent('文档已永久删除');

    await user.click(screen.getByRole('button', { name: '清空' }));
    await user.click(within(screen.getByRole('dialog', { name: '清空文档回收站' })).getByRole('button', { name: '清空' }));
    expect(await within(screen.getByRole('region', { name: '通知' })).findByText('文档回收站已清空'))
      .toBeInTheDocument();
  });

  it('uses icon controls for closing and pagination', async () => {
    vi.mocked(listDocumentRecycleBin).mockResolvedValue({
      items: [{ resourceType: 'document', id: 'doc1', name: '制度.pdf', deletedAt: '2026-07-01T00:00:00Z' }],
      total: 21,
      page: 1,
      pageSize: 20,
    });
    const user = userEvent.setup();
    renderWithRouter(<Harness />);
    await user.click(screen.getByRole('button', { name: '打开回收站' }));

    expect(screen.getByRole('button', { name: '关闭' }).querySelector('svg')).not.toBeNull();
    expect(screen.getByRole('button', { name: '上一页' }).querySelector('svg')).not.toBeNull();
    expect(screen.getByRole('button', { name: '下一页' }).querySelector('svg')).not.toBeNull();
  });

  it('keeps permanent-delete failures inside the confirmation dialog', async () => {
    vi.mocked(listDocumentRecycleBin).mockResolvedValue({
      items: [{ resourceType: 'document', id: 'doc1', name: '制度.pdf', deletedAt: '2026-07-01T00:00:00Z' }],
      total: 1,
      page: 1,
      pageSize: 20,
    });
    vi.mocked(deleteDocumentPermanently).mockRejectedValue(new Error('offline'));
    const user = userEvent.setup();
    renderWithRouter(<Harness />);
    await user.click(screen.getByRole('button', { name: '打开回收站' }));
    await user.click(await screen.findByRole('button', { name: '永久删除' }));
    const confirmation = screen.getByRole('dialog', { name: '永久删除文档' });
    await user.click(within(confirmation).getByRole('button', { name: '永久删除' }));

    expect(await within(confirmation).findByRole('alert')).toHaveTextContent('文档永久删除失败');
  });
});
