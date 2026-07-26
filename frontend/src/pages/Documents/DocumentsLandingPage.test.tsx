import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  batchDeleteDocuments,
  getWorkspacePreference,
  listGlobalDocuments,
  listKnowledgeBaseCategories,
  listKnowledgeBases,
} from '../../api/resources';
import { renderWithRouter } from '../../test/render';
import type { GlobalDocumentItem, KnowledgeBase } from '../../types/api';
import { DocumentsLandingPage } from './DocumentsLandingPage';

vi.mock('../../api/resources', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../api/resources')>(),
  batchDeleteDocuments: vi.fn(),
  getWorkspacePreference: vi.fn(),
  listGlobalDocuments: vi.fn(),
  listKnowledgeBaseCategories: vi.fn(),
  listKnowledgeBases: vi.fn(),
  logout: vi.fn(),
}));

vi.mock('./DocumentDetailDrawer', () => ({
  DocumentDetailDrawer: ({ documentId, onClose }: { documentId: string; onClose: () => void }) => (
    <section aria-label="文档详情" role="dialog">
      <output>{documentId}</output>
      <button type="button" onClick={onClose}>关闭详情</button>
    </section>
  ),
}));

vi.mock('./DocumentRecycleBinDrawer', () => ({
  DocumentRecycleBinDrawer: () => null,
}));

const knowledgeBase = {
  id: 'kb1',
  name: '制度库',
  description: '制度说明',
  visibility: 'private',
  retrievalConfig: { vectorTopN: 30, rerankTopK: 5, scoreThreshold: 0.3, enableRerank: true },
  createdAt: '2026-07-01T00:00:00Z',
  updatedAt: '2026-07-01T00:00:00Z',
} satisfies KnowledgeBase;

const document = {
  id: 'doc1',
  knowledgeBaseId: knowledgeBase.id,
  knowledgeBaseName: knowledgeBase.name,
  filename: 'handbook.pdf',
  fileType: 'pdf',
  fileSize: 1024,
  status: 'completed',
  errorMessage: null,
  createdAt: '2026-07-01T00:00:00Z',
  updatedAt: '2026-07-01T00:00:00Z',
} satisfies GlobalDocumentItem;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.mocked(batchDeleteDocuments).mockReset().mockResolvedValue({ processedCount: 1 });
  vi.mocked(listGlobalDocuments).mockReset().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });
  vi.mocked(listKnowledgeBases).mockReset().mockResolvedValue({ items: [knowledgeBase] });
  vi.mocked(listKnowledgeBaseCategories).mockReset().mockResolvedValue({ items: [] });
  vi.mocked(getWorkspacePreference).mockReset().mockResolvedValue({
    viewMode: 'table', scope: 'all', sort: 'updatedAt_desc', visibility: 'all', expandedCategoryIds: [],
  });
});

function LocationProbe() {
  const location = useLocation();
  return <output aria-label="当前位置">{location.pathname}{location.search}</output>;
}

function renderPage(entry = '/documents') {
  return renderWithRouter(
    <>
      <Routes>
        <Route path="/documents" element={<DocumentsLandingPage />} />
      </Routes>
      <LocationProbe />
    </>,
    [entry],
  );
}

describe('DocumentsLandingPage', () => {
  it('offers a create-knowledge-base path when there is no upload target', async () => {
    vi.mocked(listKnowledgeBases).mockResolvedValue({ items: [] });
    renderPage();

    expect(await screen.findByRole('link', { name: '新建知识库后导入' })).toHaveAttribute(
      'href',
      '/knowledge-bases?intent=create',
    );
    expect(screen.getByRole('button', { name: '导入文档' })).toBeDisabled();
  });

  it('opens and closes document detail from URL parameters', async () => {
    const user = userEvent.setup();
    renderPage('/documents?documentId=doc1');

    expect(await screen.findByRole('dialog', { name: '文档详情' })).toHaveTextContent('doc1');
    await user.click(screen.getByRole('button', { name: '关闭详情' }));
    expect(screen.queryByRole('dialog', { name: '文档详情' })).not.toBeInTheDocument();
    expect(screen.getByRole('status', { name: '当前位置' })).toHaveTextContent('/documents');
  });

  it('keeps loaded documents usable when upload-target loading fails', async () => {
    vi.mocked(listGlobalDocuments).mockResolvedValue({ items: [document], total: 1, page: 1, pageSize: 20 });
    vi.mocked(listKnowledgeBases).mockRejectedValue(new Error('offline'));
    renderPage();

    expect(await screen.findByText('handbook.pdf')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('上传目标加载失败');
    expect(screen.getByRole('button', { name: '查看' })).toBeEnabled();
  });

  it('keeps only the latest filtered document response', async () => {
    const first = deferred<{ items: GlobalDocumentItem[]; total: number; page: number; pageSize: number }>();
    const second = deferred<{ items: GlobalDocumentItem[]; total: number; page: number; pageSize: number }>();
    vi.mocked(listGlobalDocuments)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const user = userEvent.setup();
    renderPage();

    await waitFor(() => expect(listGlobalDocuments).toHaveBeenCalledTimes(1));
    await user.selectOptions(screen.getByRole('combobox', { name: '状态筛选' }), 'completed');
    await waitFor(() => expect(listGlobalDocuments).toHaveBeenCalledTimes(2));

    await act(async () => {
      second.resolve({ items: [document], total: 1, page: 1, pageSize: 20 });
      await Promise.resolve();
    });
    expect(await screen.findByText('handbook.pdf')).toBeInTheDocument();

    await act(async () => {
      first.resolve({ items: [], total: 0, page: 1, pageSize: 20 });
      await Promise.resolve();
    });
    expect(screen.getByText('handbook.pdf')).toBeInTheDocument();
  });

  it('does not load knowledge-base category workspace data', async () => {
    renderPage();
    await screen.findByRole('heading', { name: '全局文档台账' });

    expect(listKnowledgeBaseCategories).not.toHaveBeenCalled();
    expect(getWorkspacePreference).not.toHaveBeenCalled();
  });

  it('uses labelled icon buttons for pagination', async () => {
    renderPage();
    await screen.findByRole('heading', { name: '全局文档台账' });

    expect(screen.getByRole('button', { name: '上一页' }).querySelector('svg')).not.toBeNull();
    expect(screen.getByRole('button', { name: '下一页' }).querySelector('svg')).not.toBeNull();
  });

  it('keeps a batch-delete failure inside the confirmation dialog', async () => {
    vi.mocked(listGlobalDocuments).mockResolvedValue({ items: [document], total: 1, page: 1, pageSize: 20 });
    vi.mocked(batchDeleteDocuments).mockRejectedValue(new Error('offline'));
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('checkbox', { name: '选择 handbook.pdf' }));
    await user.click(screen.getByRole('button', { name: '批量删除' }));
    const confirmation = screen.getByRole('dialog', { name: '批量删除文档' });
    await user.click(within(confirmation).getByRole('button', { name: '删除' }));

    expect(await within(confirmation).findByRole('alert')).toHaveTextContent('批量删除失败');
  });
});
