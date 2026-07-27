import { act, screen, waitFor, within } from '@testing-library/react';
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

vi.mock('../../api/resources', () => ({
  batchDeleteDocuments: vi.fn(),
  batchReprocessDocuments: vi.fn(),
  deleteKnowledgeBase: vi.fn(),
  deleteDocument: vi.fn(),
  getKnowledgeBase: vi.fn(),
  getWorkspacePreference: vi.fn(),
  listDocuments: vi.fn(),
  listKnowledgeBaseCategories: vi.fn(),
  listKnowledgeBaseTags: vi.fn(),
  listKnowledgeBases: vi.fn(),
  logout: vi.fn(),
  reprocessDocument: vi.fn(),
  updateKnowledgeBase: vi.fn(),
  uploadDocument: vi.fn(),
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
        <Route path="/knowledge-bases/:id/documents" element={<DocumentsPage />} />
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
    await user.click(screen.getByRole('button', { name: '导入文档' }));
  }
  const dialog = await screen.findByRole('dialog', { name: '导入文档' });
  await user.upload(within(dialog).getByLabelText('选择文档文件'), file);
  await user.click(within(dialog).getByRole('button', { name: '开始导入' }));
}

describe('DocumentsPage', () => {
  it('offers knowledge-base actions without eagerly loading edit metadata', async () => {
    const user = userEvent.setup();
    renderPage();

    const actions = await screen.findByRole('button', { name: '制度库的更多操作' });
    expect(listKnowledgeBaseCategories).not.toHaveBeenCalled();
    expect(listKnowledgeBaseTags).not.toHaveBeenCalled();
    await user.click(actions);

    const menu = screen.getByRole('menu', { name: '制度库的更多操作' });
    expect(within(menu).getByRole('menuitem', { name: '编辑知识库' })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: '删除知识库' })).toBeInTheDocument();
  });

  it('keeps the document heading and knowledge-base selector in sync after editing', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: '制度库的更多操作' }));
    await user.click(screen.getByRole('menuitem', { name: '编辑知识库' }));
    const drawer = await screen.findByRole('dialog', { name: '编辑知识库' });
    const name = within(drawer).getByRole('textbox', { name: '名称' });
    await user.clear(name);
    await user.type(name, '员工制度库');
    await user.click(within(drawer).getByRole('button', { name: '保存修改' }));

    expect(await screen.findByRole('heading', { name: '员工制度库' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: '当前知识库' })).toHaveDisplayValue('员工制度库');
  });

  it('keeps the current knowledge base selectable when it is absent from the workspace page', async () => {
    vi.mocked(listKnowledgeBases).mockResolvedValue({ items: [secondKnowledgeBase] });
    renderPage();

    await screen.findByRole('heading', { name: '制度库' });
    const selector = screen.getByRole('combobox', { name: '当前知识库' });
    expect(selector).toHaveValue('kb1');
    expect(selector).toHaveDisplayValue('制度库');
    expect(within(selector).getByRole('option', { name: '产品库' })).toBeInTheDocument();
  });

  it('does not load knowledge-base category workspace data', async () => {
    renderPage();
    await screen.findByRole('heading', { name: '制度库' });

    const sectionNav = screen.getByRole('navigation', { name: '知识库功能' });
    expect(within(sectionNav).getByRole('link', { name: '概览' })).toHaveAttribute('href', '/knowledge-bases/kb1?tab=overview');
    expect(within(sectionNav).getByRole('link', { name: '文档' })).toHaveAttribute('aria-current', 'page');
    expect(within(sectionNav).getByRole('link', { name: 'AI 问答' })).toHaveAttribute('href', '/knowledge-bases/kb1?tab=qa');
    expect(within(sectionNav).getByRole('link', { name: '设置' })).toHaveAttribute('href', '/knowledge-bases/kb1?tab=settings');
    expect(screen.queryByRole('link', { name: '返回详情' })).not.toBeInTheDocument();
    expect(listKnowledgeBaseCategories).not.toHaveBeenCalled();
    expect(getWorkspacePreference).not.toHaveBeenCalled();
  });

  it('announces an asynchronous document-list failure', async () => {
    vi.mocked(listDocuments).mockRejectedValue(new Error('offline'));
    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent('文档列表加载失败');
    expect(screen.queryByText('当前筛选下没有文档。上传 txt、md 或 pdf 后开始处理。')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重试加载' })).toBeInTheDocument();
    expect(within(screen.getByText('可用于问答').parentElement!).getByText('--')).toBeInTheDocument();
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

    await user.click(await screen.findByRole('button', { name: '重处理' }));
    await user.click(screen.getByRole('button', { name: '切换到产品库路由' }));
    expect(await screen.findByText('product.md')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '重处理' }));

    await act(async () => {
      firstReprocess.reject(new Error('offline'));
      await Promise.resolve();
    });
    expect(screen.queryByText('文档重处理失败')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重处理' })).toBeDisabled();

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
    await user.click(screen.getByRole('button', { name: '批量重处理' }));
    await user.click(screen.getByRole('button', { name: '切换到产品库路由' }));
    await user.click(await screen.findByRole('checkbox', { name: '选择 product.md' }));
    await user.click(screen.getByRole('button', { name: '批量重处理' }));

    await act(async () => {
      firstBatch.reject(new Error('offline'));
      await Promise.resolve();
    });
    expect(screen.queryByText('批量重处理失败')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '批量重处理' })).toBeDisabled();

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
    await waitFor(() => expect(uploadDocument).toHaveBeenCalledWith(knowledgeBase.id, expect.any(File)));
    act(() => screen.getByText('切换到产品库路由').click());
    expect(await screen.findByRole('heading', { name: '产品库' })).toBeInTheDocument();

    await act(async () => {
      uploadResult.resolve(uploadedDocument);
      await Promise.resolve();
    });

    expect(screen.getByText('product.md')).toBeInTheDocument();
    expect(screen.queryByText('handbook.pdf')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '基于此知识库提问' })).not.toBeInTheDocument();
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
    expect(screen.getByRole('button', { name: '正在导入' })).toBeDisabled();

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

    await user.click(await screen.findByRole('button', { name: '重处理' }));
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

    await user.click(await screen.findByRole('button', { name: '重处理' }));

    expect(await within(screen.getByRole('region', { name: '通知' })).findByRole('status')).toHaveTextContent('已开始重新处理文档');
  });

  it('locks every document mutation while one reprocess is pending', async () => {
    const reprocessResult = deferred<Awaited<ReturnType<typeof reprocessDocument>>>();
    vi.mocked(reprocessDocument).mockReturnValue(reprocessResult.promise);
    vi.mocked(listDocuments).mockResolvedValue({ items: [{ ...uploadedDocument, status: 'completed' }] });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('checkbox', { name: `选择 ${uploadedDocument.filename}` }));
    await user.click(screen.getByRole('button', { name: '重处理' }));

    expect(screen.getByRole('button', { name: '导入文档' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '批量重处理' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '批量删除' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '删除' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '查看' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '文档回收站' })).toBeDisabled();

    reprocessResult.resolve({ ...uploadedDocument, status: 'uploaded' });
    await waitFor(() => expect(screen.getByRole('button', { name: '导入文档' })).toBeEnabled());
  });

  it('synchronously blocks opening document detail after a mutation starts', async () => {
    const reprocessResult = deferred<Awaited<ReturnType<typeof reprocessDocument>>>();
    vi.mocked(reprocessDocument).mockReturnValue(reprocessResult.promise);
    vi.mocked(listDocuments).mockResolvedValue({ items: [{ ...uploadedDocument, status: 'completed' }] });
    renderPage();

    const reprocessButton = await screen.findByRole('button', { name: '重处理' });
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
    expect(await screen.findByText('上传失败', { selector: 'small' })).toBeInTheDocument();
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
    await user.click(screen.getByRole('button', { name: '刷新' }));
    expect(await screen.findByText('latest.pdf')).toBeInTheDocument();

    await act(async () => {
      pollResult.resolve({ items: [uploadedDocument] });
      await Promise.resolve();
    });
    expect(screen.getByText('latest.pdf')).toBeInTheDocument();
    expect(screen.queryByText('handbook.pdf')).not.toBeInTheDocument();
  });

  it('keeps a failed document delete error inside the confirmation dialog', async () => {
    vi.mocked(listDocuments).mockResolvedValue({ items: [uploadedDocument] });
    vi.mocked(deleteDocument).mockRejectedValue(
      new ApiError(500, { code: 'DELETE_FAILED', message: '暂时无法删除文档' }),
    );
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: '删除' }));
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
    expect(await screen.findByRole('status', { name: '文档导入进度' })).toHaveTextContent('上传第一个文档');
  });

  it('offers chat only after the document uploaded in this flow finishes processing', async () => {
    const user = userEvent.setup();
    let poll: TimerHandler | undefined;
    vi.spyOn(window, 'setInterval').mockImplementation((handler, timeout) => {
      if (timeout === 3000) {
        poll = handler;
      }
      return 1;
    });
    vi.mocked(uploadDocument).mockResolvedValue(uploadedDocument);
    vi.mocked(listDocuments)
      .mockResolvedValueOnce({ items: [] })
      .mockResolvedValueOnce({ items: [{ ...uploadedDocument, status: 'completed' }] });
    renderPage('/knowledge-bases/kb1/documents?intent=upload');
    await uploadThroughDialog(user, new File(['content'], 'handbook.pdf', { type: 'application/pdf' }), false);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.queryByRole('link', { name: '基于此知识库提问' })).not.toBeInTheDocument();
    await waitFor(() => expect(poll).toBeTypeOf('function'));

    await act(async () => {
      if (typeof poll === 'function') {
        poll();
      }
      await Promise.resolve();
    });
    await waitFor(() => expect(listDocuments).toHaveBeenCalledTimes(2));

    expect(await screen.findByRole('link', { name: '基于此知识库提问' })).toHaveAttribute(
      'href',
      '/chat/new?knowledgeBaseId=kb1',
    );
  });

  it('explains a failed upload flow without offering chat', async () => {
    const user = userEvent.setup();
    let poll: TimerHandler | undefined;
    vi.spyOn(window, 'setInterval').mockImplementation((handler, timeout) => {
      if (timeout === 3000) {
        poll = handler;
      }
      return 1;
    });
    vi.mocked(uploadDocument).mockResolvedValue(uploadedDocument);
    vi.mocked(listDocuments)
      .mockResolvedValueOnce({ items: [] })
      .mockResolvedValueOnce({ items: [{ ...uploadedDocument, status: 'failed' }] });
    renderPage('/knowledge-bases/kb1/documents?intent=upload');
    await uploadThroughDialog(user, new File(['content'], 'handbook.pdf', { type: 'application/pdf' }), false);
    await waitFor(() => expect(poll).toBeTypeOf('function'));
    await act(async () => {
      if (typeof poll === 'function') {
        poll();
      }
      await Promise.resolve();
    });

    expect(await screen.findByRole('status', { name: '文档导入进度' })).toHaveTextContent('文档处理失败');
    expect(screen.getByRole('status', { name: '文档导入进度' })).toHaveTextContent('请查看处理提示并重试');
    expect(screen.queryByRole('link', { name: '基于此知识库提问' })).not.toBeInTheDocument();
  });
});
