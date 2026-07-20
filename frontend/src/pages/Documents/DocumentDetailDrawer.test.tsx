import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithRouter } from '../../test/render';
import { DocumentDetailDrawer } from './DocumentDetailDrawer';

const api = vi.hoisted(() => ({
  deleteDocument: vi.fn(),
  downloadDocument: vi.fn(),
  getDocument: vi.fn(),
  getDocumentPreview: vi.fn(),
  listDocumentChunks: vi.fn(),
  reprocessDocument: vi.fn(),
}));

vi.mock('../../api/resources', () => api);

beforeEach(() => {
  Object.values(api).forEach((mock) => mock.mockReset());
  api.getDocument.mockResolvedValue({
    id: 'doc-1', knowledgeBaseId: 'kb-1', filename: 'manual.pdf', fileType: 'pdf', fileSize: 1024,
    status: 'embedding', errorMessage: null, jobStatus: 'running', progress: 75, stage: 'embedding',
    retryCount: 2, maxRetries: 5, nextRetryAt: '2026-07-16T10:00:00Z',
    createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-16T09:00:00Z',
  });
  api.getDocumentPreview.mockResolvedValue({ id: 'doc-1', filename: 'manual.pdf', fileType: 'pdf', kind: 'file', downloadUrl: '/documents/doc-1/download' });
  api.downloadDocument.mockResolvedValue(new Blob(['pdf']));
  api.listDocumentChunks.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });
  vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:preview'), revokeObjectURL: vi.fn() });
});

afterEach(() => {
  document.body.style.overflow = '';
  document.getElementById('document-drawer-opener')?.remove();
});

describe('DocumentDetailDrawer progress', () => {
  it('uses modal focus, Escape, scroll lock, and focus restoration', async () => {
    const opener = document.createElement('button');
    opener.id = 'document-drawer-opener';
    document.body.append(opener);
    opener.focus();
    const onClose = vi.fn();
    const user = userEvent.setup();

    const rendered = renderWithRouter(<DocumentDetailDrawer documentId="doc-1" onClose={onClose} />);

    expect(screen.getByRole('button', { name: '关闭' })).toHaveFocus();
    expect(document.body.style.overflow).toBe('hidden');
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);

    rendered.unmount();
    expect(document.body.style.overflow).toBe('');
    expect(opener).toHaveFocus();
  });

  it('shows processing progress, stage, retry budget, and next retry time', async () => {
    renderWithRouter(<DocumentDetailDrawer documentId="doc-1" onClose={vi.fn()} />);

    expect(await screen.findByText('75%')).toBeInTheDocument();
    expect(screen.getByText('Embedding')).toBeInTheDocument();
    expect(screen.getByText('重试 2 / 5')).toBeInTheDocument();
    expect(screen.getByText(/下次重试/)).toBeInTheDocument();
  });

  it('hides an unavailable retry budget for legacy document responses', async () => {
    api.getDocument.mockResolvedValue({
      id: 'doc-1', knowledgeBaseId: 'kb-1', filename: 'manual.pdf', fileType: 'pdf', fileSize: 1024,
      status: 'embedding', errorMessage: null,
      createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-16T09:00:00Z',
    });

    renderWithRouter(<DocumentDetailDrawer documentId="doc-1" onClose={vi.fn()} />);

    expect(await screen.findByText('75%')).toBeInTheDocument();
    expect(screen.queryByText(/^重试/)).not.toBeInTheDocument();
  });

  it('disables queue navigation while reprocessing', async () => {
    const reprocess = deferred<typeof documentItem>();
    api.reprocessDocument.mockReturnValueOnce(reprocess.promise);
    const user = userEvent.setup();

    renderWithRouter(<DocumentDetailDrawer documentId="doc-1" onClose={vi.fn()} />);
    expect(await screen.findByText('manual.pdf')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '重处理' }));

    expect(screen.getByRole('link', { name: '进入处理队列' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('link', { name: '进入处理队列' })).toHaveAttribute('tabindex', '-1');
  });

  it('does not notify after a pending reprocess unmounts', async () => {
    const reprocess = deferred<typeof documentItem>();
    api.reprocessDocument.mockReturnValueOnce(reprocess.promise);
    const onChanged = vi.fn();
    const user = userEvent.setup();
    const rendered = renderWithRouter(
      <DocumentDetailDrawer documentId="doc-1" onChanged={onChanged} onClose={vi.fn()} />,
    );
    expect(await screen.findByText('manual.pdf')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '重处理' }));

    rendered.unmount();
    await act(async () => reprocess.resolve(documentItem));

    expect(onChanged).not.toHaveBeenCalled();
  });

  it('announces a document detail loading error', async () => {
    api.getDocument.mockRejectedValueOnce(new Error('offline'));

    renderWithRouter(<DocumentDetailDrawer documentId="doc-1" onClose={vi.fn()} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('文档详情加载失败');
  });

  it('announces a preview loading error', async () => {
    api.getDocumentPreview.mockRejectedValueOnce(new Error('offline'));

    renderWithRouter(<DocumentDetailDrawer documentId="doc-1" onClose={vi.fn()} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('文档预览加载失败');
  });

  it('announces a chunk loading error', async () => {
    api.listDocumentChunks.mockRejectedValueOnce(new Error('offline'));

    renderWithRouter(<DocumentDetailDrawer documentId="doc-1" onClose={vi.fn()} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Chunks 加载失败');
  });
});

const documentItem = {
  id: 'doc-1', knowledgeBaseId: 'kb-1', filename: 'manual.pdf', fileType: 'pdf', fileSize: 1024,
  status: 'embedding' as const, errorMessage: null, jobStatus: 'running', progress: 75, stage: 'embedding',
  retryCount: 2, maxRetries: 5, nextRetryAt: '2026-07-16T10:00:00Z',
  createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-16T09:00:00Z',
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
