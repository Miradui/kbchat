import { useEffect, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { deleteChatBookmark, listChatBookmarks, saveChatBookmark } from '../../api/resources';
import { ApiError } from '../../api/client';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { useUnsavedChangesWarning } from '../../components/feedback/useUnsavedChangesWarning';
import { Button } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';
import { Field, SearchInput } from '../../components/ui/Field';
import type { ChatBookmark, ChatBookmarkItem, ChatMessageSearchItem } from '../../types/api';
import { getErrorMessage } from '../../utils/errors';
import { ChatSearchExcerptText } from './ChatSearchDialog';
import { PERSONAL_PAGE_SIZE, usePersonalList } from './usePersonalList';

export type BookmarkTarget = { messageId: string; sessionId: string; bookmark?: ChatBookmark | null };
type BookmarkCallbacks = {
  onUpdated: (id: string, bookmark: ChatBookmark | null) => void;
  onInaccessible?: (error: unknown, sessionId: string) => void;
};

export function ChatBookmarkDialog({ target, onClose, onUpdated, onInaccessible }: BookmarkCallbacks & { target: BookmarkTarget; onClose: () => void }) {
  const [note, setNote] = useState(target.bookmark?.note ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [discard, setDiscard] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const dirty = note !== (target.bookmark?.note ?? '');
  useUnsavedChangesWarning(dirty);
  function close() { if (!pending.current) { if (dirty) setDiscard(true); else onClose(); } }
  async function save(remove = false) {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError('');
    try {
      const bookmark = remove ? (await deleteChatBookmark(target.messageId), null) : await saveChatBookmark(target.messageId, note);
      if (mounted.current) { onUpdated(target.messageId, bookmark); onClose(); }
    } catch (caught) {
      if (!mounted.current) return;
      if (caught instanceof ApiError && (caught.status === 403 || caught.status === 404)) {
        onClose(); onInaccessible?.(caught, target.sessionId);
      } else setError(getErrorMessage(caught, '收藏未保存，请重试。'));
    } finally { pending.current = false; if (mounted.current) setBusy(false); }
  }
  return <>
    <Dialog open title={target.bookmark ? '编辑收藏备注' : '收藏回答'} description="收藏当前回答版本，备注仅自己可见。" onClose={close}>
      <form className="ui-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <Field label="个人备注（可选）" hint="最多 4000 字。">
          <textarea aria-label="个人备注" className="ui-input" rows={6} maxLength={4000} value={note} disabled={busy} onChange={(event) => setNote(event.target.value)} />
        </Field>
        {error && <p role="alert" className="ui-inline-error">{error}</p>}
        <div className="ui-dialog__actions">
          {target.bookmark && <Button variant="danger" disabled={busy} onClick={() => void save(true)}>取消收藏</Button>}
          <Button variant="secondary" disabled={busy} onClick={close}>取消</Button>
          <Button type="submit" variant="primary" loading={busy}>保存收藏</Button>
        </div>
      </form>
    </Dialog>
    {discard && <ConfirmDialog title="放弃备注修改？" description="尚未保存的备注将丢失。" confirmLabel="放弃修改" onCancel={() => setDiscard(false)} onConfirm={onClose} />}
  </>;
}

export function ChatBookmarksDialog({ onClose, onSelect, onUpdated, onInaccessible }: BookmarkCallbacks & { onClose: () => void; onSelect: (item: ChatMessageSearchItem) => void }) {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [composing, setComposing] = useState(false);
  const [target, setTarget] = useState<ChatBookmarkItem | null>(null);
  const list = usePersonalList(listChatBookmarks, query, page, !composing);
  return <>
    <Dialog open title="收藏与笔记" description="搜索收藏的回答、会话标题或个人备注；点击原文可查看引用。" className="chat-search-dialog" onClose={onClose}>
      <SearchInput icon={<Search aria-hidden="true" />} aria-label="搜索收藏与备注" placeholder="搜索回答或备注" value={query} maxLength={200}
        onChange={(event) => { setQuery(event.target.value); setPage(1); }} onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)} />
      <div className="chat-search-dialog__results" aria-busy={list.loading}>
        <p role="status">{list.loading ? '正在加载收藏…' : list.error ? '加载未完成。' : `共 ${list.total} 条收藏`}</p>
        {list.error && <p role="alert">{list.error} <Button onClick={list.refresh}>重试</Button></p>}
        {!list.loading && !list.error && !list.items.length && <p>暂无匹配收藏。可以在回答下方收藏并添加备注。</p>}
        {list.items.map((item) => <article className="chat-bookmark" key={item.messageId}>
          <button type="button" className="chat-search-result" onClick={() => onSelect(item)}>
            <span className="chat-search-result__title"><strong>{item.sessionTitle || '未命名会话'}</strong>{item.archivedAt && <small>已归档</small>}</span>
            <span className="chat-find__excerpt"><ChatSearchExcerptText excerpt={item.excerpt} /></span>
            <small>查看原回答和引用</small>
          </button>
          {item.bookmark.note && <p className="chat-bookmark__note">{item.bookmark.note}</p>}
          <Button variant="ghost" onClick={() => setTarget(item)}>编辑备注 / 取消收藏</Button>
        </article>)}
      </div>
      <div className="chat-search-dialog__actions"><div className="chat-search-dialog__pages">
        <Button variant="ghost" disabled={list.loading || page <= 1} onClick={() => setPage((value) => value - 1)}>上一页</Button>
        <span>{page} / {Math.max(page, Math.ceil(list.total / PERSONAL_PAGE_SIZE))}</span>
        <Button variant="ghost" disabled={list.loading || page * PERSONAL_PAGE_SIZE >= list.total} onClick={() => setPage((value) => value + 1)}>下一页</Button>
      </div><Button variant="secondary" onClick={onClose}>关闭收藏</Button></div>
    </Dialog>
    {target && <ChatBookmarkDialog key={target.messageId} target={target} onClose={() => setTarget(null)} onUpdated={(id, bookmark) => {
      onUpdated(id, bookmark); if (!bookmark && list.items.length === 1 && page > 1) setPage(page - 1); list.refresh();
    }} onInaccessible={(error, session) => { list.refresh(); onInaccessible?.(error, session); }} />}
  </>;
}
