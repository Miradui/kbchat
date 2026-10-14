import { Search } from 'lucide-react';
import { useState } from 'react';

import { Button } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';
import { SearchInput } from '../../components/ui/Field';
import type { ChatMessageSearchItem, ChatSearchExcerpt } from '../../types/api';
import { formatDateTime } from '../../utils/format';
import { CHAT_SEARCH_PAGE_SIZE, useChatSearch } from './useChatSearch';

export function ChatSearchExcerptText({ excerpt }: { excerpt: ChatSearchExcerpt }) {
  return <>{excerpt.before}{excerpt.match && <mark>{excerpt.match}</mark>}{excerpt.after}</>;
}

export function ChatSearchDialog({ onClose, onSelect }: {
  onClose: () => void;
  onSelect: (item: ChatMessageSearchItem) => void;
}) {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [composing, setComposing] = useState(false);
  const search = useChatSearch(query, page, !composing);
  return <Dialog open title="搜索会话内容" description="查找自己的提问和回答，包含活跃及已归档会话。" className="chat-search-dialog" onClose={onClose}>
    <SearchInput icon={<Search aria-hidden="true" />} aria-label="搜索所有会话的关键词" placeholder="输入问题或回答中的关键词" maxLength={200}
      value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }}
      onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)} />
    <div className="chat-search-dialog__results" aria-busy={search.loading}>
      <p role="status" className="chat-search-dialog__status">{!query.trim() ? '输入关键词，点击结果可定位到原消息。'
        : search.loading ? '正在搜索消息…' : search.error ? '搜索未完成。' : search.total ? `找到 ${search.total} 条匹配消息` : '没有匹配消息，试试其他关键词。'}</p>
      {search.error && <div className="ui-inline-error" role="alert"><span>{search.error}</span><Button variant="link" onClick={search.retry}>重试搜索</Button></div>}
      {search.items.map((item) => <button type="button" className="chat-search-result" key={item.messageId} onClick={() => onSelect(item)}>
        <span className="chat-search-result__title"><strong>{item.sessionTitle || '未命名会话'}</strong>{item.archivedAt && <small>已归档</small>}</span>
        <span className="chat-find__excerpt"><ChatSearchExcerptText excerpt={item.excerpt} /></span>
        <small>{item.role === 'user' ? '提问' : '回答'} · {formatDateTime(item.createdAt)}</small>
      </button>)}
    </div>
    <div className="chat-search-dialog__actions">
      <div className="chat-search-dialog__pages">
        <Button variant="ghost" disabled={search.loading || page <= 1} onClick={() => setPage((value) => value - 1)}>上一页</Button>
        <span>{page} / {Math.max(page, Math.ceil(search.total / CHAT_SEARCH_PAGE_SIZE))}</span>
        <Button variant="ghost" disabled={search.loading || page * CHAT_SEARCH_PAGE_SIZE >= search.total} onClick={() => setPage((value) => value + 1)}>下一页</Button>
      </div>
      <Button variant="secondary" onClick={onClose}>关闭搜索</Button>
    </div>
  </Dialog>;
}
