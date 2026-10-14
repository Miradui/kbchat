import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { downloadDocument, getDocument, getDocumentPreview } from '../../api/resources';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import type { PdfHighlightTarget } from '../../components/pdf/PdfPreview';
import type { Citation, DocumentItem, DocumentPreviewResponse } from '../../types/api';
import { downloadBlob } from '../../utils/download';
import { ChatSourcePreview } from './ChatSourcePreview';

vi.mock('../../api/resources', () => ({ downloadDocument: vi.fn(), getDocument: vi.fn(), getDocumentPreview: vi.fn() }));
vi.mock('../../hooks/useMediaQuery', () => ({ useMediaQuery: vi.fn() }));
vi.mock('../../components/pdf/PdfPreview', () => ({
  PdfPreview: ({ url, filename, initialPage, highlight }: { url: string; filename: string; initialPage?: number | null; highlight?: PdfHighlightTarget }) => (
    <div data-highlight-content={highlight?.content} data-highlight-id={highlight?.id} data-page={initialPage ?? ''} data-testid="pdf-preview" data-url={url} title={`原文：${filename}`} />
  ),
}));
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
  it('uses sheet and physical row metadata to highlight a whole row and never guesses another row', async () => {
    const a = '工作表「销售」 · 第 5 行（表头第 2 行）\n名称：甲😀\n说明：相同内容';
    const b = '工作表「库存」 · 第 5 行（表头第 1 行）\n名称：乙\n说明：相同内容';
    const source = `${a}\n${b}`;
    const bytes = (text: string) => new TextEncoder().encode(text).length;
    const table = { sheetName: '库存', rowStart: 5, rowEnd: 5, headerRow: 1 };
    vi.mocked(getDocument).mockResolvedValue({ ...documentItem, filename: '资料.xlsx', fileType: 'xlsx' });
    vi.mocked(getDocumentPreview).mockResolvedValue({ ...preview, filename: '资料.xlsx', fileType: 'xlsx', kind: 'text', content: source, tableRows: [
      { sheetName: '销售', rowStart: 5, rowEnd: 5, headerRow: 2, startOffset: 0, endOffset: bytes(a) },
      { ...table, startOffset: bytes(`${a}\n`), endOffset: bytes(source) },
    ] });
    const props = { citation: { ...citation, filename: '资料.xlsx', pageNumber: null, content: '相同内容', table }, index: 1, knowledgeBaseId: 'kb1', onClose: vi.fn() };
    const view = render(<ChatSourcePreview {...props} />);
    const text = await screen.findByLabelText('文档原文');
    expect(text.querySelector('mark')?.textContent).toBe(b);
    expect(screen.getByText('来源 1 · 库存 · 第 5 行')).toBeInTheDocument();
    expect(screen.getByText(/公式仅显示文件已保存的结果/)).toBeInTheDocument();
    view.rerender(<ChatSourcePreview {...props} citation={{ ...props.citation, chunkId: 'missing-row', table: { ...table, rowStart: 9, rowEnd: 9 } }} />);
    expect(text.querySelector('mark')).toBeNull();
    expect(getDocumentPreview).toHaveBeenCalledTimes(1);
    expect(downloadDocument).not.toHaveBeenCalled();
  });

  it('lets viewers read a PDF citation without attempting a forbidden file download', async () => {
    render(<ChatSourcePreview canDownload={false} citation={citation} index={1} knowledgeBaseId="kb1" onClose={vi.fn()} />);
    expect(await screen.findByText('可阅读上方引用内容；下载原始文件需要编辑者及以上权限。')).toBeInTheDocument();
    expect(screen.getByText(citation.content)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '下载原文' })).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(downloadDocument).not.toHaveBeenCalled();
  });

  it('removes a downloaded PDF immediately when download permission is revoked', async () => {
    const view = render(<ChatSourcePreview canDownload citation={citation} index={1} knowledgeBaseId="kb1" onClose={vi.fn()} />);
    await screen.findByTitle('原文：手册.pdf');
    view.rerender(<ChatSourcePreview canDownload={false} citation={citation} index={1} knowledgeBaseId="kb1" onClose={vi.fn()} />);
    expect(screen.queryByTitle('原文：手册.pdf')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '下载原文' })).not.toBeInTheDocument();
    await screen.findByText('可阅读上方引用内容；下载原始文件需要编辑者及以上权限。');
    expect(downloadDocument).toHaveBeenCalledTimes(1);
    expect(revokeUrl).toHaveBeenCalledWith('blob:source-preview');
  });

  it('loads an authenticated PDF at its cited page and revokes the blob on close', async () => {
    const user = userEvent.setup();
    const view = render(<ChatSourcePreview citation={citation} index={1} knowledgeBaseId="kb1" onClose={vi.fn()} />);
    const pdf = await screen.findByTitle('原文：手册.pdf');
    expect(pdf).toHaveAttribute('data-url', 'blob:source-preview');
    expect(pdf).toHaveAttribute('data-page', '12');
    expect(pdf).toHaveAttribute('data-highlight-content', citation.content);
    expect(pdf).toHaveAttribute('data-highlight-id', citation.chunkId);
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
    expect(screen.getByTitle('原文：手册.pdf')).toHaveAttribute('data-url', 'blob:source-preview');
    expect(screen.getByTitle('原文：手册.pdf')).toHaveAttribute('data-page', '4');
    expect(downloadDocument).toHaveBeenCalledTimes(1);
  });

  it('changes the PDF excerpt on the same page without downloading it again', async () => {
    const view = render(<ChatSourcePreview citation={citation} index={1} knowledgeBaseId="kb1" onClose={vi.fn()} />);
    await screen.findByTitle('原文：手册.pdf');
    view.rerender(<ChatSourcePreview citation={{ ...citation, chunkId: 'chunk2', content: '这一页的第二段引用' }} index={2} knowledgeBaseId="kb1" onClose={vi.fn()} />);
    const pdf = screen.getByTitle('原文：手册.pdf');
    expect(pdf).toHaveAttribute('data-page', '12');
    expect(pdf).toHaveAttribute('data-highlight-content', '这一页的第二段引用');
    expect(pdf).toHaveAttribute('data-highlight-id', 'chunk2');
    expect(downloadDocument).toHaveBeenCalledTimes(1);
  });

  it.each([null, 0, -1, 1.5])('does not invent a PDF page when the citation page is %s', async (pageNumber) => {
    render(<ChatSourcePreview citation={{ ...citation, pageNumber }} index={1} knowledgeBaseId="kb1" onClose={vi.fn()} />);
    const pdf = await screen.findByTitle('原文：手册.pdf');
    expect(pdf).toHaveAttribute('data-url', 'blob:source-preview');
    expect(pdf).toHaveAttribute('data-page', '');
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

  it('locates a heading-prefixed Markdown chunk by its byte offsets', async () => {
    const source = '# 产品手册\r\n\r\n## 安装 😀\r\n\r\n安装前请确认 emoji 😀 与中文路径。\r\n\r\n后续章节\r\n';
    const body = '安装前请确认 emoji 😀 与中文路径。';
    const normalized = source.replace(/\r\n/gu, '\n');
    const start = new TextEncoder().encode(normalized.slice(0, normalized.indexOf(body))).length;
    const end = start + new TextEncoder().encode(body).length;
    vi.mocked(getDocument).mockResolvedValue({ ...documentItem, filename: '手册.md', fileType: 'md' });
    vi.mocked(getDocumentPreview).mockResolvedValue({ ...preview, filename: '手册.md', fileType: 'md', kind: 'text', content: source });
    render(<ChatSourcePreview citation={{ ...citation, filename: '手册.md', pageNumber: null, content: `产品手册 > 安装 😀\n${body}`, startOffset: start, endOffset: end }} index={1} knowledgeBaseId="kb1" onClose={vi.fn()} />);

    const text = await screen.findByLabelText('文档原文');
    expect(text.querySelector('mark')).toHaveTextContent(body);
    expect(screen.getByRole('button', { name: '定位到引用' })).toBeInTheDocument();
  });

  it('still says the excerpt cannot be located when neither offsets nor text match', async () => {
    vi.mocked(getDocumentPreview).mockResolvedValue({ ...preview, kind: 'text', content: '完全不同的原文' });
    render(<ChatSourcePreview citation={{ ...citation, pageNumber: null, content: '标题\n别处的内容', startOffset: 400, endOffset: 420 }} index={1} knowledgeBaseId="kb1" onClose={vi.fn()} />);

    const text = await screen.findByLabelText('文档原文');
    expect(text.querySelector('mark')).toBeNull();
    expect(screen.getByText('可对照上方摘录阅读原文')).toBeInTheDocument();
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
