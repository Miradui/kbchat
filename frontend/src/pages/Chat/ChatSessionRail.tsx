import { MessageSquarePlus, PanelLeftClose } from 'lucide-react';
import { useMemo, useRef } from 'react';
import type { RefObject } from 'react';
import { Link } from 'react-router-dom';

import { EmptyState } from '../../components/feedback/EmptyState';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';
import { Button } from '../../components/ui/Button';
import { IconButton } from '../../components/ui/IconButton';
import { Select } from '../../components/ui/Field';
import { OverflowMenu, type OverflowMenuItem } from '../../components/ui/OverflowMenu';
import { SegmentedControl } from '../../components/ui/SegmentedControl';
import type { ChatSession, KnowledgeBase } from '../../types/api';
import { formatRelativeTime, relativeDayBucket } from '../../utils/format';
import { useModalFocus } from '../../components/ui/useModalFocus';

const BUCKET_ORDER = ['今天', '昨天', '最近 7 天', '更早'];

export type ChatSessionScope = 'active' | 'archived';

type ChatSessionRailProps = {
  overlay?: boolean;
  open?: boolean;
  backdropRef?: RefObject<HTMLElement | null>;
  sessions: ChatSession[];
  sessionTotal: number;
  hasMore: boolean;
  loadingMore: boolean;
  loadMoreError?: string;
  knowledgeBases: KnowledgeBase[];
  knowledgeBaseId: string;
  scope: ChatSessionScope;
  activeSessionId?: string;
  disabled?: boolean;
  actionsDisabled?: boolean;
  getSessionActions: (session: ChatSession) => OverflowMenuItem[];
  loading: boolean;
  error: string;
  knowledgeBasesError?: string;
  onKnowledgeBaseChange: (knowledgeBaseId: string) => void;
  onScopeChange: (scope: ChatSessionScope) => void;
  onNewChat: () => void;
  onRetry: () => void;
  onLoadMore: () => void;
  onRetryKnowledgeBases?: () => void;
  onNavigate: () => void;
  onCollapse?: () => void;
};

export function ChatSessionRail({
  overlay = false,
  open = true,
  backdropRef,
  sessions,
  sessionTotal,
  hasMore,
  loadingMore,
  loadMoreError = '',
  knowledgeBases,
  knowledgeBaseId,
  scope,
  activeSessionId,
  disabled = false,
  actionsDisabled = disabled,
  getSessionActions,
  loading,
  error,
  knowledgeBasesError = '',
  onKnowledgeBaseChange,
  onScopeChange,
  onNewChat,
  onRetry,
  onLoadMore,
  onRetryKnowledgeBases,
  onNavigate,
  onCollapse,
}: ChatSessionRailProps) {
  const panelRef = useModalFocus<HTMLElement>(overlay && open, () => onCollapse?.(), backdropRef);
  // Filtering and ordering happen server side now; this only buckets by recency
  // so a long history stays scannable. See docs/04-api-design.md (GET /chat/sessions).
  const groups = useMemo(() => {
    const map = new Map<string, ChatSession[]>();
    sessions.forEach((session) => {
      const bucket = relativeDayBucket(session.updatedAt || session.createdAt);
      const list = map.get(bucket) ?? [];
      list.push(session);
      map.set(bucket, list);
    });
    return BUCKET_ORDER.filter((bucket) => map.has(bucket)).map((bucket) => ({
      bucket,
      sessions: map.get(bucket) ?? [],
    }));
  }, [sessions]);

  return (
    <aside aria-label="会话列表" className="chat-rail" ref={panelRef}
      role={overlay ? 'dialog' : undefined} aria-modal={overlay && open ? true : undefined}
      aria-hidden={overlay && !open ? true : undefined} inert={overlay && !open} tabIndex={overlay ? -1 : undefined}>
      <div className="chat-rail__intro"><strong>会话</strong><span>基于你的知识，持续探索</span></div>
      <div className="chat-rail__head">
        <Select
          aria-label="当前知识库"
          disabled={disabled || knowledgeBases.length === 0}
          onChange={(event) => onKnowledgeBaseChange(event.target.value)}
          value={knowledgeBaseId}
        >
          <option value="">全部知识库</option>
          {knowledgeBases.map((knowledgeBase) => (
            <option key={knowledgeBase.id} value={knowledgeBase.id}>{knowledgeBase.name}</option>
          ))}
        </Select>
        {onCollapse && (
          <IconButton className="chat-rail__collapse" label="收起会话列表" onClick={onCollapse}>
            <PanelLeftClose aria-hidden="true" />
          </IconButton>
        )}
      </div>

      {knowledgeBasesError && (
        <div className="ui-inline-error" role="alert">
          <span>{knowledgeBasesError}</span>
          {onRetryKnowledgeBases && <Button variant="link" onClick={onRetryKnowledgeBases}>重试</Button>}
        </div>
      )}

      <Button
        className="chat-rail__new"
        disabled={disabled}
        leadingIcon={<MessageSquarePlus aria-hidden="true" />}
        variant="secondary"
        onClick={onNewChat}
      >
        新建对话
      </Button>

      <SegmentedControl
        disabled={disabled}
        label="会话范围"
        onChange={onScopeChange}
        options={[
          { value: 'active', label: '活跃' },
          { value: 'archived', label: '已归档' },
        ]}
        value={scope}
      />

      <div className="chat-rail__list">
        {loading && sessions.length === 0 ? (
          <LoadingSkeleton compact columns={1} rows={5} />
        ) : error ? (
          <div className="ui-inline-error" role="alert">
            <span>{error}</span>
            <Button variant="link" onClick={onRetry}>重试</Button>
          </div>
        ) : sessions.length === 0 ? (
          <EmptyState
            description={emptyDescription(scope, Boolean(knowledgeBaseId))}
            title={scope === 'archived' ? '暂无归档会话' : '暂无会话'}
          />
        ) : (
          <>
            {groups.map((group) => (
              <div className="chat-rail__group" key={group.bucket}>
                <p className="chat-rail__group-label">{group.bucket}</p>
                {group.sessions.map((session) => (
                  <SessionItem
                    active={session.id === activeSessionId}
                    disabled={disabled}
                    actionsDisabled={actionsDisabled}
                    items={getSessionActions(session)}
                    key={session.id}
                    onNavigate={onNavigate}
                    session={session}
                  />
                ))}
              </div>
            ))}
            {hasMore && (
              <div className="chat-rail__more">
                <Button disabled={disabled || loadingMore} loading={loadingMore} variant="link" onClick={onLoadMore}>
                  加载更多会话
                </Button>
                {loadMoreError && <p className="ui-inline-error" role="alert">{loadMoreError}</p>}
                <small>已显示 {sessions.length} / {sessionTotal}</small>
              </div>
            )}
          </>
        )}
      </div>
    </aside>
  );
}

function SessionItem({ session, active, disabled, actionsDisabled, items, onNavigate }: {
  session: ChatSession;
  active: boolean;
  disabled: boolean;
  actionsDisabled: boolean;
  items: OverflowMenuItem[];
  onNavigate: () => void;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const title = session.title || '未命名会话';
  return (
    <div className={active ? 'chat-rail__item is-active' : 'chat-rail__item'} ref={rowRef}>
      <Link
        aria-current={active ? 'page' : undefined}
        aria-disabled={disabled ? 'true' : undefined}
        className="chat-rail__link"
        title={title}
        onClick={(event) => {
          if (disabled) { event.preventDefault(); return; }
          onNavigate();
        }}
        to={`/chat/${session.id}`}
      >
        <span className="ui-truncate">{title}</span>
        {session.lastMessagePreview && <span className="chat-rail__preview ui-truncate">{session.lastMessagePreview}</span>}
        <small>
          {formatRelativeTime(session.updatedAt || session.createdAt)}
          {session.messageCount !== undefined && ` · ${session.messageCount} 条消息`}
        </small>
      </Link>
      <OverflowMenu contextTargetRef={rowRef} disabled={actionsDisabled} items={items} label={`会话“${title}”的更多操作`} />
    </div>
  );
}

function emptyDescription(scope: ChatSessionScope, scoped: boolean): string {
  if (scope === 'archived') {
    return scoped ? '这个知识库没有归档会话。' : '归档的会话会出现在这里。';
  }
  return scoped ? '这个知识库还没有对话。' : '开始第一次提问吧。';
}
