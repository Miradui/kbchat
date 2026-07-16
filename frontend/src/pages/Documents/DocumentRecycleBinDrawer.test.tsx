import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

describe('DocumentRecycleBinDrawer', () => {
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
    await user.click(screen.getByRole('button', { name: '恢复' }));

    expect(await screen.findByText('文档已恢复，但回收站刷新失败：刷新服务暂不可用')).toBeInTheDocument();
    expect(screen.queryByText('文档恢复失败')).not.toBeInTheDocument();
    expect(onChanged).toHaveBeenCalledTimes(1);
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
