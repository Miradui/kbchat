import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { Link, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../api/client';
import { getDocument, replaceDocument, uploadDocument, uploadGlobalDocument } from '../../api/resources';
import { tokenStore } from '../../store/tokenStore';
import { renderWithRouter } from '../../test/render';
import type { DocumentItem } from '../../types/api';
import { useDocumentImports } from './DocumentImportContext';
import { DocumentImportProvider } from './DocumentImportProvider';
import { UploadTasksButton } from './UploadTasksButton';

vi.mock('../../api/resources', () => ({ getDocument: vi.fn(), replaceDocument: vi.fn(), uploadDocument: vi.fn(), uploadGlobalDocument: vi.fn() }));
vi.mock('../../hooks/useSystemCapabilities', () => ({ useSystemCapabilities: () => ({ upload: { allowedExtensions: ['txt', 'md', 'pdf'], maxFileBytes: 50 * 1024 * 1024 } }) }));

const file = new File(['正文'], 'policy.md', { type: 'text/markdown' });
const documentItem: DocumentItem = { id: 'doc1', knowledgeBaseId: 'kb1', filename: file.name, fileType: 'md', fileSize: file.size, status: 'uploaded', progress: 0, jobStatus: 'pending', errorMessage: null, createdAt: '' };
const duplicate = () => new ApiError(409, { code: 'DOCUMENT_DUPLICATE_CONTENT', message: '重复', details: { existingDocumentId: 'existing1', existingFilename: '已有.md', existingStatus: 'completed', existingUploadedAt: '' } });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function Page({ other = false }: { other?: boolean }) {
  const imports = useDocumentImports()!;
  return <>
    <h1>{other ? '另一页面' : '文档页面'}</h1>
    <button onClick={() => imports.openImport({ knowledgeBases: [{ id: 'kb1', name: '制度库' }, { id: 'kb2', name: '产品库' }], initialKnowledgeBaseId: other ? 'kb2' : 'kb1' })}>导入文档</button>
    <Link to={other ? '/documents' : '/other'}>{other ? '返回文档' : '切换页面'}</Link>
    <output aria-label="文档变更次数">{imports.changeVersion}</output>
  </>;
}

function renderApp() {
  return renderWithRouter(<StrictMode><DocumentImportProvider><UploadTasksButton /><Routes>
    <Route path="/documents" element={<Page />} />
    <Route path="/other" element={<Page other />} />
  </Routes></DocumentImportProvider></StrictMode>, ['/documents']);
}

beforeEach(() => {
  tokenStore.setToken('test-account-a');
  vi.mocked(getDocument).mockReset().mockResolvedValue(documentItem);
  vi.mocked(uploadGlobalDocument).mockReset().mockResolvedValue(documentItem);
  vi.mocked(uploadDocument).mockReset().mockResolvedValue(documentItem);
  vi.mocked(replaceDocument).mockReset().mockResolvedValue(documentItem);
});
afterEach(() => { vi.useRealTimers(); });

async function selectFiles(user: ReturnType<typeof userEvent.setup>, files: File[] = [file]) {
  await user.click(screen.getByRole('button', { name: '导入文档', exact: true }));
  await user.upload(screen.getByLabelText('选择文档文件'), files);
  await user.click(screen.getByRole('button', { name: '开始导入' }));
}

async function submitWithTimers(files: File[] = [file]) {
  fireEvent.click(screen.getByRole('button', { name: '导入文档', exact: true }));
  fireEvent.change(screen.getByLabelText('选择文档文件'), { target: { files } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '开始导入' })); });
  fireEvent.click(screen.getByRole('button', { name: '上传任务', exact: true }));
}

describe('DocumentImportProvider', () => {
  it('keeps the same transfer alive across route changes and restores its live progress', async () => {
    const upload = deferred<DocumentItem>();
    let signal: AbortSignal | undefined;
    let report: ((value: number) => void) | undefined;
    vi.mocked(uploadGlobalDocument).mockImplementation((_kb, _file, onProgress, abort) => { signal = abort; report = onProgress; return upload.promise; });
    const user = userEvent.setup();
    renderApp();
    await selectFiles(user);
    act(() => report?.(37));
    await user.click(screen.getByRole('button', { name: '后台继续' }));
    await user.click(screen.getByRole('link', { name: '切换页面' }));
    expect(screen.getByRole('heading', { name: '另一页面' })).toBeInTheDocument();
    expect(signal?.aborted).toBe(false);
    await user.click(screen.getByRole('button', { name: '上传任务', exact: true }));
    expect(screen.getByRole('progressbar', { name: 'policy.md 上传进度' })).toHaveAttribute('aria-valuenow', '37');
    await user.click(screen.getByRole('button', { name: '查看上传清单' }));
    expect(screen.getByRole('combobox', { name: '目标知识库' })).toHaveValue('kb1');
    expect(screen.getByRole('progressbar', { name: 'policy.md 上传进度' })).toHaveAttribute('aria-valuenow', '37');
    await user.click(screen.getByRole('button', { name: '后台继续' }));
    await act(async () => upload.resolve(documentItem));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '另一页面' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '上传任务', exact: true }));
    expect(within(screen.getByRole('region', { name: '文档处理任务' })).getByRole('article', { name: file.name })).toHaveTextContent('已上传');
    expect(uploadGlobalDocument).toHaveBeenCalledTimes(1);
  });

  it.each(['keep', 'replace'] as const)('keeps a duplicate decision bound to its original knowledge base (%s)', async (choice) => {
    vi.mocked(uploadGlobalDocument).mockRejectedValueOnce(duplicate());
    const user = userEvent.setup();
    renderApp();
    await selectFiles(user);
    await screen.findByRole('button', { name: '保留两份' });
    await user.click(screen.getByRole('button', { name: '收起窗口' }));
    await user.click(screen.getByRole('link', { name: '切换页面' }));
    // This page suggests kb2, but an existing submitted batch must not be retargeted.
    await user.click(screen.getByRole('button', { name: '导入文档', exact: true }));
    expect(screen.getByRole('combobox', { name: '目标知识库' })).toHaveValue('kb1');
    expect(screen.getByRole('combobox', { name: '目标知识库' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: choice === 'keep' ? '保留两份' : '替换原文档' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    if (choice === 'keep') expect(uploadGlobalDocument).toHaveBeenLastCalledWith('kb1', file, expect.any(Function), expect.any(AbortSignal), { allowDuplicate: true });
    else expect(replaceDocument).toHaveBeenCalledWith('existing1', file, expect.any(Function), expect.any(AbortSignal));
  });

  it('allows an explicit failed upload to be retried after navigating away', async () => {
    vi.mocked(uploadGlobalDocument).mockRejectedValueOnce(new ApiError(400, { code: 'DOCUMENT_TYPE_UNSUPPORTED', message: 'unsupported' }));
    const user = userEvent.setup();
    renderApp();
    await selectFiles(user);
    await screen.findByRole('button', { name: '重试失败项' });
    await user.click(screen.getByRole('button', { name: '收起窗口' }));
    await user.click(screen.getByRole('link', { name: '切换页面' }));
    await user.click(screen.getByRole('button', { name: '上传任务', exact: true }));
    expect(screen.getByRole('article', { name: file.name })).toHaveTextContent('上传失败');
    await user.click(screen.getByRole('button', { name: '继续导入' }));
    await user.click(screen.getByRole('button', { name: '重试失败项' }));
    await waitFor(() => expect(uploadGlobalDocument).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('does not resubmit an uncertain file when the remaining queue resumes', async () => {
    vi.mocked(uploadGlobalDocument).mockRejectedValueOnce(new ApiError(0, { code: 'NETWORK_ERROR', message: '网络中断' }));
    const other = new File(['其他正文'], 'other.md', { type: 'text/markdown' });
    const user = userEvent.setup();
    renderApp();
    await selectFiles(user, [file, other]);
    await screen.findByText('结果待确认');
    expect(uploadGlobalDocument).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: '收起窗口' }));
    const closing = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(closing);
    expect(closing.defaultPrevented).toBe(true);
    await user.click(screen.getByRole('link', { name: '切换页面' }));
    await user.click(screen.getByRole('button', { name: '上传任务', exact: true }));
    expect(screen.getByRole('article', { name: file.name })).toHaveTextContent('结果待确认');
    await user.click(screen.getByRole('button', { name: '继续导入' }));
    await user.click(screen.getByRole('button', { name: '开始导入' }));
    expect(uploadGlobalDocument).toHaveBeenCalledTimes(2);
    expect(vi.mocked(uploadGlobalDocument).mock.calls[1][1]).toBe(other);
    expect(screen.getByText('结果待确认')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '开始导入' })).toBeDisabled();
  });

  it('stops the current transfer without sending the next file', async () => {
    vi.mocked(uploadGlobalDocument).mockImplementation((_kb, _file, _progress, signal) => new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new ApiError(0, { code: 'REQUEST_ABORTED', message: '停止' })));
    }));
    const user = userEvent.setup();
    renderApp();
    await selectFiles(user, [file, new File(['other'], 'other.md', { type: 'text/markdown' })]);
    await user.click(screen.getByRole('button', { name: '停止上传' }));
    await screen.findByText('结果待确认');
    expect(screen.getByText('待上传')).toBeInTheDocument();
    expect(uploadGlobalDocument).toHaveBeenCalledTimes(1);
  });

  it.each(['logout', 'new-account', 'other-tab'] as const)('aborts and isolates local task state on %s', async (change) => {
    const upload = deferred<DocumentItem>();
    let signal: AbortSignal | undefined;
    vi.mocked(uploadGlobalDocument).mockImplementation((_kb, _file, _progress, abort) => { signal = abort; return upload.promise; });
    const user = userEvent.setup();
    renderApp();
    await selectFiles(user);
    await user.click(screen.getByRole('button', { name: '后台继续' }));
    act(() => {
      if (change === 'logout') tokenStore.clearToken();
      else if (change === 'new-account') tokenStore.setToken('test-account-b');
      else {
        window.localStorage.setItem('rag.auth.token', 'test-account-b');
        window.dispatchEvent(new StorageEvent('storage', { key: 'rag.auth.token', storageArea: window.localStorage, newValue: 'test-account-b' }));
      }
    });
    expect(signal?.aborted).toBe(true);
    expect(screen.queryByRole('button', { name: '上传任务', exact: true })).not.toBeInTheDocument();
    await act(async () => upload.resolve(documentItem));
    expect(screen.queryByRole('button', { name: '上传任务', exact: true })).not.toBeInTheDocument();
    const closing = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(closing);
    expect(closing.defaultPrevented).toBe(false);
  });

  it('tracks real processing progress until terminal and then stops polling', async () => {
    vi.useFakeTimers();
    vi.mocked(getDocument).mockResolvedValueOnce({ ...documentItem, status: 'embedding', stage: 'embedding', progress: 73, jobStatus: 'running' })
      .mockResolvedValueOnce({ ...documentItem, status: 'completed', stage: 'completed', progress: 100, jobStatus: 'completed' });
    renderApp();
    await submitWithTimers();
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(screen.getByText('向量化中')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: '处理进度' })).toHaveAttribute('aria-valuenow', '73');
    await act(async () => vi.advanceTimersByTimeAsync(2500));
    expect(screen.getByRole('link', { name: '开始提问' })).toHaveAttribute('href', '/chat?knowledgeBaseId=kb1');
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(getDocument).toHaveBeenCalledTimes(2);
    const closing = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(closing);
    expect(closing.defaultPrevented).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '清除已结束记录' }));
    expect(screen.getByText('暂无上传任务，可从文档页开始导入。')).toBeInTheDocument();
  });

  it('limits concurrent processing queries and pauses inaccessible documents until retry', async () => {
    vi.useFakeTimers();
    const read = deferred<DocumentItem>();
    const files = Array.from({ length: 4 }, (_, index) => new File([String(index)], `file-${index}.md`, { type: 'text/markdown' }));
    vi.mocked(uploadGlobalDocument).mockImplementation(async (_kb, selected) => ({ ...documentItem, id: selected.name, filename: selected.name }));
    vi.mocked(getDocument).mockReturnValue(read.promise);
    renderApp();
    await submitWithTimers(files);
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(getDocument).toHaveBeenCalledTimes(3);
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(getDocument).toHaveBeenCalledTimes(3);
    await act(async () => read.reject(new ApiError(404, { code: 'DOCUMENT_NOT_FOUND', message: '文档已移入回收站' })));
    vi.mocked(getDocument).mockResolvedValueOnce({ ...documentItem, id: files[3].name, filename: files[3].name, status: 'completed', progress: 100, jobStatus: 'completed' });
    await act(async () => vi.advanceTimersByTimeAsync(2500));
    expect(getDocument).toHaveBeenCalledTimes(4);
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(getDocument).toHaveBeenCalledTimes(4);
    expect(screen.getAllByRole('button', { name: '重试状态查询' })).toHaveLength(3);
    vi.mocked(getDocument).mockResolvedValue({ ...documentItem, id: files[0].name, filename: files[0].name, status: 'completed', progress: 100, jobStatus: 'completed' });
    fireEvent.click(screen.getAllByRole('button', { name: '重试状态查询' })[0]);
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(getDocument).toHaveBeenCalledTimes(5);
  });
});
