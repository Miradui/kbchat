import { useCallback, useEffect, useState } from 'react';

import { ApiError } from '../../api/client';
import {
  batchRestoreDocuments,
  deleteDocumentPermanently,
  emptyDocumentRecycleBin,
  listDocumentRecycleBin,
  restoreDocument,
} from '../../api/resources';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';
import type { RecycleBinItem } from '../../types/api';

type DocumentRecycleBinDrawerProps = {
  onChanged: () => void;
  onClose: () => void;
};

export function DocumentRecycleBinDrawer({
  onChanged,
  onClose,
}: DocumentRecycleBinDrawerProps) {
  const [items, setItems] = useState<RecycleBinItem[]>([]);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(20);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [workingId, setWorkingId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<RecycleBinItem | null>(null);
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const [error, setError] = useState('');

  const loadPage = useCallback(async () => {
    setError('');
    const response = await listDocumentRecycleBin(page, pageSize);
    setItems(response.items);
    setTotal(response.total);
  }, [page, pageSize]);

  const refreshAfterMutation = useCallback(async (successLabel: string) => {
    onChanged();
    try {
      await loadPage();
    } catch (err) {
      setError(`${successLabel}，但回收站刷新失败：${errorMessage(err, '请求失败')}`);
    }
  }, [loadPage, onChanged]);

  useEffect(() => {
    let mounted = true;
    setLoading(true);

    loadPage()
      .catch((err) => {
        if (mounted) {
          setError(errorMessage(err, '文档回收站加载失败'));
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

  async function handleRestore(item: RecycleBinItem) {
    setWorkingId(item.id);
    setError('');

    try {
      try {
        await restoreDocument(item.id);
      } catch (err) {
        setError(errorMessage(err, '文档恢复失败'));
        return;
      }
      await refreshAfterMutation('文档已恢复');
    } finally {
      setWorkingId(null);
    }
  }

  async function handleRestorePage() {
    if (items.length === 0) {
      return;
    }

    setSubmitting(true);
    setError('');

    try {
      try {
        await batchRestoreDocuments(items.map((item) => item.id));
      } catch (err) {
        setError(errorMessage(err, '批量恢复失败'));
        return;
      }
      await refreshAfterMutation('本页文档已恢复');
    } finally {
      setSubmitting(false);
    }
  }

  async function handlePermanentDelete() {
    if (!deleteTarget) {
      return;
    }

    setSubmitting(true);
    setError('');

    try {
      try {
        await deleteDocumentPermanently(deleteTarget.id);
      } catch (err) {
        setError(errorMessage(err, '文档永久删除失败'));
        return;
      }
      setDeleteTarget(null);
      await refreshAfterMutation('文档已永久删除');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleEmptyRecycleBin() {
    setSubmitting(true);
    setError('');

    try {
      try {
        await emptyDocumentRecycleBin();
      } catch (err) {
        setError(errorMessage(err, '清空失败，后端按 all-or-nothing 语义未执行部分删除。'));
        return;
      }
      setConfirmEmpty(false);
      await refreshAfterMutation('回收站已清空');
    } finally {
      setSubmitting(false);
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <>
    <aside className="drawer-backdrop" role="presentation">
      <section className="drawer-panel document-recycle-drawer" role="dialog" aria-modal="true" aria-labelledby="document-recycle-title">
        <header>
          <div>
            <h2 id="document-recycle-title">文档回收站</h2>
            <p className="muted-text">展示当前用户已删除的文档，可恢复到原知识库。</p>
          </div>
          <button className="secondary-button" type="button" onClick={onClose}>
            关闭
          </button>
        </header>

        <div className="drawer-actions">
          <button className="secondary-button" type="button" onClick={() => void loadPage()} disabled={loading}>
            刷新
          </button>
          <button className="secondary-button" type="button" onClick={() => void handleRestorePage()} disabled={submitting || items.length === 0}>
            {submitting ? '恢复中...' : '恢复本页'}
          </button>
          <button className="danger-button" type="button" onClick={() => setConfirmEmpty(true)} disabled={submitting || items.length === 0}>
            清空回收站
          </button>
        </div>

        {error && <p className="drawer-error-text">{error}</p>}

        <div className="recycle-list document-recycle-list">
          {loading ? (
            <LoadingSkeleton rows={5} columns={2} compact />
          ) : items.length === 0 ? (
            <div className="empty-state">文档回收站为空。</div>
          ) : (
            items.map((item) => (
              <article className="recycle-item document-recycle-item" key={item.id}>
                <div>
                  <strong>{item.name}</strong>
                  <span>{item.knowledgeBaseName || '未知知识库'}</span>
                  <span>删除时间 {formatDateTime(item.deletedAt)}</span>
                </div>
                <div className="table-actions">
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() => void handleRestore(item)}
                    disabled={workingId === item.id || submitting}
                  >
                    {workingId === item.id ? '恢复中...' : '恢复'}
                  </button>
                  <button
                    className="danger-button"
                    type="button"
                    onClick={() => setDeleteTarget(item)}
                    disabled={submitting}
                  >
                    永久删除
                  </button>
                </div>
              </article>
            ))
          )}
        </div>

        <footer className="drawer-pagination">
          <span>共 {total} 条</span>
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
          </div>
        </footer>
      </section>
    </aside>
    {deleteTarget && (
      <ConfirmDialog
        title="永久删除文档"
        description={`确认永久删除“${deleteTarget.name}”？该操作不可恢复。`}
        confirmLabel="永久删除"
        busy={submitting}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={handlePermanentDelete}
      />
    )}
    {confirmEmpty && (
      <ConfirmDialog
        title="清空文档回收站"
        description="确认清空文档回收站？后端按 all-or-nothing 语义执行，失败时不会产生部分删除。"
        confirmLabel="清空"
        busy={submitting}
        onCancel={() => setConfirmEmpty(false)}
        onConfirm={handleEmptyRecycleBin}
      />
    )}
    </>
  );
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
    return err.message;
  }
  return fallback;
}
