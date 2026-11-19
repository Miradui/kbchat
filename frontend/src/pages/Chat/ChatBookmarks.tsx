import { useEffect, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { deleteChatBookmark, listChatBookmarks, saveChatBookmark } from '../../api/resources';
import { ApiError } from '../../api/client';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { useUnsavedChangesWarning } from '../../components/feedback/useUnsavedChangesWarning';
import { Button } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';
import { Field, SearchInput, Textarea } from '../../components/ui/Field';
import { Pagination } from '../../components/ui/Pagination';
import type { ChatBookmark, ChatBookmarkItem, ChatMessageSearchItem } from '../../types/api';
import { getErrorMessage } from '../../utils/errors';
import { ChatSearchExcerptText } from './ChatSearchDialog';
import { PERSONAL_PAGE_SIZE, usePersonalList } from './usePersonalList';

export type BookmarkTarget = { messageId: string; sessionId: string; bookmark?: ChatBookmark | null };
type BookmarkCallbacks = {
  onUpdated: (id: string, bookmark: ChatBookmark | null) => void;
  onInaccessible?: (error: unknown, sessionId: string) => void;
};

function BookmarkNoteEditor({
  target,
  cancelLabel,
  onDone,
  onUpdated,
  onInaccessible,
  onDiscardChange,
  onRequestCancel,
  discard,
  onCancelDiscard,
  onConfirmDiscard,
}: BookmarkCallbacks & {
  target: BookmarkTarget;
  cancelLabel: string;
  onDone: (removed: boolean) => void;
  onDiscardChange?: (dirty: boolean) => void;
  onRequestCancel: (dirty: boolean) => void;
  discard: boolean;
  onCancelDiscard: () => void;
  onConfirmDiscard: () => void;
}) {
  const [note, setNote] = useState(target.bookmark?.note ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const dirty = note !== (target.bookmark?.note ?? '');
  useUnsavedChangesWarning(dirty);
  useEffect(() => { onDiscardChange?.(dirty); }, [dirty, onDiscardChange]);

  async function save(remove = false) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      const bookmark = remove ? (await deleteChatBookmark(target.messageId), null) : await saveChatBookmark(target.messageId, note);
      if (mounted.current) {
        onUpdated(target.messageId, bookmark);
        onDone(remove);
      }
    } catch (caught) {
      if (!mounted.current) return;
      if (caught instanceof ApiError && (caught.status === 403 || caught.status === 404)) {
        onDone(true);
        onInaccessible?.(caught, target.sessionId);
      } else {
        setError(getErrorMessage(caught, '收藏未保存，请重试。'));
      }
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <>
      <form className="ui-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <Field label="个人备注（可选）" hint="最多 4000 字。">
          <Textarea
            aria-label="个人备注"
            disabled={busy}
            maxLength={4000}
            onChange={(event) => setNote(event.target.value)}
            rows={6}
            value={note}
          />
        </Field>
        {error && <p className="ui-inline-error" role="alert">{error}</p>}
        <div className="ui-dialog__actions">
          {target.bookmark && <Button disabled={busy} onClick={() => void save(true)} variant="danger">取消收藏</Button>}
          <Button disabled={busy} onClick={() => { if (!pending.current) onRequestCancel(dirty); }} variant="secondary">{cancelLabel}</Button>
          <Button loading={busy} type="submit" variant="primary">保存收藏</Button>
        </div>
      </form>
      {discard && (
        <ConfirmDialog
          confirmLabel="放弃修改"
          description="尚未保存的备注将丢失。"
          onCancel={onCancelDiscard}
          onConfirm={onConfirmDiscard}
          title="放弃备注修改？"
        />
      )}
    </>
  );
}

export function ChatBookmarkDialog({
  target,
  onClose,
  onUpdated,
  onInaccessible,
}: BookmarkCallbacks & { target: BookmarkTarget; onClose: () => void }) {
  const [discard, setDiscard] = useState(false);
  const dirtyRef = useRef(false);

  return (
    <Dialog
      description="收藏当前回答版本，备注仅自己可见。"
      onClose={() => { if (dirtyRef.current) setDiscard(true); else onClose(); }}
      open
      title={target.bookmark ? '编辑收藏备注' : '收藏回答'}
    >
      <BookmarkNoteEditor
        cancelLabel="取消"
        discard={discard}
        onCancelDiscard={() => setDiscard(false)}
        onConfirmDiscard={onClose}
        onDiscardChange={(dirty) => { dirtyRef.current = dirty; }}
        onDone={() => onClose()}
        onInaccessible={onInaccessible}
        onRequestCancel={(dirty) => { if (dirty) setDiscard(true); else onClose(); }}
        onUpdated={onUpdated}
        target={target}
      />
    </Dialog>
  );
}

export function ChatBookmarksDialog({
  onClose,
  onSelect,
  onUpdated,
  onInaccessible,
}: BookmarkCallbacks & { onClose: () => void; onSelect: (item: ChatMessageSearchItem) => void }) {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [composing, setComposing] = useState(false);
  const [target, setTarget] = useState<ChatBookmarkItem | null>(null);
  const [discard, setDiscard] = useState(false);
  const dirtyRef = useRef(false);
  const list = usePersonalList(listChatBookmarks, query, page, !target && !composing);

  function requestCloseOrBack() {
    if (target) {
      if (dirtyRef.current) setDiscard(true);
      else setTarget(null);
      return;
    }
    onClose();
  }

  return (
    <Dialog
      className="chat-search-dialog"
      description={target ? '收藏当前回答版本，备注仅自己可见。' : '搜索收藏的回答、会话标题或个人备注；点击原文可查看引用。'}
      onClose={requestCloseOrBack}
      open
      title={target ? '编辑收藏备注' : '收藏与笔记'}
    >
      {!target ? (
        <>
          <SearchInput
            aria-label="搜索收藏与备注"
            icon={<Search aria-hidden="true" />}
            maxLength={200}
            onChange={(event) => { setQuery(event.target.value); setPage(1); }}
            onCompositionEnd={() => setComposing(false)}
            onCompositionStart={() => setComposing(true)}
            placeholder="搜索回答或备注"
            value={query}
          />
          <div aria-busy={list.loading} className="chat-search-dialog__results">
            <p className="chat-search-dialog__status" role="status">
              {list.loading ? '正在加载收藏…' : list.error ? '加载未完成。' : `共 ${list.total} 条收藏`}
            </p>
            {list.error && <p className="ui-inline-error" role="alert">{list.error} <Button onClick={list.refresh} variant="link">重试</Button></p>}
            {!list.loading && !list.error && !list.items.length && <p className="ui-muted">暂无匹配收藏。可以在回答下方收藏并添加备注。</p>}
            {list.items.map((item) => (
              <article className="chat-bookmark" key={item.messageId}>
                <button className="chat-search-result" onClick={() => onSelect(item)} type="button">
                  <span className="chat-search-result__title"><strong>{item.sessionTitle || '未命名会话'}</strong>{item.archivedAt && <small>已归档</small>}</span>
                  <span className="chat-find__excerpt"><ChatSearchExcerptText excerpt={item.excerpt} /></span>
                  <small>查看原回答和引用</small>
                </button>
                {item.bookmark.note && <p className="chat-bookmark__note">{item.bookmark.note}</p>}
                <Button onClick={() => setTarget(item)} variant="ghost">编辑备注 / 取消收藏</Button>
              </article>
            ))}
          </div>
          <div className="chat-search-dialog__actions">
            <Pagination compact onPageChange={setPage} page={page} pageSize={PERSONAL_PAGE_SIZE} total={list.total} />
            <Button onClick={onClose} variant="secondary">关闭收藏</Button>
          </div>
        </>
      ) : (
        <BookmarkNoteEditor
          cancelLabel="返回收藏列表"
          discard={discard}
          key={target.messageId}
          onCancelDiscard={() => setDiscard(false)}
          onConfirmDiscard={() => { setDiscard(false); setTarget(null); }}
          onDiscardChange={(dirty) => { dirtyRef.current = dirty; }}
          onDone={(removed) => {
            if (removed && list.items.length === 1 && page > 1) setPage(page - 1);
            setTarget(null);
            list.refresh();
          }}
          onInaccessible={(error, session) => {
            setTarget(null);
            list.refresh();
            onInaccessible?.(error, session);
          }}
          onRequestCancel={(dirty) => { if (dirty) setDiscard(true); else setTarget(null); }}
          onUpdated={onUpdated}
          target={target}
        />
      )}
    </Dialog>
  );
}
