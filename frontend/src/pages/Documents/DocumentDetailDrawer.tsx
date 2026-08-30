import { Download, FileText, RotateCw, Search, Trash2 } from 'lucide-react';
import { FormEvent, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { ApiError } from '../../api/client';
import {
  deleteDocument,
  downloadDocument,
  getDocument,
  getDocumentPreview,
  listDocumentChunks,
  reprocessDocument,
} from '../../api/resources';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { EmptyState } from '../../components/feedback/EmptyState';
import { useToast } from '../../components/feedback/ToastProvider';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Drawer } from '../../components/ui/Drawer';
import { SearchInput } from '../../components/ui/Field';
import { Pagination } from '../../components/ui/Pagination';
import type { DocumentChunk, DocumentItem, DocumentPreviewResponse } from '../../types/api';
import { formatBytes, formatDateTime } from '../../utils/format';
import { getErrorMessage } from '../../utils/errors';
import { DocumentProgress } from './DocumentProgress';
import { documentDisplayStatusLabel, documentDisplayStatusTone } from './documentDisplay';
import { documentFailureCopy, documentStalenessHint } from './documentFailure';

const CHUNK_PAGE_SIZE = 20;

type DocumentDetailDrawerProps = {
  chunkId?: string;
  documentId: string;
  knowledgeBaseId?: string;
  knowledgeBaseName?: string;
  onChanged?: () => void;
  onClose: () => void;
};

type DocumentOperation = 'download' | 'reprocess' | 'delete' | null;

export function DocumentDetailDrawer({
  chunkId,
  documentId,
  knowledgeBaseId,
  knowledgeBaseName,
  onChanged,
  onClose,
}: DocumentDetailDrawerProps) {
  const toast = useToast();
  const activeDocumentIdRef = useRef(documentId);
  const mountedRef = useRef(false);
  const mutationRef = useRef<symbol | null>(null);
  const sourceChunkRef = useRef<HTMLElement | null>(null);
  /** Which chunk has already been scrolled to, so focus moves once and not again. */
  const focusedChunkRef = useRef('');
  const [document, setDocument] = useState<DocumentItem | null>(null);
  const [documentScope, setDocumentScope] = useState<string | null>(null);
  const [preview, setPreview] = useState<DocumentPreviewResponse | null>(null);
  const [previewUrl, setPreviewUrl] = useState('');
  const [chunks, setChunks] = useState<DocumentChunk[]>([]);
  const [chunkQueryDraft, setChunkQueryDraft] = useState('');
  const [chunkQuery, setChunkQuery] = useState('');
  const [chunkPage, setChunkPage] = useState(1);
  const [chunkTotal, setChunkTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [chunksLoading, setChunksLoading] = useState(true);
  const [operation, setOperation] = useState<DocumentOperation>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [error, setError] = useState('');
  const [previewError, setPreviewError] = useState('');
  const [chunkError, setChunkError] = useState('');
  const submitting = operation !== null;
  activeDocumentIdRef.current = documentId;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      mutationRef.current = null;
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    mutationRef.current = null;
    setOperation(null);
    setConfirmDelete(false);
    setDeleteError('');
    setLoading(true);
    setError('');
    setDocument(null);
    setDocumentScope(null);
    setPreview(null);
    setPreviewUrl('');
    setPreviewError('');
    setChunks([]);
    setChunkQueryDraft('');
    setChunkQuery('');
    setChunkPage(1);
    setChunkTotal(0);
    setChunkError('');

    getDocument(documentId)
      .then(async (documentResponse) => {
        if (!mounted) return;
        // A citation deep-link can point at another knowledge base; refuse rather
        // than silently showing content from outside the current scope.
        if (knowledgeBaseId && documentResponse.knowledgeBaseId !== knowledgeBaseId) {
          setError('该文档不属于当前知识库，请从正确的知识库重新打开来源。');
          return;
        }

        setDocument(documentResponse);
        setDocumentScope(knowledgeBaseId ?? '');
        const previewResponse = await getDocumentPreview(documentId).catch((caught) => {
          if (mounted) setPreviewError(previewErrorMessage(caught, '文档预览加载失败'));
          return null;
        });
        if (!mounted) return;
        setPreview(previewResponse);
        if (previewResponse?.kind === 'file') {
          try {
            const blob = await downloadDocument(documentId);
            if (mounted) setPreviewUrl(URL.createObjectURL(blob));
          } catch (caught) {
            if (mounted) setPreviewError(previewErrorMessage(caught, '文件预览加载失败'));
          }
        }
      })
      .catch((caught) => {
        if (mounted) setError(previewErrorMessage(caught, '文档详情加载失败'));
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, [documentId, knowledgeBaseId]);

  useEffect(() => {
    if (!document || document.id !== documentId || documentScope !== (knowledgeBaseId ?? '')) {
      setChunks([]);
      setChunkTotal(0);
      setChunksLoading(false);
      return;
    }

    let mounted = true;
    setChunksLoading(true);
    setChunkError('');

    listDocumentChunks(documentId, {
      chunkId,
      page: chunkPage,
      pageSize: CHUNK_PAGE_SIZE,
      q: chunkQuery,
    })
      .then((response) => {
        if (!mounted) return;
        setChunks(response.items);
        setChunkTotal(response.total);
      })
      .catch((caught) => {
        if (!mounted) return;
        setChunkError(previewErrorMessage(caught, '内容片段加载失败'));
        setChunks([]);
        setChunkTotal(0);
      })
      .finally(() => {
        if (mounted) setChunksLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, [chunkId, chunkPage, chunkQuery, document, documentId, documentScope, knowledgeBaseId]);

  /**
   * Bring the cited chunk into view and put focus on it.
   *
   * The drawer's own focus handling cannot do this: `useModalFocus` focuses the panel
   * the moment it opens, which is before the chunk request has answered, so there is
   * nothing to focus yet. Hence a second, later focus move -- justified here because
   * the whole point of the deep link is that one chunk, and landing at the top of a
   * long drawer leaves the user to hunt for it.
   *
   * Only ever runs for a deep link (`chunkId` set), and only once per chunk, so it
   * cannot yank focus back after the user has moved on.
   */
  useEffect(() => {
    // The ref check is the one doing the work. `!chunkId` and `chunksLoading` are both
    // already covered by `sourceChunkRef` being null in those states -- kept because
    // they state the precondition, not because removing them changes behaviour.
    if (!chunkId || chunksLoading || focusedChunkRef.current === chunkId) return;
    const target = sourceChunkRef.current;
    if (!target) return;

    focusedChunkRef.current = chunkId;
    const reduceMotion = typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // Optional call: jsdom has no scrollIntoView, and a missing scroll must not stop
    // the focus move, which is the part that matters for keyboard and screen readers.
    target.scrollIntoView?.({
      behavior: reduceMotion ? 'auto' : 'smooth',
      block: 'center',
    });
    target.focus({ preventScroll: true });
  }, [chunkId, chunks, chunksLoading]);

  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  function guard(targetId: string, token: symbol): boolean {
    return mountedRef.current
      && activeDocumentIdRef.current === targetId
      && mutationRef.current === token;
  }

  async function handleReprocess() {
    if (!document || mutationRef.current) return;
    const targetId = document.id;
    const token = Symbol('reprocess-document');
    mutationRef.current = token;
    setOperation('reprocess');
    setError('');

    try {
      const next = await reprocessDocument(targetId);
      if (!guard(targetId, token)) return;
      setDocument(next);
      setChunks([]);
      setChunkTotal(0);
      setPreview(null);
      setPreviewUrl('');
      setPreviewError('');
      toast.success('已开始重新处理文档');
      onChanged?.();
    } catch (caught) {
      if (guard(targetId, token)) setError(previewErrorMessage(caught, '文档重处理失败'));
    } finally {
      if (guard(targetId, token)) {
        mutationRef.current = null;
        setOperation(null);
      }
    }
  }

  async function handleDelete() {
    if (!document || mutationRef.current) return;
    const targetId = document.id;
    const token = Symbol('delete-document');
    mutationRef.current = token;
    setOperation('delete');
    setDeleteError('');

    try {
      await deleteDocument(targetId);
      if (!guard(targetId, token)) return;
      setConfirmDelete(false);
      toast.success('文档已移入回收站');
      onChanged?.();
      onClose();
    } catch (caught) {
      if (guard(targetId, token)) setDeleteError(previewErrorMessage(caught, '文档删除失败'));
    } finally {
      if (guard(targetId, token)) {
        mutationRef.current = null;
        setOperation(null);
      }
    }
  }

  async function handleDownload() {
    if (!document || mutationRef.current) return;
    const targetId = document.id;
    const token = Symbol('download-document');
    mutationRef.current = token;
    setOperation('download');
    setError('');

    try {
      const blob = await downloadDocument(targetId);
      if (!guard(targetId, token)) return;
      const objectUrl = URL.createObjectURL(blob);
      const anchor = window.document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = document.filename;
      window.document.body.append(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
    } catch (caught) {
      if (guard(targetId, token)) setError(previewErrorMessage(caught, '文档下载失败'));
    } finally {
      if (guard(targetId, token)) {
        mutationRef.current = null;
        setOperation(null);
      }
    }
  }

  const failure = document ? documentFailureCopy(document) : null;
  const stalenessHint = document ? documentStalenessHint(document) : null;

  function handleChunkSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setChunkPage(1);
    setChunkQuery(chunkQueryDraft.trim());
  }

  return (
    <>
      <Drawer
        onClose={() => {
          if (!submitting) onClose();
        }}
        open
        title="文档详情"
        wide
      >
        {loading ? (
          <LoadingSkeleton announce compact columns={2} rows={6} />
        ) : (
          <>
            {error && <p className="ui-inline-error" role="alert">{error}</p>}
            {document && (
              <>
                <section className="doc-detail__head">
                  <span className="ui-kb-glyph ui-kb-glyph--lg" aria-hidden="true"><FileText /></span>
                  <div className="ui-cell-stack">
                    <strong>{document.filename}</strong>
                    <small>{knowledgeBaseName ?? document.knowledgeBaseId}</small>
                  </div>
                  <Badge tone={documentDisplayStatusTone(document.status, document.jobStatus)}>
                    {documentDisplayStatusLabel(document.status, document.jobStatus)}
                  </Badge>
                </section>

                <DocumentProgress document={document} />

                {document.status === 'failed' && failure && (
                  <div
                    className={document.jobStatus === 'cancelled' ? 'ui-muted' : 'ui-inline-error'}
                    role={document.jobStatus === 'cancelled' ? undefined : 'alert'}
                  >
                    <p>{failure.reason}</p>
                    {/* The drawer is where the advice belongs: it has the room the list
                        row does not, and it is where the retry button already is. */}
                    <p>{failure.advice}</p>
                  </div>
                )}

                {stalenessHint && (
                  <p className="ui-inline-notice" role="note">
                    <span>{stalenessHint}</span>
                    <span className="ui-muted">检索和引用不受影响。</span>
                  </p>
                )}

                <dl className="doc-meta-grid">
                  <div><dt>类型</dt><dd>{document.fileType || '—'}</dd></div>
                  <div><dt>大小</dt><dd>{formatBytes(document.fileSize)}</dd></div>
                  <div><dt>创建</dt><dd>{formatDateTime(document.createdAt)}</dd></div>
                  <div><dt>更新</dt><dd>{formatDateTime(document.updatedAt || document.createdAt)}</dd></div>
                </dl>

                <div className="doc-detail__actions">
                  <Button
                    disabled={submitting}
                    leadingIcon={<Download aria-hidden="true" />}
                    loading={operation === 'download'}
                    loadingLabel="下载中"
                    variant="secondary"
                    onClick={() => void handleDownload()}
                  >
                    下载
                  </Button>
                  <Button
                    disabled={submitting}
                    leadingIcon={<RotateCw aria-hidden="true" />}
                    loading={operation === 'reprocess'}
                    loadingLabel="处理中"
                    variant="secondary"
                    onClick={() => void handleReprocess()}
                  >
                    重新处理
                  </Button>
                  <span className="ui-toolbar__spacer" />
                  <Link
                    className="ui-button ui-button--ghost"
                    to={`/knowledge-bases/${document.knowledgeBaseId}/documents`}
                  >
                    <span>在知识库中打开</span>
                  </Link>
                  <Button
                    disabled={submitting}
                    leadingIcon={<Trash2 aria-hidden="true" />}
                    variant="ghost"
                    onClick={() => {
                      if (mutationRef.current) return;
                      setDeleteError('');
                      setConfirmDelete(true);
                    }}
                  >
                    删除
                  </Button>
                </div>

                <section className="ui-panel">
                  <div className="ui-panel__head">
                    <h3>预览</h3>
                    <span className="ui-panel__head-note">{preview?.contentType || '原始上传文件'}</span>
                  </div>
                  <div className="ui-panel__body doc-preview">
                    {previewError ? (
                      <p className="ui-inline-error" role="alert">{previewError}</p>
                    ) : !preview ? (
                      <LoadingSkeleton announce compact columns={1} rows={3} />
                    ) : preview.kind === 'text' ? (
                      <pre className="doc-preview__text">{preview.content || ''}</pre>
                    ) : previewUrl ? (
                      preview.fileType.toLowerCase() === 'pdf' || preview.contentType.includes('pdf') ? (
                        <iframe className="doc-preview__frame" src={previewUrl} title={`${preview.filename} 预览`} />
                      ) : (
                        <EmptyState
                          action={<a className="ui-button ui-button--secondary" href={previewUrl} rel="noreferrer" target="_blank"><span>在新标签页打开</span></a>}
                          description="这个文件类型需要用浏览器单独打开。"
                          title="无法内嵌预览"
                        />
                      )
                    ) : (
                      <LoadingSkeleton announce compact columns={1} rows={3} />
                    )}
                  </div>
                </section>

                <section className="ui-panel">
                  <div className="ui-panel__head">
                    <h3>{chunkId ? '引用来源片段' : '内容片段'}</h3>
                    {chunkId ? (
                      <span className="ui-panel__head-note">回答实际使用的片段</span>
                    ) : (
                      <form onSubmit={handleChunkSearch} role="search" style={{ flex: '0 1 220px' }}>
                        <SearchInput
                          aria-label="搜索内容片段"
                          onChange={(event) => setChunkQueryDraft(event.target.value)}
                          icon={<Search aria-hidden="true" />}
                          placeholder="搜索片段"
                          value={chunkQueryDraft}
                        />
                      </form>
                    )}
                  </div>
                  <div className="ui-panel__body">
                    {chunkError ? (
                      <p className="ui-inline-error" role="alert">{chunkError}</p>
                    ) : chunksLoading ? (
                      <LoadingSkeleton announce compact columns={1} rows={4} />
                    ) : chunks.length === 0 ? (
                      <EmptyState
                        description={chunkId
                          ? '可能已重新处理或删除。你仍可查看当前文档内容。'
                          : '文档完成处理后会在这里显示切片。'}
                        title={chunkId ? '未找到该引用片段' : '还没有内容片段'}
                      />
                    ) : (
                      <>
                        <div className="doc-chunks">
                          {chunks.map((chunk) => {
                            const isSource = Boolean(chunkId) && chunk.id === chunkId;
                            return (
                            <article
                              // Named, because focus lands here programmatically: without
                              // a label a screen reader would announce a bare group.
                              aria-label={isSource ? `引用来源片段 #${chunk.chunkIndex}` : undefined}
                              className={isSource ? 'doc-chunk is-source' : 'doc-chunk'}
                              key={chunk.id}
                              ref={isSource ? sourceChunkRef : undefined}
                              // -1, not 0: reachable for the focus move below but kept out
                              // of the tab order, so tabbing through the drawer is unchanged.
                              tabIndex={isSource ? -1 : undefined}
                            >
                              <header>
                                <strong>#{chunk.chunkIndex}</strong>
                                {isSource && <Badge tone="accent">引用来源</Badge>}
                                <span className="ui-muted">
                                  {chunk.tokenCount} 词元{chunk.pageNumber ? ` · p.${chunk.pageNumber}` : ''}
                                </span>
                              </header>
                              <p>{chunk.content}</p>
                            </article>
                            );
                          })}
                        </div>
                        {!chunkId && (
                          <Pagination
                            onPageChange={setChunkPage}
                            page={chunkPage}
                            pageSize={CHUNK_PAGE_SIZE}
                            total={chunkTotal}
                          />
                        )}
                      </>
                    )}
                  </div>
                </section>
              </>
            )}
          </>
        )}
      </Drawer>

      {confirmDelete && document && (
        <ConfirmDialog
          busy={submitting}
          confirmLabel="删除"
          description={`确认删除“${document.filename}”？文档会进入回收站，可随时恢复。`}
          error={deleteError}
          onCancel={() => {
            setDeleteError('');
            setConfirmDelete(false);
          }}
          onConfirm={handleDelete}
          title="删除文档"
        />
      )}
    </>
  );
}

function previewErrorMessage(caught: unknown, fallback: string): string {
  if (caught instanceof ApiError) {
    if (caught.code === 'DOCUMENT_FILE_NOT_FOUND') return '原始文件不存在，无法下载或预览。';
    if (caught.code === 'FILE_TOO_LARGE_FOR_PREVIEW') return '文件过大，无法在线预览，请下载后查看。';
  }
  return getErrorMessage(caught, fallback);
}
