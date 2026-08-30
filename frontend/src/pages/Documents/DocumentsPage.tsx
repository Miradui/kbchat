import { Ban, FileText, MessageSquareText, PencilLine, RotateCw, Search, Trash2, Upload, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';

import {
  batchDeleteDocuments,
  batchReprocessDocuments,
  cancelDocumentJob,
  deleteDocument,
  listKnowledgeBases,
  replaceDocument,
  reprocessDocument,
  updateDocument,
  uploadDocument,
  uploadGlobalDocument,
} from '../../api/resources';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { EmptyState } from '../../components/feedback/EmptyState';
import { ErrorState } from '../../components/feedback/ErrorState';
import { useToast } from '../../components/feedback/ToastProvider';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';
import { Checkbox, Field, Input, SearchInput, Select } from '../../components/ui/Field';
import { IconButton } from '../../components/ui/IconButton';
import { MetricStrip } from '../../components/ui/MetricStrip';
import { OverflowMenu } from '../../components/ui/OverflowMenu';
import { Pagination } from '../../components/ui/Pagination';
import { useEntityMutation } from '../../hooks/useEntityMutation';
import { AppShell } from '../../layouts/AppShell';
import type { DocumentItem, DocumentSort, DocumentStatus, KnowledgeBase } from '../../types/api';
import { formatBytes, formatRelativeTime } from '../../utils/format';
import { getDocumentProcessingErrorMessage, getErrorMessage } from '../../utils/errors';
import { KnowledgeBaseLayout, KnowledgeBaseLoadFailure } from '../KnowledgeBase/KnowledgeBaseLayout';
import { useKnowledgeBase } from '../KnowledgeBase/useKnowledgeBase';
import { DocumentDetailDrawer } from './DocumentDetailDrawer';
import { DocumentImportDialog } from './DocumentImportDialog';
import { DocumentProgress } from './DocumentProgress';
import { DocumentRecycleBinDrawer } from './DocumentRecycleBinDrawer';
import {
  documentStatuses,
  documentDisplayStatusLabel,
  documentDisplayStatusTone,
  documentStatusLabel,
  documentStatusTone,
  isTerminalDocumentStatus,
} from './documentDisplay';
import { importGuidance, importGuidanceMessage } from './importGuidance';
import { useDocumentList } from './useDocumentList';

type DocumentsPageProps = {
  /** Renders inside the knowledge-base shell and pins the knowledge-base filter. */
  scoped?: boolean;
};

/**
 * One implementation behind two routes.
 *
 * `/documents` and `/knowledge-bases/:id/documents` used to be separate 600- and
 * 770-line pages with their own table, filter bar, status cards, import entry,
 * recycle bin and detail drawer. They now differ only in shell and scope.
 */
export function DocumentsPage({ scoped = false }: DocumentsPageProps) {
  const { id } = useParams();
  const scopeId = scoped ? id : undefined;
  const body = <DocumentsBody scopeKnowledgeBaseId={scopeId} />;

  if (!scoped) {
    return (
      <AppShell active="documents" breadcrumbs={[{ label: '文档' }]}>
        {body}
      </AppShell>
    );
  }

  return <ScopedDocuments>{body}</ScopedDocuments>;
}

function ScopedDocuments({ children }: { children: React.ReactNode }) {
  const { knowledgeBase, setKnowledgeBase, loading, error, reload } = useKnowledgeBase();

  if (loading && !knowledgeBase) {
    return (
      <AppShell active="knowledge-bases" breadcrumbs={[{ label: '知识库', to: '/knowledge-bases' }]}>
        <div className="ui-panel"><LoadingSkeleton announce columns={4} rows={5} /></div>
      </AppShell>
    );
  }

  if (!knowledgeBase) {
    return <KnowledgeBaseLoadFailure message={error || '知识库不存在或无权访问。'} onRetry={() => void reload()} />;
  }

  return (
    <KnowledgeBaseLayout active="documents" knowledgeBase={knowledgeBase} onUpdated={setKnowledgeBase}>
      {children}
    </KnowledgeBaseLayout>
  );
}

function DocumentsBody({ scopeKnowledgeBaseId }: { scopeKnowledgeBaseId?: string }) {
  const toast = useToast();
  const mutation = useEntityMutation();
  const list = useDocumentList(scopeKnowledgeBaseId);
  const { items, total, counts, loading, error, filters, activeFilterCount, refresh, setFilter } = list;

  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [importOpen, setImportOpen] = useState(false);
  const [recycleOpen, setRecycleOpen] = useState(false);
  const [deleteIds, setDeleteIds] = useState<string[] | null>(null);
  const [deleteError, setDeleteError] = useState('');
  const [renameTarget, setRenameTarget] = useState<{ id: string; filename: string } | null>(null);
  const [renameError, setRenameError] = useState('');
  const [detailId, setDetailId] = useState<string | null>(null);
  const [searchDraft, setSearchDraft] = useState(filters.q);
  // Ids from the most recent import, watched until they stop processing. Held here
  // rather than derived from the list because "just imported" is not a property of
  // a document -- a document that was already completed when the page loaded must
  // not trigger the guidance.
  const [watchedImportIds, setWatchedImportIds] = useState<string[]>([]);
  // Where "开始提问" should go. Read off the imported documents rather than the page
  // scope, so the workspace-wide page also gets a working entry point; a batch split
  // across knowledge bases has no single destination and shows the notice only.
  const [guidanceKnowledgeBaseId, setGuidanceKnowledgeBaseId] = useState('');
  const [guidanceDismissed, setGuidanceDismissed] = useState(false);
  const navigate = useNavigate();
  const mountedRef = useRef(true);
  const scopeRef = useRef(scopeKnowledgeBaseId);
  const previousScopeRef = useRef(scopeKnowledgeBaseId);

  scopeRef.current = scopeKnowledgeBaseId;

  const [searchParams, setSearchParams] = useSearchParams();
  const deepLinkDocumentId = searchParams.get('documentId');
  const deepLinkChunkId = searchParams.get('chunkId') ?? undefined;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (previousScopeRef.current === scopeKnowledgeBaseId) return;
    previousScopeRef.current = scopeKnowledgeBaseId;
    setSelectedIds([]);
    setImportOpen(false);
    setRecycleOpen(false);
    setDeleteIds(null);
    setDeleteError('');
    setRenameTarget(null);
    setRenameError('');
    setWatchedImportIds([]);
    setGuidanceKnowledgeBaseId('');
    setGuidanceDismissed(false);
  }, [scopeKnowledgeBaseId]);

  useEffect(() => setSearchDraft(filters.q), [filters.q]);

  useEffect(() => {
    void listKnowledgeBases({ pageSize: 100 })
      .then((response) => setKnowledgeBases(response.items))
      .catch(() => setKnowledgeBases([]));
  }, []);

  // `?documentId=` (and optional `?chunkId=`) opens the detail drawer. Citations
  // and global search both rely on this contract.
  useEffect(() => {
    setDetailId(deepLinkDocumentId);
  }, [deepLinkDocumentId]);

  // `?intent=upload` opens the import dialog once and consumes the parameter.
  useEffect(() => {
    if (searchParams.get('intent') !== 'upload') return;
    openImport();
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      next.delete('intent');
      return next;
    }, { replace: true });
  }, [searchParams, setSearchParams]);

  useEffect(() => {
    setSelectedIds((current) => current.filter((docId) => items.some((item) => item.id === docId)));
  }, [items]);

  const guidance = useMemo(
    () => (guidanceDismissed ? null : importGuidance(watchedImportIds, items)),
    [guidanceDismissed, items, watchedImportIds],
  );

  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const allSelected = items.length > 0 && items.every((item) => selected.has(item.id));
  const fileTypes = useMemo(
    () => Array.from(new Set(items.map((item) => item.fileType).filter(Boolean))).sort(),
    [items],
  );

  function mutationKey(key: string) {
    return `${scopeKnowledgeBaseId ?? 'workspace'}:${key}`;
  }

  // Every import starts a fresh watch: carrying ids over would let a second batch
  // report the first one's totals alongside its own.
  function openImport() {
    setWatchedImportIds([]);
    setGuidanceKnowledgeBaseId('');
    setGuidanceDismissed(false);
    setImportOpen(true);
  }

  /**
   * Start watching a finished upload batch so the guidance can fire when the
   * documents stop processing. Called per batch, and again for each duplicate the
   * user resolves afterwards, so ids accumulate instead of replacing.
   */
  function watchImport(documents: DocumentItem[]) {
    if (documents.length === 0) return;
    setWatchedImportIds((current) => {
      const known = new Set(current);
      return [...current, ...documents.map((document) => document.id).filter((id) => !known.has(id))];
    });
    setGuidanceKnowledgeBaseId((current) => {
      const targets = new Set(documents.map((document) => document.knowledgeBaseId));
      if (current) targets.add(current);
      // Mixed targets: there is no single knowledge base to ask against.
      return targets.size === 1 ? [...targets][0] : '';
    });
    setGuidanceDismissed(false);
  }

  function isCurrentOperation(operationScope: string | undefined) {
    return mountedRef.current && scopeRef.current === operationScope;
  }

  function openDetail(documentId: string) {
    if (mutation.isPendingSync(mutationKey(documentId))) return;
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      next.set('documentId', documentId);
      next.delete('chunkId');
      return next;
    });
  }

  function closeDetail() {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      next.delete('documentId');
      next.delete('chunkId');
      return next;
    }, { replace: true });
  }

  async function run(
    key: string,
    action: () => Promise<void>,
    success: string,
    failure: string,
    onSuccess?: () => void,
  ) {
    const operationScope = scopeKnowledgeBaseId;
    await mutation.run(mutationKey(key), async () => {
      try {
        await action();
        if (!isCurrentOperation(operationScope)) return;
        onSuccess?.();
        toast.success(success);
        await refresh();
      } catch (caught) {
        if (isCurrentOperation(operationScope)) {
          toast.error(getErrorMessage(caught, failure));
        }
      }
    });
  }

  const uploadTargets = scopeKnowledgeBaseId
    ? knowledgeBases.filter((item) => item.id === scopeKnowledgeBaseId)
    : knowledgeBases;

  return (
    <div className="doc-page">
      <div className="doc-toolbar">
        <div className="ui-toolbar">
          <SearchInput
            aria-label="按文件名搜索"
            icon={<Search aria-hidden="true" />}
            onChange={(event) => {
              setSearchDraft(event.target.value);
              setFilter({ q: event.target.value.trim() });
            }}
            placeholder="搜索文件名"
            value={searchDraft}
          />

          {!scopeKnowledgeBaseId && (
            <Select
              aria-label="知识库筛选"
              onChange={(event) => setFilter({ knowledgeBaseId: event.target.value })}
              value={filters.knowledgeBaseId}
            >
              <option value="">全部知识库</option>
              {knowledgeBases.map((item) => (
                <option key={item.id} value={item.id}>{item.name}</option>
              ))}
            </Select>
          )}

          <Select
            aria-label="类型筛选"
            onChange={(event) => setFilter({ fileType: event.target.value })}
            value={filters.fileType}
          >
            <option value="">全部类型</option>
            {fileTypes.map((type) => <option key={type} value={type}>{type}</option>)}
          </Select>

          <Select
            aria-label="排序"
            onChange={(event) => setFilter({ sort: event.target.value as DocumentSort })}
            value={filters.sort}
          >
            <option value="updatedAt_desc">最新更新</option>
            <option value="createdAt_desc">最新创建</option>
            <option value="filename_asc">文件名升序</option>
          </Select>

          <span className="ui-toolbar__spacer" />

          <OverflowMenu
            label="更多文档操作"
            items={[
              { label: '刷新列表', icon: <RotateCw aria-hidden="true" />, onSelect: () => void refresh() },
              { label: '文档回收站', icon: <Trash2 aria-hidden="true" />, onSelect: () => setRecycleOpen(true) },
            ]}
          />

          <Button
            disabled={uploadTargets.length === 0}
            leadingIcon={<Upload aria-hidden="true" />}
            onClick={openImport}
          >
            导入文档
          </Button>
        </div>

        {/* Status counts double as filters, so a failure count is one click from the list. */}
        <MetricStrip
          label="文档处理概况"
          metrics={[
            {
              key: 'all',
              label: '个文档',
              value: counts.total,
              active: filters.status === '',
              onToggle: () => setFilter({ status: '' }),
            },
            {
              key: 'completed',
              label: '可用于问答',
              value: counts.completed,
              active: filters.status === 'completed',
              onToggle: () => setFilter({ status: filters.status === 'completed' ? '' : 'completed' }),
            },
            {
              key: 'processing',
              label: '处理中',
              tone: 'warn',
              value: counts.processing,
              active: filters.status !== '' && filters.status !== 'completed' && filters.status !== 'failed',
              onToggle: () => setFilter({ status: filters.status === 'parsing' ? '' : 'parsing' }),
            },
            {
              key: 'failed',
              label: '失败',
              tone: 'danger',
              value: counts.failed,
              active: filters.status === 'failed',
              onToggle: () => setFilter({ status: filters.status === 'failed' ? '' : 'failed' }),
            },
          ]}
          trailing={activeFilterCount > 0 ? (
            <Button
              variant="link"
              onClick={() => setFilter({ q: '', status: '', fileType: '', knowledgeBaseId: scopeKnowledgeBaseId ? filters.knowledgeBaseId : '' })}
            >
              清除筛选
            </Button>
          ) : undefined}
        />

        {filters.status !== '' && !isTerminalDocumentStatus(filters.status) && (
          <div className="ui-inline-notice">
            <span>正在按“{documentStatusLabel(filters.status)}”筛选。</span>
            <Select
              aria-label="处理阶段"
              onChange={(event) => setFilter({ status: event.target.value as DocumentStatus | '' })}
              value={filters.status}
            >
              {documentStatuses
                .filter((status) => !isTerminalDocumentStatus(status))
                .map((status) => (
                  <option key={status} value={status}>{documentStatusLabel(status)}</option>
                ))}
            </Select>
          </div>
        )}
      </div>

      {guidance && (
        <div
          aria-label="导入结果"
          className={`doc-guidance${guidance.canAsk ? '' : ' doc-guidance--warn'}`}
          // Polite: the user is watching the list, and an assertive interruption
          // would cut across whatever they are reading in it.
          role="status"
        >
          <div className="doc-guidance__text">
            <strong>{importGuidanceMessage(guidance)}</strong>
            {guidance.canAsk && (
              <span className="ui-muted">回答只会引用这个知识库里的内容。</span>
            )}
          </div>
          {guidance.canAsk && guidanceKnowledgeBaseId && (
            <Button
              leadingIcon={<MessageSquareText aria-hidden="true" />}
              onClick={() => navigate(`/chat?knowledgeBaseId=${encodeURIComponent(guidanceKnowledgeBaseId)}`)}
            >
              开始提问
            </Button>
          )}
          <IconButton label="关闭提示" onClick={() => setGuidanceDismissed(true)}>
            <X aria-hidden="true" />
          </IconButton>
        </div>
      )}

      {selectedIds.length > 0 && (
        <div className="ui-bulkbar">
          <span className="ui-bulkbar__count">已选择 {selectedIds.length} 个文档</span>
          <Button
            disabled={mutation.isPending(mutationKey('bulk'))}
            variant="secondary"
            onClick={() => void run(
              'bulk',
              async () => { await batchReprocessDocuments(selectedIds); },
              '已开始批量重新处理',
              '批量重处理失败',
              () => setSelectedIds([]),
            )}
          >
            重新处理
          </Button>
          <span className="ui-toolbar__spacer" />
          <Button
            variant="danger"
            onClick={() => {
              setDeleteError('');
              setDeleteIds(selectedIds);
            }}
          >
            删除
          </Button>
        </div>
      )}

      <div className={loading && items.length > 0 ? 'doc-results is-refreshing' : 'doc-results'}>
        {loading && items.length === 0 ? (
          <LoadingSkeleton announce columns={6} rows={6} />
        ) : error ? (
          <ErrorState description={error} onRetry={() => void refresh()} title="文档列表加载失败" />
        ) : items.length === 0 ? (
          <EmptyState
            action={activeFilterCount > 0
              ? <Button variant="secondary" onClick={() => setFilter({ q: '', status: '', fileType: '' })}>清除筛选</Button>
              : uploadTargets.length > 0
                ? <Button onClick={openImport}>导入文档</Button>
                : <Link className="ui-button ui-button--primary" to="/knowledge-bases?intent=create"><span>先新建知识库</span></Link>}
            description={activeFilterCount > 0
              ? '调整筛选条件后再试。'
              : '导入 txt、md 或 pdf，处理完成后即可用于问答。'}
            title={activeFilterCount > 0 ? '没有匹配的文档' : '还没有文档'}
          />
        ) : (
          <div className="ui-table-wrap">
            <table className="ui-table doc-table">
              <thead>
                <tr>
                  <th className="ui-table__select">
                    <Checkbox
                      aria-label="选择当前页全部文档"
                      checked={allSelected}
                      onChange={() => setSelectedIds(allSelected ? [] : items.map((item) => item.id))}
                    />
                  </th>
                  <th>文件名</th>
                  {!scopeKnowledgeBaseId && <th>知识库</th>}
                  <th>状态</th>
                  <th>大小</th>
                  <th>更新</th>
                  <th className="ui-table__actions">操作</th>
                </tr>
              </thead>
              <tbody>
                {items.map((document) => {
                  const pending = mutation.isPending(mutationKey(document.id));
                  return (
                    <tr data-busy={pending || undefined} data-selected={selected.has(document.id) || undefined} key={document.id}>
                      <td className="ui-table__select" data-label="选择">
                        <Checkbox
                          aria-label={`选择 ${document.filename}`}
                          checked={selected.has(document.id)}
                          onChange={() => setSelectedIds((current) => (
                            current.includes(document.id)
                              ? current.filter((value) => value !== document.id)
                              : [...current, document.id]
                          ))}
                        />
                      </td>
                      <td data-label="文件名">
                        <button className="doc-name" onClick={() => openDetail(document.id)} type="button">
                          <FileText aria-hidden="true" />
                          <span className="ui-truncate">{document.filename}</span>
                        </button>
                      </td>
                      {!scopeKnowledgeBaseId && (
                        <td data-label="知识库">
                          <Link className="ui-truncate" to={`/knowledge-bases/${document.knowledgeBaseId}`}>
                            {document.knowledgeBaseName}
                          </Link>
                        </td>
                      )}
                      <td data-label="状态">
                        <div className="doc-status-cell">
                          <Badge tone={documentDisplayStatusTone(document.status, document.jobStatus)}>
                            {documentDisplayStatusLabel(document.status, document.jobStatus)}
                          </Badge>
                          {!isTerminalDocumentStatus(document.status) && (
                            <DocumentProgress compact document={document} />
                          )}
                          {/* The failure reason replaces the old always-present column that
                              showed "-" on every healthy row. */}
                          {document.status === 'failed' && (
                            <small className="doc-status-cell__error">
                              {getDocumentProcessingErrorMessage(document.errorMessage)}
                            </small>
                          )}
                        </div>
                      </td>
                      <td className="ui-table__num" data-label="大小">{formatBytes(document.fileSize)}</td>
                      <td data-label="更新">{formatRelativeTime(document.updatedAt || document.createdAt)}</td>
                      <td className="ui-table__actions" data-label="操作">
                        <div>
                          <Button disabled={pending} variant="ghost" onClick={() => openDetail(document.id)}>查看</Button>
                          <OverflowMenu
                            disabled={pending}
                            label={`${document.filename} 的更多操作`}
                            items={[
                              {
                                label: '重命名',
                                icon: <PencilLine aria-hidden="true" />,
                                onSelect: () => {
                                  setRenameError('');
                                  setRenameTarget({ id: document.id, filename: document.filename });
                                },
                              },
                              {
                                label: '重新处理',
                                icon: <RotateCw aria-hidden="true" />,
                                disabled: !isTerminalDocumentStatus(document.status),
                                onSelect: () => void run(
                                  document.id,
                                  async () => { await reprocessDocument(document.id); },
                                  '已开始重新处理',
                                  '文档重处理失败',
                                ),
                              },
                              {
                                // Only a queued or running job can be cancelled;
                                // the server enforces the same rule.
                                label: '取消处理',
                                icon: <Ban aria-hidden="true" />,
                                disabled: isTerminalDocumentStatus(document.status),
                                onSelect: () => void run(
                                  document.id,
                                  async () => { await cancelDocumentJob(document.id); },
                                  '已取消文档处理',
                                  '取消文档处理失败',
                                ),
                              },
                              {
                                label: '删除',
                                icon: <Trash2 aria-hidden="true" />,
                                tone: 'danger',
                                onSelect: () => {
                                  setDeleteError('');
                                  setDeleteIds([document.id]);
                                },
                              },
                            ]}
                          />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Pagination
        onPageChange={(page) => setFilter({ page })}
        onPageSizeChange={(pageSize) => setFilter({ pageSize })}
        page={filters.page}
        pageSize={filters.pageSize}
        total={total}
      />

      {deleteIds && (
        <ConfirmDialog
          busy={mutation.isPending(mutationKey('delete'))}
          confirmLabel="删除"
          description={deleteIds.length === 1
            ? '确认删除这个文档？它会进入回收站，可随时恢复。'
            : `确认删除选中的 ${deleteIds.length} 个文档？它们会进入回收站，可随时恢复。`}
          error={deleteError}
          onCancel={() => {
            setDeleteError('');
            setDeleteIds(null);
          }}
          onConfirm={() => {
            const ids = deleteIds;
            const operationScope = scopeKnowledgeBaseId;
            void mutation.run(mutationKey('delete'), async () => {
              try {
                if (ids.length === 1) await deleteDocument(ids[0]);
                else await batchDeleteDocuments(ids);
                if (!isCurrentOperation(operationScope)) return;
                setDeleteIds(null);
                setSelectedIds([]);
                toast.success('文档已移入回收站');
                await refresh();
              } catch (caught) {
                if (isCurrentOperation(operationScope)) {
                  setDeleteError(getErrorMessage(caught, '文档删除失败'));
                }
              }
            });
          }}
          title={deleteIds.length === 1 ? '删除文档' : '批量删除文档'}
        />
      )}

      {renameTarget && (
        <RenameDocumentDialog
          busy={mutation.isPending(mutationKey('rename'))}
          error={renameError}
          filename={renameTarget.filename}
          onCancel={() => {
            setRenameError('');
            setRenameTarget(null);
          }}
          onSubmit={(filename) => {
            const target = renameTarget;
            const operationScope = scopeKnowledgeBaseId;
            void mutation.run(mutationKey('rename'), async () => {
              try {
                await updateDocument(target.id, { filename });
                if (!isCurrentOperation(operationScope)) return;
                setRenameTarget(null);
                toast.success('文档已重命名');
                await refresh();
              } catch (caught) {
                if (isCurrentOperation(operationScope)) {
                  setRenameError(getErrorMessage(caught, '文档重命名失败'));
                }
              }
            });
          }}
        />
      )}

      {detailId && (
        <DocumentDetailDrawer
          chunkId={deepLinkChunkId}
          documentId={detailId}
          knowledgeBaseId={scopeKnowledgeBaseId}
          knowledgeBaseName={items.find((item) => item.id === detailId)?.knowledgeBaseName}
          onChanged={() => void refresh()}
          onClose={closeDetail}
        />
      )}

      {recycleOpen && (
        <DocumentRecycleBinDrawer onChanged={() => void refresh()} onClose={() => setRecycleOpen(false)} />
      )}

      <DocumentImportDialog
        fixedKnowledgeBaseId={scopeKnowledgeBaseId}
        fixedKnowledgeBaseName={uploadTargets[0]?.name}
        knowledgeBases={uploadTargets}
        onBatchComplete={(documents) => {
          if (!isCurrentOperation(scopeKnowledgeBaseId)) return undefined;
          watchImport(documents);
          return refresh();
        }}
        onClose={() => setImportOpen(false)}
        onReplace={replaceDocument}
        onUpload={scopeKnowledgeBaseId ? uploadDocument : uploadGlobalDocument}
        open={importOpen}
      />
    </div>
  );
}

type RenameDocumentDialogProps = {
  busy: boolean;
  error: string;
  filename: string;
  onCancel: () => void;
  onSubmit: (filename: string) => void;
};

/**
 * The extension is fixed: `fileType` is derived from it at upload and selects the
 * parser used on the next reprocess, so the server rejects a rename that changes
 * it. Only the stem is editable here. See docs/14-frontend-api-gaps.md G7.
 */
function RenameDocumentDialog({ busy, error, filename, onCancel, onSubmit }: RenameDocumentDialogProps) {
  const separator = filename.lastIndexOf('.');
  const extension = separator > 0 ? filename.slice(separator) : '';
  const [stem, setStem] = useState(separator > 0 ? filename.slice(0, separator) : filename);
  const trimmed = stem.trim();

  return (
    <Dialog description="扩展名由上传时确定，不可修改。" onClose={onCancel} open title="重命名文档">
      <form
        className="ui-dialog__form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!trimmed || busy) return;
          onSubmit(`${trimmed}${extension}`);
        }}
      >
        <Field error={error} hint={extension ? `保存后为 ${trimmed || '…'}${extension}` : undefined} label="文件名">
          <Input
            autoFocus
            onChange={(event) => setStem(event.target.value)}
            required
            value={stem}
          />
        </Field>
        <div className="ui-dialog__actions">
          <Button disabled={busy} onClick={onCancel} type="button" variant="secondary">取消</Button>
          <Button disabled={!trimmed} loading={busy} loadingLabel="保存中" type="submit">保存</Button>
        </div>
      </form>
    </Dialog>
  );
}
