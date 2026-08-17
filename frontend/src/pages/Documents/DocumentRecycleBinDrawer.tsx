import { useCallback, useEffect, useRef, useState } from 'react';

import {
  batchRestoreDocuments,
  deleteDocumentPermanently,
  emptyDocumentRecycleBin,
  listDocumentRecycleBin,
  restoreDocument,
} from '../../api/resources';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { EmptyState } from '../../components/feedback/EmptyState';
import { useToast } from '../../components/feedback/ToastProvider';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';
import { Button } from '../../components/ui/Button';
import { Drawer } from '../../components/ui/Drawer';
import { Pagination } from '../../components/ui/Pagination';
import { useEntityMutation } from '../../hooks/useEntityMutation';
import type { RecycleBinItem } from '../../types/api';
import { formatDateTime } from '../../utils/format';
import { getErrorMessage } from '../../utils/errors';

const PAGE_SIZE = 20;

type DocumentRecycleBinDrawerProps = {
  onChanged: () => void;
  onClose: () => void;
};

export function DocumentRecycleBinDrawer({ onChanged, onClose }: DocumentRecycleBinDrawerProps) {
  const toast = useToast();
  const mutation = useEntityMutation();
  const [items, setItems] = useState<RecycleBinItem[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<RecycleBinItem | null>(null);
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const [dialogError, setDialogError] = useState('');
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    const request = ++requestRef.current;
    setLoading(true);
    try {
      const response = await listDocumentRecycleBin(page, PAGE_SIZE);
      if (requestRef.current === request) {
        setItems(response.items);
        setTotal(response.total);
        setError('');
      }
    } catch (caught) {
      if (requestRef.current === request) setError(getErrorMessage(caught, '文档回收站加载失败'));
    } finally {
      if (requestRef.current === request) setLoading(false);
    }
  }, [page]);

  useEffect(() => {
    void load();
    return () => {
      requestRef.current += 1;
    };
  }, [load]);

  async function run(key: string, action: () => Promise<void>, success: string, failure: string) {
    await mutation.run(key, async () => {
      try {
        await action();
        toast.success(success);
        await load();
        onChanged();
      } catch (caught) {
        toast.error(getErrorMessage(caught, failure));
      }
    });
  }

  return (
    <>
      <Drawer
        headerActions={
          <>
            <Button
              disabled={loading || items.length === 0 || mutation.anyPending}
              variant="secondary"
              onClick={() => void run(
                'restore-page',
                async () => { await batchRestoreDocuments(items.map((item) => item.id)); },
                '本页文档已恢复',
                '批量恢复失败',
              )}
            >
              恢复本页
            </Button>
            <Button
              disabled={loading || items.length === 0 || mutation.anyPending}
              variant="secondary"
              onClick={() => {
                setDialogError('');
                setConfirmEmpty(true);
              }}
            >
              清空
            </Button>
          </>
        }
        onClose={onClose}
        open
        title="文档回收站"
      >
        {loading && items.length === 0 ? (
          <LoadingSkeleton announce compact columns={2} rows={5} />
        ) : error ? (
          <div className="ui-inline-error" role="alert">
            <span>{error}</span>
            <Button variant="link" onClick={() => void load()}>重试</Button>
          </div>
        ) : items.length === 0 ? (
          <EmptyState title="回收站为空" description="删除的文档会先移到这里，可恢复到原知识库。" />
        ) : (
          <>
            <div className="recycle-list">
              {items.map((item) => (
                <article className="recycle-list__item" key={item.id}>
                  <div className="ui-cell-stack">
                    <strong>{item.name}</strong>
                    <small>{item.knowledgeBaseName || '未知知识库'} · 删除于 {formatDateTime(item.deletedAt)}</small>
                  </div>
                  <div className="recycle-list__actions">
                    <Button
                      disabled={mutation.isPending(item.id)}
                      loading={mutation.isPending(item.id)}
                      loadingLabel="恢复中"
                      variant="secondary"
                      onClick={() => void run(item.id, () => restoreDocument(item.id), '文档恢复成功', '文档恢复失败')}
                    >
                      恢复
                    </Button>
                    <Button
                      disabled={mutation.isPending(item.id)}
                      variant="ghost"
                      onClick={() => {
                        setDialogError('');
                        setDeleteTarget(item);
                      }}
                    >
                      永久删除
                    </Button>
                  </div>
                </article>
              ))}
            </div>
            <Pagination onPageChange={setPage} page={page} pageSize={PAGE_SIZE} total={total} />
          </>
        )}
      </Drawer>

      {deleteTarget && (
        <ConfirmDialog
          busy={mutation.isPending(`permanent-${deleteTarget.id}`)}
          confirmLabel="永久删除"
          description={`确认永久删除“${deleteTarget.name}”？该操作不可恢复。`}
          error={dialogError}
          onCancel={() => {
            setDialogError('');
            setDeleteTarget(null);
          }}
          onConfirm={() => {
            const target = deleteTarget;
            void mutation.run(`permanent-${target.id}`, async () => {
              try {
                await deleteDocumentPermanently(target.id);
                setDeleteTarget(null);
                toast.success('文档已永久删除');
                await load();
                onChanged();
              } catch (caught) {
                setDialogError(getErrorMessage(caught, '文档永久删除失败'));
              }
            });
          }}
          title="永久删除文档"
        />
      )}

      {confirmEmpty && (
        <ConfirmDialog
          busy={mutation.isPending('empty')}
          confirmLabel="清空"
          description="确认清空文档回收站？操作失败时不会删除其中任何文档。"
          error={dialogError}
          onCancel={() => {
            setDialogError('');
            setConfirmEmpty(false);
          }}
          onConfirm={() => {
            void mutation.run('empty', async () => {
              try {
                await emptyDocumentRecycleBin();
                setConfirmEmpty(false);
                toast.success('文档回收站已清空');
                await load();
                onChanged();
              } catch (caught) {
                setDialogError(getErrorMessage(caught, '清空失败，未删除任何文档。'));
              }
            });
          }}
          title="清空文档回收站"
        />
      )}
    </>
  );
}
