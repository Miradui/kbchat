import { useState } from 'react';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  deleteDocument,
  downloadDocument,
  getDocument,
  getDocumentPreview,
  getKnowledgeBase,
  listDocumentChunks,
  reprocessDocument,
} from '../../api/resources';
import { renderWithRouter } from '../../test/render';
import type { DocumentItem } from '../../types/api';
import { DocumentDetailDrawer } from './DocumentDetailDrawer';

vi.mock('../../api/resources', () => ({
  deleteDocument: vi.fn(),
  downloadDocument: vi.fn(),
  getDocument: vi.fn(),
  getDocumentPreview: vi.fn(),
  getKnowledgeBase: vi.fn().mockResolvedValue({ id: 'kb1', capabilities: ['document.download', 'content.write'] }),
  listDocumentChunks: vi.fn(),
  reprocessDocument: vi.fn(),
}));

const document = {
  id: 'doc1',
  knowledgeBaseId: 'kb1',
  filename: '制度.pdf',
  fileType: 'pdf',
  fileSize: 1024,
  status: 'completed',
  errorMessage: null,
  createdAt: '2026-07-01T00:00:00Z',
  updatedAt: '2026-07-01T00:00:00Z',
} satisfies DocumentItem;

const sourceChunk = {
  id: 'chunk1',
  chunkIndex: 3,
  content: '这是回答使用的原始片段。',
  tokenCount: 42,
  pageNumber: 5,
  metadata: {},
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function DocumentSwitchHarness({
  onChanged = () => undefined,
  onClose = () => undefined,
}: {
  onChanged?: () => void;
  onClose?: () => void;
}) {
  const [documentId, setDocumentId] = useState('doc1');
  return (
    <>
      <button type="button" onClick={() => setDocumentId('doc2')}>打开另一文档</button>
      <DocumentDetailDrawer documentId={documentId} onChanged={onChanged} onClose={onClose} />
    </>
  );
}

function DocumentScopeHarness() {
  const [knowledgeBaseId, setKnowledgeBaseId] = useState('kb1');
  return (
    <>
      <button type="button" onClick={() => setKnowledgeBaseId('kb2')}>切换知识库范围</button>
      <DocumentDetailDrawer
        chunkId={knowledgeBaseId === 'kb1' ? 'chunk1' : 'chunk2'}
        documentId="doc1"
        knowledgeBaseId={knowledgeBaseId}
        onClose={vi.fn()}
      />
    </>
  );
}

beforeEach(() => {
  vi.mocked(getKnowledgeBase).mockReset().mockResolvedValue({ id: 'kb1', capabilities: ['document.download', 'content.write'] } as Awaited<ReturnType<typeof getKnowledgeBase>>);
  vi.mocked(deleteDocument).mockReset().mockResolvedValue(undefined);
  vi.mocked(downloadDocument).mockReset().mockResolvedValue(new Blob(['document']));
  vi.mocked(getDocument).mockReset().mockResolvedValue(document);
  vi.mocked(getDocumentPreview).mockReset().mockResolvedValue({
    id: document.id,
    filename: document.filename,
    fileType: document.fileType,
    contentType: 'application/pdf',
    kind: 'text',
    content: '',
    downloadUrl: '/documents/doc1/download',
  });
  vi.mocked(listDocumentChunks).mockReset();
  vi.mocked(reprocessDocument).mockReset();
});

describe('DocumentDetailDrawer', () => {
  it('keeps PDF text readable for a viewer without fetching the original or offering writes', async () => {
    vi.mocked(getKnowledgeBase).mockResolvedValue({ id: 'kb1', capabilities: ['document.read'] } as Awaited<ReturnType<typeof getKnowledgeBase>>);
    vi.mocked(getDocumentPreview).mockResolvedValue({ id: document.id, filename: document.filename, fileType: 'pdf', contentType: 'application/pdf', kind: 'file', downloadUrl: '/documents/doc1/download' });
    vi.mocked(listDocumentChunks).mockResolvedValue({ items: [sourceChunk], total: 1, page: 1, pageSize: 20 });
    renderWithRouter(<DocumentDetailDrawer documentId="doc1" onClose={vi.fn()} />);
    expect(await screen.findByText('可阅读下方内容片段；下载原始文件需要编辑者及以上权限。')).toBeInTheDocument();
    expect(await screen.findByText(sourceChunk.content)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '下载', exact: true })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '重新处理' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '删除', exact: true })).not.toBeInTheDocument();
    expect(downloadDocument).not.toHaveBeenCalled();
  });

  it('hides document actions when the knowledge-base permission lookup fails', async () => {
    vi.mocked(getKnowledgeBase).mockRejectedValue(new Error('permission lookup unavailable'));
    vi.mocked(listDocumentChunks).mockResolvedValue({ items: [sourceChunk], total: 1, page: 1, pageSize: 20 });
    renderWithRouter(<DocumentDetailDrawer documentId="doc1" onClose={vi.fn()} />);
    expect(await screen.findByText('暂时无法确认文档操作权限，请重新打开文档重试。')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '下载', exact: true })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '重新处理' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '删除', exact: true })).not.toBeInTheDocument();
  });

  it('closes from the backdrop but not from clicks inside the panel', async () => {
    vi.mocked(listDocumentChunks).mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });
    const onClose = vi.fn();
    renderWithRouter(<DocumentDetailDrawer documentId="doc1" onClose={onClose} />);

    const dialog = await screen.findByRole('dialog', { name: '文档详情' });
    fireEvent.click(dialog);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.mouseDown(dialog.parentElement!);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('keeps the drawer open when its backdrop is clicked during a mutation', async () => {
    const reprocessResult = deferred<DocumentItem>();
    vi.mocked(reprocessDocument).mockReturnValue(reprocessResult.promise);
    vi.mocked(listDocumentChunks).mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });
    const onClose = vi.fn();
    renderWithRouter(<DocumentDetailDrawer documentId="doc1" onClose={onClose} />);

    await userEvent.click(await screen.findByRole('button', { name: '重新处理' }));
    fireEvent.mouseDown(screen.getByRole('dialog', { name: '文档详情' }).parentElement!);

    expect(onClose).not.toHaveBeenCalled();
    reprocessResult.resolve({ ...document, status: 'uploaded' });
  });

  it('shows operation-specific feedback while a download is pending', async () => {
    const downloadResult = deferred<Blob>();
    vi.mocked(downloadDocument).mockReturnValue(downloadResult.promise);
    vi.mocked(listDocumentChunks).mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });
    renderWithRouter(<DocumentDetailDrawer documentId="doc1" onClose={vi.fn()} />);

    await userEvent.click(await screen.findByRole('button', { name: '下载' }));

    expect(screen.getByRole('button', { name: '下载中' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '重新处理' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: '处理中' })).not.toBeInTheDocument();
    downloadResult.resolve(new Blob(['document']));
  });

  it('synchronously rejects duplicate reprocess events', async () => {
    const reprocessResult = deferred<DocumentItem>();
    vi.mocked(reprocessDocument).mockReturnValue(reprocessResult.promise);
    vi.mocked(listDocumentChunks).mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });
    renderWithRouter(<DocumentDetailDrawer documentId="doc1" onClose={vi.fn()} />);

    const reprocessButton = await screen.findByRole('button', { name: '重新处理' });
    act(() => {
      fireEvent.click(reprocessButton);
      fireEvent.click(reprocessButton);
    });

    expect(reprocessDocument).toHaveBeenCalledTimes(1);
    reprocessResult.resolve({ ...document, status: 'uploaded' });
  });

  it('announces successful reprocessing from the detail drawer', async () => {
    vi.mocked(reprocessDocument).mockResolvedValue({ ...document, status: 'uploaded' });
    vi.mocked(listDocumentChunks).mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });
    const user = userEvent.setup();
    renderWithRouter(<DocumentDetailDrawer documentId="doc1" onClose={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: '重新处理' }));

    expect(await within(screen.getByRole('region', { name: '通知' })).findByRole('status'))
      .toHaveTextContent('已开始重新处理文档');
  });

  it('announces successful deletion from the detail drawer', async () => {
    vi.mocked(listDocumentChunks).mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });
    const user = userEvent.setup();
    renderWithRouter(<DocumentDetailDrawer documentId="doc1" onClose={vi.fn()} />);

    await screen.findByText('制度.pdf');
    await user.click(screen.getByRole('button', { name: '删除' }));
    await user.click(within(screen.getByRole('dialog', { name: '删除文档' })).getByRole('button', { name: '删除' }));

    expect(await within(screen.getByRole('region', { name: '通知' })).findByRole('status'))
      .toHaveTextContent('文档已移入回收站');
  });

  it('synchronously blocks opening delete confirmation after another document operation starts', async () => {
    const reprocessResult = deferred<DocumentItem>();
    vi.mocked(reprocessDocument).mockReturnValue(reprocessResult.promise);
    vi.mocked(listDocumentChunks).mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });
    renderWithRouter(<DocumentDetailDrawer documentId="doc1" onClose={vi.fn()} />);

    const reprocessButton = await screen.findByRole('button', { name: '重新处理' });
    const deleteButton = screen.getByRole('button', { name: '删除' });
    act(() => {
      fireEvent.click(reprocessButton);
      fireEvent.click(deleteButton);
    });

    expect(reprocessDocument).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog', { name: '删除文档' })).not.toBeInTheDocument();
    reprocessResult.resolve({ ...document, status: 'uploaded' });
  });

  it('traps focus, closes on Escape, locks scrolling, and restores the opener', async () => {
    vi.mocked(listDocumentChunks).mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });
    const user = userEvent.setup();
    const onClose = vi.fn();
    const opener = window.document.createElement('button');
    opener.textContent = '打开来源';
    window.document.body.append(opener);
    opener.focus();
    window.document.body.style.overflow = 'clip';

    const { unmount } = renderWithRouter(
      <DocumentDetailDrawer documentId="doc1" onClose={onClose} />,
    );

    const close = screen.getByRole('button', { name: '关闭' });
    const dialog = screen.getByRole('dialog', { name: '文档详情' });
    expect(dialog.closest('.ui-drawer-backdrop')?.parentElement).toBe(window.document.body);
    expect(close.querySelector('svg')).toBeInTheDocument();
    expect(close).toHaveFocus();
    expect(window.document.body.style.overflow).toBe('hidden');
    await screen.findByText('制度.pdf');
    await user.tab({ shift: true });
    expect(screen.getByRole('searchbox', { name: '搜索内容片段' })).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();

    unmount();
    expect(window.document.body.style.overflow).toBe('clip');
    expect(opener).toHaveFocus();
    opener.remove();
    window.document.body.style.overflow = '';
  });

  it('closes only the nested delete confirmation on the first Escape', async () => {
    vi.mocked(listDocumentChunks).mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderWithRouter(<DocumentDetailDrawer documentId="doc1" onClose={onClose} />);

    await screen.findByText('制度.pdf');
    const deleteButton = screen.getByRole('button', { name: '删除' });
    await user.click(deleteButton);
    expect(screen.getByRole('dialog', { name: '删除文档' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '取消' })).toHaveFocus();

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog', { name: '删除文档' })).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: '文档详情' })).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(window.document.body.style.overflow).toBe('hidden');
    expect(deleteButton).toHaveFocus();

    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('rejects a deep link to a document from another knowledge base', async () => {
    vi.mocked(listDocumentChunks).mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });
    renderWithRouter(
      <DocumentDetailDrawer
        documentId="doc1"
        knowledgeBaseId="kb-other"
        knowledgeBaseName="其他知识库"
        onClose={vi.fn()}
      />,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent('该文档不属于当前知识库');
    expect(screen.queryByText('制度.pdf')).not.toBeInTheDocument();
    expect(getDocumentPreview).not.toHaveBeenCalled();
    expect(listDocumentChunks).not.toHaveBeenCalled();
  });

  it('does not load chunks from a stale document after the knowledge base scope changes', async () => {
    vi.mocked(listDocumentChunks).mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });
    vi.mocked(getDocument)
      .mockResolvedValueOnce(document)
      .mockReturnValueOnce(new Promise<DocumentItem>(() => undefined));

    renderWithRouter(<DocumentScopeHarness />);

    await waitFor(() => expect(listDocumentChunks).toHaveBeenCalledOnce());

    fireEvent.click(screen.getByText('切换知识库范围'));

    await waitFor(() => expect(getDocument).toHaveBeenCalledTimes(2));
    expect(listDocumentChunks).toHaveBeenCalledOnce();
    expect(listDocumentChunks).not.toHaveBeenCalledWith(
      'doc1',
      expect.objectContaining({ chunkId: 'chunk2' }),
    );
  });

  it('resets chunk search and pagination when opening another document', async () => {
    const secondDocument = {
      ...document,
      id: 'doc2',
      filename: '产品.md',
      fileType: 'md',
    } satisfies DocumentItem;
    vi.mocked(getDocument).mockImplementation((id) => Promise.resolve(
      id === secondDocument.id ? secondDocument : document,
    ));
    vi.mocked(listDocumentChunks).mockResolvedValue({
      items: [sourceChunk],
      total: 21,
      page: 1,
      pageSize: 20,
    });
    const user = userEvent.setup();
    renderWithRouter(<DocumentSwitchHarness />);

    const search = await screen.findByRole('searchbox', { name: '搜索内容片段' });
    await user.type(search, '旧查询');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(listDocumentChunks).toHaveBeenCalledWith('doc1', {
      chunkId: undefined,
      page: 1,
      pageSize: 20,
      q: '旧查询',
    }));
    await user.click(screen.getByRole('button', { name: '下一页' }));
    await waitFor(() => expect(listDocumentChunks).toHaveBeenCalledWith('doc1', {
      chunkId: undefined,
      page: 2,
      pageSize: 20,
      q: '旧查询',
    }));

    fireEvent.click(screen.getByText('打开另一文档'));

    await waitFor(() => expect(screen.getByRole('searchbox', { name: '搜索内容片段' })).toHaveValue(''));
    await waitFor(() => expect(vi.mocked(listDocumentChunks).mock.calls.at(-1)).toEqual([
      'doc2',
      { chunkId: undefined, page: 1, pageSize: 20, q: '' },
    ]));
  });

  it('ignores a reprocess result after another document replaces the drawer content', async () => {
    const reprocessResult = deferred<DocumentItem>();
    const secondDocument = {
      ...document,
      id: 'doc2',
      filename: '产品.md',
      fileType: 'md',
    } satisfies DocumentItem;
    vi.mocked(getDocument).mockImplementation((id) => Promise.resolve(
      id === secondDocument.id ? secondDocument : document,
    ));
    vi.mocked(listDocumentChunks).mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });
    vi.mocked(reprocessDocument).mockReturnValue(reprocessResult.promise);
    const onChanged = vi.fn();
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderWithRouter(<DocumentSwitchHarness onChanged={onChanged} onClose={onClose} />);

    await user.click(await screen.findByRole('button', { name: '重新处理' }));
    await waitFor(() => expect(reprocessDocument).toHaveBeenCalledWith('doc1'));
    fireEvent.click(screen.getByText('打开另一文档'));
    expect(await screen.findByText('产品.md')).toBeInTheDocument();

    reprocessResult.resolve(document);
    await waitFor(() => expect(screen.getByText('产品.md')).toBeInTheDocument());
    expect(screen.queryByText('制度.pdf')).not.toBeInTheDocument();
    expect(onChanged).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('loads and marks the exact citation chunk', async () => {
    vi.mocked(listDocumentChunks).mockResolvedValue({
      items: [sourceChunk],
      total: 1,
      page: 1,
      pageSize: 20,
    });

    renderWithRouter(
      <DocumentDetailDrawer chunkId="chunk1" documentId="doc1" onClose={vi.fn()} />,
    );

    await waitFor(() => expect(listDocumentChunks).toHaveBeenCalledWith('doc1', {
      chunkId: 'chunk1',
      page: 1,
      pageSize: 20,
      q: '',
    }));
    const source = (await screen.findByText('这是回答使用的原始片段。')).closest('article');
    expect(source).toHaveClass('is-source');
    expect(source).toHaveTextContent('这是回答使用的原始片段。');
    expect(screen.getByText('引用来源')).toBeInTheDocument();
  });

  it('explains when a citation chunk no longer exists', async () => {
    vi.mocked(listDocumentChunks).mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });

    renderWithRouter(
      <DocumentDetailDrawer chunkId="missing-chunk" documentId="doc1" onClose={vi.fn()} />,
    );

    expect(await screen.findByText('未找到该引用片段')).toBeInTheDocument();
    expect(screen.getByText('可能已重新处理或删除。你仍可查看当前文档内容。')).toBeInTheDocument();
  });

  it('announces preview and chunk loading failures', async () => {
    vi.mocked(getDocumentPreview).mockRejectedValue(new Error('offline'));
    vi.mocked(listDocumentChunks).mockRejectedValue(new Error('offline'));
    renderWithRouter(<DocumentDetailDrawer documentId="doc1" onClose={vi.fn()} />);

    expect(await screen.findByText('内容片段加载失败')).toHaveAttribute('role', 'alert');
    expect(await screen.findByText('文档预览加载失败')).toHaveAttribute('role', 'alert');
  });

  it('keeps a delete failure inside the open confirmation dialog', async () => {
    vi.mocked(listDocumentChunks).mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });
    vi.mocked(deleteDocument).mockRejectedValue(new Error('offline'));
    const user = userEvent.setup();
    renderWithRouter(<DocumentDetailDrawer documentId="doc1" onClose={vi.fn()} />);

    await screen.findByText('制度.pdf');
    await user.click(screen.getByRole('button', { name: '删除' }));
    const confirmation = screen.getByRole('dialog', { name: '删除文档' });
    await user.click(within(confirmation).getByRole('button', { name: '删除' }));

    expect(await within(confirmation).findByRole('alert')).toHaveTextContent('文档删除失败');
    expect(confirmation).toBeInTheDocument();
  });
  it('turns a parsing failure into a reason and a next step', async () => {
    vi.mocked(getDocument).mockResolvedValue({
      ...document,
      status: 'failed',
      errorCode: 'empty_content',
      // The raw parser text is kept server-side for debugging and must not surface.
      errorMessage: 'document contains no extractable text',
    });
    vi.mocked(listDocumentChunks).mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });
    renderWithRouter(<DocumentDetailDrawer documentId="doc1" onClose={vi.fn()} />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('没有可提取的文字');
    expect(alert).toHaveTextContent('OCR');
    expect(alert).not.toHaveTextContent('extractable');
  });

  it('falls back to neutral wording for an error code it does not know', async () => {
    vi.mocked(getDocument).mockResolvedValue({
      ...document,
      status: 'failed',
      errorCode: 'from_a_newer_server',
      errorMessage: null,
    });
    vi.mocked(listDocumentChunks).mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });
    renderWithRouter(<DocumentDetailDrawer documentId="doc1" onClose={vi.fn()} />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('文档处理失败');
    expect(alert).toHaveTextContent('联系管理员');
  });

  it('flags a stale document without claiming it is wrong', async () => {
    vi.mocked(getDocument).mockResolvedValue({ ...document, isStale: true, staleAfterDays: 180 });
    vi.mocked(listDocumentChunks).mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });
    renderWithRouter(<DocumentDetailDrawer documentId="doc1" onClose={vi.fn()} />);

    const note = await screen.findByRole('note');
    expect(note).toHaveTextContent('超过 180 天没有更新，内容可能已过期。');
    // Staleness never changes retrieval, and saying so stops the user from deleting
    // a document that is still being cited correctly.
    expect(note).toHaveTextContent('检索和引用不受影响');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('does not flag a document that is inside the threshold', async () => {
    vi.mocked(getDocument).mockResolvedValue({ ...document, isStale: false, staleAfterDays: 180 });
    vi.mocked(listDocumentChunks).mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });
    renderWithRouter(<DocumentDetailDrawer documentId="doc1" onClose={vi.fn()} />);

    expect(await screen.findByText('制度.pdf')).toBeInTheDocument();
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });
});

/**
 * Landing on the cited chunk. The drawer's own `useModalFocus` focuses the panel when
 * it opens, which is before the chunk request answers -- so this is a second, later
 * focus move, and these tests pin down that it happens exactly once and only for a
 * deep link.
 */
describe('DocumentDetailDrawer citation landing', () => {
  // Both stubs below reach outside the test, so they are put back afterwards rather
  // than left for whatever runs next in this file.
  const originalScrollIntoView = Element.prototype.scrollIntoView;

  afterEach(() => {
    Element.prototype.scrollIntoView = originalScrollIntoView;
    vi.unstubAllGlobals();
  });

  const otherChunk = {
    id: 'chunk9',
    chunkIndex: 1,
    content: '另一个片段。',
    tokenCount: 10,
    pageNumber: 1,
    metadata: {},
  };

  function mockMatchMedia(reduceMotion: boolean) {
    const matchMedia = vi.fn((query: string) => ({
      matches: reduceMotion && query.includes('prefers-reduced-motion'),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
      onchange: null,
    }));
    vi.stubGlobal('matchMedia', matchMedia);
    return matchMedia;
  }

  // jsdom has no scrollIntoView, so it has to be supplied to be observed at all.
  function stubScrollIntoView() {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    return scrollIntoView;
  }

  it('scrolls the cited chunk into view and focuses it', async () => {
    const scrollIntoView = stubScrollIntoView();
    mockMatchMedia(false);
    vi.mocked(listDocumentChunks).mockResolvedValue({
      items: [otherChunk, sourceChunk],
      total: 2,
      page: 1,
      pageSize: 20,
    });

    renderWithRouter(<DocumentDetailDrawer chunkId="chunk1" documentId="doc1" onClose={vi.fn()} />);

    const source = (await screen.findByText('这是回答使用的原始片段。')).closest('article');
    await waitFor(() => expect(source).toHaveFocus());
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
    // preventScroll, so the focus call does not fight the smooth scroll it just started.
    expect(source).toHaveAttribute('tabindex', '-1');
    expect(source).toHaveAccessibleName('引用来源片段 #3');
  });

  it('skips the smooth scroll when reduced motion is preferred', async () => {
    const scrollIntoView = stubScrollIntoView();
    mockMatchMedia(true);
    vi.mocked(listDocumentChunks).mockResolvedValue({
      items: [sourceChunk],
      total: 1,
      page: 1,
      pageSize: 20,
    });

    renderWithRouter(<DocumentDetailDrawer chunkId="chunk1" documentId="doc1" onClose={vi.fn()} />);

    const source = (await screen.findByText('这是回答使用的原始片段。')).closest('article');
    // Still scrolls and still focuses -- reduced motion removes the animation, not the
    // navigation.
    await waitFor(() => expect(source).toHaveFocus());
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', block: 'center' });
  });

  it('leaves focus alone when there is no citation deep link', async () => {
    const scrollIntoView = stubScrollIntoView();
    mockMatchMedia(false);
    vi.mocked(listDocumentChunks).mockResolvedValue({
      items: [otherChunk, sourceChunk],
      total: 2,
      page: 1,
      pageSize: 20,
    });

    renderWithRouter(<DocumentDetailDrawer documentId="doc1" onClose={vi.fn()} />);

    await screen.findByText('另一个片段。');
    expect(scrollIntoView).not.toHaveBeenCalled();
    // Browsing the chunk list must not put any of them in the tab order.
    expect(screen.queryByText('另一个片段。')?.closest('article')).not.toHaveAttribute('tabindex');
  });

  it('does not pull focus back when the chunks reload underneath the user', async () => {
    const scrollIntoView = stubScrollIntoView();
    mockMatchMedia(false);
    vi.mocked(listDocumentChunks).mockResolvedValue({
      items: [sourceChunk],
      total: 1,
      page: 1,
      pageSize: 20,
    });
    // Reprocessing replaces `document`, which refetches the chunks and hands the
    // effect a new array -- a real path where it runs again after focus has landed.
    vi.mocked(reprocessDocument).mockResolvedValue({ ...document, status: 'processing' });

    const user = userEvent.setup();
    renderWithRouter(<DocumentDetailDrawer chunkId="chunk1" documentId="doc1" onClose={vi.fn()} />);

    const source = (await screen.findByText('这是回答使用的原始片段。')).closest('article');
    await waitFor(() => expect(source).toHaveFocus());
    expect(scrollIntoView).toHaveBeenCalledTimes(1);

    const reprocess = screen.getByRole('button', { name: '重新处理' });
    await user.click(reprocess);
    await waitFor(() => expect(listDocumentChunks).toHaveBeenCalledTimes(2));
    await screen.findByText('这是回答使用的原始片段。');

    // Focus is on the button the user just pressed. Jumping back to the chunk would
    // lose their place for a change they made deliberately.
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
    expect(reprocess).toHaveFocus();
  });

  it('does not let the focus call cancel the smooth scroll it just started', async () => {
    stubScrollIntoView();
    mockMatchMedia(false);
    const focusSpy = vi.spyOn(HTMLElement.prototype, 'focus');
    vi.mocked(listDocumentChunks).mockResolvedValue({
      items: [sourceChunk],
      total: 1,
      page: 1,
      pageSize: 20,
    });

    renderWithRouter(<DocumentDetailDrawer chunkId="chunk1" documentId="doc1" onClose={vi.fn()} />);

    const source = (await screen.findByText('这是回答使用的原始片段。')).closest('article');
    await waitFor(() => expect(source).toHaveFocus());

    // jsdom ignores focus options, so the argument has to be asserted directly:
    // without preventScroll the browser jumps to the element instantly and the smooth
    // scroll never runs.
    const call = focusSpy.mock.calls.find((_, index) => focusSpy.mock.instances[index] === source);
    expect(call).toEqual([{ preventScroll: true }]);
    focusSpy.mockRestore();
  });

  it('does not throw when the browser has no scrollIntoView', async () => {
    // @ts-expect-error deliberately removing it to prove focus still happens
    Element.prototype.scrollIntoView = undefined;
    mockMatchMedia(false);
    vi.mocked(listDocumentChunks).mockResolvedValue({
      items: [sourceChunk],
      total: 1,
      page: 1,
      pageSize: 20,
    });

    renderWithRouter(<DocumentDetailDrawer chunkId="chunk1" documentId="doc1" onClose={vi.fn()} />);

    const source = (await screen.findByText('这是回答使用的原始片段。')).closest('article');
    // The focus move is the part that matters for keyboard and screen-reader users, so
    // it must not be taken out by a missing scroll API.
    await waitFor(() => expect(source).toHaveFocus());
  });
});
