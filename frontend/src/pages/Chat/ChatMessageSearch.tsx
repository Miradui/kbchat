import { ChevronDown, ChevronUp } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';

import { IconButton } from '../../components/ui/IconButton';
import type { ChatMessage } from '../../types/api';

type Match = { message: ChatMessage; index: number; length: number };

export function useChatMessageSearch({ sessionId, messages, ready, targetMessageId, onLocate }: {
  sessionId?: string;
  messages: ChatMessage[];
  ready: boolean;
  targetMessageId: string;
  onLocate: (messageId: string, focus: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const lastTarget = useRef('');
  const term = query.trim();
  const matches = useMemo<Match[]>(() => {
    if (!term || !ready) return [];
    // Literal, case-insensitive search; punctuation never becomes a regular expression.
    const pattern = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu');
    return messages.flatMap((message) => {
      const match = pattern.exec(message.content);
      return message.sessionId === sessionId && match
        ? [{ message, index: match.index, length: match[0].length }] : [];
    });
  }, [messages, ready, sessionId, term]);
  const index = Math.max(0, matches.findIndex((match) => match.message.id === selectedId));
  const active = matches[index];
  const targetExists = ready && messages.some((message) => message.id === targetMessageId && message.sessionId === sessionId);

  useEffect(() => {
    setOpen(false);
    setQuery('');
    setSelectedId(null);
    lastTarget.current = '';
  }, [sessionId]);

  useEffect(() => {
    if (!targetMessageId) { lastTarget.current = ''; return; }
    if (!ready) return;
    const key = `${sessionId}:${targetMessageId}`;
    if (lastTarget.current === key) return;
    lastTarget.current = key;
    if (targetExists) onLocate(targetMessageId, true);
  }, [onLocate, ready, sessionId, targetExists, targetMessageId]);

  useEffect(() => {
    if (open && active) onLocate(active.message.id, false);
  }, [open, active?.message.id, term, onLocate]);

  const openSearch = useCallback(() => {
    setOpen(true);
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
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

  function close() {
    setOpen(false);
    setQuery('');
    setSelectedId(null);
    if (targetExists) onLocate(targetMessageId, false);
    triggerRef.current?.focus({ preventScroll: true });
  }
  function move(direction: number) {
    if (matches.length) setSelectedId(matches[(index + direction + matches.length) % matches.length].message.id);
  }

  return {
    open, openSearch, close, query, inputRef, triggerRef, active, index, matches, move,
    setQuery: (value: string) => { setQuery(value); setSelectedId(null); },
    locatedId: open && term ? active?.message.id : targetExists ? targetMessageId : undefined,
    missingTarget: Boolean(targetMessageId && ready && !targetExists),
  };
}

export function ChatMessageSearch({ query, setQuery, matches, index, active, move, close, inputRef, loading }: {
  query: string;
  setQuery: (value: string) => void;
  matches: Match[];
  index: number;
  active?: Match;
  move: (direction: number) => void;
  close: () => void;
  inputRef: RefObject<HTMLInputElement | null>;
  loading: boolean;
}) {
  const start = active ? Math.max(0, active.index - 32) : 0;
  const end = active ? active.index + active.length : 0;
  return (
    <section aria-label="会话内查找" className="chat-find" onKeyDown={(event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
      if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.target === inputRef.current) {
        event.preventDefault();
        move(event.shiftKey ? -1 : 1);
      }
    }}>
      <div className="chat-find__controls">
        <input aria-label="查找消息关键词" className="ui-input" ref={inputRef} value={query}
          autoComplete="off" autoCorrect="off" autoCapitalize="off" enterKeyHint="search"
          maxLength={200} onChange={(event) => setQuery(event.target.value)} placeholder="查找当前会话的消息" />
        <span aria-live="polite" className="chat-find__count" role="status">
          {loading ? '正在加载消息' : !query.trim() ? '输入关键词' : matches.length ? `${index + 1} / ${matches.length} 条匹配消息` : '没有匹配消息'}
        </span>
        <IconButton disabled={!matches.length} label="上一条匹配消息" onClick={() => move(-1)}><ChevronUp aria-hidden="true" /></IconButton>
        <IconButton disabled={!matches.length} label="下一条匹配消息" onClick={() => move(1)}><ChevronDown aria-hidden="true" /></IconButton>
        <button className="ui-button ui-button--ghost" onClick={close} type="button">关闭查找</button>
      </div>
      {active && <p className="chat-find__excerpt">
        <span>{active.message.role === 'user' ? '提问' : '回答'} · </span>
        {start > 0 && '…'}{active.message.content.slice(start, active.index)}
        <mark>{active.message.content.slice(active.index, end)}</mark>
        {active.message.content.slice(end, end + 80)}{end + 80 < active.message.content.length && '…'}
      </p>}
    </section>
  );
}
