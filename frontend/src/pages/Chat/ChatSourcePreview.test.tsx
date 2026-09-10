import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { downloadDocument, getDocument, getDocumentPreview } from '../../api/resources';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import type { Citation, DocumentItem, DocumentPreviewResponse } from '../../types/api';
import { downloadBlob } from '../../utils/download';
import { ChatSourcePreview } from './ChatSourcePreview';

vi.mock('../../api/resources', () => ({ downloadDocument: vi.fn(), getDocument: vi.fn(), getDocumentPreview: vi.fn() }));
vi.mock('../../hooks/useMediaQuery', () => ({ useMediaQuery: vi.fn() }));
vi.mock('../../utils/download', () => ({ downloadBlob: vi.fn() }));

const documentItem: DocumentItem = { id: 'doc1', knowledgeBaseId: 'kb1', filename: '手册.pdf', fileType: 'pdf', fileSize: 1024, status: 'completed', errorMessage: null, createdAt: '', updatedAt: '' };
const citation: Citation = { documentId: 'doc1', chunkId: 'chunk1', filename: '手册.pdf', pageNumber: 12, content: '引用正文', vectorScore: 0.8, rerankScore: 0.9 };
const preview: DocumentPreviewResponse = { id: 'doc1', filename: '手册.pdf', fileType: 'pdf', contentType: 'application/pdf', kind: 'file', downloadUrl: '/documents/doc1/download' };
const file = new Blob(['pdf bytes'], { type: 'application/pdf' });
const createUrl = vi.fn(() => 'blob:source-preview');
const revokeUrl = vi.fn();

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.mocked(useMediaQuery).mockReturnValue(false);
  vi.mocked(getDocument).mockReset().mockResolvedValue(documentItem);
  vi.mocked(getDocumentPreview).mockReset().mockResolvedValue(preview);
  vi.mocked(downloadDocument).mockReset().mockResolvedValue(file);
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createUrl });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeUrl });
});

describe('ChatSourcePreview', () => {
  it('loads an authenticated PDF at its cited page and revokes the blob on close', async () => {
    const user = userEvent.setup();
    const view = render(<ChatSourcePreview citation={citation} index={1} knowledgeBaseId="kb1" onClose={vi.fn()} />);
    expect(await screen.findByTitle('原文：手册.pdf')).toHaveAttribute('src', 'blob:source-preview#page=12&view=FitH');
    expect(getDocumentPreview).toHaveBeenCalledWith('doc1');
    expect(downloadDocument).toHaveBeenCalledWith('doc1');
    expect(screen.getByRole('complementary', { name: '原文预览' })).not.toHaveAttribute('aria-modal');
    await user.click(screen.getByRole('button', { name: '下载原文' }));
    expect(vi.mocked(downloadBlob).mock.calls[0]?.[0]).toBe(file);
    expect(vi.mocked(downloadBlob).mock.calls[0]?.[1]).toBe('手册.pdf');
    expect(downloadDocument).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(revokeUrl).toHaveBeenCalledWith('blob:source-preview');
  });

  it('changes pages within the same PDF without downloading it again', async () => {
    const view = render(<ChatSourcePreview citation={citation} index={1} knowledgeBaseId="kb1" onClose={vi.fn()} />);
    await screen.findByTitle('原文：手册.pdf');
    view.rerender(<ChatSourcePreview citation={{ ...citation, chunkId: 'chunk2', pageNumber: 4 }} index={2} knowledgeBaseId="kb1" onClose={vi.fn()} />);
    expect(screen.getByTitle('原文：手册.pdf')).toHaveAttribute('src', 'blob:source-preview#page=4&view=FitH');
    expect(downloadDocument).toHaveBeenCalledTimes(1);
  });

  it.each([null, 0, -1, 1.5])('does not invent a PDF page when the citation page is %s', async (pageNumber) => {
    render(<ChatSourcePreview citation={{ ...citation, pageNumber }} index={1} knowledgeBaseId="kb1" onClose={vi.fn()} />);
    expect(await screen.findByTitle('原文：手册.pdf')).toHaveAttribute('src', 'blob:source-preview#view=FitH');
    expect(screen.getByText('来源 1 · 未提供页码')).toBeInTheDocument();
  });

  it('highlights the actual text excerpt and does not steal focus when a slow preview arrives', async () => {
    const loading = deferred<DocumentPreviewResponse>();
    vi.mocked(getDocumentPreview).mockReturnValue(loading.promise);
    const user = userEvent.setup();
    render(<><input aria-label="继续提问" /><ChatSourcePreview citation={citation} index={1} knowledgeBaseId="kb1" onClose={vi.fn()} /></>);
    await waitFor(() => expect(getDocumentPreview).toHaveBeenCalled());
    await user.click(screen.getByRole('textbox', { name: '继续提问' }));
    await act(async () => loading.resolve({ ...preview, kind: 'text', content: '前文\r\n引用正文\r\n后文' }));
    const text = screen.getByLabelText('文档原文');
    expect(text.querySelector('mark')).toHaveTextContent('引用正文');
    expect(text.textContent).toBe('前文\n引用正文\n后文');
    expect(screen.getByRole('textbox', { name: '继续提问' })).toHaveFocus();
    expect(screen.getByRole('button', { name: '定位到引用' })).toBeInTheDocument();
    expect(downloadDocument).not.toHaveBeenCalled();
  });

  it('checks the current knowledge base before requesting content or bytes', async () => {
    vi.mocked(getDocument).mockResolvedValue({ ...documentItem, knowledgeBaseId: 'another-kb' });
    render(<ChatSourcePreview citation={citation} index={1} knowledgeBaseId="kb1" onClose={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('不属于当前会话');
    expect(getDocumentPreview).not.toHaveBeenCalled();
    expect(downloadDocument).not.toHaveBeenCalled();
  });

  it('can retry a failed preview without disrupting the chat', async () => {
    vi.mocked(getDocumentPreview).mockRejectedValueOnce(new Error('offline'));
    const user = userEvent.setup();
    render(<ChatSourcePreview citation={citation} index={1} knowledgeBaseId="kb1" onClose={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('原文加载失败');
    await user.click(screen.getByRole('button', { name: '重新加载原文' }));
    expect(await screen.findByTitle('原文：手册.pdf')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('ignores a late file response after selecting another document', async () => {
    const lateFile = deferred<Blob>();
    vi.mocked(downloadDocument).mockReturnValueOnce(lateFile.promise);
    const view = render(<ChatSourcePreview citation={citation} index={1} knowledgeBaseId="kb1" onClose={vi.fn()} />);
    await waitFor(() => expect(downloadDocument).toHaveBeenCalledWith('doc1'));
    vi.mocked(getDocument).mockResolvedValue({ ...documentItem, id: 'doc2', filename: '当前.md' });
    vi.mocked(getDocumentPreview).mockResolvedValue({ ...preview, id: 'doc2', kind: 'text', content: '当前文档原文' });
    view.rerender(<ChatSourcePreview citation={{ ...citation, documentId: 'doc2', filename: '当前.md' }} index={2} knowledgeBaseId="kb1" onClose={vi.fn()} />);
    await screen.findByText('当前文档原文');
    await act(async () => lateFile.resolve(file));
    expect(screen.queryByTitle('原文：手册.pdf')).not.toBeInTheDocument();
    expect(createUrl).not.toHaveBeenCalled();
    expect(screen.getByText('当前文档原文')).toBeInTheDocument();
  });

  it('offers the existing accessible drawer on smaller windows', async () => {
    vi.mocked(useMediaQuery).mockReturnValue(true);
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<ChatSourcePreview citation={citation} index={1} knowledgeBaseId="kb1" onClose={onClose} />);
    await screen.findByTitle('原文：手册.pdf');
    expect(screen.getByRole('dialog', { name: '原文预览' })).toHaveAttribute('aria-modal', 'true');
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });
});
