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
    await waitFor(() => expect(onUpload).toHaveBeenCalledWith('kb1', expect.objectContaining({ name: 'notes.txt' })));
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

    expect(await screen.findByText('格式不受支持')).toBeInTheDocument();
    expect(screen.getByText('已上传')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: '重试失败项' }));

    await waitFor(() => expect(onUpload).toHaveBeenCalledTimes(3));
    expect(onUpload.mock.calls.map(([, file]) => file.name)).toEqual(['good.md', 'bad.pdf', 'bad.pdf']);
    expect(onClose).toHaveBeenCalledOnce();
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
    expect(within(screen.getByRole('dialog')).getByRole('button', { name: '取消' })).toBeDisabled();

    await act(async () => {
      result.resolve(documentFor(file));
      await Promise.resolve();
    });
  });
});
