import { Ban, FileText, FileType, PencilLine, RotateCw, Trash2, Upload, X } from 'lucide-react';
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';

import {
  batchDeleteDocuments,
  batchReprocessDocuments,
  cancelDocumentJob,
  deleteDocument,
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
import { Checkbox, Field, Input } from '../../components/ui/Field';
import { PageHeading } from '../../components/ui/PageHeading';
import { useKnowledgeBaseOptions } from '../../hooks/useKnowledgeBaseOptions';
import { IconButton } from '../../components/ui/IconButton';
import { OverflowMenu } from '../../components/ui/OverflowMenu';
import { Pagination } from '../../components/ui/Pagination';
import { useEntityMutation } from '../../hooks/useEntityMutation';
import { useSystemCapabilities } from '../../hooks/useSystemCapabilities';
import { AppShell } from '../../layouts/AppShell';
import type { Capability, DocumentItem, KnowledgeBase } from '../../types/api';
import { canUnlessUnknown, hasCapability } from '../../utils/access';
import { formatBytes, formatRelativeTime } from '../../utils/format';
import { getErrorMessage } from '../../utils/errors';
import { KnowledgeBaseLayout, KnowledgeBaseLoadFailure } from '../KnowledgeBase/KnowledgeBaseLayout';
import { useKnowledgeBase } from '../KnowledgeBase/useKnowledgeBase';
import { DocumentDetailDrawer } from './DocumentDetailDrawer';
import { useDocumentImports, type ImportBatch } from './DocumentImportContext';
import { ImportBatchChat } from './ImportBatchChat';
import { DocumentProgress } from './DocumentProgress';
import { DocumentRecycleBinDrawer } from './DocumentRecycleBinDrawer';

const LazyDocumentImportDialog = lazy(() =>
  import('./DocumentImportDialog').then((m) => ({ default: m.DocumentImportDialog })),
);
import {
  documentDisplayStatusLabel,
  documentDisplayStatusTone,
  documentStatusTone,
  isTerminalDocumentStatus,
} from './documentDisplay';
import { DocumentsBatchBar } from './DocumentsBatchBar';
import { DocumentsFilterBar } from './DocumentsFilterBar';
import { documentFailureCopy, documentStalenessHint } from './documentFailure';
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
  const imports = useDocumentImports();
  const observedImportVersion = useRef(imports?.changeVersion ?? 0);
  const mutation = useEntityMutation();
  const list = useDocumentList(scopeKnowledgeBaseId);
  const { items, total, counts, loading, error, filters, activeFilterCount, refresh, setFilter } = list;
  const { upload } = useSystemCapabilities();

  const knowledgeBaseOptions = useKnowledgeBaseOptions();
  const knowledgeBases = knowledgeBaseOptions.items;
  const knowledgeBasesLoaded = !knowledgeBaseOptions.loading;
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [importOpen, setImportOpen] = useState(false);
  const [recycleOpen, setRecycleOpen] = useState(false);
  const [deleteIds, setDeleteIds] = useState<string[] | null>(null);
  const [deleteError, setDeleteError] = useState('');
  const [renameTarget, setRenameTarget] = useState<{ id: string; filename: string } | null>(null);
  const [renameError, setRenameError] = useState('');
  const [detailId, setDetailId] = useState<string | null>(null);
  const [watchedImportDocuments, setWatchedImportDocuments] = useState<DocumentItem[]>([]);
  const [localBatchId, setLocalBatchId] = useState(0);
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
    setWatchedImportDocuments([]);
    setGuidanceDismissed(false);
  }, [scopeKnowledgeBaseId]);



  useEffect(() => {
    if (!imports?.changeVersion || observedImportVersion.current === imports.changeVersion) return;
    observedImportVersion.current = imports.changeVersion;
    void refresh();
  }, [imports?.changeVersion, refresh]);

  useEffect(() => { setGuidanceDismissed(false); }, [imports?.lastBatch?.id]);

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

  const sourceImportBatch: ImportBatch | null = imports ? imports.lastBatch : watchedImportDocuments.length ? {
    id: localBatchId,
    documents: watchedImportDocuments.map((document) => items.find((item) => item.id === document.id) ?? document),
  } : null;
  const importBatch: ImportBatch | null = sourceImportBatch ? { ...sourceImportBatch,
    tasks: (sourceImportBatch.tasks ?? sourceImportBatch.documents.map((document) => ({ document, paused: false, error: '' }))).map((task) => {
      const knowledgeBase = knowledgeBases.find((item) => item.id === task.document.knowledgeBaseId);
      return knowledgeBase && !canUnlessUnknown(knowledgeBase, 'chat.use')
        ? { ...task, paused: true, error: '当前无权在此知识库提问。' } : task;
    }),
  } : null;
  const guidance = importBatch && !(importBatch.pendingItems?.length) && !importBatch.tasks?.some((task) => task.paused || task.error || task.document.jobStatus === 'cancelled') ? importGuidance(importBatch.documents.map((document) => document.id), importBatch.documents) : null;

  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const fileTypes = useMemo(() => {
    const supported = upload.allowedExtensions.map((ext) => ext.replace(/^\./, '').toLowerCase());
    const fromItems = items.map((item) => item.fileType).filter(Boolean);
    return Array.from(new Set([...supported, ...fromItems])).sort();
  }, [items, upload.allowedExtensions]);

  function mutationKey(key: string) {
    return `${scopeKnowledgeBaseId ?? 'workspace'}:${key}`;
  }

  // Every import starts a fresh watch: carrying ids over would let a second batch
  // report the first one's totals alongside its own.
  function openImport() {
    setWatchedImportDocuments([]);
    setGuidanceDismissed(false);
    setLocalBatchId((value) => value + 1);
    setImportOpen(true);
  }

  function watchImport(documents: DocumentItem[]) {
    setWatchedImportDocuments((current) => [...new Map([...current, ...documents].map((document) => [document.id, document])).values()]);
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

  // Per-row capability comes from the knowledge base list this page already loads,
  // rather than from the document rows: the document endpoints do not carry a
  // capability list, and asking per row would be one request per row.
  const knowledgeBaseById = useMemo(
    () => new Map(knowledgeBases.map((item) => [item.id, item])),
    [knowledgeBases],
  );

  /**
   * Whether the caller may do `capability` to this document's knowledge base.
   *
   * Absent from the map means unknown, not denied: the lookup is capped at 100
   * knowledge bases and can also fail outright, and hiding every action because a
   * list request failed would look like the document page broke.
   */
  function canOnDocument(document: DocumentItem, capability: Capability) {
    const knowledgeBase = knowledgeBaseById.get(document.knowledgeBaseId);
    if (!knowledgeBase) return true;
    return canUnlessUnknown(knowledgeBase, capability);
  }

  // Only bases the caller can write to are offered as upload targets. A base they
  // can read but not write is not a destination, and listing it would turn every
  // selection into a 403 after the file was already chosen.
  const uploadTargets = (scopeKnowledgeBaseId
    ? knowledgeBases.filter((item) => item.id === scopeKnowledgeBaseId)
    : knowledgeBases
  ).filter((item) => canUnlessUnknown(item, 'content.write'));
  const writableItems = items.filter((document) => canOnDocument(document, 'content.write'));
  // Selection exists to drive the bulk bar, and every bulk action writes. Selecting a
  // read-only row would put it in a batch the server refuses as a whole.
  const allSelected = writableItems.length > 0 && writableItems.every((item) => selected.has(item.id));

  useEffect(() => {
    if (!imports || !importOpen || !knowledgeBasesLoaded) return;
    imports.openImport({
      fixedKnowledgeBaseId: scopeKnowledgeBaseId,
      fixedKnowledgeBaseName: uploadTargets[0]?.name,
      knowledgeBases: uploadTargets,
    });
    setImportOpen(false);
  }, [imports, importOpen, knowledgeBasesLoaded, scopeKnowledgeBaseId, uploadTargets]);

  const importButton = (
    <Button
      disabled={uploadTargets.length === 0}
      leadingIcon={<Upload aria-hidden="true" />}
      onClick={openImport}
    >
      导入文档
    </Button>
  );

  return (
    <div className="doc-page">
      {!scopeKnowledgeBaseId ? (
        <PageHeading
          actions={importButton}
          className="doc-page__heading"
          description="管理原始资料，查看处理进度与可用于问答的内容。"
          title="文档资料"
        />
      ) : (
        <h2 className="sr-only">文档资料</h2>
      )}
      <DocumentsFilterBar
        activeFilterCount={activeFilterCount}
        counts={counts}
        fileTypes={fileTypes}
        filters={filters}
        importButton={importButton}
        knowledgeBaseError={knowledgeBaseOptions.error}
        knowledgeBases={knowledgeBases}
        onOpenRecycle={() => setRecycleOpen(true)}
        onRefresh={() => void refresh()}
        onReloadKnowledgeBases={() => void knowledgeBaseOptions.reload()}
        scopeKnowledgeBaseId={scopeKnowledgeBaseId}
        setFilter={setFilter}
      />

      {importBatch && !guidanceDismissed && (importBatch.documents.length > 0 || (importBatch.pendingItems?.length ?? 0) > 0) && (
        <div aria-label="导入结果" className="doc-guidance" role="status">
          <div className="doc-guidance__text">
            {guidance && <strong>{importGuidanceMessage(guidance)}</strong>}
            <ImportBatchChat batch={importBatch} key={importBatch.id} onNavigate={navigate} />
          </div>
          <IconButton label="关闭提示" onClick={() => setGuidanceDismissed(true)}><X aria-hidden="true" /></IconButton>
        </div>
      )}

      <DocumentsBatchBar
        items={items}
        onDelete={() => {
          setDeleteError('');
          setDeleteIds(selectedIds);
        }}
        onNavigate={navigate}
        onReprocess={() => void run(
          'bulk',
          async () => { await batchReprocessDocuments(selectedIds); },
          '已开始批量重新处理',
          '批量重处理失败',
          () => setSelectedIds([]),
        )}
        reprocessing={mutation.isPending(mutationKey('bulk'))}
        selectedIds={selectedIds}
      />

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
              : '导入 TXT、Markdown、PDF、DOCX、XLSX 或 CSV，处理完成后即可用于问答。'}
            title={activeFilterCount > 0 ? '没有匹配的文档' : '还没有文档'}
          />
        ) : (
          <div className="ui-table-wrap">
            <table className="ui-table doc-table">
              <thead>
                <tr>
                  <th className="ui-table__select">
                    <Checkbox touchTarget
                      aria-label="选择当前页全部文档"
                      checked={allSelected}
                      disabled={writableItems.length === 0}
                      onChange={() => setSelectedIds(allSelected ? [] : writableItems.map((item) => item.id))}
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
                  const stalenessHint = documentStalenessHint(document);
                  const writable = canOnDocument(document, 'content.write');
                  return (
                    <tr data-busy={pending || undefined} data-selected={selected.has(document.id) || undefined} key={document.id}>
                      <td className="ui-table__select" data-label="选择">
                        <Checkbox touchTarget
                          aria-label={`选择 ${document.filename}`}
                          checked={selected.has(document.id)}
                          disabled={!writable}
                          onChange={() => setSelectedIds((current) => (
                            current.includes(document.id)
                              ? current.filter((value) => value !== document.id)
                              : [...current, document.id]
                          ))}
                        />
                      </td>
                      <td data-label="文件名">
                        <button className="doc-name" onClick={() => openDetail(document.id)} type="button">
                          {document.fileType.toLowerCase() === 'docx' ? <FileType aria-hidden="true" /> : <FileText aria-hidden="true" />}
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
                              showed "-" on every healthy row. The advice is left to the
                              drawer: the row has to stay one line tall to stay scannable. */}
                          {document.status === 'failed' && document.jobStatus !== 'cancelled' && (
                            <small className="doc-status-cell__error">
                              {documentFailureCopy(document).reason}
                            </small>
                          )}
                          {/* Advisory only -- a stale document is still retrieved and still
                              cited, so this is a Badge and not a warning banner. */}
                          {stalenessHint && (
                            // aria-label carries the full sentence: a title attribute
                            // alone is not announced reliably and is invisible on touch,
                            // so "可能过期" would be the only thing some users ever get.
                            <Badge aria-label={stalenessHint} tone="warn" title={stalenessHint}>
                              可能过期
                            </Badge>
                          )}
                        </div>
                      </td>
                      <td className="ui-table__num" data-label="大小">{formatBytes(document.fileSize)}</td>
                      <td data-label="更新">{formatRelativeTime(document.updatedAt || document.createdAt)}</td>
                      <td className="ui-table__actions" data-label="操作">
                        <div>
                          <Button disabled={pending} variant="ghost" onClick={() => openDetail(document.id)}>查看</Button>
                          {/* Every entry in this menu writes, so a viewer gets no menu
                              at all rather than an empty one. Viewing stays available:
                              document.read is what put the row on screen. */}
                          {writable && (
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
                          )}
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

      {!imports && importOpen && <Suspense fallback={null}><LazyDocumentImportDialog
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
      /></Suspense>}
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
 * it. Only the stem is editable here. See docs/04-api-design.md (PUT /documents/:id).
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
