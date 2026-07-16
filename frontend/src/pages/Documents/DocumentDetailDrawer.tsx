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
import { LoadingSkeleton } from '../../components/LoadingSkeleton';
import type { DocumentChunk, DocumentItem, DocumentPreviewResponse, DocumentStatus } from '../../types/api';
import { DocumentProgress } from './DocumentProgress';

type DocumentDetailDrawerProps = {
  documentId: string;
  knowledgeBaseName?: string;
  onChanged?: () => void;
  onClose: () => void;
};

export function DocumentDetailDrawer({
  documentId,
  knowledgeBaseName,
  onChanged,
  onClose,
}: DocumentDetailDrawerProps) {
  const mountedRef = useRef(true);
  const mutationInFlightRef = useRef(false);
  const [document, setDocument] = useState<DocumentItem | null>(null);
  const [preview, setPreview] = useState<DocumentPreviewResponse | null>(null);
  const [previewUrl, setPreviewUrl] = useState('');
  const [chunks, setChunks] = useState<DocumentChunk[]>([]);
  const [chunkQueryDraft, setChunkQueryDraft] = useState('');
  const [chunkQuery, setChunkQuery] = useState('');
  const [chunkPage, setChunkPage] = useState(1);
  const [chunkPageSize] = useState(20);
  const [chunkTotal, setChunkTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [chunksLoading, setChunksLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState('');
  const [previewError, setPreviewError] = useState('');
  const [chunkError, setChunkError] = useState('');

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    setError('');
    setPreview(null);
    setPreviewUrl('');
    setPreviewError('');

    Promise.all([
      getDocument(documentId),
      getDocumentPreview(documentId).catch((err) => {
        if (mounted) {
          setPreviewError(errorMessage(err, '文档预览加载失败'));
        }
        return null;
      }),
    ])
      .then(async ([documentResponse, previewResponse]) => {
        if (!mounted) {
          return;
        }
        setDocument(documentResponse);
        setPreview(previewResponse);
        if (previewResponse?.kind === 'file') {
          try {
            const blob = await downloadDocument(documentId);
            if (mounted) {
              setPreviewUrl(URL.createObjectURL(blob));
            }
          } catch (err) {
            if (mounted) {
              setPreviewError(errorMessage(err, '文件预览加载失败'));
            }
          }
        }
      })
      .catch((err) => {
        if (mounted) {
          setError(errorMessage(err, '文档详情加载失败'));
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
  }, [documentId]);

  useEffect(() => {
    let mounted = true;
    setChunksLoading(true);
    setChunkError('');

    listDocumentChunks(documentId, {
      page: chunkPage,
      pageSize: chunkPageSize,
      q: chunkQuery,
    })
      .then((response) => {
        if (!mounted) {
          return;
        }
        setChunks(response.items);
        setChunkTotal(response.total);
      })
      .catch((err) => {
        if (mounted) {
          setChunkError(errorMessage(err, 'Chunks 加载失败'));
          setChunks([]);
          setChunkTotal(0);
        }
      })
      .finally(() => {
        if (mounted) {
          setChunksLoading(false);
        }
      });

    return () => {
      mounted = false;
    };
  }, [chunkPage, chunkPageSize, chunkQuery, documentId]);

  useEffect(() => {
    return () => {
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
      }
    };
  }, [previewUrl]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  async function handleReprocess() {
    if (!document || mutationInFlightRef.current) {
      return;
    }

    mutationInFlightRef.current = true;
    setSubmitting(true);
    setError('');

    try {
      const nextDocument = await reprocessDocument(document.id);
      if (!mountedRef.current) {
        return;
      }
      setDocument(nextDocument);
      setChunks([]);
      setChunkTotal(0);
      setPreview(null);
      setPreviewUrl('');
      setPreviewError('');
      onChanged?.();
    } catch (err) {
      if (mountedRef.current) {
        setError(errorMessage(err, '文档重处理失败'));
      }
    } finally {
      mutationInFlightRef.current = false;
      if (mountedRef.current) {
        setSubmitting(false);
      }
    }
  }

  async function handleDelete() {
    if (!document || mutationInFlightRef.current) {
      return;
    }

    mutationInFlightRef.current = true;
    setSubmitting(true);
    setError('');

    try {
      await deleteDocument(document.id);
      if (!mountedRef.current) {
        return;
      }
      setConfirmDelete(false);
      onChanged?.();
      onClose();
    } catch (err) {
      if (mountedRef.current) {
        setError(errorMessage(err, '文档删除失败'));
      }
    } finally {
      mutationInFlightRef.current = false;
      if (mountedRef.current) {
        setSubmitting(false);
      }
    }
  }

  function handleChunkSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setChunkPage(1);
    setChunkQuery(chunkQueryDraft.trim());
  }

  async function handleDownload() {
    if (!document || mutationInFlightRef.current) {
      return;
    }

    mutationInFlightRef.current = true;
    setSubmitting(true);
    setError('');

    try {
      const blob = await downloadDocument(document.id);
      if (!mountedRef.current) {
        return;
      }
      const objectUrl = URL.createObjectURL(blob);
      const anchor = window.document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = document.filename;
      window.document.body.append(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
    } catch (err) {
      if (mountedRef.current) {
        setError(errorMessage(err, '文档下载失败'));
      }
    } finally {
      mutationInFlightRef.current = false;
      if (mountedRef.current) {
        setSubmitting(false);
      }
    }
  }

  const chunkTotalPages = Math.max(1, Math.ceil(chunkTotal / chunkPageSize));

  return (
    <>
      <aside className="drawer-backdrop" role="presentation">
        <section className="drawer-panel document-detail-drawer" role="dialog" aria-modal="true" aria-labelledby="document-detail-title">
          <header>
            <div>
              <h2 id="document-detail-title">文档详情</h2>
              <p className="muted-text">查看后端文档状态和切分后的 chunks。</p>
            </div>
            <button className="secondary-button" type="button" onClick={onClose} disabled={submitting}>
              关闭
            </button>
          </header>

          {loading ? (
            <LoadingSkeleton rows={6} columns={2} compact />
          ) : (
            <>
              {error && <p className="drawer-error-text" role="alert">{error}</p>}
              {document ? (
                <div className="document-detail-content">
                  <section className="document-detail-summary">
                    <div className="document-detail-title">
                      <span className="document-file-icon" aria-hidden="true" />
                      <div>
                        <strong>{document.filename}</strong>
                        <span>{knowledgeBaseName ?? document.knowledgeBaseId}</span>
                      </div>
                    </div>
                    <span className={`status-pill status-${statusClass(document.status)}`}>
                      {statusLabel(document.status)}
                    </span>
                  </section>

                  <DocumentProgress document={document} />

                  <dl className="document-meta-grid">
                    <div>
                      <dt>类型</dt>
                      <dd>{document.fileType || '-'}</dd>
                    </div>
                    <div>
                      <dt>大小</dt>
                      <dd>{formatBytes(document.fileSize)}</dd>
                    </div>
                    <div>
                      <dt>创建时间</dt>
                      <dd>{formatDateTime(document.createdAt)}</dd>
                    </div>
                    <div>
                      <dt>更新时间</dt>
                      <dd>{formatDateTime(document.updatedAt || document.createdAt)}</dd>
                    </div>
                  </dl>

                  {document.errorMessage && (
                    <p className="document-alert error-text">{document.errorMessage}</p>
                  )}

                  <div className="document-detail-actions">
                    <Link
                      aria-disabled={submitting}
                      className="secondary-link"
                      tabIndex={submitting ? -1 : undefined}
                      to={`/knowledge-bases/${document.knowledgeBaseId}/documents`}
                      onClick={(event) => {
                        if (submitting) {
                          event.preventDefault();
                        }
                      }}
                    >
                      进入处理队列
                    </Link>
                    <button className="secondary-button" type="button" onClick={() => void handleDownload()} disabled={submitting}>
                      下载
                    </button>
                    <button className="secondary-button" type="button" onClick={() => void handleReprocess()} disabled={submitting}>
                      {submitting ? '处理中...' : '重处理'}
                    </button>
                    <button className="danger-button" type="button" onClick={() => setConfirmDelete(true)} disabled={submitting}>
                      删除
                    </button>
                  </div>

                  <section className="document-preview-section">
                    <header>
                      <div>
                        <h3>预览</h3>
                        <p className="muted-text">{preview?.contentType || '读取原始上传文件'}</p>
                      </div>
                    </header>
                    {previewError ? (
                      <div className="empty-state" role="alert">{previewError}</div>
                    ) : !preview ? (
                      <LoadingSkeleton rows={3} columns={1} compact />
                    ) : preview.kind === 'text' ? (
                      <pre className="document-text-preview">{preview.content || ''}</pre>
                    ) : previewUrl ? (
                      preview.fileType.toLowerCase() === 'pdf' || preview.contentType.includes('pdf') ? (
                        <iframe className="document-file-preview" src={previewUrl} title={`${preview.filename} 预览`} />
                      ) : (
                        <div className="empty-state">
                          该文件类型使用浏览器打开预览。
                          <a className="secondary-link" href={previewUrl} target="_blank" rel="noreferrer">
                            打开文件
                          </a>
                        </div>
                      )
                    ) : (
                      <LoadingSkeleton rows={3} columns={1} compact />
                    )}
                  </section>

                  <section className="document-chunk-section">
                    <header>
                      <div>
                        <h3>Chunks</h3>
                        <p className="muted-text">共 {chunkTotal} 个切片。</p>
                      </div>
                      <form className="chunk-search-form" onSubmit={handleChunkSearch}>
                        <input
                          aria-label="搜索 chunk 内容"
                          placeholder="搜索 chunk"
                          value={chunkQueryDraft}
                          onChange={(event) => setChunkQueryDraft(event.target.value)}
                        />
                        <button className="secondary-button" type="submit" disabled={chunksLoading}>
                          搜索
                        </button>
                      </form>
                    </header>

                    {chunkError ? (
                      <div className="empty-state" role="alert">{chunkError}</div>
                    ) : chunksLoading ? (
                      <LoadingSkeleton rows={4} columns={1} compact />
                    ) : chunks.length === 0 ? (
                      <div className="empty-state">当前文档还没有 chunks。处理中或失败的文档可能为空。</div>
                    ) : (
                      <>
                        <div className="document-chunk-list">
                          {chunks.map((chunk) => (
                            <article className="document-chunk-card" key={chunk.id}>
                              <header>
                                <strong>#{chunk.chunkIndex}</strong>
                                <span>
                                  {chunk.tokenCount} tokens
                                  {chunk.pageNumber ? ` · p.${chunk.pageNumber}` : ''}
                                </span>
                              </header>
                              <p>{chunk.content}</p>
                              {Object.keys(chunk.metadata ?? {}).length > 0 && (
                                <code>{JSON.stringify(chunk.metadata)}</code>
                              )}
                            </article>
                          ))}
                        </div>
                        <footer className="drawer-pagination chunk-pagination">
                          <span>第 {chunkPage} / {chunkTotalPages} 页</span>
                          <div className="pager">
                            <button
                              className="secondary-button"
                              type="button"
                              disabled={chunkPage <= 1 || chunksLoading}
                              onClick={() => setChunkPage(chunkPage - 1)}
                            >
                              ‹
                            </button>
                            <button className="secondary-button active-page" type="button">
                              {chunkPage}
                            </button>
                            <button
                              className="secondary-button"
                              type="button"
                              disabled={chunkPage >= chunkTotalPages || chunksLoading}
                              onClick={() => setChunkPage(chunkPage + 1)}
                            >
                              ›
                            </button>
                          </div>
                        </footer>
                      </>
                    )}
                  </section>
                </div>
              ) : (
                null
              )}
            </>
          )}
        </section>
      </aside>

      {confirmDelete && document && (
        <ConfirmDialog
          title="删除文档"
          description={`确认删除“${document.filename}”？文档会进入回收站。`}
          confirmLabel="删除"
          busy={submitting}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={handleDelete}
        />
      )}
    </>
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
  if (err instanceof ApiError) {
    if (err.code === 'DOCUMENT_FILE_NOT_FOUND') {
      return '原始文件不存在，无法下载或预览。';
    }
    if (err.code === 'FILE_TOO_LARGE_FOR_PREVIEW') {
      return '文件过大，无法在线预览，请下载后查看。';
    }
    return err.message;
  }
  return fallback;
}
