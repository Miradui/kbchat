import { ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import {
  batchDeleteDocuments,
  batchReprocessDocuments,
  deleteDocument,
  getKnowledgeBase,
  getWorkspacePreference,
  listDocuments,
  listKnowledgeBaseCategories,
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
import type {
  DocumentItem,
  DocumentStatus,
  KnowledgeBase,
  KnowledgeBaseCategory,
  KnowledgeBaseWorkspacePreference,
} from '../../types/api';
import { getDocumentProcessingErrorMessage, getErrorMessage } from '../../utils/errors';

const terminalStatuses: DocumentStatus[] = ['completed', 'failed'];
const statusOptions: Array<DocumentStatus | 'all'> = [
  'all',
  'uploaded',
  'parsing',
  'chunking',
  'embedding',
  'completed',
  'failed',
];
const pipelineStatuses: DocumentStatus[] = ['uploaded', 'parsing', 'chunking', 'embedding', 'completed', 'failed'];

type DeleteTarget =
  | { kind: 'single'; document: DocumentItem }
  | { kind: 'batch'; ids: string[] };

const fallbackPreference: KnowledgeBaseWorkspacePreference = {
  viewMode: 'table',
  scope: 'all',
  sort: 'updatedAt_desc',
  visibility: 'all',
  expandedCategoryIds: [],
};

export function DocumentsPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const activeKnowledgeBaseIdRef = useRef(id);
  const pageRequestIdRef = useRef(0);
  const pollRequestIdRef = useRef(0);
  activeKnowledgeBaseIdRef.current = id;
  const [categories, setCategories] = useState<KnowledgeBaseCategory[]>([]);
  const [expandedIds, setExpandedIds] = useState<string[]>([]);
  const [knowledgeBase, setKnowledgeBase] = useState<KnowledgeBase | null>(null);
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([]);
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [statusFilter, setStatusFilter] = useState<DocumentStatus | 'all'>('all');
  const [typeFilter, setTypeFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [workingId, setWorkingId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [detailDocumentId, setDetailDocumentId] = useState<string | null>(null);
  const [showRecycleBin, setShowRecycleBin] = useState(false);

  const loadPage = useCallback(async () => {
    if (!id) {
      return;
    }

    const targetKnowledgeBaseId = id;
    const requestId = pageRequestIdRef.current + 1;
    pageRequestIdRef.current = requestId;
    pollRequestIdRef.current += 1;
    const isCurrentRequest = () =>
      pageRequestIdRef.current === requestId && activeKnowledgeBaseIdRef.current === targetKnowledgeBaseId;
    setError('');
    const responses = await Promise.all([
      getKnowledgeBase(targetKnowledgeBaseId),
      listDocuments(targetKnowledgeBaseId),
      listKnowledgeBases({ pageSize: 100 }),
    ]).catch((err) => {
      if (isCurrentRequest()) {
        throw err;
      }
      return null;
    });
    if (!responses || !isCurrentRequest()) {
      return;
    }
    const [kb, docs, kbList] = responses;
    setKnowledgeBase(kb);
    setDocuments(docs.items);
    setKnowledgeBases(kbList.items);
    setSelectedIds((current) => current.filter((docId) => docs.items.some((doc) => doc.id === docId)));
  }, [id]);

  useEffect(() => {
    let mounted = true;
    pollRequestIdRef.current += 1;
    setKnowledgeBase(null);
    setDocuments([]);
    setSelectedIds([]);
    setLoading(true);

    loadPage()
      .catch((err) => {
        if (mounted) {
          setError(errorMessage(err, '文档列表加载失败'));
        }
      })
      .finally(() => {
        if (mounted) {
          setLoading(false);
        }
      });

    return () => {
      mounted = false;
    };
  }, [loadPage]);

  useEffect(() => {
    let mounted = true;

    Promise.all([
      listKnowledgeBaseCategories().catch(() => ({ items: [] })),
      getWorkspacePreference().catch(() => fallbackPreference),
    ]).then(([categoryResponse, preference]) => {
      if (!mounted) {
        return;
      }
      setCategories(categoryResponse.items);
      setExpandedIds(preference.expandedCategoryIds);
    });

    return () => {
      mounted = false;
    };
  }, []);

  const hasProcessingDocuments = useMemo(
    () => documents.some((document) => !terminalStatuses.includes(document.status)),
    [documents],
  );

  useEffect(() => {
    if (!hasProcessingDocuments || !id) {
      return;
    }

    const timer = window.setInterval(() => {
      const targetKnowledgeBaseId = id;
      const requestId = pollRequestIdRef.current + 1;
      const pageRequestId = pageRequestIdRef.current;
      pollRequestIdRef.current = requestId;
      const isCurrentRequest = () =>
        pollRequestIdRef.current === requestId
        && pageRequestIdRef.current === pageRequestId
        && activeKnowledgeBaseIdRef.current === targetKnowledgeBaseId;
      listDocuments(targetKnowledgeBaseId)
        .then((response) => {
          if (isCurrentRequest()) {
            setDocuments(response.items);
          }
        })
        .catch((err) => {
          if (isCurrentRequest()) {
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
  const processingCount = documents.filter((document) => !terminalStatuses.includes(document.status)).length;
  const allVisibleSelected =
    filteredDocuments.length > 0 && filteredDocuments.every((document) => selectedSet.has(document.id));
  const activeFilterCount = [
    query.trim(),
    statusFilter !== 'all' ? statusFilter : '',
    typeFilter !== 'all' ? typeFilter : '',
  ].filter(Boolean).length;

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file || !id) {
      return;
    }

    setUploading(true);
    setError('');

    try {
      await uploadDocument(id, file);
      await loadPage();
    } catch (err) {
      setError(errorMessage(err, '文档上传失败'));
    } finally {
      setUploading(false);
      event.target.value = '';
    }
  }

  async function handleReprocess(document: DocumentItem) {
    setWorkingId(document.id);
    setError('');

    try {
      await reprocessDocument(document.id);
      await loadPage();
    } catch (err) {
      setError(errorMessage(err, '文档重处理失败'));
    } finally {
      setWorkingId(null);
    }
  }

  async function handleBatchReprocess() {
    if (selectedIds.length === 0) {
      return;
    }

    setSubmitting(true);
    setError('');

    try {
      await batchReprocessDocuments(selectedIds);
      await loadPage();
    } catch (err) {
      setError(errorMessage(err, '批量重处理失败'));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) {
      return;
    }

    setSubmitting(true);
    setError('');

    try {
      if (deleteTarget.kind === 'single') {
        await deleteDocument(deleteTarget.document.id);
      } else {
        await batchDeleteDocuments(deleteTarget.ids);
      }
      setDeleteTarget(null);
      await loadPage();
    } catch (err) {
      setError(errorMessage(err, '文档删除失败'));
    } finally {
      setSubmitting(false);
    }
  }

  function toggleSelected(documentId: string) {
    setSelectedIds((current) =>
      current.includes(documentId)
        ? current.filter((item) => item !== documentId)
        : [...current, documentId],
    );
  }

  function toggleAllVisible() {
    const visibleIds = filteredDocuments.map((document) => document.id);
    setSelectedIds(allVisibleSelected ? [] : visibleIds);
  }

  return (
    <WorkspaceShell active="documents" categories={categories} expandedIds={expandedIds}>
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
              <button type="button" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
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

        <section className="document-pipeline-panel">
          <div className="document-pipeline-copy">
            <span className="document-aside-label">处理流水线</span>
            <strong>上传后自动进入解析队列</strong>
            <p>支持 txt、md、pdf，完成向量化后即可在搜索和问答中引用。</p>
          </div>
          <div className="document-pipeline-steps" aria-label="文档处理阶段">
            {pipelineStatuses.map((status) => (
              <span key={status}>{statusLabel(status)}</span>
            ))}
          </div>
        </section>

        <div className="document-status-strip">
          <MetricCard label="文档总数" value={documents.length} />
          <MetricCard label="已完成" value={completedCount} tone="success" />
          <MetricCard label="处理中" value={processingCount} tone="warning" />
          <MetricCard label="失败" value={failedCount} tone="danger" />
        </div>

        {error && <p className="document-alert error-text">{error}</p>}

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
            <button className="secondary-button" type="button" onClick={() => setShowRecycleBin(true)}>
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
                  {status === 'all' ? '全部状态' : statusLabel(status)}
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
                disabled={submitting}
              >
                批量重处理
              </button>
              <button
                className="danger-button"
                type="button"
                onClick={() => setDeleteTarget({ kind: 'batch', ids: selectedIds })}
                disabled={submitting}
              >
                批量删除
              </button>
            </div>
          )}
        {loading ? (
          <LoadingSkeleton rows={4} columns={8} />
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
                    <td data-label="大小">{formatBytes(document.fileSize)}</td>
                    <td data-label="状态">
                      <span className={`status-pill status-${statusClass(document.status)}`}>
                        {statusLabel(document.status)}
                      </span>
                      <DocumentProgress compact document={document} />
                    </td>
                    <td data-label="处理提示">
                      {document.status === 'failed'
                        ? getDocumentProcessingErrorMessage(document.errorMessage)
                        : '-'}
                    </td>
                    <td data-label="更新时间">{formatDateTime(document.updatedAt || document.createdAt)}</td>
                    <td data-label="操作">
                      <div className="table-actions">
                        <button
                          className="link-button"
                          type="button"
                          onClick={() => setDetailDocumentId(document.id)}
                        >
                          查看
                        </button>
                        <button
                          className="link-button"
                          type="button"
                          onClick={() => void handleReprocess(document)}
                          disabled={workingId === document.id || !terminalStatuses.includes(document.status)}
                        >
                          重处理
                        </button>
                        <button
                          className="link-button"
                          type="button"
                          onClick={() => setDeleteTarget({ kind: 'single', document })}
                          disabled={workingId === document.id}
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
          onCancel={() => setDeleteTarget(null)}
          onConfirm={handleDelete}
        />
      )}

      {detailDocumentId && (
        <DocumentDetailDrawer
          documentId={detailDocumentId}
          knowledgeBaseName={knowledgeBase?.name}
          onChanged={() => void loadPage()}
          onClose={() => setDetailDocumentId(null)}
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

function MetricCard({ label, value, tone }: { label: string; value: number; tone?: 'success' | 'warning' | 'danger' }) {
  return (
    <div className={tone ? `document-status-tile document-status-${tone}` : 'document-status-tile'}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function statusClass(status: DocumentStatus): string {
  if (status === 'completed' || status === 'failed') {
    return status;
  }
  return 'processing';
}

function statusLabel(status: DocumentStatus): string {
  const labels: Record<DocumentStatus, string> = {
    uploaded: '已上传',
    parsing: '解析中',
    chunking: '切分中',
    embedding: '向量化',
    completed: '已完成',
    failed: '失败',
  };
  return labels[status];
}

function formatBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function errorMessage(err: unknown, fallback: string): string {
  return getErrorMessage(err, fallback);
}
