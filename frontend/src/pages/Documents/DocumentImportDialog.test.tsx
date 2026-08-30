import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../api/client';
import { ToastProvider } from '../../components/feedback/ToastProvider';
import type { DocumentItem } from '../../types/api';
import { DocumentImportDialog } from './DocumentImportDialog';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function documentFor(file: File, index = 0): DocumentItem {
  return {
    id: `doc-${index}-${file.name}`,
    knowledgeBaseId: 'kb1',
    filename: file.name,
    fileType: file.name.split('.').pop() ?? '',
    fileSize: file.size,
    status: 'uploaded',
    errorMessage: null,
    createdAt: '2026-07-01T00:00:00Z',
    updatedAt: '2026-07-01T00:00:00Z',
  };
}

function duplicateError(overrides: Record<string, unknown> = {}) {
  return new ApiError(409, {
    code: 'DOCUMENT_DUPLICATE_CONTENT',
    message: '知识库中已存在内容相同的文档',
    details: {
      existingDocumentId: 'doc-existing',
      existingFilename: 'policy-v1.md',
      existingStatus: 'completed',
      existingUploadedAt: '2026-06-01T00:00:00Z',
      ...overrides,
    },
  });
}

function renderDialog(props: Partial<React.ComponentProps<typeof DocumentImportDialog>> = {}) {
  const defaults: React.ComponentProps<typeof DocumentImportDialog> = {
    open: true,
    fixedKnowledgeBaseId: 'kb1',
    fixedKnowledgeBaseName: '制度库',
    knowledgeBases: [{ id: 'kb1', name: '制度库' }],
    onClose: vi.fn(),
    onUpload: vi.fn(async (_knowledgeBaseId, file) => documentFor(file)),
  };

  return render(
    <ToastProvider>
      <DocumentImportDialog {...defaults} {...props} />
    </ToastProvider>,
  );
}

describe('DocumentImportDialog', () => {
  it('requires an explicit target for a global import', async () => {
    const user = userEvent.setup();
    renderDialog({
      fixedKnowledgeBaseId: undefined,
      fixedKnowledgeBaseName: undefined,
      initialKnowledgeBaseId: undefined,
      knowledgeBases: [{ id: 'kb1', name: '制度库' }, { id: 'kb2', name: '产品库' }],
    });

    const target = screen.getByRole('combobox', { name: '目标知识库' });
    expect(target).toHaveValue('');

    await user.upload(
      screen.getByLabelText('选择文档文件'),
      new File(['policy'], 'policy.md', { type: 'text/markdown' }),
    );
    expect(screen.getByRole('button', { name: '开始导入' })).toBeDisabled();

    await user.selectOptions(target, 'kb2');
    expect(screen.getByRole('button', { name: '开始导入' })).toBeEnabled();
  });

  it('keeps selected files for confirmation and uploads a fixed-target batch in order', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onUploaded = vi.fn();
    const onBatchComplete = vi.fn();
    const onUpload = vi.fn(async (_knowledgeBaseId: string, file: File) => documentFor(file, onUploaded.mock.calls.length));
    renderDialog({ onBatchComplete, onClose, onUpload, onUploaded });

    const files = [
      new File(['policy'], 'policy.md', { type: 'text/markdown' }),
      new File(['manual'], 'manual.pdf', { type: 'application/pdf' }),
    ];
    await user.upload(screen.getByLabelText('选择文档文件'), files);

    expect(screen.getByText('policy.md')).toBeInTheDocument();
    expect(screen.getByText('manual.pdf')).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: '目标知识库' })).not.toBeInTheDocument();
    expect(onUpload).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: '开始导入' }));

    await waitFor(() => expect(onUpload).toHaveBeenCalledTimes(2));
    expect(onUpload.mock.calls.map(([knowledgeBaseId, file]) => [knowledgeBaseId, file.name])).toEqual([
      ['kb1', 'policy.md'],
      ['kb1', 'manual.pdf'],
    ]);
    expect(onUploaded).toHaveBeenCalledTimes(2);
    expect(onBatchComplete).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ filename: 'policy.md' }),
      expect.objectContaining({ filename: 'manual.pdf' }),
    ]));
    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.getByText('已导入 2 个文档，正在处理中。')).toBeInTheDocument();
  });

  it('supports drop selection, validates files, and lets global imports choose a target', async () => {
    const user = userEvent.setup();
    const onUpload = vi.fn(async (_knowledgeBaseId: string, file: File) => documentFor(file));
    renderDialog({
      fixedKnowledgeBaseId: undefined,
      fixedKnowledgeBaseName: undefined,
      initialKnowledgeBaseId: 'kb2',
      knowledgeBases: [{ id: 'kb1', name: '制度库' }, { id: 'kb2', name: '产品库' }],
      onUpload,
    });

    expect(screen.getByRole('combobox', { name: '目标知识库' })).toHaveValue('kb2');
    await user.selectOptions(screen.getByRole('combobox', { name: '目标知识库' }), 'kb1');

    fireEvent.drop(screen.getByRole('button', { name: '拖放或选择文档' }), {
      dataTransfer: {
        files: [
          new File(['ok'], 'notes.txt', { type: 'text/plain' }),
          new File(['bad'], 'archive.zip', { type: 'application/zip' }),
          new File([], 'empty.md', { type: 'text/markdown' }),
        ],
      },
    });

    expect(screen.getByText('notes.txt')).toBeInTheDocument();
    expect(screen.queryByText('archive.zip')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('仅支持 TXT、MD、PDF');
    expect(screen.getByRole('alert')).toHaveTextContent('不能为空');

    await user.click(screen.getByRole('button', { name: '开始导入' }));
    await waitFor(() => expect(onUpload).toHaveBeenCalledWith(
      'kb1',
      expect.objectContaining({ name: 'notes.txt' }),
      expect.any(Function),
      expect.any(AbortSignal),
    ));
  });

  it('keeps selected files when the global target changes while the dialog is open', async () => {
    const user = userEvent.setup();
    const file = new File(['policy'], 'policy.md', { type: 'text/markdown' });
    const { rerender } = renderDialog({
      fixedKnowledgeBaseId: undefined,
      fixedKnowledgeBaseName: undefined,
      initialKnowledgeBaseId: 'kb1',
      knowledgeBases: [{ id: 'kb1', name: '制度库' }, { id: 'kb2', name: '产品库' }],
    });

    await user.upload(screen.getByLabelText('选择文档文件'), file);
    await user.selectOptions(screen.getByRole('combobox', { name: '目标知识库' }), 'kb2');
    rerender(
      <ToastProvider>
        <DocumentImportDialog
          initialKnowledgeBaseId="kb2"
          knowledgeBases={[{ id: 'kb1', name: '制度库' }, { id: 'kb2', name: '产品库' }]}
          onClose={vi.fn()}
          onUpload={vi.fn(async (_knowledgeBaseId, selectedFile) => documentFor(selectedFile))}
          open
        />
      </ToastProvider>,
    );

    expect(screen.getByText('policy.md')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: '目标知识库' })).toHaveValue('kb2');
  });

  it('keeps failed files and retries only those files', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const failedFile = new File(['bad'], 'bad.pdf', { type: 'application/pdf' });
    const goodFile = new File(['good'], 'good.md', { type: 'text/markdown' });
    const onUpload = vi.fn()
      .mockResolvedValueOnce(documentFor(goodFile))
      .mockRejectedValueOnce(new ApiError(400, {
        code: 'DOCUMENT_TYPE_UNSUPPORTED',
        message: 'unsupported document type',
        details: {},
      }))
      .mockResolvedValueOnce(documentFor(failedFile));
    renderDialog({ onClose, onUpload });

    await user.upload(screen.getByLabelText('选择文档文件'), [goodFile, failedFile]);
    await user.click(screen.getByRole('button', { name: '开始导入' }));

    const failedRow = (await screen.findByText('bad.pdf')).closest('article');
    expect(failedRow).toHaveTextContent('格式不受支持');
    expect(screen.getByText('已上传')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: '重试失败项' }));

    await waitFor(() => expect(onUpload).toHaveBeenCalledTimes(3));
    expect(onUpload.mock.calls.map(([, file]) => file.name)).toEqual(['good.md', 'bad.pdf', 'bad.pdf']);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('shows real per-file upload progress reported by the transport', async () => {
    const user = userEvent.setup();
    const result = deferred<DocumentItem>();
    let reportProgress: ((progress: number) => void) | undefined;
    renderDialog({
      onUpload: vi.fn((_knowledgeBaseId, _file, onProgress) => {
        reportProgress = onProgress;
        return result.promise;
      }),
    });

    const file = new File(['policy'], 'policy.md', { type: 'text/markdown' });
    await user.upload(screen.getByLabelText('选择文档文件'), file);
    await user.click(screen.getByRole('button', { name: '开始导入' }));

    act(() => reportProgress?.(37));
    const progress = screen.getByRole('progressbar', { name: 'policy.md 上传进度' });
    expect(progress).toHaveAttribute('aria-valuenow', '37');
    expect(screen.getByText('37%')).toBeInTheDocument();

    await act(async () => {
      result.resolve(documentFor(file));
      await result.promise;
    });
  });

  it('ignores a late upload result after the dialog is externally closed', async () => {
    const user = userEvent.setup();
    const result = deferred<DocumentItem>();
    const onUploaded = vi.fn();
    const onBatchComplete = vi.fn();
    const { rerender } = renderDialog({
      onBatchComplete,
      onUpload: vi.fn(() => result.promise),
      onUploaded,
    });

    const file = new File(['policy'], 'policy.md', { type: 'text/markdown' });
    await user.upload(screen.getByLabelText('选择文档文件'), file);
    await user.click(screen.getByRole('button', { name: '开始导入' }));

    rerender(
      <ToastProvider>
        <DocumentImportDialog
          fixedKnowledgeBaseId="kb1"
          fixedKnowledgeBaseName="制度库"
          knowledgeBases={[{ id: 'kb1', name: '制度库' }]}
          onClose={vi.fn()}
          onUpload={vi.fn(() => result.promise)}
          onUploaded={onUploaded}
          onBatchComplete={onBatchComplete}
          open={false}
        />
      </ToastProvider>,
    );

    await act(async () => {
      result.resolve(documentFor(file));
      await Promise.resolve();
    });

    expect(onUploaded).not.toHaveBeenCalled();
    expect(onBatchComplete).not.toHaveBeenCalled();
  });

  it('blocks dismissal while a batch is uploading', async () => {
    const user = userEvent.setup();
    const result = deferred<DocumentItem>();
    const onClose = vi.fn();
    renderDialog({ onClose, onUpload: vi.fn(() => result.promise) });

    const file = new File(['policy'], 'policy.md', { type: 'text/markdown' });
    await user.upload(screen.getByLabelText('选择文档文件'), file);
    await user.click(screen.getByRole('button', { name: '开始导入' }));
    await user.keyboard('{Escape}');
    fireEvent.mouseDown(screen.getByTestId('dialog-backdrop'));

    expect(onClose).not.toHaveBeenCalled();
    expect(within(screen.getByRole('dialog')).getByRole('button', { name: '停止上传' })).toBeEnabled();

    await act(async () => {
      result.resolve(documentFor(file));
      await Promise.resolve();
    });
  });

  it('asks before discarding a selected import list', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderDialog({ onClose });

    await user.upload(
      screen.getByLabelText('选择文档文件'),
      new File(['policy'], 'policy.md', { type: 'text/markdown' }),
    );
    await user.click(screen.getByRole('button', { name: '取消' }));

    const confirmation = screen.getByRole('dialog', { name: '放弃待导入文件' });
    expect(onClose).not.toHaveBeenCalled();
    await user.click(within(confirmation).getByRole('button', { name: '继续编辑' }));
    expect(screen.getByText('policy.md')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '取消' }));
    await user.click(within(
      screen.getByRole('dialog', { name: '放弃待导入文件' }),
    ).getByRole('button', { name: '放弃文件' }));
    expect(onClose).toHaveBeenCalledOnce();
  });
  it('turns a duplicate into a choice without stopping the rest of the batch', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const dupe = new File(['policy'], 'policy.md', { type: 'text/markdown' });
    const other = new File(['manual'], 'manual.pdf', { type: 'application/pdf' });
    const onUpload = vi.fn()
      .mockRejectedValueOnce(duplicateError())
      .mockResolvedValueOnce(documentFor(other));
    renderDialog({ onClose, onReplace: vi.fn(), onUpload });

    await user.upload(screen.getByLabelText('选择文档文件'), [dupe, other]);
    await user.click(screen.getByRole('button', { name: '开始导入' }));

    // The second file went through even though the first raised a conflict.
    await waitFor(() => expect(onUpload).toHaveBeenCalledTimes(2));
    expect(screen.getByText('已上传')).toBeInTheDocument();

    const row = (await screen.findByText('policy.md')).closest('article') as HTMLElement;
    expect(row).toHaveTextContent('policy-v1.md');
    expect(within(row).getByRole('button', { name: '替换原文档' })).toBeEnabled();
    expect(within(row).getByRole('button', { name: '保留两份' })).toBeEnabled();
    // A conflict is not a failure, so the row must not be labelled as one.
    expect(row).not.toHaveTextContent('上传失败');
    expect(row).toHaveTextContent('内容重复');

    // The dialog has to stay open or the decision the server asked for is lost.
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('请选择替换或保留两份');
  });

  it('keeps both copies by re-uploading with the duplicate override', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onBatchComplete = vi.fn();
    const file = new File(['policy'], 'policy.md', { type: 'text/markdown' });
    const onReplace = vi.fn();
    const onUpload = vi.fn()
      .mockRejectedValueOnce(duplicateError())
      .mockResolvedValueOnce(documentFor(file));
    renderDialog({ onBatchComplete, onClose, onReplace, onUpload });

    await user.upload(screen.getByLabelText('选择文档文件'), file);
    await user.click(screen.getByRole('button', { name: '开始导入' }));
    await user.click(await screen.findByRole('button', { name: '保留两份' }));

    await waitFor(() => expect(onUpload).toHaveBeenCalledTimes(2));
    expect(onUpload.mock.calls[1]).toEqual([
      'kb1',
      expect.objectContaining({ name: 'policy.md' }),
      expect.any(Function),
      expect.any(AbortSignal),
      { allowDuplicate: true },
    ]);
    expect(onReplace).not.toHaveBeenCalled();
    expect(onBatchComplete).toHaveBeenCalledWith([expect.objectContaining({ filename: 'policy.md' })]);
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  it('replaces the existing document by id rather than re-uploading', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const file = new File(['policy'], 'policy.md', { type: 'text/markdown' });
    const onReplace = vi.fn(async () => documentFor(file));
    const onUpload = vi.fn().mockRejectedValueOnce(duplicateError());
    renderDialog({ onClose, onReplace, onUpload });

    await user.upload(screen.getByLabelText('选择文档文件'), file);
    await user.click(screen.getByRole('button', { name: '开始导入' }));
    await user.click(await screen.findByRole('button', { name: '替换原文档' }));

    await waitFor(() => expect(onReplace).toHaveBeenCalledOnce());
    expect(onReplace).toHaveBeenCalledWith(
      'doc-existing',
      expect.objectContaining({ name: 'policy.md' }),
      expect.any(Function),
      expect.any(AbortSignal),
    );
    // Replacement must not also create a second copy.
    expect(onUpload).toHaveBeenCalledTimes(1);
    expect(screen.getByText('已替换原文档，正在处理中。')).toBeInTheDocument();
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  it('offers only the keep option when replacement is not wired up', async () => {
    const user = userEvent.setup();
    const file = new File(['policy'], 'policy.md', { type: 'text/markdown' });
    renderDialog({ onReplace: undefined, onUpload: vi.fn().mockRejectedValueOnce(duplicateError()) });

    await user.upload(screen.getByLabelText('选择文档文件'), file);
    await user.click(screen.getByRole('button', { name: '开始导入' }));

    expect(await screen.findByRole('button', { name: '保留两份' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: '替换原文档' })).not.toBeInTheDocument();
  });

  it('lets the user choose again when resolving the duplicate fails', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const file = new File(['policy'], 'policy.md', { type: 'text/markdown' });
    const onReplace = vi.fn().mockRejectedValueOnce(new ApiError(500, {
      code: 'INTERNAL_ERROR',
      message: 'boom',
      details: {},
    }));
    renderDialog({ onClose, onReplace, onUpload: vi.fn().mockRejectedValueOnce(duplicateError()) });

    await user.upload(screen.getByLabelText('选择文档文件'), file);
    await user.click(screen.getByRole('button', { name: '开始导入' }));
    await user.click(await screen.findByRole('button', { name: '替换原文档' }));

    await waitFor(() => expect(onReplace).toHaveBeenCalledOnce());
    const row = (await screen.findByText('policy.md')).closest('article') as HTMLElement;
    expect(within(row).getByRole('button', { name: '替换原文档' })).toBeEnabled();
    expect(within(row).getByRole('button', { name: '保留两份' })).toBeEnabled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('waits for every duplicate before closing', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const first = new File(['policy'], 'policy.md', { type: 'text/markdown' });
    const second = new File(['manual'], 'manual.pdf', { type: 'application/pdf' });
    const onUpload = vi.fn()
      .mockRejectedValueOnce(duplicateError())
      .mockRejectedValueOnce(duplicateError({ existingFilename: 'manual-v1.pdf' }))
      .mockResolvedValueOnce(documentFor(first))
      .mockResolvedValueOnce(documentFor(second, 1));
    renderDialog({ onClose, onUpload });

    await user.upload(screen.getByLabelText('选择文档文件'), [first, second]);
    await user.click(screen.getByRole('button', { name: '开始导入' }));

    const firstRow = (await screen.findByText('policy.md')).closest('article') as HTMLElement;
    await user.click(within(firstRow).getByRole('button', { name: '保留两份' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('还有文件与知识库中已有内容重复'));
    expect(onClose).not.toHaveBeenCalled();

    const secondRow = (await screen.findByText('manual.pdf')).closest('article') as HTMLElement;
    await user.click(within(secondRow).getByRole('button', { name: '保留两份' }));

    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  it('treats a malformed conflict payload as a plain failure', async () => {
    const user = userEvent.setup();
    const file = new File(['policy'], 'policy.md', { type: 'text/markdown' });
    renderDialog({
      onReplace: vi.fn(),
      // No existingDocumentId: there is nothing to replace, so offering the choice
      // would produce a request that cannot succeed.
      onUpload: vi.fn().mockRejectedValueOnce(new ApiError(409, {
        code: 'DOCUMENT_DUPLICATE_CONTENT',
        message: '知识库中已存在内容相同的文档',
        details: {},
      })),
    });

    await user.upload(screen.getByLabelText('选择文档文件'), file);
    await user.click(screen.getByRole('button', { name: '开始导入' }));

    const row = (await screen.findByText('policy.md')).closest('article') as HTMLElement;
    expect(row).toHaveTextContent('上传失败');
    expect(within(row).queryByRole('button', { name: '替换原文档' })).not.toBeInTheDocument();
  });
});
