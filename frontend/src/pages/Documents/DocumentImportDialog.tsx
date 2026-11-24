import { Minimize2, Square, Upload, X } from 'lucide-react';
import { ChangeEvent, DragEvent, useEffect, useMemo, useRef, useState } from 'react';

import { ApiError } from '../../api/client';
import { createTextDocument, getDocumentUploadResult, type UploadDocumentOptions } from '../../api/resources';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { useToast } from '../../components/feedback/ToastProvider';
import { useUnsavedChangesWarning } from '../../components/feedback/useUnsavedChangesWarning';
import { Button } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';
import { Field, Input, Select, Textarea } from '../../components/ui/Field';
import { IconButton } from '../../components/ui/IconButton';
import { SegmentedControl } from '../../components/ui/SegmentedControl';
import { useSystemCapabilities } from '../../hooks/useSystemCapabilities';
import type { DocumentItem, SystemCapabilities, TextDocumentInput } from '../../types/api';
import { getErrorMessage } from '../../utils/errors';
import { formatDocumentBytes } from './documentDisplay';
import type { ImportSnapshot, ImportStatus } from './DocumentImportContext';
import {
  acceptAttribute,
  clampProgress,
  documentUploadErrorMessage,
  duplicateDetails,
  extensionSummary,
  fileKey,
  importStatusLabel,
  MIME_BY_EXTENSION,
  updateImportItem,
  validateDocumentFile,
  type ImportItem,
} from './documentImportUtils';
import { DuplicateChoice } from './DuplicateChoice';
import { MAX_IMPORT_BYTES, MAX_IMPORT_FILES, prepareImportFiles, preparePlainImportFiles, type PreparedImportFile } from './importFiles';
import { isUnconfirmedUpload, recoverUpload } from './recoverUpload';
import { TableImportSettingsDialog } from './TableImportSettingsDialog';

type KnowledgeBaseOption = {
  id: string;
  name: string;
};

type DocumentImportDialogProps = {
	onCheckUpload?: typeof getDocumentUploadResult;
  onCreateText?: (knowledgeBaseId: string, input: TextDocumentInput, signal?: AbortSignal) => Promise<DocumentItem>;
  fixedKnowledgeBaseId?: string;
  fixedKnowledgeBaseName?: string;
  initialKnowledgeBaseId?: string;
  knowledgeBases: KnowledgeBaseOption[];
  onBatchComplete?: (documents: DocumentItem[]) => void | Promise<void>;
  onClose: () => void;
  onKnowledgeBaseChange?: (knowledgeBaseId: string) => void;
  onUpload: (
    knowledgeBaseId: string,
    file: File,
    onProgress?: (progress: number) => void,
    signal?: AbortSignal,
    options?: UploadDocumentOptions,
  ) => Promise<DocumentItem>;
  /**
   * Replace the colliding document instead of adding a second copy. Injected so the
   * dialog stays testable without the network, same as `onUpload`.
   */
  onReplace?: (
    documentId: string,
    file: File,
    onProgress?: (progress: number) => void,
    signal?: AbortSignal,
    options?: UploadDocumentOptions,
  ) => Promise<DocumentItem>;
  onUploaded?: (document: DocumentItem) => void;
  open: boolean;
  /** Hides the view while its upload queue remains mounted above the routes. */
  minimized?: boolean;
  onMinimize?: () => void;
  onStateChange?: (snapshot: ImportSnapshot) => void;
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
  onCreateText,
  onCheckUpload = (...args) => getDocumentUploadResult(...args),
  onReplace,
  onUploaded,
  open,
  minimized = false,
  onMinimize,
  onStateChange,
}: DocumentImportDialogProps) {
  const toast = useToast();
  const { upload } = useSystemCapabilities();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const folderRef = useRef<HTMLInputElement | null>(null);
  const archiveRef = useRef<HTMLInputElement | null>(null);
  const prepareRef = useRef<AbortController | null>(null);
  const [preparing, setPreparing] = useState(false);
  const operationRef = useRef<symbol | null>(null);
  const autoResumeRef = useRef(false);
  const uploadAbortRef = useRef<AbortController | null>(null);
  const wasOpenRef = useRef(false);
  const [items, setItems] = useState<ImportItem[]>([]);
  const [tableSettingsKey, setTableSettingsKey] = useState<string | null>(null);
  const tableSettingsItem = items.find((item) => item.key === tableSettingsKey);
  const [knowledgeBaseId, setKnowledgeBaseId] = useState('');
  const [validationError, setValidationError] = useState('');
  const [uploading, setUploading] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [targetLocked, setTargetLocked] = useState(false);
  const [mode, setMode] = useState<'file' | 'text'>('file');
  const [textTitle, setTextTitle] = useState('');
  const [textContent, setTextContent] = useState('');
  const [textFormat, setTextFormat] = useState<'md' | 'txt'>('md');
  const hasTextDraft = Boolean(textTitle || textContent);
  const textBytes = new Blob([textContent]).size;

  useEffect(() => {
    const opening = open && !wasOpenRef.current;
    wasOpenRef.current = open;
    if (!open) {
      prepareRef.current?.abort(); prepareRef.current = null; setPreparing(false);
      uploadAbortRef.current?.abort();
      uploadAbortRef.current = null;
      operationRef.current = null;
      setConfirmDiscard(false);
      return;
    }
    if (!opening) {
      return;
    }

    operationRef.current = null;
    setItems([]);
    setTableSettingsKey(null);
    setValidationError('');
    setUploading(false);
    setConfirmDiscard(false);
    setTargetLocked(false);
    setMode('file'); setTextTitle(''); setTextContent(''); setTextFormat('md');
    setKnowledgeBaseId(
      fixedKnowledgeBaseId
      ?? (knowledgeBases.some((item) => item.id === initialKnowledgeBaseId)
        ? initialKnowledgeBaseId ?? ''
        : ''),
    );
  }, [fixedKnowledgeBaseId, initialKnowledgeBaseId, knowledgeBases, open]);

  useEffect(() => () => {
    prepareRef.current?.abort(); prepareRef.current = null;
    uploadAbortRef.current?.abort();
    uploadAbortRef.current = null;
    operationRef.current = null;
  }, []);

  const failedCount = items.filter((item) => item.status === 'failed').length;
  const pendingCount = items.filter((item) => item.status === 'pending').length;
  const unconfirmedCount = items.filter((item) => item.status === 'unconfirmed').length;
  const uploadCandidates = useMemo(
    () => items.filter((item) => item.status === 'pending' || item.status === 'failed' || item.status === 'unconfirmed'),
    [items],
  );

  useEffect(() => {
    const resume = () => { if (autoResumeRef.current && !operationRef.current) void handleSubmit(); };
    window.addEventListener('online', resume);
    return () => window.removeEventListener('online', resume);
    // The event uses the latest queue and target after an interrupted transfer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, knowledgeBaseId]);

  useUnsavedChangesWarning(open && (preparing || hasTextDraft || items.some((item) => item.status !== 'succeeded')));

  const knowledgeBaseName = (fixedKnowledgeBaseId ? fixedKnowledgeBaseName : undefined) || knowledgeBases.find((item) => item.id === knowledgeBaseId)?.name || '目标知识库';
  useEffect(() => {
    onStateChange?.({
      knowledgeBaseId,
      knowledgeBaseName,
      uploading,
      items: items.map((item) => ({ key: item.key, name: item.file.name, size: item.file.size, status: item.status, progress: item.progress, error: item.error })),
    });
  }, [items, knowledgeBaseId, knowledgeBaseName, uploading, onStateChange]);

  function closeSafely() {
    prepareRef.current?.abort(); prepareRef.current = null; setPreparing(false);
    if (uploading) {
      onMinimize?.();
      return;
    }
    if (items.length > 0 || hasTextDraft) {
      setConfirmDiscard(true);
      return;
    }
    onClose();
  }

  function handleFileInput(event: ChangeEvent<HTMLInputElement>) {
    void addFiles(Array.from(event.target.files ?? []));
    event.target.value = '';
  }

  function handleDrop(event: DragEvent<HTMLButtonElement>) {
    event.preventDefault();
    if (!uploading) {
      void addFiles(Array.from(event.dataTransfer.files));
    }
  }

  async function addFiles(files: File[]) {
    if (uploading || preparing || prepareRef.current || files.length === 0) {
      return;
    }
    const controller = new AbortController(); prepareRef.current = controller; setPreparing(true); setValidationError('');
    let expanded: { files: PreparedImportFile[]; warnings: string[] };
    try {
      expanded = files.some((file) => file.name.toLowerCase().endsWith('.zip'))
        ? await prepareImportFiles(files, upload.maxFileBytes, upload.allowedExtensions, controller.signal)
        : preparePlainImportFiles(files);
      if (controller.signal.aborted) return;
    } catch (caught) {
      if (!controller.signal.aborted) setValidationError(`文件展开失败：${getErrorMessage(caught, 'ZIP 可能损坏、不完整或包含不支持的结构。')}`);
      return;
    } finally { if (prepareRef.current === controller) { prepareRef.current = null; setPreparing(false); } }
    const errors: string[] = [...expanded.warnings];
    const validFiles = expanded.files.filter(({ file, sourcePath }) => {
      const error = validateDocumentFile(file, upload);
      if (error) {
        errors.push(`${sourcePath || file.name}：${error}`);
        return false;
      }
      return true;
    });

    const existingKeys = new Set(items.map((item) => item.key));
    const additions: ImportItem[] = [];
    for (const { file, sourcePath } of validFiles) {
      const key = `${sourcePath ?? ''}:${fileKey(file)}`;
      if (existingKeys.has(key)) { errors.push('已忽略重复选择的文件。'); continue; }
      existingKeys.add(key); additions.push({ file, sourcePath, key, requestId: crypto.randomUUID(), error: '', progress: 0, status: 'pending' });
    }
    if (items.length + additions.length > MAX_IMPORT_FILES || [...items, ...additions].reduce((sum, item) => sum + item.file.size, 0) > MAX_IMPORT_BYTES) {
      setValidationError('导入清单最多 200 个文件，总大小不超过 200 MiB。请分批导入。'); return;
    }
    setItems((current) => [...current, ...additions]);
    setValidationError(errors.join(' '));
  }

  function removeFile(key: string) {
    if (!uploading) {
      setItems((current) => current.filter((item) => item.key !== key));
    }
  }

  async function handleSubmit() {
    if (uploading || preparing || prepareRef.current || operationRef.current) {
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
    const controller = new AbortController();
    operationRef.current = operation;
    uploadAbortRef.current = controller;
    setUploading(true);
    setTargetLocked(true);
    setValidationError('');
    const uploadedDocuments: DocumentItem[] = [];
    let batchCompleteError: unknown;
    let hasFailure = false;
    let hasDuplicate = items.some((item) => item.status === 'duplicate');
    let cancelled = false;
    let hasUnconfirmed = false;
    autoResumeRef.current = false;

    for (const item of uploadCandidates) {
      if (operationRef.current !== operation) {
        return;
      }
      if (controller.signal.aborted) {
        cancelled = true;
        break;
      }
      setItems((current) => updateImportItem(current, item.key, {
        error: '',
        progress: 0,
        status: 'uploading',
      }));
      try {
        const document = await uploadItem(item, (progress) => {
          if (operationRef.current !== operation) return;
          setItems((current) => updateImportItem(current, item.key, {
            progress: clampProgress(progress),
            status: 'uploading',
          }));
        }, controller.signal);
        if (operationRef.current !== operation) {
          return;
        }
        uploadedDocuments.push(document);
        setItems((current) => updateImportItem(current, item.key, {
          error: '',
          progress: 100,
          status: 'succeeded',
        }));
        try { onUploaded?.(document); } catch (error) { batchCompleteError = error; }
      } catch (error) {
        if (operationRef.current !== operation) {
          return;
        }
        if (controller.signal.aborted) {
          hasFailure = true;
          cancelled = true;
          setItems((current) => updateImportItem(current, item.key, {
            error: '上传已停止，可恢复时核对结果并继续。',
            status: 'unconfirmed',
          }));
          break;
        }
        // A duplicate is a question, not a failure, so the batch keeps going and the
        // rest of the files are not held up behind one decision. The choice is made
        // per file after the batch settles.
        const duplicate = duplicateDetails(error);
        if (duplicate) {
          hasDuplicate = true;
          setItems((current) => updateImportItem(current, item.key, {
            duplicate,
            error: '',
            status: 'duplicate',
          }));
          continue;
        }
        if (isUnconfirmedUpload(error)) {
          hasUnconfirmed = true;
          autoResumeRef.current = true;
          setItems((current) => updateImportItem(current, item.key, {
            error: '暂时无法核对上传结果，联网后可恢复上传。',
            status: 'unconfirmed',
          }));
          // Stop this batch on connection uncertainty; do not pile up ambiguous writes.
          break;
        }
        hasFailure = true;
        setItems((current) => updateImportItem(current, item.key, {
          error: documentUploadErrorMessage(error),
          status: error instanceof ApiError && error.code === 'DOCUMENT_UPLOAD_RESULT_UNAVAILABLE' ? 'unavailable' : 'failed',
        }));
      }
    }

    if (operationRef.current !== operation) {
      return;
    }
    try {
      if (uploadedDocuments.length > 0 || cancelled || hasUnconfirmed) {
        await onBatchComplete?.(uploadedDocuments);
      }
    } catch (error) {
      batchCompleteError = error;
    }
    if (operationRef.current !== operation) {
      return;
    }

    operationRef.current = null;
    if (uploadAbortRef.current === controller) uploadAbortRef.current = null;
    setUploading(false);
    if (cancelled) {
      setValidationError(batchCompleteError
        ? '上传已停止，列表刷新失败。恢复上传时会先核对服务器结果。'
        : '上传已停止。恢复上传时会先核对已提交的文件，再继续剩余清单。');
      return;
    }
    if (hasUnconfirmed) {
      setValidationError('暂时无法连接服务器。恢复上传会先核对结果，已成功的文件不会重复创建；网络恢复时会自动继续。');
      return;
    }
    if (hasFailure) {
      if (batchCompleteError) {
        toast.error(getErrorMessage(batchCompleteError, '部分文档已上传，但列表刷新失败'));
      }
      toast.error('部分文档导入失败，请检查后重试。');
      return;
    }
    // Held open on a duplicate: closing would discard the decision the server just
    // asked for, and the file would silently not be imported.
    if (hasDuplicate) {
      if (batchCompleteError) {
        toast.error(getErrorMessage(batchCompleteError, '部分文档已上传，但列表刷新失败'));
      }
      setValidationError('有文件与知识库中已有内容重复，请选择替换或保留两份。');
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

  /**
   * Resolve one duplicate. Both choices go through the same path because both end in
   * a new document row and a list refresh; only the request differs.
   *
   * `keep` re-uploads with the override, `replace` posts to the replace endpoint so
   * the old document is archived with a version trail rather than left as a second
   * copy. Replace needs `onReplace` wired up; without it only `keep` is offered.
   */
  async function resolveDuplicate(item: ImportItem, choice: 'keep' | 'replace') {
    if (uploading || operationRef.current || !item.duplicate) return;
    const existingId = item.duplicate.existingDocumentId;
    const resolvedItem: ImportItem = { ...item, requestId: crypto.randomUUID(), allowDuplicate: choice === 'keep', replaceId: choice === 'replace' ? existingId : undefined };

    const operation = Symbol('duplicate-resolution');
    const controller = new AbortController();
    operationRef.current = operation;
    uploadAbortRef.current = controller;
    setUploading(true);
    setValidationError('');
    setItems((current) => updateImportItem(current, item.key, {
      requestId: resolvedItem.requestId, allowDuplicate: resolvedItem.allowDuplicate, replaceId: resolvedItem.replaceId,
      error: '',
      progress: 0,
      status: 'uploading',
    }));

    const onProgress = (progress: number) => {
      if (operationRef.current !== operation) return;
      setItems((current) => updateImportItem(current, item.key, {
        progress: clampProgress(progress),
        status: 'uploading',
      }));
    };

    try {
      const document = await uploadItem(resolvedItem, onProgress, controller.signal);
      if (operationRef.current !== operation) return;
      setItems((current) => updateImportItem(current, item.key, {
        duplicate: undefined,
        error: '',
        progress: 100,
        status: 'succeeded',
      }));
      // Completion observers may fail independently of the committed upload.
      try {
        onUploaded?.(document);
        await onBatchComplete?.([document]);
      } catch (error) {
        if (operationRef.current === operation) toast.error(getErrorMessage(error, '文档已上传，但列表刷新失败'));
      }
      if (operationRef.current !== operation) return;
      toast.success(choice === 'replace' ? '已替换原文档，正在处理中。' : '已保留两份，正在处理中。');
      // Only the last outstanding row closes the dialog. `items` is the list as of the
      // click, which is accurate here: resolutions are serialised by `uploading`, so
      // no other row can have changed state in the meantime.
      const pendingDuplicate = items.some(
        (other) => other.key !== item.key && other.status === 'duplicate',
      );
      if (pendingDuplicate) {
        setValidationError('还有文件与知识库中已有内容重复，请继续选择。');
        return;
      }
      if (items.some((other) => other.key !== item.key && other.status !== 'succeeded')) {
        return;
      }
      onClose();
    } catch (error) {
      if (operationRef.current !== operation) return;
      if (controller.signal.aborted || isUnconfirmedUpload(error)) {
        setItems((current) => updateImportItem(current, item.key, {
          duplicate: undefined,
          error: '暂时无法核对上传结果，恢复时会继续本次选择。',
          status: 'unconfirmed',
        }));
        autoResumeRef.current = !controller.signal.aborted;
        setValidationError('上传结果待确认。恢复上传会先核对结果，再继续本次替换或保留两份的操作。');
        try { await onBatchComplete?.([]); } catch { /* The result stays unknown even when the list cannot refresh. */ }
        return;
      }
      setItems((current) => updateImportItem(current, item.key, {
        // The conflict details are kept so the row can offer the choice again
        // rather than dropping the user back to a bare failure.
        error: documentUploadErrorMessage(error),
        status: error instanceof ApiError && error.code === 'DOCUMENT_UPLOAD_RESULT_UNAVAILABLE' ? 'unavailable' : 'duplicate',
      }));
    } finally {
      if (operationRef.current === operation) {
        operationRef.current = null;
        if (uploadAbortRef.current === controller) uploadAbortRef.current = null;
        setUploading(false);
      }
    }
  }

  function uploadItem(item: ImportItem, onProgress: (progress: number) => void, signal: AbortSignal) {
    const options: UploadDocumentOptions = { requestId: item.requestId, ...(item.tableImport ? { tableImport: item.tableImport } : {}), ...(item.allowDuplicate ? { allowDuplicate: true } : {}), ...(item.sourcePath ? { sourcePath: item.sourcePath } : {}) };
    return recoverUpload({
      signal, reconcileFirst: item.status === 'unconfirmed',
      onReconciling: () => setItems((current) => updateImportItem(current, item.key, { error: '正在核对服务器上传结果…' })),
      check: () => onCheckUpload(knowledgeBaseId, item.requestId, signal),
      send: () => {
        signal.throwIfAborted();
        if (item.replaceId && onReplace) return onReplace(item.replaceId, item.file, onProgress, signal, options);
        if (item.text) return (onCreateText ?? createTextDocument)(knowledgeBaseId, { ...item.text, requestId: item.requestId, ...(item.allowDuplicate ? { allowDuplicate: true } : {}) }, signal);
        return onUpload(knowledgeBaseId, item.file, onProgress, signal, options);
      },
    });
  }

  function addText() {
    const title = textTitle.trim();
    if (!title || Array.from(title).length > 200) { setValidationError('标题须为 1–200 个字符。'); return; }
    if (!textContent.trim()) { setValidationError('正文不能为空。'); return; }
    if (textBytes > upload.maxFileBytes) { setValidationError('正文大小超过上传限制。'); return; }
    const file = new File([textContent], `${title}.${textFormat}`, { type: MIME_BY_EXTENSION[textFormat] });
    if (items.length >= MAX_IMPORT_FILES || items.reduce((sum, item) => sum + item.file.size, 0) + file.size > MAX_IMPORT_BYTES) { setValidationError('导入清单最多 200 个文件，总大小不超过 200 MiB。'); return; }
    setItems((current) => [...current, { file, text: { title, content: textContent, format: textFormat }, key: `text-${crypto.randomUUID()}`, requestId: crypto.randomUUID(), error: '', progress: 0, status: 'pending' }]);
    setTextTitle(''); setTextContent(''); setValidationError('');
  }

  return (
    <>
      <Dialog
        description={onMinimize ? '确认文件后开始导入，可收起窗口并切换页面。上传和处理进度可从顶部的上传任务查看。' : '选择目标知识库并确认文件后开始导入。文档将在后台处理，完成后即可用于问答。'}
        onClose={closeSafely}
        open={open && !minimized}
        title="导入文档"
      >
      <div className="doc-import">
        {fixedKnowledgeBaseId ? (
          <div className="doc-import__target">
            <span>目标知识库</span>
            <strong>{fixedKnowledgeBaseName || '当前知识库'}</strong>
          </div>
        ) : (
          <Field label="目标知识库">
            <Select
              aria-label="目标知识库"
              data-autofocus
              disabled={uploading || targetLocked || knowledgeBases.length === 0}
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
            </Select>
          </Field>
        )}

        <SegmentedControl
          disabled={uploading || preparing}
          label="导入方式"
          onChange={setMode}
          options={[
            { value: 'file', label: '上传文件' },
            { value: 'text', label: '粘贴文本' },
          ]}
          value={mode}
        />
        {mode === 'text' && <div className="ui-dialog__form">
          <Field label="文档标题"><Input aria-label="文档标题" disabled={uploading} onChange={(event) => setTextTitle(event.target.value)} value={textTitle} /></Field>
          <Field label="文本格式"><Select aria-label="文本格式" disabled={uploading} onChange={(event) => setTextFormat(event.target.value as 'md' | 'txt')} value={textFormat}><option value="md">Markdown</option><option value="txt">纯文本</option></Select></Field>
          <Field label="正文"><Textarea aria-label="正文" disabled={uploading} onChange={(event) => setTextContent(event.target.value)} rows={8} value={textContent} /></Field>
          <p className="ui-muted">{formatDocumentBytes(textBytes)} / {formatDocumentBytes(upload.maxFileBytes)}。加入清单后点击“开始导入”。</p>
          <Button disabled={uploading} onClick={addText} variant="secondary">加入导入清单</Button>
        </div>}
        {mode === 'file' && <><button
          aria-label="拖放或选择文档"
          className="doc-import__dropzone"
          data-autofocus={fixedKnowledgeBaseId ? '' : undefined}
          disabled={uploading || preparing}
          onClick={() => inputRef.current?.click()}
          onDragOver={(event) => event.preventDefault()}
          onDrop={handleDrop}
          type="button"
        >
          <Upload aria-hidden="true" />
          <strong>拖放或选择文档</strong>
          <span>
            支持 {extensionSummary(upload.allowedExtensions)}，单个文件不超过 {formatDocumentBytes(upload.maxFileBytes)}
          </span>
        </button>
        <input
          ref={inputRef}
          accept={`${acceptAttribute(upload.allowedExtensions)},.zip,application/zip`}
          aria-label="选择文档文件"
          className="sr-only"
          disabled={uploading}
          multiple
          onChange={handleFileInput}
          type="file"
        />
        <div className="doc-import__batch-actions">
          <Button variant="secondary" disabled={uploading || preparing} onClick={() => folderRef.current?.click()}>选择文件夹</Button>
          <Button variant="secondary" disabled={uploading || preparing} onClick={() => archiveRef.current?.click()}>选择 ZIP</Button>
          <input ref={folderRef} {...{ webkitdirectory: '', directory: '' }} className="sr-only" type="file" multiple aria-label="选择文档文件夹" disabled={uploading || preparing} onChange={handleFileInput} />
          <input ref={archiveRef} className="sr-only" type="file" accept=".zip,application/zip" aria-label="选择 ZIP 压缩包" disabled={uploading || preparing} onChange={handleFileInput} />
        </div>
        <p className="ui-muted">文件夹与 ZIP 会先展开为清单，保留来源路径。单批最多 200 个文件／200 MiB，不展开嵌套 ZIP。</p>
        <p className="ui-muted">Excel 支持 .xlsx，CSV 请使用 UTF-8。可逐文件设置工作表、表头行和导入列；默认使用全部工作表及首个非空记录作为表头。</p>
        {preparing && <p role="status">正在展开文件… <Button variant="link" onClick={() => { prepareRef.current?.abort(); prepareRef.current = null; setPreparing(false); }}>取消展开</Button></p>}
        </>}

        {validationError && <p className="ui-inline-error" role="alert">{validationError}</p>}

        {items.length > 0 && (
          <div aria-label="待导入文件" className="doc-import__list" role="list">
            {items.map((item) => (
              <article className="doc-import__item" key={item.key} role="listitem">
                <div className="ui-cell-stack">
                  <strong>{item.file.name}</strong>
                  {item.sourcePath && <small className="doc-import__path">{item.sourcePath}</small>}
                  <small>{formatDocumentBytes(item.file.size)}{item.error ? ` · ${item.error}` : ''}</small>
                  {/\.(xlsx|csv)$/i.test(item.file.name) && <div>
                    <Button variant="link" disabled={uploading || !knowledgeBaseId || !['pending', 'failed'].includes(item.status)} onClick={() => setTableSettingsKey(item.key)}>表格导入设置</Button>
                    <small>{item.tableImport ? `已选择 ${item.tableImport.sheets.length} 张表，按设置导入` : '自动识别表头，导入全部列'}</small>
                  </div>}
                  {item.status === 'duplicate' && item.duplicate && (
                    <DuplicateChoice
                      busy={uploading}
                      canReplace={Boolean(onReplace)}
                      details={item.duplicate}
                      filename={item.file.name}
                      onChoose={(choice) => void resolveDuplicate(item, choice)}
                    />
                  )}
                </div>
                <div className={`doc-import__status is-${item.status}`}>
                  {item.status === 'uploading' ? (
                    <div className="doc-import__upload-progress">
                      <div
                        aria-label={`${item.file.name} 上传进度`}
                        aria-valuemax={100}
                        aria-valuemin={0}
                        aria-valuenow={item.progress}
                        className="ui-progress"
                        role="progressbar"
                      >
                        <span className="ui-progress__fill" style={{ width: `${item.progress}%` }} />
                      </div>
                      <span className="ui-num">{item.progress}%</span>
                    </div>
                  ) : (
                    <span>{importStatusLabel(item.status)}</span>
                  )}
                  {item.status !== 'uploading' && item.status !== 'succeeded' && (
                    <IconButton
                      disabled={uploading}
                      label={`移除 ${item.file.name}`}
                      onClick={() => removeFile(item.key)}
                    >
                      <X aria-hidden="true" />
                    </IconButton>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}

        <div className="ui-dialog__actions">
          {onMinimize && <Button leadingIcon={<Minimize2 aria-hidden="true" />} onClick={onMinimize} variant="ghost">{uploading ? '后台继续' : '收起窗口'}</Button>}
          {uploading ? (
            <Button
              leadingIcon={<Square aria-hidden="true" />}
              onClick={() => uploadAbortRef.current?.abort()}
              variant="secondary"
            >
              停止上传
            </Button>
          ) : (
            <>
              <Button onClick={closeSafely} variant="secondary">取消</Button>
              <Button
                disabled={preparing || !knowledgeBaseId || hasTextDraft || (pendingCount === 0 && failedCount === 0 && unconfirmedCount === 0)}
                onClick={() => void handleSubmit()}
              >
                {unconfirmedCount > 0 ? '恢复上传' : failedCount > 0 && pendingCount === 0 ? '重试失败项' : '开始导入'}
              </Button>
            </>
          )}
        </div>
      </div>
      </Dialog>
      {tableSettingsItem && !minimized && <TableImportSettingsDialog
        key={tableSettingsItem.key}
        file={tableSettingsItem.file}
        knowledgeBaseId={knowledgeBaseId}
        initial={tableSettingsItem.tableImport}
        onClose={() => setTableSettingsKey(null)}
        onApply={(tableImport) => {
          setItems((current) => updateImportItem(current, tableSettingsItem.key, { tableImport, requestId: crypto.randomUUID(), status: 'pending', error: '', duplicate: undefined, allowDuplicate: undefined, replaceId: undefined }));
          setTableSettingsKey(null);
        }}
      />}
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
