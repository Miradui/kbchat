import { ChevronDown, ChevronUp } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';

import { Button } from '../../components/ui/Button';
import { IconButton } from '../../components/ui/IconButton';
import type { ChatMessage, ChatMessageSearchItem } from '../../types/api';
import { ChatSearchExcerptText } from './ChatSearchDialog';
import { CHAT_SEARCH_PAGE_SIZE, useChatSearch } from './useChatSearch';

type Match = Pick<ChatMessageSearchItem, 'messageId' | 'role' | 'excerpt'>;

export function useChatMessageSearch({ sessionId, messages, ready, complete = true, blocked = false, missingMessageId = '', targetMessageId, onLocate }: {
  sessionId?: string;
  messages: ChatMessage[];
  ready: boolean;
  complete?: boolean;
  blocked?: boolean;
  missingMessageId?: string;
  targetMessageId: string;
  onLocate: (messageId: string, focus: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [composing, setComposing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const lastLocation = useRef('');
  const term = query.trim();
  const localMatches = useMemo<Match[]>(() => {
    if (!term || !ready || !complete) return [];
    const pattern = new RegExp(term.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&'), 'iu');
    return messages.flatMap((message) => {
      const match = pattern.exec(message.content);
      if (message.sessionId !== sessionId || !match) return [];
      const before = Array.from(message.content.slice(0, match.index));
      const after = Array.from(message.content.slice(match.index + match[0].length));
      return [{ messageId: message.id, role: message.role, excerpt: {
        before: (before.length > 40 ? '…' : '') + before.slice(-40).join(''), match: match[0],
        after: after.slice(0, 80).join('') + (after.length > 80 ? '…' : ''),
      } }];
    });
  }, [messages, ready, complete, sessionId, term]);
  const remote = useChatSearch(query, Math.floor(selectedIndex / CHAT_SEARCH_PAGE_SIZE) + 1,
    open && ready && !complete && !blocked && !composing, sessionId);
  const matches: Match[] = complete ? localMatches : remote.items;
  const total = complete ? matches.length : remote.total;
  const active = matches[complete ? selectedIndex : selectedIndex % CHAT_SEARCH_PAGE_SIZE];
  const requestedId = open && term ? active?.messageId ?? '' : targetMessageId;
  const exists = ready && messages.some((message) => message.id === requestedId && message.sessionId === sessionId);
  const loading = !ready || composing || (!complete && remote.loading);
  const missingTarget = Boolean(requestedId && ready && !exists && (complete || missingMessageId === requestedId));

  useEffect(() => {
    setOpen(false);
    setQuery('');
    setSelectedIndex(0);
    setComposing(false);
    lastLocation.current = '';
  }, [sessionId]);
  useEffect(() => {
    if (!loading && !remote.error && total > 0 && selectedIndex >= total) setSelectedIndex(total - 1);
  }, [loading, remote.error, selectedIndex, total]);
  useEffect(() => {
    if (!exists) { lastLocation.current = ''; return; }
    const key = [sessionId, requestedId, open ? term : ''].join(':');
    if (lastLocation.current === key) return;
    lastLocation.current = key;
    onLocate(requestedId, !open);
  }, [exists, onLocate, open, requestedId, sessionId, term]);

  const openSearch = useCallback(() => {
    if (blocked) return;
    setOpen(true);
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [blocked]);
  useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);
  useEffect(() => {
    if (!sessionId) return;
    const handleKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'f'
        && !document.querySelector('[role="dialog"][aria-modal="true"]')) {
        event.preventDefault();
        openSearch();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [openSearch, sessionId]);

  function clear() {
    setOpen(false);
    setQuery('');
    setSelectedIndex(0);
  }
  function close() {
    clear();
    triggerRef.current?.focus({ preventScroll: true });
  }
  function move(direction: number) {
    if (total && !loading && !blocked) setSelectedIndex((selectedIndex + direction + total) % total);
  }
  return {
    open, openSearch, close, clear, query, inputRef, triggerRef, active, index: selectedIndex, total, move, loading,
    error: complete ? '' : remote.error, cause: complete ? undefined : remote.cause, retry: remote.retry, setComposing,
    setQuery: (value: string) => { setQuery(value); setSelectedIndex(0); },
    requestedId, locatedId: exists ? requestedId : undefined, missingTarget,
  };
}

export function ChatMessageSearch({ query, setQuery, total, index, active, move, close, inputRef, loading, error, retry, setComposing, missingTarget }: {
  query: string;
  setQuery: (value: string) => void;
  total: number;
  index: number;
  active?: Match;
  move: (direction: number) => void;
  close: () => void;
  inputRef: RefObject<HTMLInputElement | null>;
  loading: boolean;
  error: string;
  retry: () => void;
  setComposing: (value: boolean) => void;
  missingTarget: boolean;
}) {
  return <section aria-label="会话内查找" className="chat-find" onKeyDown={(event) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.target === inputRef.current) {
      event.preventDefault(); move(event.shiftKey ? -1 : 1);
    }
  }}>
    <div className="chat-find__controls">
      <input aria-label="查找消息关键词" className="ui-input" ref={inputRef} value={query}
        autoComplete="off" autoCorrect="off" autoCapitalize="off" enterKeyHint="search"
        onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)}
        maxLength={200} onChange={(event) => setQuery(event.target.value)} placeholder="查找当前会话的消息" />
      <span aria-live="polite" className="chat-find__count" role="status">
        {loading ? '正在加载消息' : !query.trim() ? '输入关键词' : error ? '搜索未完成' : total ? (index + 1) + ' / ' + total + ' 条匹配消息' : '没有匹配消息'}
      </span>
      <IconButton disabled={!total || loading} label="上一条匹配消息" onClick={() => move(-1)}><ChevronUp aria-hidden="true" /></IconButton>
      <IconButton disabled={!total || loading} label="下一条匹配消息" onClick={() => move(1)}><ChevronDown aria-hidden="true" /></IconButton>
      <Button variant="ghost" onClick={close}>关闭查找</Button>
    </div>
    {error && <div className="ui-inline-error" role="alert"><span>{error}</span><Button variant="link" onClick={retry}>重试搜索</Button></div>}
    {active && <p className="chat-find__excerpt"><span>{active.role === 'user' ? '提问' : '回答'} · </span><ChatSearchExcerptText excerpt={active.excerpt} /></p>}
    {missingTarget && <p role="status">指定消息已不存在或不属于当前会话。</p>}
  </section>;
}
