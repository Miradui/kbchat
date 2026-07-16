import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

describe('DocumentDetailDrawer progress', () => {
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
});
