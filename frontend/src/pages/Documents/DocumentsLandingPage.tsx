import { ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { ApiError } from '../../api/client';
import {
  batchDeleteDocuments,
  batchReprocessDocuments,
  getWorkspacePreference,
  listGlobalDocuments,
  listKnowledgeBaseCategories,
  listKnowledgeBases,
  uploadGlobalDocument,
} from '../../api/resources';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';
import { WorkspaceShell } from '../../components/WorkspaceShell';
import { DocumentDetailDrawer } from './DocumentDetailDrawer';
import { DocumentProgress } from './DocumentProgress';
import { DocumentRecycleBinDrawer } from './DocumentRecycleBinDrawer';
import type {
  DocumentSort,
  DocumentStatus,
  GlobalDocumentItem,
  KnowledgeBase,
  KnowledgeBaseCategory,
  KnowledgeBaseWorkspacePreference,
} from '../../types/api';

const statusOptions: Array<DocumentStatus | ''> = [
  '',
  'uploaded',
  'parsing',
  'chunking',
  'embedding',
  'completed',
  'failed',
];

const fallbackPreference: KnowledgeBaseWorkspacePreference = {
  viewMode: 'table',
  scope: 'all',
  sort: 'updatedAt_desc',
  visibility: 'all',
  expandedCategoryIds: [],
};

export function DocumentsLandingPage() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const documentRequestIdRef = useRef(0);
  const mountedRef = useRef(true);
  const [categories, setCategories] = useState<KnowledgeBaseCategory[]>([]);
  const [expandedIds, setExpandedIds] = useState<string[]>([]);
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([]);
  const [documents, setDocuments] = useState<GlobalDocumentItem[]>([]);
  const [uploadKnowledgeBaseId, setUploadKnowledgeBaseId] = useState('');
  const [knowledgeBaseFilter, setKnowledgeBaseFilter] = useState('');
  const [queryDraft, setQueryDraft] = useState('');
  const [status, setStatus] = useState<DocumentStatus | ''>('');
  const [fileType, setFileType] = useState('');
  const [sort, setSort] = useState<DocumentSort>('updatedAt_desc');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [detailDocumentId, setDetailDocumentId] = useState<string | null>(null);
  const [showRecycleBin, setShowRecycleBin] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [deleteTargetIds, setDeleteTargetIds] = useState<string[] | null>(null);
  const debouncedQuery = useDebouncedValue(queryDraft.trim(), 260);

  const loadPage = useCallback(async () => {
    const requestId = documentRequestIdRef.current + 1;
    documentRequestIdRef.current = requestId;
    const responses = await Promise.all([
        listGlobalDocuments({
          q: debouncedQuery,
          knowledgeBaseId: knowledgeBaseFilter,
          status,
          fileType,
          sort,
          page,
          pageSize,
        }),
        listKnowledgeBases({ pageSize: 100 }),
      ]).catch((err) => {
      if (mountedRef.current && documentRequestIdRef.current === requestId) {
        throw err;
      }
      return null;
    });
    if (!responses || !mountedRef.current || documentRequestIdRef.current !== requestId) {
      return;
    }
    const [documentResponse, kbResponse] = responses;
    setLoadError('');
    setDocuments(documentResponse.items);
    setTotal(documentResponse.total);
    setKnowledgeBases(kbResponse.items);
    setUploadKnowledgeBaseId((current) => current || kbResponse.items[0]?.id || '');
    setSelectedIds((current) => current.filter((id) => documentResponse.items.some((document) => document.id === id)));
  }, [debouncedQuery, fileType, knowledgeBaseFilter, page, pageSize, sort, status]);

  const refreshPage = useCallback(async (fallback: string) => {
    try {
      await loadPage();
    } catch (err) {
      if (mountedRef.current) {
        setLoadError(errorMessage(err, fallback));
      }
    }
  }, [loadPage]);

  const refreshAfterAction = useCallback(async (successLabel: string) => {
    try {
      await loadPage();
    } catch (err) {
      if (mountedRef.current) {
        setLoadError(`${successLabel}，但列表刷新失败：${errorMessage(err, '请求失败')}`);
      }
    }
  }, [loadPage]);

  const hasProcessingDocuments = useMemo(
    () => documents.some((document) => document.status !== 'completed' && document.status !== 'failed'),
    [documents],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      documentRequestIdRef.current += 1;
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    setLoading(true);

    refreshPage('全局文档加载失败')
      .finally(() => {
        if (mounted) {
          setLoading(false);
        }
      });

    return () => {
      mounted = false;
    };
  }, [refreshPage]);

  useEffect(() => {
    if (!hasProcessingDocuments) {
      return;
    }

    let active = true;
    const timer = window.setInterval(() => {
	  if (active) {
		void refreshPage('文档状态刷新失败');
	  }
    }, 3000);

    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [hasProcessingDocuments, refreshPage]);

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

  const fileTypes = useMemo(
    () => Array.from(new Set(documents.map((document) => document.fileType).filter(Boolean))).sort(),
    [documents],
  );
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const completedCount = documents.filter((document) => document.status === 'completed').length;
  const failedCount = documents.filter((document) => document.status === 'failed').length;
  const processingCount = documents.filter(
    (document) => document.status !== 'completed' && document.status !== 'failed',
  ).length;
  const currentUploadTarget = knowledgeBases.find((item) => item.id === uploadKnowledgeBaseId);
  const activeFilterCount = [queryDraft.trim(), knowledgeBaseFilter, status, fileType].filter(Boolean).length;
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const allVisibleSelected = documents.length > 0 && documents.every((document) => selectedSet.has(document.id));

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file || !uploadKnowledgeBaseId) {
      return;
    }

    setUploading(true);
    setActionError('');

	try {
	  try {
		await uploadGlobalDocument(uploadKnowledgeBaseId, file);
	  } catch (err) {
		setActionError(errorMessage(err, '全局上传失败'));
		return;
	  }
	  await refreshAfterAction('文档已上传');
	} finally {
      setUploading(false);
      event.target.value = '';
    }
  }

  function resetToFirstPage(update: () => void) {
    update();
    setPage(1);
  }

  function toggleSelected(documentId: string) {
    setSelectedIds((current) =>
      current.includes(documentId)
        ? current.filter((item) => item !== documentId)
        : [...current, documentId],
    );
  }

  function toggleAllVisible() {
    const visibleIds = documents.map((document) => document.id);
    setSelectedIds(allVisibleSelected ? [] : visibleIds);
  }

  async function handleBatchReprocess() {
    if (selectedIds.length === 0) {
      return;
    }

    setSubmitting(true);
    setActionError('');

	try {
	  try {
		await batchReprocessDocuments(selectedIds);
	  } catch (err) {
		setActionError(errorMessage(err, '批量重处理失败'));
		return;
	  }
	  setSelectedIds([]);
	  await refreshAfterAction('批量重处理已提交');
	} finally {
      setSubmitting(false);
    }
  }

  async function handleBatchDelete() {
    if (!deleteTargetIds) {
      return;
    }

    setSubmitting(true);
    setActionError('');

	try {
	  try {
		await batchDeleteDocuments(deleteTargetIds);
	  } catch (err) {
		setActionError(errorMessage(err, '批量删除失败'));
		return;
	  }
	  setDeleteTargetIds(null);
	  setSelectedIds([]);
	  await refreshAfterAction('批量删除已完成');
	} finally {
      setSubmitting(false);
    }
  }

  const listRefreshing = loading && documents.length > 0;

  return (
    <WorkspaceShell active="documents" categories={categories} expandedIds={expandedIds}>
      <div className="documents-overview-page">
        <section className="document-command-band">
          <div className="document-command-main">
            <p className="breadcrumb">首页 / 文档管理</p>
            <h1>全局文档台账</h1>
            <p className="page-description">
              跨知识库查看文档处理进度、失败原因和处理入口；上传时先选择目标知识库。
            </p>
          </div>
          <div className="document-command-aside" aria-label="上传文档">
            <span className="document-aside-label">上传目标</span>
            <label className="document-target-select">
              <select
                value={uploadKnowledgeBaseId}
                onChange={(event) => setUploadKnowledgeBaseId(event.target.value)}
                disabled={knowledgeBases.length === 0}
              >
                {knowledgeBases.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <p className="document-aside-note">
              {currentUploadTarget ? `将上传到：${currentUploadTarget.name}` : '暂无可上传的知识库'}
            </p>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading || !uploadKnowledgeBaseId}
            >
              {uploading ? '上传中...' : '导入文档'}
            </button>
            <input
              ref={fileInputRef}
              accept=".txt,.md,.pdf,text/plain,text/markdown,application/pdf"
              hidden
              type="file"
              onChange={handleFileChange}
            />
          </div>
        </section>

        <div className="document-status-strip">
          <MetricCard label="当前页文档" value={documents.length} />
          <MetricCard label="已完成" value={completedCount} tone="success" />
          <MetricCard label="处理中" value={processingCount} tone="warning" />
          <MetricCard label="失败" value={failedCount} tone="danger" />
        </div>

        {(actionError || loadError) && (
          <p className="document-alert error-text" role="alert">{actionError || loadError}</p>
        )}

        <div className={listRefreshing ? 'panel data-panel document-list-panel is-refreshing' : 'panel data-panel document-list-panel'}>
          <div className="panel-header document-list-header">
            <div>
              <h2>文档列表</h2>
              <p>共 {total} 条，{activeFilterCount > 0 ? `已启用 ${activeFilterCount} 个筛选` : '当前显示全部范围'}</p>
            </div>
            <div className="table-actions">
              {listRefreshing && <span className="muted-text" aria-live="polite">刷新中...</span>}
              <button className="secondary-button" type="button" onClick={() => setShowRecycleBin(true)}>
                文档回收站
              </button>
			  <button className="secondary-button" type="button" onClick={() => void refreshPage('文档列表刷新失败')}>
                刷新
              </button>
            </div>
          </div>

          <div className="document-filter-bar global-document-controls">
            <input
              aria-label="搜索文件或知识库"
              placeholder="搜索文件名或知识库"
              value={queryDraft}
              onChange={(event) => resetToFirstPage(() => setQueryDraft(event.target.value))}
            />
            <select
              aria-label="知识库筛选"
              value={knowledgeBaseFilter}
              onChange={(event) => resetToFirstPage(() => setKnowledgeBaseFilter(event.target.value))}
            >
              <option value="">全部知识库</option>
              {knowledgeBases.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
            <select
              aria-label="状态筛选"
              value={status}
              onChange={(event) => resetToFirstPage(() => setStatus(event.target.value as DocumentStatus | ''))}
            >
              {statusOptions.map((item) => (
                <option key={item || 'all'} value={item}>
                  {item ? statusLabel(item) : '全部状态'}
                </option>
              ))}
            </select>
            <select
              aria-label="类型筛选"
              value={fileType}
              onChange={(event) => resetToFirstPage(() => setFileType(event.target.value))}
            >
              <option value="">全部类型</option>
              {fileTypes.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
            <select
              aria-label="排序"
              value={sort}
              onChange={(event) => resetToFirstPage(() => setSort(event.target.value as DocumentSort))}
            >
              <option value="updatedAt_desc">最新更新</option>
              <option value="createdAt_desc">最新创建</option>
              <option value="filename_asc">文件名升序</option>
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
                onClick={() => setDeleteTargetIds(selectedIds)}
                disabled={submitting}
              >
                批量删除
              </button>
            </div>
          )}

        {loading && documents.length === 0 ? (
          <LoadingSkeleton rows={5} columns={9} />
        ) : documents.length === 0 ? (
          <div className="empty-state">当前筛选下没有文档。选择知识库后导入 txt、md 或 pdf。</div>
        ) : (
          <div className="table-wrap">
            <table className="data-table global-document-table">
              <thead>
                <tr>
                  <th>
                    <input
                      aria-label="选择当前页全部文档"
                      checked={allVisibleSelected}
                      type="checkbox"
                      onChange={toggleAllVisible}
                    />
                  </th>
                  <th>文件名</th>
                  <th>知识库</th>
                  <th>类型</th>
                  <th>大小</th>
                  <th>状态</th>
                  <th>错误信息</th>
                  <th>更新时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {documents.map((document) => (
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
                    <td data-label="知识库">{document.knowledgeBaseName}</td>
                    <td data-label="类型">{document.fileType}</td>
                    <td data-label="大小">{formatBytes(document.fileSize)}</td>
                    <td data-label="状态">
                      <span className={`status-pill status-${statusClass(document.status)}`}>
                        {statusLabel(document.status)}
                      </span>
                      <DocumentProgress compact document={document} />
                    </td>
                    <td className="document-error-cell" data-label="错误信息">{document.errorMessage || '-'}</td>
                    <td data-label="更新时间">{formatDateTime(document.updatedAt || document.createdAt)}</td>
                    <td data-label="操作">
                      <div className="table-actions">
                        <button className="link-button" type="button" onClick={() => setDetailDocumentId(document.id)}>
                          查看
                        </button>
                        <Link className="link-button" to={`/knowledge-bases/${document.knowledgeBaseId}/documents`}>
                          进入处理
                        </Link>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

        <footer className="workspace-pagination document-pagination">
          <span>第 {page} / {totalPages} 页</span>
          <div className="pager">
            <button className="secondary-button" type="button" disabled={page <= 1} onClick={() => setPage(page - 1)}>
              ‹
            </button>
            <button className="secondary-button active-page" type="button">
              {page}
            </button>
            <button className="secondary-button" type="button" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>
              ›
            </button>
            <select
              aria-label="每页数量"
              value={pageSize}
              onChange={(event) => {
                setPageSize(Number(event.target.value));
                setPage(1);
              }}
            >
              {[10, 20, 50].map((item) => (
                <option key={item} value={item}>
                  {item} 条/页
                </option>
              ))}
            </select>
          </div>
        </footer>

        {detailDocumentId && (
          <DocumentDetailDrawer
            documentId={detailDocumentId}
            knowledgeBaseName={documents.find((document) => document.id === detailDocumentId)?.knowledgeBaseName}
			onChanged={() => void refreshPage('文档列表刷新失败')}
            onClose={() => setDetailDocumentId(null)}
          />
        )}

        {showRecycleBin && (
          <DocumentRecycleBinDrawer
			onChanged={() => void refreshPage('文档列表刷新失败')}
            onClose={() => setShowRecycleBin(false)}
          />
        )}

        {deleteTargetIds && (
          <ConfirmDialog
            title="批量删除文档"
            description={`确认删除选中的 ${deleteTargetIds.length} 个文档？这些文档会进入回收站。`}
            confirmLabel="删除"
            busy={submitting}
            onCancel={() => setDeleteTargetIds(null)}
            onConfirm={handleBatchDelete}
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

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedValue(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [delayMs, value]);

  return debouncedValue;
}

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    return err.message;
  }
  return fallback;
}
