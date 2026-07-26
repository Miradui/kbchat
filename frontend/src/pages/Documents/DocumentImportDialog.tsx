import { Upload, X } from 'lucide-react';
import { ChangeEvent, DragEvent, useEffect, useMemo, useRef, useState } from 'react';

import { ApiError } from '../../api/client';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { useToast } from '../../components/feedback/ToastProvider';
import { useUnsavedChangesWarning } from '../../components/feedback/useUnsavedChangesWarning';
import { Button } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';
import type { DocumentItem } from '../../types/api';
import { getErrorMessage } from '../../utils/errors';
import { formatDocumentBytes } from './documentDisplay';

const DOCUMENT_ACCEPT = '.txt,.md,.pdf,text/plain,text/markdown,application/pdf';
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set(['txt', 'md', 'pdf']);

type ImportStatus = 'pending' | 'uploading' | 'succeeded' | 'failed';

type ImportItem = {
  error: string;
  file: File;
  key: string;
  status: ImportStatus;
};

type KnowledgeBaseOption = {
  id: string;
  name: string;
};

type DocumentImportDialogProps = {
  fixedKnowledgeBaseId?: string;
  fixedKnowledgeBaseName?: string;
  initialKnowledgeBaseId?: string;
  knowledgeBases: KnowledgeBaseOption[];
  onBatchComplete?: (documents: DocumentItem[]) => void | Promise<void>;
  onClose: () => void;
  onKnowledgeBaseChange?: (knowledgeBaseId: string) => void;
  onUpload: (knowledgeBaseId: string, file: File) => Promise<DocumentItem>;
  onUploaded?: (document: DocumentItem) => void;
  open: boolean;
};

export function DocumentImportDialog({
  fixedKnowledgeBaseId,
  fixedKnowledgeBaseName,
  initialKnowledgeBaseId,
  knowledgeBases,
  onBatchComplete,
  onClose,
  onKnowledgeBaseChange,
  onUpload,
  onUploaded,
  open,
}: DocumentImportDialogProps) {
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const operationRef = useRef<symbol | null>(null);
  const wasOpenRef = useRef(false);
  const [items, setItems] = useState<ImportItem[]>([]);
  const [knowledgeBaseId, setKnowledgeBaseId] = useState('');
  const [validationError, setValidationError] = useState('');
  const [uploading, setUploading] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  useEffect(() => {
    const opening = open && !wasOpenRef.current;
    wasOpenRef.current = open;
    if (!open) {
      operationRef.current = null;
      setConfirmDiscard(false);
      return;
    }
    if (!opening) {
      return;
    }

    operationRef.current = null;
    setItems([]);
    setValidationError('');
    setUploading(false);
    setConfirmDiscard(false);
    setKnowledgeBaseId(
      fixedKnowledgeBaseId
      ?? (knowledgeBases.some((item) => item.id === initialKnowledgeBaseId)
        ? initialKnowledgeBaseId ?? ''
        : ''),
    );
  }, [fixedKnowledgeBaseId, initialKnowledgeBaseId, knowledgeBases, open]);

  useEffect(() => () => {
    operationRef.current = null;
  }, []);

  const failedCount = items.filter((item) => item.status === 'failed').length;
  const pendingCount = items.filter((item) => item.status === 'pending').length;
  const uploadCandidates = useMemo(
    () => items.filter((item) => item.status === 'pending' || item.status === 'failed'),
    [items],
  );

  useUnsavedChangesWarning(open && items.length > 0);

  function closeSafely() {
    if (uploading) {
      return;
    }
    if (items.length > 0) {
      setConfirmDiscard(true);
      return;
    }
    onClose();
  }

  function handleFileInput(event: ChangeEvent<HTMLInputElement>) {
    addFiles(Array.from(event.target.files ?? []));
    event.target.value = '';
  }

  function handleDrop(event: DragEvent<HTMLButtonElement>) {
    event.preventDefault();
    if (!uploading) {
      addFiles(Array.from(event.dataTransfer.files));
    }
  }

  function addFiles(files: File[]) {
    if (uploading || files.length === 0) {
      return;
    }

    const errors: string[] = [];
    const validFiles = files.filter((file) => {
      const error = validateDocumentFile(file);
      if (error) {
        errors.push(`${file.name}：${error}`);
        return false;
      }
      return true;
    });

    setItems((current) => {
      const existingKeys = new Set(current.map((item) => item.key));
      const additions = validFiles
        .map((file) => ({ file, key: fileKey(file) }))
        .filter(({ key }) => !existingKeys.has(key))
        .map(({ file, key }): ImportItem => ({ error: '', file, key, status: 'pending' }));
      if (additions.length < validFiles.length) {
        errors.push('已忽略重复选择的文件。');
      }
      return [...current, ...additions];
    });
    setValidationError(errors.join(' '));
  }

  function removeFile(key: string) {
    if (!uploading) {
      setItems((current) => current.filter((item) => item.key !== key));
    }
  }

  async function handleSubmit() {
    if (uploading) {
      return;
    }
    if (!knowledgeBaseId) {
      setValidationError('请选择目标知识库。');
      return;
    }
    if (uploadCandidates.length === 0) {
      setValidationError('请先选择要导入的文档。');
      return;
    }

    const operation = Symbol('document-import');
    operationRef.current = operation;
    setUploading(true);
    setValidationError('');
    const uploadedDocuments: DocumentItem[] = [];
    let batchCompleteError: unknown;
    let hasFailure = false;

    for (const item of uploadCandidates) {
      if (operationRef.current !== operation) {
        return;
      }
      setItems((current) => updateImportItem(current, item.key, { error: '', status: 'uploading' }));
      try {
        const document = await onUpload(knowledgeBaseId, item.file);
        if (operationRef.current !== operation) {
          return;
        }
        uploadedDocuments.push(document);
        setItems((current) => updateImportItem(current, item.key, { error: '', status: 'succeeded' }));
        onUploaded?.(document);
      } catch (error) {
        if (operationRef.current !== operation) {
          return;
        }
        hasFailure = true;
        setItems((current) => updateImportItem(current, item.key, {
          error: documentUploadErrorMessage(error),
          status: 'failed',
        }));
      }
    }

    if (operationRef.current !== operation) {
      return;
    }
    try {
      if (uploadedDocuments.length > 0) {
        await onBatchComplete?.(uploadedDocuments);
      }
    } catch (error) {
      batchCompleteError = error;
    }
    if (operationRef.current !== operation) {
      return;
    }

    operationRef.current = null;
    setUploading(false);
    if (hasFailure) {
      if (batchCompleteError) {
        toast.error(getErrorMessage(batchCompleteError, '部分文档已上传，但列表刷新失败'));
      }
      toast.error('部分文档导入失败，请检查后重试。');
      return;
    }
    if (batchCompleteError) {
      onClose();
      toast.error(getErrorMessage(batchCompleteError, '文档已上传，但列表刷新失败'));
      return;
    }

    toast.success(`已导入 ${uploadedDocuments.length} 个文档，正在处理中。`);
    onClose();
  }

  return (
    <>
      <Dialog
        description="选择目标知识库并确认文件后开始导入。文档将在后台处理，完成后即可用于问答。"
        onClose={closeSafely}
        open={open}
        title="导入文档"
      >
      <div className="document-import-dialog">
        {fixedKnowledgeBaseId ? (
          <div className="document-import-target">
            <span>目标知识库</span>
            <strong>{fixedKnowledgeBaseName || '当前知识库'}</strong>
          </div>
        ) : (
          <label className="document-import-target">
            <span>目标知识库</span>
            <select
              aria-label="目标知识库"
              data-autofocus
              disabled={uploading || knowledgeBases.length === 0}
              onChange={(event) => {
                setKnowledgeBaseId(event.target.value);
                onKnowledgeBaseChange?.(event.target.value);
              }}
              value={knowledgeBaseId}
            >
              <option value="">请选择知识库</option>
              {knowledgeBases.map((item) => (
                <option key={item.id} value={item.id}>{item.name}</option>
              ))}
            </select>
          </label>
        )}

        <button
          aria-label="拖放或选择文档"
          className="document-import-dropzone"
          data-autofocus={fixedKnowledgeBaseId ? '' : undefined}
          disabled={uploading}
          onClick={() => inputRef.current?.click()}
          onDragOver={(event) => event.preventDefault()}
          onDrop={handleDrop}
          type="button"
        >
          <Upload aria-hidden="true" />
          <strong>拖放或选择文档</strong>
          <span>支持 TXT、MD、PDF，单个文件不超过 50 MiB</span>
        </button>
        <input
          ref={inputRef}
          accept={DOCUMENT_ACCEPT}
          aria-label="选择文档文件"
          className="document-import-input"
          disabled={uploading}
          multiple
          onChange={handleFileInput}
          type="file"
        />

        {validationError && <p className="document-import-error" role="alert">{validationError}</p>}

        {items.length > 0 && (
          <div aria-label="待导入文件" className="document-import-list" role="list">
            {items.map((item) => (
              <article className="document-import-item" key={item.key} role="listitem">
                <div>
                  <strong>{item.file.name}</strong>
                  <span>{formatDocumentBytes(item.file.size)}</span>
                  {item.error && <small>{item.error}</small>}
                </div>
                <div className={`document-import-status is-${item.status}`}>
                  <span>{importStatusLabel(item.status)}</span>
                  {item.status !== 'uploading' && item.status !== 'succeeded' && (
                    <button
                      aria-label={`移除 ${item.file.name}`}
                      className="document-import-remove"
                      disabled={uploading}
                      onClick={() => removeFile(item.key)}
                      title="移除文件"
                      type="button"
                    >
                      <X aria-hidden="true" />
                    </button>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}

        <div className="ui-dialog__actions document-import-actions">
          <Button disabled={uploading} onClick={closeSafely} variant="secondary">取消</Button>
          <Button
            disabled={!knowledgeBaseId || (pendingCount === 0 && failedCount === 0)}
            loading={uploading}
            loadingLabel="正在导入"
            onClick={() => void handleSubmit()}
          >
            {failedCount > 0 && pendingCount === 0 ? '重试失败项' : '开始导入'}
          </Button>
        </div>
      </div>
      </Dialog>
      {confirmDiscard && (
        <ConfirmDialog
          cancelLabel="继续编辑"
          confirmLabel="放弃文件"
          description="关闭后将清空当前待导入清单，已经上传的文档不受影响。"
          onCancel={() => setConfirmDiscard(false)}
          onConfirm={() => {
            setConfirmDiscard(false);
            onClose();
          }}
          title="放弃待导入文件"
        />
      )}
    </>
  );
}

function validateDocumentFile(file: File): string {
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    return '仅支持 TXT、MD、PDF。';
  }
  if (file.size === 0) {
    return '文件不能为空。';
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return '单个文件不得超过 50 MiB。';
  }
  return '';
}

function fileKey(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

function updateImportItem(
  items: ImportItem[],
  key: string,
  update: Pick<ImportItem, 'error' | 'status'>,
): ImportItem[] {
  return items.map((item) => item.key === key ? { ...item, ...update } : item);
}

function importStatusLabel(status: ImportStatus): string {
  switch (status) {
    case 'uploading': return '上传中';
    case 'succeeded': return '已上传';
    case 'failed': return '上传失败';
    default: return '待上传';
  }
}

function documentUploadErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'DOCUMENT_TYPE_UNSUPPORTED') {
      return '格式不受支持';
    }
    if (error.code === 'VALIDATION_ERROR') {
      const fileError = error.details.file;
      if (fileError === 'file size exceeds limit') {
        return '文件超过大小限制';
      }
      if (typeof fileError === 'string' && fileError) {
        return fileError === 'file is required' ? '文件不能为空' : '文件校验失败';
      }
    }
  }
  return getErrorMessage(error, '上传失败');
}
