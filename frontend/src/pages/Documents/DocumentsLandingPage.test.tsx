import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  batchDeleteDocuments,
  batchReprocessDocuments,
  getWorkspacePreference,
  listGlobalDocuments,
  listKnowledgeBaseCategories,
  listKnowledgeBases,
  uploadGlobalDocument,
} from '../../api/resources';
import { renderWithRouter } from '../../test/render';
import type { GlobalDocumentItem, KnowledgeBase } from '../../types/api';
import { DocumentsLandingPage } from './DocumentsLandingPage';

vi.mock('../../api/resources', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../api/resources')>(),
  batchDeleteDocuments: vi.fn(),
  batchReprocessDocuments: vi.fn(),
  getWorkspacePreference: vi.fn(),
  listGlobalDocuments: vi.fn(),
  listKnowledgeBaseCategories: vi.fn(),
  listKnowledgeBases: vi.fn(),
  logout: vi.fn(),
  uploadGlobalDocument: vi.fn(),
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

const secondKnowledgeBase = {
  ...knowledgeBase,
  id: 'kb2',
  name: '产品库',
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
  vi.mocked(batchReprocessDocuments).mockReset().mockResolvedValue({ processedCount: 1 });
  vi.mocked(listGlobalDocuments).mockReset().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });
  vi.mocked(listKnowledgeBases).mockReset().mockResolvedValue({ items: [knowledgeBase] });
  vi.mocked(listKnowledgeBaseCategories).mockReset().mockResolvedValue({ items: [] });
  vi.mocked(getWorkspacePreference).mockReset().mockResolvedValue({
    viewMode: 'table', scope: 'all', sort: 'updatedAt_desc', visibility: 'all', expandedCategoryIds: [],
  });
  vi.mocked(uploadGlobalDocument).mockReset().mockResolvedValue(document);
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

  it('opens a global import without binding the first knowledge base', async () => {
    vi.mocked(listKnowledgeBases).mockResolvedValue({ items: [knowledgeBase, secondKnowledgeBase] });
    const user = userEvent.setup();
    renderPage();

    const importButton = await screen.findByRole('button', { name: '导入文档' });
    expect(importButton).toBeEnabled();
    await user.click(importButton);

    expect(screen.getByRole('combobox', { name: '目标知识库' })).toHaveValue('');
  });

  it('opens and closes document detail from URL parameters', async () => {
    const user = userEvent.setup();
    renderPage('/documents?documentId=doc1');

    expect(await screen.findByRole('dialog', { name: '文档详情' })).toHaveTextContent('doc1');
    await user.click(screen.getByRole('button', { name: '关闭详情' }));
    expect(screen.queryByRole('dialog', { name: '文档详情' })).not.toBeInTheDocument();
    expect(screen.getByRole('status', { name: '当前位置' })).toHaveTextContent('/documents');
  });

  it('imports a document into the target selected inside the dialog and refreshes the list', async () => {
    vi.mocked(listKnowledgeBases).mockResolvedValue({ items: [knowledgeBase, secondKnowledgeBase] });
    vi.mocked(listGlobalDocuments)
      .mockResolvedValueOnce({ items: [], total: 0, page: 1, pageSize: 20 })
      .mockResolvedValueOnce({ items: [document], total: 1, page: 1, pageSize: 20 });
    const user = userEvent.setup();
    const file = new File(['policy'], 'policy.md', { type: 'text/markdown' });
    renderPage();

    await user.click(await screen.findByRole('button', { name: '导入文档' }));
    const dialog = screen.getByRole('dialog', { name: '导入文档' });
    await user.selectOptions(within(dialog).getByRole('combobox', { name: '目标知识库' }), 'kb2');
    await user.upload(within(dialog).getByLabelText('选择文档文件'), file);
    await user.click(within(dialog).getByRole('button', { name: '开始导入' }));

    await waitFor(() => expect(uploadGlobalDocument).toHaveBeenCalledWith('kb2', file));
    expect(await screen.findByText('handbook.pdf')).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: '导入文档' })).not.toBeInTheDocument();
  });

  it('reports when upload succeeds but the global list refresh fails', async () => {
    vi.mocked(listGlobalDocuments)
      .mockResolvedValueOnce({ items: [], total: 0, page: 1, pageSize: 20 })
      .mockRejectedValueOnce(new Error('offline'));
    const user = userEvent.setup();
    const file = new File(['policy'], 'policy.md', { type: 'text/markdown' });
    renderPage();

    await user.click(await screen.findByRole('button', { name: '导入文档' }));
    const dialog = screen.getByRole('dialog', { name: '导入文档' });
    await user.selectOptions(within(dialog).getByRole('combobox', { name: '目标知识库' }), 'kb1');
    await user.upload(within(dialog).getByLabelText('选择文档文件'), file);
    await user.click(within(dialog).getByRole('button', { name: '开始导入' }));

    expect(await screen.findByText('文档已上传，但列表刷新失败')).toBeInTheDocument();
    expect(screen.queryByText('已导入 1 个文档，正在处理中。')).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: '导入文档' })).not.toBeInTheDocument();
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

  it('polls while global documents are processing and stops presenting stale status', async () => {
    let poll: TimerHandler | undefined;
    vi.spyOn(window, 'setInterval').mockImplementation((handler, timeout) => {
      if (timeout === 3000) poll = handler;
      return 1;
    });
    const processingDocument = { ...document, status: 'uploaded' as const };
    vi.mocked(listGlobalDocuments)
      .mockResolvedValueOnce({ items: [processingDocument], total: 1, page: 1, pageSize: 20 })
      .mockResolvedValueOnce({ items: [document], total: 1, page: 1, pageSize: 20 });
    renderPage();

    const processingRow = (await screen.findByText('handbook.pdf')).closest('tr');
    expect(processingRow).not.toBeNull();
    expect(within(processingRow!).getByText('已上传')).toBeInTheDocument();
    await waitFor(() => expect(poll).toBeTypeOf('function'));
    act(() => {
      if (typeof poll === 'function') poll();
    });

    expect(await screen.findByText('已完成')).toBeInTheDocument();
    expect(listGlobalDocuments).toHaveBeenCalledTimes(2);
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

  it('keeps global document table cells aligned with their headers', async () => {
    vi.mocked(listGlobalDocuments).mockResolvedValue({ items: [document], total: 1, page: 1, pageSize: 20 });
    renderPage();

    const documentRow = (await screen.findByText('handbook.pdf')).closest('tr');
    expect(documentRow).not.toBeNull();
    expect(within(documentRow!).getAllByRole('cell')).toHaveLength(9);
  });

  it('disables document import while a batch mutation is running', async () => {
    const mutation = deferred<{ processedCount: number }>();
    vi.mocked(listGlobalDocuments).mockResolvedValue({ items: [document], total: 1, page: 1, pageSize: 20 });
    vi.mocked(batchReprocessDocuments).mockReturnValue(mutation.promise);
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('checkbox', { name: '选择 handbook.pdf' }));
    await user.click(screen.getByRole('button', { name: '批量重处理' }));

    expect(screen.getByRole('button', { name: '导入文档' })).toBeDisabled();
    mutation.resolve({ processedCount: 1 });
  });

  it('distinguishes a submitted batch reprocess from its failed list refresh', async () => {
    vi.mocked(listGlobalDocuments)
      .mockResolvedValueOnce({ items: [document], total: 1, page: 1, pageSize: 20 })
      .mockRejectedValueOnce(new Error('offline'));
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('checkbox', { name: '选择 handbook.pdf' }));
    await user.click(screen.getByRole('button', { name: '批量重处理' }));

    expect(await screen.findByText('批量重处理已提交，但页面数据刷新失败：请求失败')).toBeInTheDocument();
  });

  it('distinguishes a completed batch delete from its failed list refresh', async () => {
    vi.mocked(listGlobalDocuments)
      .mockResolvedValueOnce({ items: [document], total: 1, page: 1, pageSize: 20 })
      .mockRejectedValueOnce(new Error('offline'));
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('checkbox', { name: '选择 handbook.pdf' }));
    await user.click(screen.getByRole('button', { name: '批量删除' }));
    await user.click(within(screen.getByRole('dialog', { name: '批量删除文档' })).getByRole('button', { name: '删除' }));

    expect(await screen.findByText('批量删除已完成，但列表刷新失败：请求失败')).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: '批量删除文档' })).not.toBeInTheDocument();
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
