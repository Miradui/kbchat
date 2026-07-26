import { ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';

import {
  batchDeleteDocuments,
  batchReprocessDocuments,
  deleteDocument,
  getKnowledgeBase,
  listDocuments,
  listKnowledgeBases,
  reprocessDocument,
  uploadDocument,
} from '../../api/resources';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';
import { WorkspaceShell } from '../../components/WorkspaceShell';
import { DocumentDetailDrawer } from './DocumentDetailDrawer';
import { DocumentProgress } from './DocumentProgress';
import { DocumentRecycleBinDrawer } from './DocumentRecycleBinDrawer';
import {
  documentStatuses,
  documentStatusClass,
  documentStatusLabel,
  formatDocumentBytes,
  formatDocumentDateTime,
  isTerminalDocumentStatus,
} from './documentDisplay';
import type {
  DocumentItem,
  DocumentStatus,
  KnowledgeBase,
} from '../../types/api';
import { getDocumentProcessingErrorMessage, getErrorMessage } from '../../utils/errors';

const statusOptions: Array<DocumentStatus | 'all'> = [
  'all',
  ...documentStatuses,
];
const pipelineStatuses = documentStatuses;

type DeleteTarget =
  | { kind: 'single'; document: DocumentItem }
  | { kind: 'batch'; ids: string[] };

export function DocumentsPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const uploadButtonRef = useRef<HTMLButtonElement | null>(null);
  const activeKnowledgeBaseIdRef = useRef(id);
  const loadRequestRef = useRef(0);
  const documentDataRequestRef = useRef(0);
  const uploadOperationRef = useRef<symbol | null>(null);
  const reprocessOperationRef = useRef<symbol | null>(null);
  const submitOperationRef = useRef<symbol | null>(null);
  const mutationOperationRef = useRef<symbol | null>(null);
  const [knowledgeBase, setKnowledgeBase] = useState<KnowledgeBase | null>(null);
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([]);
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [deleteError, setDeleteError] = useState('');
  const [statusFilter, setStatusFilter] = useState<DocumentStatus | 'all'>('all');
  const [typeFilter, setTypeFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [workingId, setWorkingId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [showRecycleBin, setShowRecycleBin] = useState(false);
  const [uploadFlowActive, setUploadFlowActive] = useState(
    () => searchParams.get('intent') === 'upload',
  );
  const [trackedUploadId, setTrackedUploadId] = useState<string | null>(null);
  const detailDocumentId = searchParams.get('documentId');
  const detailChunkId = searchParams.get('chunkId') ?? undefined;
  activeKnowledgeBaseIdRef.current = id;

  useEffect(() => {
    loadRequestRef.current += 1;
    documentDataRequestRef.current += 1;
    setKnowledgeBase(null);
    setDocuments([]);
    setSelectedIds([]);
    setDeleteTarget(null);
    setDeleteError('');
    setLoadError('');
    setError('');
    setTrackedUploadId(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
    uploadOperationRef.current = null;
    reprocessOperationRef.current = null;
    submitOperationRef.current = null;
    mutationOperationRef.current = null;
    setUploading(false);
    setWorkingId(null);
    setSubmitting(false);
    setUploadFlowActive(searchParams.get('intent') === 'upload');
  }, [id]);

  useEffect(() => {
    if (searchParams.get('intent') !== 'upload') {
      return;
    }

    setUploadFlowActive(true);
    uploadButtonRef.current?.focus();
    const nextSearchParams = new URLSearchParams(searchParams);
    nextSearchParams.delete('intent');
    setSearchParams(nextSearchParams, { replace: true });
  }, [searchParams, setSearchParams]);

  const loadPage = useCallback(async () => {
    if (!id) {
      return;
    }

    const requestedKnowledgeBaseId = id;
    if (activeKnowledgeBaseIdRef.current !== requestedKnowledgeBaseId) {
      return;
    }
    const request = ++loadRequestRef.current;
    const documentRequest = ++documentDataRequestRef.current;
    setLoading(true);
    setLoadError('');
    try {
      const [kb, docs, kbList] = await Promise.all([
        getKnowledgeBase(requestedKnowledgeBaseId),
        listDocuments(requestedKnowledgeBaseId),
        listKnowledgeBases({ pageSize: 100 }),
      ]);
      if (
        activeKnowledgeBaseIdRef.current !== requestedKnowledgeBaseId
        || loadRequestRef.current !== request
      ) {
        return;
      }
      setKnowledgeBase(kb);
      if (documentDataRequestRef.current === documentRequest) {
        setDocuments(docs.items);
        setSelectedIds((current) => current.filter((docId) => docs.items.some((doc) => doc.id === docId)));
      }
      setKnowledgeBases(kbList.items);
    } catch (err) {
      if (
        activeKnowledgeBaseIdRef.current === requestedKnowledgeBaseId
        && loadRequestRef.current === request
      ) {
        setLoadError(errorMessage(err, '文档列表加载失败'));
      }
    } finally {
      if (
        activeKnowledgeBaseIdRef.current === requestedKnowledgeBaseId
        && loadRequestRef.current === request
      ) {
        setLoading(false);
      }
    }
  }, [id]);

  useEffect(() => {
    void loadPage();

    return () => {
      loadRequestRef.current += 1;
      documentDataRequestRef.current += 1;
      uploadOperationRef.current = null;
      reprocessOperationRef.current = null;
      submitOperationRef.current = null;
      mutationOperationRef.current = null;
    };
  }, [loadPage]);

  const hasProcessingDocuments = useMemo(
    () => documents.some((document) => !isTerminalDocumentStatus(document.status)),
    [documents],
  );

  useEffect(() => {
    if (!hasProcessingDocuments || !id) {
      return;
    }

    const timer = window.setInterval(() => {
      const requestedKnowledgeBaseId = id;
      const request = ++documentDataRequestRef.current;
      listDocuments(requestedKnowledgeBaseId)
        .then((response) => {
          if (
            activeKnowledgeBaseIdRef.current === requestedKnowledgeBaseId
            && documentDataRequestRef.current === request
          ) {
            setDocuments(response.items);
          }
        })
        .catch((err) => {
          if (
            activeKnowledgeBaseIdRef.current === requestedKnowledgeBaseId
            && documentDataRequestRef.current === request
          ) {
            setError(errorMessage(err, '文档状态刷新失败'));
          }
        });
    }, 3000);

    return () => window.clearInterval(timer);
  }, [hasProcessingDocuments, id]);

  const filteredDocuments = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return documents.filter((document) => {
      const matchesStatus = statusFilter === 'all' || document.status === statusFilter;
      const matchesType = typeFilter === 'all' || document.fileType === typeFilter;
      const matchesQuery =
        normalizedQuery === '' || document.filename.toLowerCase().includes(normalizedQuery);
      return matchesStatus && matchesType && matchesQuery;
    });
  }, [documents, query, statusFilter, typeFilter]);

  const fileTypes = useMemo(
    () => Array.from(new Set(documents.map((document) => document.fileType).filter(Boolean))).sort(),
    [documents],
  );

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const completedCount = documents.filter((document) => document.status === 'completed').length;
  const failedCount = documents.filter((document) => document.status === 'failed').length;
  const processingCount = documents.filter((document) => !isTerminalDocumentStatus(document.status)).length;
  const documentMetricsKnown = documents.length > 0 || (!loading && !loadError);
  const allVisibleSelected =
    filteredDocuments.length > 0 && filteredDocuments.every((document) => selectedSet.has(document.id));
  const activeFilterCount = [
    query.trim(),
    statusFilter !== 'all' ? statusFilter : '',
    typeFilter !== 'all' ? typeFilter : '',
  ].filter(Boolean).length;
  const trackedDocument = trackedUploadId
    ? documents.find((document) => document.id === trackedUploadId) ?? null
    : null;
  const documentMutationBusy = uploading || Boolean(workingId) || submitting;

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file || !id || uploadOperationRef.current || mutationOperationRef.current) {
      return;
    }

    const operation = Symbol('upload-document');
    const uploadKnowledgeBaseId = id;
    uploadOperationRef.current = operation;
    mutationOperationRef.current = operation;
    setUploading(true);
    setError('');

    try {
      const uploadedDocument = await uploadDocument(uploadKnowledgeBaseId, file);
      if (
        activeKnowledgeBaseIdRef.current !== uploadKnowledgeBaseId
        || uploadOperationRef.current !== operation
      ) {
        return;
      }
      setTrackedUploadId(uploadedDocument.id);
      setUploadFlowActive(true);
      setDocuments((current) => [
        uploadedDocument,
        ...current.filter((document) => document.id !== uploadedDocument.id),
      ]);
    } catch (err) {
      if (
        activeKnowledgeBaseIdRef.current === uploadKnowledgeBaseId
        && uploadOperationRef.current === operation
      ) {
        setError(errorMessage(err, '文档上传失败'));
      }
    } finally {
      if (
        activeKnowledgeBaseIdRef.current === uploadKnowledgeBaseId
        && uploadOperationRef.current === operation
        && mutationOperationRef.current === operation
      ) {
        uploadOperationRef.current = null;
        mutationOperationRef.current = null;
        setUploading(false);
        event.target.value = '';
      }
    }
  }

  async function handleReprocess(document: DocumentItem) {
    if (!id || reprocessOperationRef.current || mutationOperationRef.current) {
      return;
    }

    const requestedKnowledgeBaseId = id;
    const operation = Symbol('reprocess-document');
    reprocessOperationRef.current = operation;
    mutationOperationRef.current = operation;
    setWorkingId(document.id);
    setError('');

    try {
      await reprocessDocument(document.id);
      if (
        activeKnowledgeBaseIdRef.current === requestedKnowledgeBaseId
        && reprocessOperationRef.current === operation
      ) {
        await loadPage();
      }
    } catch (err) {
      if (
        activeKnowledgeBaseIdRef.current === requestedKnowledgeBaseId
        && reprocessOperationRef.current === operation
      ) {
        setError(errorMessage(err, '文档重处理失败'));
      }
    } finally {
      if (
        reprocessOperationRef.current === operation
        && mutationOperationRef.current === operation
      ) {
        reprocessOperationRef.current = null;
        mutationOperationRef.current = null;
        setWorkingId(null);
      }
    }
  }

  async function handleBatchReprocess() {
    if (!id || selectedIds.length === 0 || submitOperationRef.current || mutationOperationRef.current) {
      return;
    }

    const requestedKnowledgeBaseId = id;
    const operation = Symbol('batch-reprocess-documents');
    submitOperationRef.current = operation;
    mutationOperationRef.current = operation;
    setSubmitting(true);
    setError('');

    try {
      await batchReprocessDocuments(selectedIds);
      if (
        activeKnowledgeBaseIdRef.current === requestedKnowledgeBaseId
        && submitOperationRef.current === operation
      ) {
        await loadPage();
      }
    } catch (err) {
      if (
        activeKnowledgeBaseIdRef.current === requestedKnowledgeBaseId
        && submitOperationRef.current === operation
      ) {
        setError(errorMessage(err, '批量重处理失败'));
      }
    } finally {
      if (
        submitOperationRef.current === operation
        && mutationOperationRef.current === operation
      ) {
        submitOperationRef.current = null;
        mutationOperationRef.current = null;
        setSubmitting(false);
      }
    }
  }

  async function handleDelete() {
    if (!id || !deleteTarget || submitOperationRef.current || mutationOperationRef.current) {
      return;
    }

    const requestedKnowledgeBaseId = id;
    const operation = Symbol('delete-documents');
    submitOperationRef.current = operation;
    mutationOperationRef.current = operation;
    setSubmitting(true);
    setError('');
    setDeleteError('');

    try {
      if (deleteTarget.kind === 'single') {
        await deleteDocument(deleteTarget.document.id);
      } else {
        await batchDeleteDocuments(deleteTarget.ids);
      }
      if (
        activeKnowledgeBaseIdRef.current === requestedKnowledgeBaseId
        && submitOperationRef.current === operation
      ) {
        setDeleteError('');
        setDeleteTarget(null);
        await loadPage();
      }
    } catch (err) {
      if (
        activeKnowledgeBaseIdRef.current === requestedKnowledgeBaseId
        && submitOperationRef.current === operation
      ) {
        setDeleteError(errorMessage(err, '文档删除失败'));
      }
    } finally {
      if (
        submitOperationRef.current === operation
        && mutationOperationRef.current === operation
      ) {
        submitOperationRef.current = null;
        mutationOperationRef.current = null;
        setSubmitting(false);
      }
    }
  }

  function toggleSelected(documentId: string) {
    setSelectedIds((current) =>
      current.includes(documentId)
        ? current.filter((item) => item !== documentId)
        : [...current, documentId],
    );
  }

  function openDeleteTarget(target: DeleteTarget) {
    setDeleteError('');
    setDeleteTarget(target);
  }

  function toggleAllVisible() {
    const visibleIds = filteredDocuments.map((document) => document.id);
    setSelectedIds(allVisibleSelected ? [] : visibleIds);
  }

  function openDocumentDetail(documentId: string) {
    if (mutationOperationRef.current) {
      return;
    }
    const nextSearchParams = new URLSearchParams(searchParams);
    nextSearchParams.set('documentId', documentId);
    nextSearchParams.delete('chunkId');
    setSearchParams(nextSearchParams);
  }

  function closeDocumentDetail() {
    const nextSearchParams = new URLSearchParams(searchParams);
    nextSearchParams.delete('documentId');
    nextSearchParams.delete('chunkId');
    setSearchParams(nextSearchParams, { replace: true });
  }

  function openRecycleBin() {
    if (mutationOperationRef.current) {
      return;
    }
    setShowRecycleBin(true);
  }

  return (
    <WorkspaceShell active="documents">
      <div className="documents-workspace-page">
        <section className="document-command-band document-kb-band">
          <div className="document-command-main">
            <p className="breadcrumb">
              知识库 / {knowledgeBase?.name ?? '加载中'} / 文档管理
            </p>
            <h1>{knowledgeBase?.name ?? '文档管理'}</h1>
            <p className="page-description">
              管理当前知识库的上传、解析、切分和向量化队列。存在处理中任务时，页面会每 3 秒刷新状态。
            </p>
          </div>
          <div className="document-command-aside" aria-label="当前知识库操作">
            <span className="document-aside-label">当前知识库</span>
            <label className="document-target-select">
              <select
                value={id ?? ''}
                disabled={documentMutationBusy}
                onChange={(event) => navigate(`/knowledge-bases/${event.target.value}/documents`)}
              >
                {knowledgeBases.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="document-command-actions">
              {id && (
                <Link className="secondary-link" to={`/knowledge-bases/${id}`}>
                  返回详情
                </Link>
              )}
              <button
                ref={uploadButtonRef}
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={documentMutationBusy}
              >
                {uploading ? '上传中...' : '上传文档'}
              </button>
            </div>
            <input
              ref={fileInputRef}
              accept=".txt,.md,.pdf,text/plain,text/markdown,application/pdf"
              hidden
              type="file"
              onChange={handleFileChange}
            />
          </div>
        </section>

        {uploadFlowActive && (
          <section
            aria-label="文档导入进度"
            className={`document-upload-flow${trackedDocument?.status === 'completed' ? ' is-complete' : ''}`}
            role="status"
          >
            <div>
              <span className="document-aside-label">下一步</span>
              <strong>
                {!trackedDocument
                  ? '上传第一个文档'
                  : trackedDocument.status === 'completed'
                    ? '文档已可用于问答'
                    : trackedDocument.status === 'failed'
                      ? '文档处理失败'
                      : `正在处理 ${trackedDocument.filename}`}
              </strong>
              <p>
                {!trackedDocument
                  ? '选择 txt、md 或 pdf 文件，系统会自动完成解析、切分和向量化。'
                  : trackedDocument.status === 'completed'
                    ? `${trackedDocument.filename} 已完成向量化，可以基于这份文档开始提问。`
                    : trackedDocument.status === 'failed'
                      ? '请查看处理提示并重试，或重新上传一份文档。'
                      : `当前阶段：${documentStatusLabel(trackedDocument.status)}。页面会自动刷新处理结果。`}
              </p>
            </div>
            {!trackedDocument && (
              <button type="button" onClick={() => fileInputRef.current?.click()} disabled={documentMutationBusy}>
                {uploading ? '上传中...' : '选择文件'}
              </button>
            )}
            {trackedDocument?.status === 'completed' && id && (
              <Link className="button-link" to={`/chat/new?knowledgeBaseId=${id}`}>
                开始问答
              </Link>
            )}
          </section>
        )}

        <section className="document-pipeline-panel">
          <div className="document-pipeline-copy">
            <span className="document-aside-label">处理流水线</span>
            <strong>上传后自动进入解析队列</strong>
            <p>支持 txt、md、pdf，完成向量化后即可在搜索和问答中引用。</p>
          </div>
          <div className="document-pipeline-steps" aria-label="文档处理阶段">
            {pipelineStatuses.map((status) => (
              <span key={status}>{documentStatusLabel(status)}</span>
            ))}
          </div>
        </section>

        <div className="document-status-strip">
          <MetricCard label="文档总数" value={documentMetricsKnown ? documents.length : '--'} />
          <MetricCard label="已完成" value={documentMetricsKnown ? completedCount : '--'} tone="success" />
          <MetricCard label="处理中" value={documentMetricsKnown ? processingCount : '--'} tone="warning" />
          <MetricCard label="失败" value={documentMetricsKnown ? failedCount : '--'} tone="danger" />
        </div>

        {error && <p className="document-alert error-text" role="alert">{error}</p>}

        <div className="panel document-list-panel">
          <div className="panel-header document-list-header">
            <div>
              <h2>处理队列</h2>
              <p>
                当前显示 {filteredDocuments.length} / {documents.length} 个文档
                {activeFilterCount > 0 ? `，已启用 ${activeFilterCount} 个筛选` : ''}
              </p>
            </div>
            <button className="secondary-button" type="button" onClick={() => void loadPage()}>
              刷新
            </button>
            <button
              className="secondary-button"
              type="button"
              onClick={openRecycleBin}
              disabled={documentMutationBusy}
            >
              文档回收站
            </button>
          </div>

          <div className="document-filter-bar">
            <input
              aria-label="按文件名搜索"
              placeholder="搜索文件名"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <select
              aria-label="状态筛选"
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value as DocumentStatus | 'all')}
            >
              {statusOptions.map((status) => (
                <option key={status} value={status}>
                  {status === 'all' ? '全部状态' : documentStatusLabel(status)}
                </option>
              ))}
            </select>
            <select
              aria-label="文件类型筛选"
              value={typeFilter}
              onChange={(event) => setTypeFilter(event.target.value)}
            >
              <option value="all">全部类型</option>
              {fileTypes.map((fileType) => (
                <option key={fileType} value={fileType}>
                  {fileType}
                </option>
              ))}
            </select>
          </div>

          {selectedIds.length > 0 && (
            <div className="document-selection-bar">
              <span>已选择 {selectedIds.length} 个文档</span>
              <button
                className="secondary-button"
                type="button"
                onClick={() => void handleBatchReprocess()}
                disabled={documentMutationBusy}
              >
                批量重处理
              </button>
              <button
                className="danger-button"
                type="button"
                onClick={() => openDeleteTarget({ kind: 'batch', ids: selectedIds })}
                disabled={documentMutationBusy}
              >
                批量删除
              </button>
            </div>
          )}
        {loading ? (
          <LoadingSkeleton rows={4} columns={8} announce />
        ) : loadError ? (
          <div className="empty-state" role="alert">
            <p>{loadError}</p>
            <button className="secondary-button" type="button" onClick={() => void loadPage()}>
              重试加载
            </button>
          </div>
        ) : filteredDocuments.length === 0 ? (
          <div className="empty-state">当前筛选下没有文档。上传 txt、md 或 pdf 后开始处理。</div>
        ) : (
          <div className="table-wrap">
            <table className="data-table document-table">
              <thead>
                <tr>
                  <th>
                    <input
                      aria-label="选择当前筛选下全部文档"
                      checked={allVisibleSelected}
                      type="checkbox"
                      onChange={toggleAllVisible}
                    />
                  </th>
                  <th>文件名</th>
                  <th>类型</th>
                  <th>大小</th>
                  <th>状态</th>
                  <th>处理提示</th>
                  <th>更新时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {filteredDocuments.map((document) => (
                  <tr key={document.id}>
                    <td data-label="选择">
                      <input
                        aria-label={`选择 ${document.filename}`}
                        checked={selectedSet.has(document.id)}
                        type="checkbox"
                        onChange={() => toggleSelected(document.id)}
                      />
                    </td>
                    <td className="table-title" data-label="文件名">
                      <span className="document-name-cell">
                        <span className="document-file-icon" aria-hidden="true" />
                        {document.filename}
                      </span>
                    </td>
                    <td data-label="类型">{document.fileType}</td>
                    <td data-label="大小">{formatDocumentBytes(document.fileSize)}</td>
                    <td data-label="状态">
                      <span className={`status-pill status-${documentStatusClass(document.status)}`}>
                        {documentStatusLabel(document.status)}
                      </span>
                      <DocumentProgress compact document={document} />
                    </td>
                    <td data-label="处理提示">
                      {document.status === 'failed'
                        ? getDocumentProcessingErrorMessage(document.errorMessage)
                        : '-'}
                    </td>
                    <td data-label="更新时间">{formatDocumentDateTime(document.updatedAt || document.createdAt)}</td>
                    <td data-label="操作">
                      <div className="table-actions">
                        <button
                          className="link-button"
                          type="button"
                          onClick={() => openDocumentDetail(document.id)}
                          disabled={documentMutationBusy}
                        >
                          查看
                        </button>
                        <button
                          className="link-button"
                          type="button"
                          onClick={() => void handleReprocess(document)}
                          disabled={documentMutationBusy || !isTerminalDocumentStatus(document.status)}
                        >
                          重处理
                        </button>
                        <button
                          className="link-button"
                          type="button"
                          onClick={() => openDeleteTarget({ kind: 'single', document })}
                          disabled={documentMutationBusy}
                        >
                          删除
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {deleteTarget && (
        <ConfirmDialog
          title={deleteTarget.kind === 'single' ? '删除文档' : '批量删除文档'}
          description={
            deleteTarget.kind === 'single'
              ? `确认删除“${deleteTarget.document.filename}”？`
              : `确认删除选中的 ${deleteTarget.ids.length} 个文档？`
          }
          confirmLabel="删除"
          busy={submitting}
          error={deleteError}
          onCancel={() => {
            setDeleteError('');
            setDeleteTarget(null);
          }}
          onConfirm={handleDelete}
        />
      )}

      {detailDocumentId && (
        <DocumentDetailDrawer
          chunkId={detailChunkId}
          documentId={detailDocumentId}
          knowledgeBaseId={id}
          knowledgeBaseName={knowledgeBase?.name}
          onChanged={() => void loadPage()}
          onClose={closeDocumentDetail}
        />
      )}

      {showRecycleBin && (
        <DocumentRecycleBinDrawer
          onChanged={() => void loadPage()}
          onClose={() => setShowRecycleBin(false)}
        />
      )}
      </div>
    </WorkspaceShell>
  );
}

function MetricCard({ label, value, tone }: { label: string; value: number | string; tone?: 'success' | 'warning' | 'danger' }) {
  return (
    <div className={tone ? `document-status-tile document-status-${tone}` : 'document-status-tile'}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function errorMessage(err: unknown, fallback: string): string {
  return getErrorMessage(err, fallback);
}
