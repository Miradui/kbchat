import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
import { downloadDocument, getEditableDocumentText, getPDFCorrection, saveDocumentTextRevision, savePDFCorrection } from '../../api/resources';
import type { DocumentItem } from '../../types/api';
import { DocumentTextEditor } from './DocumentTextEditor';
import { DocumentOCRCorrection } from './DocumentOCRCorrection';

vi.mock('../../api/resources', () => ({ downloadDocument: vi.fn(), getEditableDocumentText: vi.fn(), getPDFCorrection: vi.fn(), saveDocumentTextRevision: vi.fn(), savePDFCorrection: vi.fn() }));
vi.mock('../../components/pdf/PdfPreview', () => ({ PdfPreview: ({ initialPage, lockPage }: { initialPage: number; lockPage: boolean }) => <div data-testid="original-page">{initialPage}:{String(lockPage)}</div> }));
const document = { id: 'old', knowledgeBaseId: 'kb', filename: '说明.md', fileType: 'md' } as DocumentItem;
beforeEach(() => { vi.resetAllMocks(); vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:pdf'), revokeObjectURL: vi.fn() })); });

it('retains edited text on conflict and reuses the request ID for the same retry', async () => {
  vi.mocked(getEditableDocumentText).mockResolvedValue({ documentId: 'old', content: '# 原文', maxBytes: 1048576, filename: '说明.md' });
  vi.mocked(saveDocumentTextRevision).mockRejectedValueOnce(new Error('版本冲突')).mockResolvedValueOnce({ ...document, id: 'new' });
  const onSaved = vi.fn();
  render(<MemoryRouter><DocumentTextEditor document={document} onClose={vi.fn()} onSaved={onSaved} /></MemoryRouter>);
  fireEvent.change(await screen.findByLabelText('文档正文编辑'), { target: { value: '# 校正的中文' } });
  fireEvent.click(screen.getByRole('button', { name: '保存新版本' }));
  await screen.findByRole('alert');
  expect(screen.getByLabelText('文档正文编辑')).toHaveValue('# 校正的中文');
  const first = vi.mocked(saveDocumentTextRevision).mock.calls[0][1];
  fireEvent.click(screen.getByRole('button', { name: '保存新版本' }));
  expect(await screen.findByRole('link', { name: '查看新版本' })).toHaveAttribute('href', '/documents?documentId=new');
  expect(vi.mocked(saveDocumentTextRevision).mock.calls[1][1]).toEqual(first);
  expect(onSaved).toHaveBeenCalledTimes(1);
});

it('confirms before discarding unsaved text and refuses empty content', async () => {
  vi.mocked(getEditableDocumentText).mockResolvedValue({ documentId: 'old', content: '原文', maxBytes: 1048576, filename: '说明.md' });
  const close = vi.fn(); render(<MemoryRouter><DocumentTextEditor document={document} onClose={close} onSaved={vi.fn()} /></MemoryRouter>);
  fireEvent.change(await screen.findByLabelText('文档正文编辑'), { target: { value: '' } });
  expect(screen.getByRole('button', { name: '保存新版本' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  expect(close).not.toHaveBeenCalled();
  fireEvent.click(await screen.findByRole('button', { name: '放弃修改' }));
  expect(close).toHaveBeenCalledOnce();
});

it('keeps image and text pages aligned and submits only changed OCR pages', async () => {
  vi.mocked(downloadDocument).mockResolvedValue(new Blob(['pdf']));
  vi.mocked(getPDFCorrection).mockResolvedValue({ documentId: 'old', revision: 'snapshot', pages: [{ pageNumber: 2, content: '错别宇', textSource: 'ocr' }, { pageNumber: 4, content: '另一页', textSource: 'ocr' }] });
  vi.mocked(savePDFCorrection).mockRejectedValueOnce(new Error('结果未确认')).mockResolvedValueOnce({ ...document, id: 'corrected' });
  render(<MemoryRouter><DocumentOCRCorrection document={{ ...document, fileType: 'pdf' }} onClose={vi.fn()} onSaved={vi.fn()} /></MemoryRouter>);
  fireEvent.change(await screen.findByLabelText('第 2 页识别文本'), { target: { value: '错别字' } });
  fireEvent.change(screen.getByLabelText('校对页面'), { target: { value: '1' } });
  expect(screen.getByTestId('original-page')).toHaveTextContent('4:true');
  expect(screen.getByLabelText('第 4 页识别文本')).toHaveValue('另一页');
  fireEvent.change(screen.getByLabelText('校对页面'), { target: { value: '0' } });
  expect(screen.getByLabelText('第 2 页识别文本')).toHaveValue('错别字');
  fireEvent.click(screen.getByRole('button', { name: '保存校对版本' }));
  await screen.findByRole('alert');
  const request = vi.mocked(savePDFCorrection).mock.calls[0][1];
  expect(request).toMatchObject({ revision: 'snapshot', pages: [{ pageNumber: 2, content: '错别字' }] });
  fireEvent.click(screen.getByRole('button', { name: '保存校对版本' }));
  await waitFor(() => expect(savePDFCorrection).toHaveBeenCalledTimes(2));
  expect(vi.mocked(savePDFCorrection).mock.calls[1][1]).toEqual(request);
  expect(await screen.findByRole('link', { name: '查看校对版本' })).toHaveAttribute('href', '/documents?documentId=corrected');
});
