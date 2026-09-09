import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  batchReprocessDocuments,
  deleteKnowledgeBase,
  deleteDocument,
  getKnowledgeBase,
  getWorkspacePreference,
  listDocuments,
  listKnowledgeBaseCategories,
  listKnowledgeBaseTags,
  listKnowledgeBases,
  reprocessDocument,
  updateKnowledgeBase,
  uploadDocument,
} from '../../api/resources';
import { ApiError } from '../../api/client';
import { renderWithRouter } from '../../test/render';
import type { DocumentItem, KnowledgeBase } from '../../types/api';
import { DocumentsPage } from './DocumentsPage';

const documentListMocks = vi.hoisted(() => ({
  counts: vi.fn(),
  primary: vi.fn(),
}));

vi.mock('../../api/resources', () => ({
  batchDeleteDocuments: vi.fn(),
  batchReprocessDocuments: vi.fn(),
  deleteKnowledgeBase: vi.fn(),
  deleteDocument: vi.fn(),
  getKnowledgeBase: vi.fn(),
  getSystemCapabilities: vi.fn().mockResolvedValue({
    rerankEnabled: false,
    upload: { maxFileBytes: 50 * 1024 * 1024, allowedExtensions: ['txt', 'md', 'pdf'] },
    retrieval: { maxVectorTopN: 100, maxRerankTopK: 20 },
    account: {
      minPasswordLength: 8,
      maxPasswordBytes: 72,
      maxDisplayNameLength: 128,
      maxAvatarUrlLength: 512,
    },
  }),
  getWorkspacePreference: vi.fn(),
  listDocuments: documentListMocks.primary,
  listGlobalDocuments: vi.fn(async (params: {
    knowledgeBaseId?: string;
    page?: number;
    pageSize?: number;
    status?: string;
  } = {}) => {
    const response = params.pageSize === 1
      ? await documentListMocks.counts(params)
      : await documentListMocks.primary(params.knowledgeBaseId ?? '', params);
    return {
      ...response,
      items: response.items ?? [],
      total: response.total ?? response.items?.length ?? 0,
      page: response.page ?? params.page ?? 1,
      pageSize: response.pageSize ?? params.pageSize ?? 20,
    };
  }),
  listKnowledgeBaseCategories: vi.fn(),
  listKnowledgeBaseTags: vi.fn(),
  listKnowledgeBases: vi.fn(),
  logout: vi.fn(),
  recordKnowledgeBaseView: vi.fn().mockResolvedValue(undefined),
  replaceDocument: vi.fn(),
  reprocessDocument: vi.fn(),
  updateKnowledgeBase: vi.fn(),
  uploadDocument: vi.fn(),
  uploadGlobalDocument: vi.fn(),
}));

vi.mock('./DocumentDetailDrawer', () => ({
  DocumentDetailDrawer: ({
    chunkId,
    documentId,
    onClose,
  }: {
    chunkId?: string;
    documentId: string;
    onClose: () => void;
  }) => (
    <section aria-label="文档来源" role="dialog">
      <output>{documentId}:{chunkId ?? ''}</output>
      <button type="button" onClick={onClose}>关闭来源</button>
    </section>
  ),
}));

const knowledgeBase = {
  id: 'kb1',
  name: '制度库',
  description: '制度说明',
  retrievalConfig: { vectorTopN: 30, rerankTopK: 5, scoreThreshold: 0.3, enableRerank: true },
  createdAt: '2026-07-01T00:00:00Z',
  updatedAt: '2026-07-01T00:00:00Z',
} satisfies KnowledgeBase;

const secondKnowledgeBase = {
  ...knowledgeBase,
  id: 'kb2',
  name: '产品库',
} satisfies KnowledgeBase;

const uploadedDocument = {
  id: 'doc1',
  knowledgeBaseId: 'kb1',
  filename: 'handbook.pdf',
  fileType: 'pdf',
  fileSize: 1024,
  status: 'uploaded',
  errorMessage: null,
  createdAt: '2026-07-01T00:00:00Z',
  updatedAt: '2026-07-01T00:00:00Z',
} satisfies DocumentItem;

const secondDocument = {
  ...uploadedDocument,
  id: 'doc2',
  knowledgeBaseId: 'kb2',
  filename: 'product.md',
  fileType: 'md',
  status: 'completed',
} satisfies DocumentItem;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

beforeEach(() => {
  documentListMocks.counts.mockReset().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 1 });
  vi.mocked(getKnowledgeBase).mockReset().mockResolvedValue(knowledgeBase);
  vi.mocked(listDocuments).mockReset().mockResolvedValue({ items: [] });
  vi.mocked(listKnowledgeBases).mockReset().mockResolvedValue({ items: [knowledgeBase] });
  vi.mocked(listKnowledgeBaseCategories).mockReset().mockResolvedValue({ items: [] });
  vi.mocked(listKnowledgeBaseTags).mockReset().mockResolvedValue({ items: [] });
  vi.mocked(getWorkspacePreference).mockReset().mockResolvedValue({
    viewMode: 'table', scope: 'all', sort: 'updatedAt_desc', visibility: 'all', expandedCategoryIds: [],
  });
  vi.mocked(uploadDocument).mockReset();
  vi.mocked(deleteKnowledgeBase).mockReset().mockResolvedValue(undefined);
  vi.mocked(deleteDocument).mockReset();
  vi.mocked(reprocessDocument).mockReset();
  vi.mocked(batchReprocessDocuments).mockReset();
  vi.mocked(updateKnowledgeBase).mockReset().mockImplementation(async (_, input) => ({
    ...knowledgeBase,
    name: input.name,
    description: input.description,
    categoryId: input.categoryId,
    visibility: input.visibility,
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

function renderPage(entry = '/knowledge-bases/kb1/documents') {
  return renderWithRouter(
    <>
      <Routes>
        <Route path="/knowledge-bases/:id/documents" element={<DocumentsPage scoped />} />
        <Route path="/chat" element={<div>问答页</div>} />
        <Route path="/chat/:sessionId" element={<div>问答页</div>} />
        <Route path="/away" element={<div>已离开文档页</div>} />
      </Routes>
      <LocationProbe />
      <KnowledgeBaseRouteControl />
      <LeaveDocumentsButton />
    </>,
    [entry],
  );
}

function LocationProbe() {
  const location = useLocation();
  return <output aria-label="当前位置">{location.pathname}{location.search}</output>;
}

function KnowledgeBaseRouteControl() {
  const navigate = useNavigate();
  return <button type="button" onClick={() => navigate('/knowledge-bases/kb2/documents')}>切换到产品库路由</button>;
}

function LeaveDocumentsButton() {
  const navigate = useNavigate();
  return <button type="button" onClick={() => navigate('/away')}>离开文档页</button>;
}

async function uploadThroughDialog(user: ReturnType<typeof userEvent.setup>, file: File, open = true) {
  if (open) {
    await user.click(await screen.findByRole('button', { name: '导入文档' }));
  }
  const dialog = await screen.findByRole('dialog', { name: '导入文档' });
  await user.upload(within(dialog).getByLabelText('选择文档文件'), file);
  await user.click(within(dialog).getByRole('button', { name: '开始导入' }));
}

async function openDocumentMenu(user: ReturnType<typeof userEvent.setup>, filename: string) {
  const label = `${filename} 的更多操作`;
  await user.click(await screen.findByRole('button', { name: label }));
  return screen.getByRole('menu', { name: label });
}

async function clickDocumentAction(
  user: ReturnType<typeof userEvent.setup>,
  filename: string,
  action: string,
) {
  const menu = await openDocumentMenu(user, filename);
  await user.click(within(menu).getByRole('menuitem', { name: action }));
}

describe('DocumentsPage', () => {
  it('keeps a cancelled document neutral without failure advice', async () => {
    vi.mocked(listDocuments).mockResolvedValue({ items: [{
      ...uploadedDocument,
      status: 'failed',
      jobStatus: 'cancelled',
      errorMessage: '用户主动取消',
    }] });
    renderPage();

    const row = (await screen.findByRole('button', { name: 'handbook.pdf', exact: true })).closest('tr')!;
    expect(within(row).getByText('已取消')).toBeInTheDocument();
    expect(within(row).queryByText(/文档处理失败|用户主动取消/)).not.toBeInTheDocument();
  });

  it('queries every processing stage and preserves the aggregate filter in the URL', async () => {
    documentListMocks.counts.mockImplementation(async (params) => ({
      items: [], total: params.status === undefined ? 4 : 0,
    }));
    const user = userEvent.setup();
    renderPage();

    const processing = await screen.findByRole('button', { name: /4.*处理中/ });
    await user.click(processing);
    await waitFor(() => expect(documentListMocks.primary).toHaveBeenLastCalledWith(
      'kb1', expect.objectContaining({ status: 'processing', page: 1 }),
    ));
    expect(screen.getByLabelText('当前位置')).toHaveTextContent('status=processing');
    expect(screen.getByRole('combobox', { name: '处理阶段' })).toHaveValue('processing');

    await user.selectOptions(screen.getByRole('combobox', { name: '处理阶段' }), 'embedding');
    await waitFor(() => expect(documentListMocks.primary).toHaveBeenLastCalledWith(
      'kb1', expect.objectContaining({ status: 'embedding' }),
    ));
    await user.selectOptions(screen.getByRole('combobox', { name: '处理阶段' }), 'processing');
    await user.click(screen.getByRole('button', { name: /4.*处理中/ }));
    expect(screen.getByLabelText('当前位置')).not.toHaveTextContent('status=');
  });

  it('restores the aggregate processing filter from a deep link', async () => {
    renderPage('/knowledge-bases/kb1/documents?status=processing');
    expect(await screen.findByRole('combobox', { name: '处理阶段' })).toHaveValue('processing');
    await waitFor(() => expect(documentListMocks.primary).toHaveBeenLastCalledWith(
      'kb1', expect.objectContaining({ status: 'processing' }),
    ));
  });

  it('offers knowledge-base actions without eagerly loading edit metadata', async () => {
    const user = userEvent.setup();
    renderPage();

    const actions = await screen.findByRole('button', { name: '制度库 的更多操作' });
    expect(listKnowledgeBaseCategories).not.toHaveBeenCalled();
    expect(listKnowledgeBaseTags).not.toHaveBeenCalled();
    await user.click(actions);

    const menu = screen.getByRole('menu', { name: '制度库 的更多操作' });
    expect(within(menu).getByRole('menuitem', { name: '编辑知识库' })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: '删除知识库' })).toBeInTheDocument();
  });

  it('keeps the document heading and knowledge-base selector in sync after editing', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: '制度库 的更多操作' }));
    await user.click(screen.getByRole('menuitem', { name: '编辑知识库' }));
    const drawer = await screen.findByRole('dialog', { name: '编辑知识库' });
    const name = within(drawer).getByRole('textbox', { name: '名称' });
    await user.clear(name);
    await user.type(name, '员工制度库');
    await user.click(within(drawer).getByRole('button', { name: '保存修改' }));

    expect(await screen.findByRole('heading', { name: '员工制度库' })).toBeInTheDocument();
    expect(within(screen.getByRole('navigation', { name: '面包屑' })).getByText('员工制度库'))
      .toHaveAttribute('aria-current', 'page');
  });

  it('keeps the scoped knowledge base visible when it is absent from the workspace page', async () => {
    vi.mocked(listKnowledgeBases).mockResolvedValue({ items: [secondKnowledgeBase] });
    renderPage();

    expect(await screen.findByRole('heading', { name: '制度库' })).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: '知识库筛选' })).not.toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: '知识库功能' })).toBeInTheDocument();
  });

  it('does not load knowledge-base category workspace data', async () => {
    renderPage();
    await screen.findByRole('heading', { name: '制度库' });

    const sectionNav = screen.getByRole('navigation', { name: '知识库功能' });
    expect(within(sectionNav).getByRole('link', { name: '概览' })).toHaveAttribute('href', '/knowledge-bases/kb1');
    expect(within(sectionNav).getByRole('link', { name: '文档' })).toHaveAttribute('aria-current', 'page');
    expect(within(sectionNav).queryByRole('link', { name: 'AI 问答' })).not.toBeInTheDocument();
    expect(within(sectionNav).getByRole('link', { name: '设置' })).toHaveAttribute('href', '/knowledge-bases/kb1/settings');
    expect(screen.queryByRole('link', { name: '返回详情' })).not.toBeInTheDocument();
    expect(listKnowledgeBaseCategories).not.toHaveBeenCalled();
    expect(getWorkspacePreference).not.toHaveBeenCalled();
  });

  it('announces an asynchronous document-list failure', async () => {
    vi.mocked(listDocuments).mockRejectedValue(new Error('offline'));
    documentListMocks.counts.mockRejectedValue(new Error('offline'));
    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent('文档列表加载失败');
    expect(screen.queryByText('当前筛选下没有文档。上传 txt、md 或 pdf 后开始处理。')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument();
    expect(within(screen.getByText('可用于问答').parentElement!).getByText('—')).toBeInTheDocument();
  });

  it('does not let a late reprocess failure affect a newer knowledge-base operation', async () => {
    const firstReprocess = deferred<Awaited<ReturnType<typeof reprocessDocument>>>();
    const secondReprocess = deferred<Awaited<ReturnType<typeof reprocessDocument>>>();
    vi.mocked(reprocessDocument).mockImplementation((documentId) => (
      documentId === uploadedDocument.id ? firstReprocess.promise : secondReprocess.promise
    ));
    vi.mocked(getKnowledgeBase).mockImplementation((knowledgeBaseId) => Promise.resolve(
      knowledgeBaseId === secondKnowledgeBase.id ? secondKnowledgeBase : knowledgeBase,
    ));
    vi.mocked(listDocuments).mockImplementation((knowledgeBaseId) => Promise.resolve({
      items: knowledgeBaseId === secondKnowledgeBase.id ? [secondDocument] : [{ ...uploadedDocument, status: 'completed' }],
    }));
    vi.mocked(listKnowledgeBases).mockResolvedValue({ items: [knowledgeBase, secondKnowledgeBase] });
    const user = userEvent.setup();
    renderPage();

    await clickDocumentAction(user, uploadedDocument.filename, '重新处理');
    await user.click(screen.getByRole('button', { name: '切换到产品库路由' }));
    expect(await screen.findByText('product.md')).toBeInTheDocument();
    await clickDocumentAction(user, secondDocument.filename, '重新处理');

    await act(async () => {
      firstReprocess.reject(new Error('offline'));
      await Promise.resolve();
    });
    expect(screen.queryByText('文档重处理失败')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: `${secondDocument.filename} 的更多操作` })).toBeDisabled();

    await act(async () => {
      secondReprocess.resolve(secondDocument);
      await Promise.resolve();
    });
  });

  it('does not let a late batch reprocess failure unlock a newer batch operation', async () => {
    const firstBatch = deferred<Awaited<ReturnType<typeof batchReprocessDocuments>>>();
    const secondBatch = deferred<Awaited<ReturnType<typeof batchReprocessDocuments>>>();
    vi.mocked(batchReprocessDocuments)
      .mockReturnValueOnce(firstBatch.promise)
      .mockReturnValueOnce(secondBatch.promise);
    vi.mocked(getKnowledgeBase).mockImplementation((knowledgeBaseId) => Promise.resolve(
      knowledgeBaseId === secondKnowledgeBase.id ? secondKnowledgeBase : knowledgeBase,
    ));
    vi.mocked(listDocuments).mockImplementation((knowledgeBaseId) => Promise.resolve({
      items: knowledgeBaseId === secondKnowledgeBase.id ? [secondDocument] : [{ ...uploadedDocument, status: 'completed' }],
    }));
    vi.mocked(listKnowledgeBases).mockResolvedValue({ items: [knowledgeBase, secondKnowledgeBase] });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('checkbox', { name: '选择 handbook.pdf' }));
    await user.click(screen.getByRole('button', { name: '重新处理' }));
    await user.click(screen.getByRole('button', { name: '切换到产品库路由' }));
    await user.click(await screen.findByRole('checkbox', { name: '选择 product.md' }));
    await user.click(screen.getByRole('button', { name: '重新处理' }));

    await act(async () => {
      firstBatch.reject(new Error('offline'));
      await Promise.resolve();
    });
    expect(screen.queryByText('批量重处理失败')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重新处理' })).toBeDisabled();

    await act(async () => {
      secondBatch.resolve({ processedCount: 1 });
      await Promise.resolve();
    });
  });

  it('does not let a slow previous knowledge base load overwrite the current route', async () => {
    const firstKnowledgeBase = deferred<KnowledgeBase>();
    const firstDocuments = deferred<{ items: DocumentItem[] }>();
    vi.mocked(getKnowledgeBase).mockImplementation((id) => (
      id === knowledgeBase.id ? firstKnowledgeBase.promise : Promise.resolve(secondKnowledgeBase)
    ));
    vi.mocked(listDocuments).mockImplementation((id) => (
      id === knowledgeBase.id ? firstDocuments.promise : Promise.resolve({ items: [secondDocument] })
    ));
    vi.mocked(listKnowledgeBases).mockResolvedValue({ items: [knowledgeBase, secondKnowledgeBase] });
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole('button', { name: '切换到产品库路由' }));
    expect(await screen.findByRole('heading', { name: '产品库' })).toBeInTheDocument();
    expect(screen.getByText('product.md')).toBeInTheDocument();

    await act(async () => {
      firstKnowledgeBase.resolve(knowledgeBase);
      firstDocuments.resolve({ items: [uploadedDocument] });
      await Promise.resolve();
    });

    expect(screen.getByRole('heading', { name: '产品库' })).toBeInTheDocument();
    expect(screen.getByText('product.md')).toBeInTheDocument();
    expect(screen.queryByText('handbook.pdf')).not.toBeInTheDocument();
  });

  it('does not inject a late upload response into another knowledge base route', async () => {
    const uploadResult = deferred<DocumentItem>();
    vi.mocked(uploadDocument).mockReturnValue(uploadResult.promise);
    vi.mocked(getKnowledgeBase).mockImplementation((id) => Promise.resolve(
      id === secondKnowledgeBase.id ? secondKnowledgeBase : knowledgeBase,
    ));
    vi.mocked(listDocuments).mockImplementation((id) => Promise.resolve({
      items: id === secondKnowledgeBase.id ? [secondDocument] : [],
    }));
    vi.mocked(listKnowledgeBases).mockResolvedValue({ items: [knowledgeBase, secondKnowledgeBase] });
    const user = userEvent.setup();
    renderPage();

    await uploadThroughDialog(user, new File(['content'], 'handbook.pdf', { type: 'application/pdf' }));
    await waitFor(() => expect(uploadDocument).toHaveBeenCalledWith(
      knowledgeBase.id,
      expect.any(File),
      expect.any(Function),
      expect.any(AbortSignal),
    ));
    act(() => screen.getByText('切换到产品库路由').click());
    expect(await screen.findByRole('heading', { name: '产品库' })).toBeInTheDocument();

    await act(async () => {
      uploadResult.resolve(uploadedDocument);
      await Promise.resolve();
    });

    expect(screen.getByText('product.md')).toBeInTheDocument();
    expect(screen.queryByText('handbook.pdf')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '基于此知识库提问' })).toBeInTheDocument();
  });

  it('does not let an old upload unlock a newer knowledge-base upload', async () => {
    const firstUpload = deferred<DocumentItem>();
    const secondUpload = deferred<DocumentItem>();
    vi.mocked(uploadDocument)
      .mockReturnValueOnce(firstUpload.promise)
      .mockReturnValueOnce(secondUpload.promise);
    vi.mocked(getKnowledgeBase).mockImplementation((knowledgeBaseId) => Promise.resolve(
      knowledgeBaseId === secondKnowledgeBase.id ? secondKnowledgeBase : knowledgeBase,
    ));
    vi.mocked(listDocuments).mockImplementation((knowledgeBaseId) => Promise.resolve({
      items: knowledgeBaseId === secondKnowledgeBase.id ? [secondDocument] : [],
    }));
    vi.mocked(listKnowledgeBases).mockResolvedValue({ items: [knowledgeBase, secondKnowledgeBase] });
    const user = userEvent.setup();
    renderPage();

    await uploadThroughDialog(user, new File(['a'], 'first.pdf', { type: 'application/pdf' }));
    act(() => screen.getByText('切换到产品库路由').click());
    await screen.findByRole('heading', { name: '产品库' });
    await uploadThroughDialog(user, new File(['b'], 'second.md', { type: 'text/markdown' }));
    await waitFor(() => expect(uploadDocument).toHaveBeenCalledTimes(2));

    await act(async () => {
      firstUpload.resolve(uploadedDocument);
      await Promise.resolve();
    });
    expect(screen.getByRole('button', { name: '停止上传' })).toBeEnabled();

    await act(async () => {
      secondUpload.resolve(secondDocument);
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '导入文档' })).not.toBeInTheDocument());
  });

  it('announces the primary document-list loading state', () => {
    vi.mocked(listDocuments).mockReturnValue(deferred<Awaited<ReturnType<typeof listDocuments>>>().promise);
    renderPage();

    expect(screen.getByRole('status', { name: '正在加载' })).toBeInTheDocument();
  });

  it('does not refresh document data after an in-flight reprocess outlives the page', async () => {
    const reprocessResult = deferred<Awaited<ReturnType<typeof reprocessDocument>>>();
    vi.mocked(reprocessDocument).mockReturnValue(reprocessResult.promise);
    vi.mocked(listDocuments).mockResolvedValue({ items: [{ ...uploadedDocument, status: 'completed' }] });
    const user = userEvent.setup();
    renderPage();

    await clickDocumentAction(user, uploadedDocument.filename, '重新处理');
    await user.click(screen.getByRole('button', { name: '离开文档页' }));
    expect(await screen.findByText('已离开文档页')).toBeInTheDocument();
    await act(async () => {
      reprocessResult.resolve({ ...uploadedDocument, status: 'uploaded' });
      await Promise.resolve();
    });

    expect(listDocuments).toHaveBeenCalledTimes(1);
  });

  it('announces successful document reprocessing', async () => {
    vi.mocked(listDocuments).mockResolvedValue({ items: [{ ...uploadedDocument, status: 'completed' }] });
    vi.mocked(reprocessDocument).mockResolvedValue({ ...uploadedDocument, status: 'uploaded' });
    const user = userEvent.setup();
    renderPage();

    await clickDocumentAction(user, uploadedDocument.filename, '重新处理');

    expect(await within(screen.getByRole('region', { name: '通知' })).findByRole('status')).toHaveTextContent('已开始重新处理');
  });

  it('locks the active document row while keeping unrelated page controls available', async () => {
    const reprocessResult = deferred<Awaited<ReturnType<typeof reprocessDocument>>>();
    vi.mocked(reprocessDocument).mockReturnValue(reprocessResult.promise);
    vi.mocked(listDocuments).mockResolvedValue({ items: [{ ...uploadedDocument, status: 'completed' }] });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('checkbox', { name: `选择 ${uploadedDocument.filename}` }));
    await clickDocumentAction(user, uploadedDocument.filename, '重新处理');

    expect(screen.getByRole('button', { name: '导入文档' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '重新处理' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '删除' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '查看' })).toBeDisabled();
    expect(screen.getByRole('button', { name: `${uploadedDocument.filename} 的更多操作` })).toBeDisabled();
    expect(screen.getByRole('button', { name: '更多文档操作' })).toBeEnabled();

    reprocessResult.resolve({ ...uploadedDocument, status: 'uploaded' });
    await waitFor(() => expect(screen.getByRole('button', { name: '导入文档' })).toBeEnabled());
  });

  it('synchronously blocks opening document detail after a mutation starts', async () => {
    const reprocessResult = deferred<Awaited<ReturnType<typeof reprocessDocument>>>();
    vi.mocked(reprocessDocument).mockReturnValue(reprocessResult.promise);
    vi.mocked(listDocuments).mockResolvedValue({ items: [{ ...uploadedDocument, status: 'completed' }] });
    renderPage();

    const rowMenu = await openDocumentMenu(userEvent.setup(), uploadedDocument.filename);
    const reprocessButton = within(rowMenu).getByRole('menuitem', { name: '重新处理' });
    const detailButton = screen.getByRole('button', { name: '查看' });
    act(() => {
      reprocessButton.click();
      detailButton.click();
    });

    expect(reprocessDocument).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog', { name: '文档来源' })).not.toBeInTheDocument();

    reprocessResult.resolve({ ...uploadedDocument, status: 'uploaded' });
  });

  it('clears an operation error after switching to another knowledge base', async () => {
    vi.mocked(uploadDocument).mockRejectedValue(new Error('offline'));
    vi.mocked(getKnowledgeBase).mockImplementation((id) => Promise.resolve(
      id === secondKnowledgeBase.id ? secondKnowledgeBase : knowledgeBase,
    ));
    vi.mocked(listDocuments).mockImplementation((id) => Promise.resolve({
      items: id === secondKnowledgeBase.id ? [secondDocument] : [],
    }));
    vi.mocked(listKnowledgeBases).mockResolvedValue({ items: [knowledgeBase, secondKnowledgeBase] });
    const user = userEvent.setup();
    renderPage();

    await uploadThroughDialog(user, new File(['content'], 'handbook.pdf', { type: 'application/pdf' }));
    expect(await screen.findByText(/上传失败/, { selector: 'small' })).toBeInTheDocument();
    act(() => screen.getByText('切换到产品库路由').click());

    expect(await screen.findByRole('heading', { name: '产品库' })).toBeInTheDocument();
    expect(screen.queryByText('上传失败', { selector: 'small' })).not.toBeInTheDocument();
  });

  it('does not let an older poll overwrite a newer manual refresh', async () => {
    let poll: TimerHandler | undefined;
    vi.spyOn(window, 'setInterval').mockImplementation((handler, timeout) => {
      if (timeout === 3000) poll = handler;
      return 1;
    });
    const pollResult = deferred<{ items: DocumentItem[] }>();
    const refreshedDocument = { ...uploadedDocument, id: 'doc-latest', filename: 'latest.pdf', status: 'completed' as const };
    vi.mocked(listDocuments)
      .mockResolvedValueOnce({ items: [uploadedDocument] })
      .mockReturnValueOnce(pollResult.promise)
      .mockResolvedValueOnce({ items: [refreshedDocument] });
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByText('handbook.pdf')).toBeInTheDocument();
    await waitFor(() => expect(poll).toBeTypeOf('function'));
    act(() => {
      if (typeof poll === 'function') poll();
    });
    await waitFor(() => expect(listDocuments).toHaveBeenCalledTimes(2));
    await user.click(screen.getByRole('button', { name: '更多文档操作' }));
    const toolbarMenu = screen.getByRole('menu', { name: '更多文档操作' });
    await user.click(within(toolbarMenu).getByRole('menuitem', { name: '刷新列表' }));
    expect(await screen.findByText('latest.pdf')).toBeInTheDocument();

    await act(async () => {
      pollResult.resolve({ items: [uploadedDocument] });
      await Promise.resolve();
    });
    expect(screen.getByText('latest.pdf')).toBeInTheDocument();
    expect(screen.queryByText('handbook.pdf')).not.toBeInTheDocument();
  });

  it('does not let stale count requests overwrite the current search totals', async () => {
    const stale = deferred<{ items: DocumentItem[]; total: number; page: number; pageSize: number }>();
    documentListMocks.counts.mockImplementation((params: { q?: string; status?: string }) => {
      if (params.q === '旧筛选') return stale.promise;
      if (params.q === '新筛选') {
        const total = params.status === 'completed' ? 5 : params.status === 'failed' ? 1 : 8;
        return Promise.resolve({ items: [], total, page: 1, pageSize: 1 });
      }
      return Promise.resolve({ items: [], total: 0, page: 1, pageSize: 1 });
    });
    renderPage();
    const search = await screen.findByRole('searchbox', { name: '按文件名搜索' });

    fireEvent.change(search, { target: { value: '旧筛选' } });
    await waitFor(() => expect(documentListMocks.counts).toHaveBeenCalledWith(expect.objectContaining({ q: '旧筛选' })));
    fireEvent.change(search, { target: { value: '新筛选' } });

    const metrics = screen.getByRole('group', { name: '文档处理概况' });
    await waitFor(() => expect(metrics).toHaveTextContent('8个文档'));
    expect(metrics).toHaveTextContent('5可用于问答');
    expect(metrics).toHaveTextContent('2处理中');

    await act(async () => {
      stale.resolve({ items: [], total: 99, page: 1, pageSize: 1 });
      await Promise.resolve();
    });
    expect(metrics).toHaveTextContent('8个文档');
    expect(metrics).not.toHaveTextContent('99个文档');
  });

  it('keeps a failed document delete error inside the confirmation dialog', async () => {
    vi.mocked(listDocuments).mockResolvedValue({ items: [uploadedDocument] });
    vi.mocked(deleteDocument).mockRejectedValue(
      new ApiError(500, { code: 'DELETE_FAILED', message: '暂时无法删除文档' }),
    );
    const user = userEvent.setup();
    renderPage();

    await clickDocumentAction(user, uploadedDocument.filename, '删除');
    const dialog = screen.getByRole('dialog', { name: '删除文档' });
    await user.click(within(dialog).getByRole('button', { name: '删除' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('暂时无法删除文档');
    expect(within(dialog).getByRole('button', { name: '删除' })).toBeEnabled();
  });

  it('opens and closes a citation source from URL parameters', async () => {
    const user = userEvent.setup();
    renderPage('/knowledge-bases/kb1/documents?documentId=doc1&chunkId=chunk1');

    expect(await screen.findByRole('dialog', { name: '文档来源' })).toHaveTextContent('doc1:chunk1');
    await user.click(screen.getByRole('button', { name: '关闭来源' }));

    expect(screen.queryByRole('dialog', { name: '文档来源' })).not.toBeInTheDocument();
    expect(screen.getByRole('status', { name: '当前位置' })).toHaveTextContent(
      '/knowledge-bases/kb1/documents',
    );
  });

  it('guides the user to upload without opening the system file picker automatically', async () => {
    renderPage('/knowledge-bases/kb1/documents?intent=upload');

    const dialog = await screen.findByRole('dialog', { name: '导入文档' });
    const filePicker = within(dialog).getByRole('button', { name: '拖放或选择文档' });

    await waitFor(() => expect(filePicker).toHaveFocus());
    expect(uploadDocument).not.toHaveBeenCalled();

    await userEvent.setup().click(within(dialog).getByRole('button', { name: '取消' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '导入文档' })).not.toBeInTheDocument());
    expect(screen.getByRole('status', { name: '当前位置' })).toHaveTextContent(
      '/knowledge-bases/kb1/documents',
    );
  });

  it('refreshes the list after upload and keeps the knowledge-base chat action available', async () => {
    const user = userEvent.setup();
    let uploaded = false;
    vi.mocked(uploadDocument).mockImplementation(async () => {
      uploaded = true;
      return uploadedDocument;
    });
    vi.mocked(listDocuments).mockImplementation(async () => ({
      items: uploaded ? [{ ...uploadedDocument, status: 'completed' }] : [],
    }));
    renderPage('/knowledge-bases/kb1/documents?intent=upload');
    await uploadThroughDialog(user, new File(['content'], 'handbook.pdf', { type: 'application/pdf' }), false);

    await waitFor(() => expect(screen.queryByRole('dialog', { name: '导入文档' })).not.toBeInTheDocument());
    await waitFor(() => expect(vi.mocked(listDocuments).mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(await screen.findByText('handbook.pdf')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '基于此知识库提问' }));
    expect(screen.getByRole('status', { name: '当前位置' })).toHaveTextContent(
      '/chat?knowledgeBaseId=kb1',
    );
  });

  it('shows a failed processing result after the uploaded document is refreshed', async () => {
    const user = userEvent.setup();
    const failedDocument = { ...uploadedDocument, status: 'failed' as const, errorMessage: 'parse failed' };
    let uploaded = false;
    vi.mocked(uploadDocument).mockImplementation(async () => {
      uploaded = true;
      return uploadedDocument;
    });
    vi.mocked(listDocuments).mockImplementation(async () => ({
      items: uploaded ? [failedDocument] : [],
    }));
    renderPage('/knowledge-bases/kb1/documents?intent=upload');
    await uploadThroughDialog(user, new File(['content'], 'handbook.pdf', { type: 'application/pdf' }), false);

    await waitFor(() => expect(screen.queryByRole('dialog', { name: '导入文档' })).not.toBeInTheDocument());
    const row = (await screen.findByText('handbook.pdf')).closest('tr');
    expect(row).not.toBeNull();
    expect(within(row!).getByText('失败')).toBeInTheDocument();
    expect(within(row!).getByText('文档处理失败，请检查文件内容或稍后重处理。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '基于此知识库提问' })).toBeInTheDocument();
  });

  it('treats a stopped upload as unknown and refreshes before allowing another upload', async () => {
    let uploadSignal: AbortSignal | undefined;
    vi.mocked(uploadDocument).mockImplementation((
      _knowledgeBaseId,
      _file,
      _onProgress,
      signal,
    ) => {
      uploadSignal = signal;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(
          new ApiError(0, { code: 'REQUEST_ABORTED', message: '请求已取消。' }),
        ), { once: true });
      });
    });
    const user = userEvent.setup();
    renderPage();

    await uploadThroughDialog(user, new File(['large-content'], 'large.pdf', { type: 'application/pdf' }));
    const dialog = screen.getByRole('dialog', { name: '导入文档' });
    await waitFor(() => expect(uploadSignal).toBeInstanceOf(AbortSignal));
    await user.click(within(dialog).getByRole('button', { name: '停止上传' }));

    expect(uploadSignal?.aborted).toBe(true);
    expect(await within(dialog).findByText(/上传结果未知/)).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: '重试失败项' })).not.toBeInTheDocument();
    await waitFor(() => expect(listDocuments).toHaveBeenCalledTimes(2));
  });
  it('invites the user to ask only once the imported documents finish processing', async () => {
    const completed = { ...uploadedDocument, status: 'completed' as const };
    vi.mocked(uploadDocument).mockResolvedValue(uploadedDocument);
    vi.mocked(listDocuments).mockResolvedValue({ items: [uploadedDocument] });
    const user = userEvent.setup();
    renderPage();

    await uploadThroughDialog(user, new File(['content'], 'handbook.pdf', { type: 'application/pdf' }));
    await waitFor(() => expect(uploadDocument).toHaveBeenCalledOnce());

    // Still processing: prompting now would send the user to ask a question against
    // chunks that do not exist yet.
    expect(await screen.findByText('handbook.pdf')).toBeInTheDocument();
    expect(screen.queryByText(/可以开始提问/)).not.toBeInTheDocument();

    vi.mocked(listDocuments).mockResolvedValue({ items: [completed] });
    await user.click(screen.getByRole('button', { name: '更多文档操作' }));
    await user.click(screen.getByRole('menuitem', { name: '刷新列表' }));

    const banner = await screen.findByRole('status', { name: '导入结果' });
    expect(banner).toHaveTextContent('1 个文档已处理完成，可以开始提问了。');
    await user.click(within(banner).getByRole('button', { name: '开始提问' }));
    expect(screen.getByLabelText('当前位置')).toHaveTextContent('/chat?knowledgeBaseId=kb1');
  });

  it('does not invite questions about documents that were already complete on load', async () => {
    // The guidance is about a batch the user just imported, not about the list
    // happening to contain finished documents.
    vi.mocked(listDocuments).mockResolvedValue({ items: [{ ...uploadedDocument, status: 'completed' }] });
    renderPage();

    expect(await screen.findByText('handbook.pdf')).toBeInTheDocument();
    expect(screen.queryByText(/可以开始提问/)).not.toBeInTheDocument();
  });

  it('reports a failed import without offering to ask', async () => {
    const failed = { ...uploadedDocument, status: 'failed' as const, errorMessage: 'boom' };
    vi.mocked(uploadDocument).mockResolvedValue(uploadedDocument);
    vi.mocked(listDocuments).mockResolvedValue({ items: [failed] });
    const user = userEvent.setup();
    renderPage();

    await uploadThroughDialog(user, new File(['content'], 'handbook.pdf', { type: 'application/pdf' }));

    const banner = await screen.findByRole('status', { name: '导入结果' });
    expect(banner).toHaveTextContent('文档处理失败，暂时还不能基于它提问。');
    expect(within(banner).queryByRole('button', { name: '开始提问' })).not.toBeInTheDocument();

    await user.click(within(banner).getByRole('button', { name: '关闭提示' }));
    expect(screen.queryByRole('status', { name: '导入结果' })).not.toBeInTheDocument();
  });
  it('shows the classified reason in the list and flags stale documents', async () => {
    vi.mocked(listDocuments).mockResolvedValue({
      items: [
        {
          ...uploadedDocument,
          status: 'failed',
          errorCode: 'encoding_invalid',
          errorMessage: 'content is not valid UTF-8',
        },
        {
          ...uploadedDocument,
          id: 'doc2',
          filename: 'old-policy.md',
          status: 'completed',
          isStale: true,
          staleAfterDays: 180,
        },
      ],
    });
    renderPage();

    const failedRow = (await screen.findByText('handbook.pdf')).closest('tr') as HTMLElement;
    expect(failedRow).toHaveTextContent('文本编码无法识别。');
    // The raw parser sentence stays server-side.
    expect(failedRow).not.toHaveTextContent('UTF-8');
    // Advice belongs in the drawer; the row has to stay one line tall.
    expect(failedRow).not.toHaveTextContent('另存');

    const staleRow = (await screen.findByText('old-policy.md')).closest('tr') as HTMLElement;
    // The status badge survives: a stale document is still completed.
    expect(staleRow).toHaveTextContent('已完成');
    expect(within(staleRow).getByLabelText('超过 180 天没有更新，内容可能已过期。')).toHaveTextContent('可能过期');
  });
});

/**
 * The rest of this file omits `capabilities`, which is the unknown case: the page
 * shows every control and lets the server refuse. These cover the other branch,
 * where the server did report a capability list and it excludes writing.
 */
describe('DocumentsPage capability gating', () => {
  const viewerKnowledgeBase = {
    ...knowledgeBase,
    effectiveRole: 'viewer',
    capabilities: ['kb.read', 'kb.search', 'document.read', 'chat.use'],
  } satisfies KnowledgeBase;

  function renderAsViewer() {
    vi.mocked(getKnowledgeBase).mockResolvedValue(viewerKnowledgeBase);
    vi.mocked(listKnowledgeBases).mockResolvedValue({ items: [viewerKnowledgeBase] });
    vi.mocked(listDocuments).mockResolvedValue({ items: [uploadedDocument] });
    return renderPage();
  }

  /**
   * The workspace-wide route, which the rest of this file never renders. Upload
   * targets come from the knowledge-base list request, and on the scoped route
   * nothing on screen changes when it resolves -- so an assertion there passes
   * against the empty initial state whether the filter works or not. Here the
   * picker lists the base, which is the signal to wait for.
   */
  async function renderWorkspaceWide(bases: KnowledgeBase[], documents: DocumentItem[] = []) {
    vi.mocked(listKnowledgeBases).mockResolvedValue({ items: bases });
    vi.mocked(listDocuments).mockResolvedValue({ items: documents });
    renderWithRouter(
      <Routes>
        <Route path="/documents" element={<DocumentsPage />} />
        <Route path="/knowledge-bases" element={<div>知识库列表</div>} />
      </Routes>,
      ['/documents'],
    );
    const picker = await screen.findByRole('combobox', { name: '知识库筛选' });
    await waitFor(() => {
      expect(within(picker).getAllByRole('option')).toHaveLength(bases.length + 1);
    });
  }

  it('offers no upload target when every readable base is read-only', async () => {
    await renderWorkspaceWide([viewerKnowledgeBase]);

    // The base is readable and listed in the filter, yet not a destination.
    expect(within(screen.getByRole('combobox', { name: '知识库筛选' })).getByRole('option', { name: '制度库' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '导入文档' })).toBeDisabled();
    // With no writable base the empty state points at creating one instead.
    expect(await screen.findByRole('link', { name: '先新建知识库' })).toBeInTheDocument();
  });

  it('offers upload once one readable base is writable', async () => {
    const writable = {
      ...knowledgeBase,
      id: 'kb2',
      name: '产品库',
      effectiveRole: 'editor',
      capabilities: ['kb.read', 'document.read', 'content.write'],
    } satisfies KnowledgeBase;
    // A document on screen, so the empty state does not add a second import button.
    await renderWorkspaceWide([viewerKnowledgeBase, writable], [uploadedDocument]);

    expect(screen.getByRole('button', { name: '导入文档' })).toBeEnabled();
  });

  it('leaves a viewer the document list without any way to change it', async () => {
    renderAsViewer();

    // The row is present: document.read is what put it there.
    expect(await screen.findByText(uploadedDocument.filename)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: `${uploadedDocument.filename} 的更多操作` })).not.toBeInTheDocument();
    expect(screen.getByLabelText(`选择 ${uploadedDocument.filename}`)).toBeDisabled();
    expect(screen.getByLabelText('选择当前页全部文档')).toBeDisabled();
  });

  it('hides the knowledge-base menu when the caller can neither edit nor delete it', async () => {
    renderAsViewer();

    await screen.findByText(uploadedDocument.filename);
    expect(screen.queryByRole('button', { name: '制度库 的更多操作' })).not.toBeInTheDocument();
  });

  it('keeps write controls for an editor, who holds content.write but not kb.delete', async () => {
    const editorKnowledgeBase = {
      ...knowledgeBase,
      effectiveRole: 'editor',
      capabilities: ['kb.read', 'kb.search', 'document.read', 'document.download', 'content.write'],
    } satisfies KnowledgeBase;
    vi.mocked(getKnowledgeBase).mockResolvedValue(editorKnowledgeBase);
    vi.mocked(listKnowledgeBases).mockResolvedValue({ items: [editorKnowledgeBase] });
    vi.mocked(listDocuments).mockResolvedValue({ items: [uploadedDocument] });
    const user = userEvent.setup();
    renderPage();

    await screen.findByText(uploadedDocument.filename);
    expect(screen.getByLabelText(`选择 ${uploadedDocument.filename}`)).toBeEnabled();
    expect(screen.getByRole('button', { name: `${uploadedDocument.filename} 的更多操作` })).toBeEnabled();
    expect(screen.getByRole('button', { name: '导入文档' })).toBeEnabled();
    // Documents yes, the knowledge base itself no: both entries in that menu are
    // above an editor, so it disappears the same way it does for a viewer.
    expect(screen.queryByRole('button', { name: '制度库 的更多操作' })).not.toBeInTheDocument();
  });

  it('offers a manager the edit entry but not the delete entry', async () => {
    const managerKnowledgeBase = {
      ...knowledgeBase,
      effectiveRole: 'manager',
      capabilities: ['kb.read', 'kb.write', 'kb.search', 'document.read', 'content.write', 'content.purge'],
    } satisfies KnowledgeBase;
    vi.mocked(getKnowledgeBase).mockResolvedValue(managerKnowledgeBase);
    vi.mocked(listKnowledgeBases).mockResolvedValue({ items: [managerKnowledgeBase] });
    vi.mocked(listDocuments).mockResolvedValue({ items: [uploadedDocument] });
    const user = userEvent.setup();
    renderPage();

    await screen.findByText(uploadedDocument.filename);
    await user.click(screen.getByRole('button', { name: '制度库 的更多操作' }));
    const menu = screen.getByRole('menu', { name: '制度库 的更多操作' });
    expect(within(menu).getByRole('menuitem', { name: '编辑知识库' })).toBeInTheDocument();
    // Deleting is the owner's alone, so the item is absent rather than disabled.
    expect(within(menu).queryByRole('menuitem', { name: '删除知识库' })).not.toBeInTheDocument();
  });
});
