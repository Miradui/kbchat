import { Check, Library, MessageSquareText, PanelLeft, Search, Sparkles } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';

import {
  setChatMessageFeedback,
} from '../../api/resources';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { EmptyState } from '../../components/feedback/EmptyState';
import { RerankFallbackNotice } from '../../components/feedback/RerankFallbackNotice';
import { useToast } from '../../components/feedback/ToastProvider';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { IconButton } from '../../components/ui/IconButton';
import { InlineEdit } from '../../components/ui/InlineEdit';
import { OverflowMenu } from '../../components/ui/OverflowMenu';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { AppShell } from '../../layouts/AppShell';
import type { ChatFeedbackDetails, ChatFeedbackRating, ChatMessage, Citation, KnowledgeBase } from '../../types/api';
import { knowledgeBaseOptionsKey, queryClient } from '../../store/queryClient';
import { formatDateTime } from '../../utils/format';
import { getErrorMessage } from '../../utils/errors';
import { ChatComposer } from './ChatComposer';
import { useEventCallback } from '../../hooks/useEventCallback';
import { ChatFeedbackDialog } from './ChatFeedbackDialog';
import { ChatMessageSearch, useChatMessageSearch } from './ChatMessageSearch';
import { ChatMarkdown } from './ChatMarkdown';
import { ChatAssistantLabel, CitationCard, MessageBubble } from './ChatMessage';
import { ChatSessionRail } from './ChatSessionRail';
import { ChatSessionRenameDialog } from './ChatSessionRenameDialog';
import { ChatSourcePreview } from './ChatSourcePreview';
import { canUnlessUnknown } from '../../utils/access';
import type { ChatSessionScope } from './ChatSessionRail';
import { useChatSessions } from './useChatSessions';
import { useChatThread } from './useChatThread';
import { useChatInteractionState } from './useChatInteractionState';
import { useSessionActions } from './useSessionActions';
import { useChatAnswerVersions } from './useChatAnswerVersions';
import { ChatStreamView, StreamAnnouncement } from './ChatStreamView';

/**
 * `/chat` is the draft state and `/chat/:sessionId` is a thread.
 *
 * There used to be three routes: a landing page, a `/chat/new` draft and the
 * thread itself. The landing page's content is now this page's empty state, so
 * choosing a knowledge base and asking a question never changes screens.
 */
export function ChatPage() {
  const { sessionId } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const isNarrow = useMediaQuery('(max-width: 1080px)');
  const [railOpen, setRailOpen] = useState(false);
  const railBackdropRef = useRef<HTMLButtonElement>(null);
  const {
    draft, setDraft, focusedCitation, setFocusedCitation, sourcePreview, setSourcePreview,
    feedbackSavingIds, setFeedbackSavingIds, feedbackTarget, setFeedbackTarget,
    editingMessageId, setEditingMessageId, editingDraft, setEditingDraft,
  } = useChatInteractionState(sessionId);
  const sourceTriggerRef = useRef<HTMLElement | null>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const activeSessionIdRef = useRef(sessionId);
  const feedbackOperationsRef = useRef<Map<string, symbol>>(new Map());
  const skipSessionScopeSyncRef = useRef(false);
  const activeScopeRef = useRef<string[]>([]);

  const urlKnowledgeBaseId = searchParams.get('knowledgeBaseId') ?? '';
  const manyParam = searchParams.get('knowledgeBaseIds') ?? '';
  const draftKnowledgeBaseIds = useMemo(() => manyParam ? [...new Set(manyParam.split(',').filter(Boolean))].slice(0, 5) : urlKnowledgeBaseId ? [urlKnowledgeBaseId] : [], [manyParam, urlKnowledgeBaseId]);
  const targetMessageId = searchParams.get('messageId') ?? '';
  const [railScope, setRailScope] = useState<ChatSessionScope>('active');

  activeSessionIdRef.current = sessionId;

  const sessionStore = useChatSessions({
    archived: railScope === 'archived',
    knowledgeBaseId: urlKnowledgeBaseId,
  });
  const {
    sessions,
    sessionTotal,
    knowledgeBases,
    mergeSession,
    removeSession,
    reloadKnowledgeBases,
    reloadSessions,
    loadMoreSessions,
  } = sessionStore;

  const thread = useChatThread({
    sessionId,
    draftKnowledgeBaseId: urlKnowledgeBaseId || undefined,
    draftScopeMode: draftKnowledgeBaseIds.length ? 'manual' : 'auto',
    draftKnowledgeBaseIds: draftKnowledgeBaseIds.length > 1 ? draftKnowledgeBaseIds : undefined,
    onSessionCreated: (session) => {
      mergeSession(session);
      navigate(`/chat/${session.id}`, { replace: true });
    },
    onSessionsChanged: () => void reloadSessions(),
    onAccessLost: (targetSessionId) => {
      setSourcePreview(null);
      setFocusedCitation(null);
      setDraft('');
      const inaccessible = new Set(activeScopeRef.current);
      for (const item of sessions) {
        if (item.id === targetSessionId || (item.knowledgeBaseIds ?? [item.knowledgeBaseId]).some((id) => inaccessible.has(id))) removeSession(item.id);
      }
      toast.error('会话已不可访问，可能已删除或访问权限发生变化。');
      void (async () => {
        await queryClient.cancelQueries({ queryKey: knowledgeBaseOptionsKey });
        if ((activeSessionIdRef.current ?? '') !== targetSessionId) return;
        queryClient.setQueriesData<KnowledgeBase[]>({ queryKey: knowledgeBaseOptionsKey },
          (items) => items?.filter((item) => !inaccessible.has(item.id)));
        navigate('/chat', { replace: true });
        void reloadKnowledgeBases();
      })();
    },
  });

  const {
    confirmArchive, setConfirmArchive, confirmDelete, setConfirmDelete, renameTarget, setRenameTarget,
    sessionActionError, setSessionActionError, sessionBusy, sessionBusyRef, sessionExporting,
    renameSession, getSessionActions, confirmArchiveSession, confirmDeleteSession,
  } = useSessionActions({
    sessionId, activeSessionIdRef, thread, mergeSession, removeSession, reloadSessions, skipSessionScopeSyncRef,
  });

  useEffect(() => {
    if (!thread.rateLimitedQuestion) return;
    setDraft((current) => current || thread.rateLimitedQuestion || '');
  }, [thread.rateLimitedQuestion, setDraft]);

  const loadedSession = sessionId && thread.session?.id === sessionId ? thread.session : null;
  const listedSession = sessions.find((session) => session.id === sessionId) ?? null;
  // Sending refreshes the list, which can now carry the first question's title.
  // A slower detail or list response must not replace a newer manual rename.
  const currentSession = listedSession && (
    !loadedSession || Date.parse(listedSession.updatedAt) > Date.parse(loadedSession.updatedAt)
  ) ? listedSession : loadedSession;

  const activeKnowledgeBaseId = currentSession?.knowledgeBaseId
    ?? urlKnowledgeBaseId
    ?? '';
  const activeKnowledgeBase = knowledgeBases.find((item) => item.id === activeKnowledgeBaseId);
  const activeKnowledgeBaseIds = currentSession?.knowledgeBaseIds ?? (currentSession ? [currentSession.knowledgeBaseId] : draftKnowledgeBaseIds);
  const activeKnowledgeBases = activeKnowledgeBaseIds.map((id) => knowledgeBases.find((kb) => kb.id === id) ?? currentSession?.knowledgeBases?.find((kb) => kb.id === id)).filter((kb) => kb !== undefined);
  activeScopeRef.current = activeKnowledgeBaseIds;
  const multiBase = activeKnowledgeBaseIds.length > 1;
  const automaticScope = currentSession ? currentSession.scopeMode === 'auto' : !sessionId && draftKnowledgeBaseIds.length === 0;
  const sourceScope = `${sessionId ?? ''}:${automaticScope ? 'auto' : activeKnowledgeBaseIds.join(',')}`;
  const visibleSource = sourcePreview?.scope === sourceScope ? sourcePreview : null;

  const locateMessage = useCallback((messageId: string, focus: boolean) => {
    const container = messagesRef.current;
    const element = document.getElementById(`chat-message-${messageId}`);
    if (!container || !element || !container.contains(element)) return;
    stickToBottomRef.current = false;
    const target = element.getBoundingClientRect();
    const frame = container.getBoundingClientRect();
    container.scrollTo({ top: container.scrollTop + target.top - frame.top - (container.clientHeight - Math.min(target.height, container.clientHeight)) / 2, behavior: 'instant' });
    if (focus) element.focus({ preventScroll: true });
  }, []);
  const messagesReady = Boolean(sessionId && !thread.loading && !thread.loadError && thread.session?.id === sessionId);
  const messageSearch = useChatMessageSearch({
    sessionId, messages: thread.messages, targetMessageId, onLocate: locateMessage,
    ready: messagesReady,
  });
  const answerVersions = useChatAnswerVersions(thread.messages, sessionId, messageSearch.locatedId);

  function leaveMessageLocation() {
    messageSearch.clear();
    if (targetMessageId) setSearchParams((current) => {
      const next = new URLSearchParams(current);
      next.delete('messageId');
      return next;
    }, { replace: true });
  }

  const selectAnswerVersion = useEventCallback((groupId: string, index: number) => {
    stickToBottomRef.current = false;
    answerVersions.selectVersion(groupId, index);
    leaveMessageLocation();
    setFocusedCitation(null);
    setSourcePreview(null);
  });

  const regenerateAnswer = useEventCallback((messageId: string) => {
    if (sessionBusyRef.current) return;
    leaveMessageLocation();
    void thread.regenerate(messageId);
  });

  useEffect(() => { setSourcePreview(null); }, [sourceScope, setSourcePreview]);

  const openSource = useEventCallback((citation: Citation, index: number) => {
    if (!automaticScope && !activeKnowledgeBaseIds.includes(citation.knowledgeBaseId ?? activeKnowledgeBaseId)) return;
    sourceTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSourcePreview({ citation, index, scope: sourceScope });
  });

  function closeSource() {
    setSourcePreview(null);
    if (sourceTriggerRef.current?.isConnected) sourceTriggerRef.current.focus({ preventScroll: true });
  }

  // The rail is scoped to the conversation you are in, and that scope is now a
  // server-side filter, so the URL has to carry it. Opening a session from
  // another knowledge base re-points the filter instead of silently disagreeing
  // with the list. See docs/04-api-design.md (GET /chat/sessions).
  useEffect(() => {
    if (currentSession?.scopeMode === 'auto') {
      if (urlKnowledgeBaseId || manyParam) setSearchParams((current) => {
        const next = new URLSearchParams(current);
        next.delete('knowledgeBaseId'); next.delete('knowledgeBaseIds');
        return next;
      }, { replace: true });
      return;
    }
    const sessionKnowledgeBaseId = currentSession?.knowledgeBaseId;
    if (!sessionKnowledgeBaseId || sessionKnowledgeBaseId === urlKnowledgeBaseId || currentSession?.knowledgeBaseIds?.includes(urlKnowledgeBaseId)) return;
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      next.set('knowledgeBaseId', sessionKnowledgeBaseId);
      return next;
    }, { replace: true });
  }, [currentSession?.knowledgeBaseId, currentSession?.knowledgeBaseIds, currentSession?.scopeMode, manyParam, setSearchParams, urlKnowledgeBaseId]);

  const currentSessionId = currentSession?.id;
  const currentArchivedAt = currentSession?.archivedAt;
  useEffect(() => {
    if (!sessionId || !currentSessionId) return;
    if (skipSessionScopeSyncRef.current) {
      skipSessionScopeSyncRef.current = false;
      return;
    }
    const nextScope: ChatSessionScope = currentArchivedAt ? 'archived' : 'active';
    setRailScope((current) => current === nextScope ? current : nextScope);
  }, [currentArchivedAt, currentSessionId, sessionId]);

  useEffect(() => {
    if (!isNarrow) setRailOpen(false);
  }, [isNarrow]);

  useEffect(() => {
    const operations = feedbackOperationsRef.current;
    operations.clear();
    stickToBottomRef.current = true;
    return () => { operations.clear(); };
  }, [sessionId]);

  // The home page hands a question over via `?q=`; consume it into the composer.
  useEffect(() => {
    const seeded = searchParams.get('q');
    if (!seeded) return;
    setDraft(seeded);
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      next.delete('q');
      return next;
    }, { replace: true });
  }, [searchParams, setSearchParams, setDraft]);

  useEffect(() => {
    if (!stickToBottomRef.current || targetMessageId || messageSearch.open) return;
    // `auto` while streaming: a smooth scroll per token never settles.
    messagesRef.current?.scrollTo({
      top: messagesRef.current.scrollHeight,
      behavior: thread.sending ? 'auto' : 'smooth',
    });
  }, [thread.messages, thread.pendingQuestion, thread.sending, targetMessageId, messageSearch.open]);

  const latestAssistantId = useMemo(
    () => [...thread.messages].reverse().find((message) => message.role === 'assistant')?.id ?? null,
    [thread.messages],
  );

  const archived = Boolean(currentSession?.archivedAt);
  const threadInteractionPending = thread.sending
    || Boolean(thread.regeneratingId)
    || Boolean(thread.editingId)
    || Boolean(thread.unconfirmedSend?.checking)
    || Boolean(thread.stoppedStream?.checking)
    || Boolean(thread.regeneration?.checking);
  const interactionLocked = thread.loading || sessionBusy || threadInteractionPending;
  const canSend = (automaticScope ? knowledgeBases.length > 0 : Boolean(activeKnowledgeBase) && activeKnowledgeBaseIds.every((id) => knowledgeBases.some((kb) => kb.id === id)))
    && !archived
    && !thread.loading
    && !sessionBusy
    && !thread.editingId
    && !thread.unconfirmedSend
    && (!thread.stoppedStream || thread.stoppedStream.resumable);

  const composerHint = knowledgeBases.length === 0 ? '还没有知识库。先创建一个知识库并导入文档。' : !activeKnowledgeBase && !automaticScope
    ? knowledgeBases.length === 0
      ? '还没有知识库。先创建一个知识库并导入文档。'
      : '先选择 1–5 个知识库。'
    : archived
      ? '这个会话已归档，内容仍可查看。'
      : undefined;

  const selectKnowledgeBase = useCallback((knowledgeBaseId: string) => {
    // From a thread, switching knowledge base starts a new draft rather than
    // silently jumping into some other session.
    if (knowledgeBaseId) navigate(`/chat?knowledgeBaseId=${encodeURIComponent(knowledgeBaseId)}`);
    else navigate('/chat');
  }, [navigate]);

  async function handleMessageFeedback(messageId: string, rating: ChatFeedbackRating, details?: ChatFeedbackDetails): Promise<boolean> {
    if (feedbackOperationsRef.current.has(messageId)) return false;
    const operation = Symbol('chat-feedback');
    const operationSessionId = sessionId;
    const isCurrent = () => feedbackOperationsRef.current.get(messageId) === operation && activeSessionIdRef.current === operationSessionId;
    feedbackOperationsRef.current.set(messageId, operation);
    setFeedbackSavingIds((current) => new Set(current).add(messageId));
    try {
      const feedback = await (details ? setChatMessageFeedback(messageId, rating, details) : setChatMessageFeedback(messageId, rating));
      if (!isCurrent()) return false;
      thread.updateMessageFeedback(messageId, feedback);
      toast.success(rating === 'positive' ? '已记录“有帮助”' : '已记录“没有帮助”');
      return true;
    } catch (caught) {
      if (isCurrent()) {
        toast.error(getErrorMessage(caught, '回答反馈保存失败'));
      }
      return false;
    } finally {
      if (isCurrent()) {
        feedbackOperationsRef.current.delete(messageId);
        setFeedbackSavingIds((current) => {
          const next = new Set(current);
          next.delete(messageId);
          return next;
        });
      }
    }
  }

  const onMessageFeedback = useEventCallback((messageId: string, rating: ChatFeedbackRating) => {
    if (rating === 'negative') setFeedbackTarget(thread.messages.find((message) => message.id === messageId) ?? null);
    else void handleMessageFeedback(messageId, rating);
  });
  const startEditing = useEventCallback((messageId: string, content: string) => {
    if (archived || interactionLocked || thread.editingId || thread.messages.find((message) => message.id === messageId)?.role !== 'user') return;
    setEditingMessageId(messageId); setEditingDraft(content);
  });
  const cancelEditing = useEventCallback(() => {
    if (thread.editingId) return;
    setEditingMessageId(null); setEditingDraft('');
  });
  const submitEditing = useEventCallback((messageId: string, content: string) => {
    if (archived || interactionLocked || thread.editingId || !content.trim()) return;
    void thread.editMessage(messageId, content).then(() => {
      if (activeSessionIdRef.current === sessionId && editingMessageId === messageId) {
        setEditingMessageId(null); setEditingDraft(''); toast.success('消息已更新并重新生成');
      }
    }).catch((caught) => toast.error(getErrorMessage(caught, '消息更新失败，请稍后重试')));
  });
  const focusCitation = useEventCallback((messageId: string, index: number | null) => setFocusedCitation({ messageId, index }));

  const topbarActions = currentSession ? (
    <OverflowMenu disabled={interactionLocked || sessionExporting} label="会话操作" items={getSessionActions(currentSession)} />
  ) : undefined;

  return (
    <AppShell
      active="chat"
      breadcrumbs={[
        { label: 'AI 问答', to: '/chat' },
        ...(automaticScope ? [{ label: '自动检索' }] : activeKnowledgeBase ? [{ label: activeKnowledgeBase.name }] : []),
      ]}
      flush
      topbarActions={topbarActions}
    >
      <div className={`chat-layout${railOpen ? ' is-rail-open' : ''}${visibleSource ? ' has-source-preview' : ''}`}>
        {isNarrow && railOpen && (
          <button aria-hidden="true" className="chat-layout__scrim" onClick={() => setRailOpen(false)} ref={railBackdropRef} tabIndex={-1} type="button" />
        )}

        <ChatSessionRail
          backdropRef={railBackdropRef}
          overlay={isNarrow}
          open={railOpen}
          activeSessionId={sessionId}
          disabled={interactionLocked}
          actionsDisabled={interactionLocked || sessionExporting}
          getSessionActions={(target) => getSessionActions(target, true)}
          error={sessionStore.sessionsError}
          knowledgeBaseId={automaticScope ? '' : activeKnowledgeBaseId}
          knowledgeBases={knowledgeBases}
          knowledgeBasesError={sessionStore.knowledgeBasesError}
          loading={sessionStore.sessionsLoading}
          onCollapse={isNarrow ? () => setRailOpen(false) : undefined}
          onKnowledgeBaseChange={(knowledgeBaseId) => {
            if (!sessionBusyRef.current && !thread.hasPendingWrite()) {
              selectKnowledgeBase(knowledgeBaseId);
            }
          }}
          onNavigate={() => setRailOpen(false)}
          onNewChat={() => {
            if (sessionBusyRef.current || thread.hasPendingWrite()) return;
            setRailOpen(false);
            selectKnowledgeBase('');
          }}
          onRetry={() => void reloadSessions()}
          hasMore={sessionStore.hasMoreSessions}
          loadingMore={sessionStore.sessionsLoadingMore}
          loadMoreError={sessionStore.loadMoreError}
          onLoadMore={() => void loadMoreSessions()}
          onRetryKnowledgeBases={() => void reloadKnowledgeBases()}
          onScopeChange={setRailScope}
          scope={railScope}
          sessions={sessions}
          sessionTotal={sessionTotal}
        />

        <section aria-label="问答会话" className="chat-main">
          <header className="chat-main__head">
            {isNarrow && (
              <IconButton label="打开会话列表" onClick={() => setRailOpen(true)}>
                <PanelLeft aria-hidden="true" />
              </IconButton>
            )}
            <div className="chat-main__title">
              {currentSession ? (
                <InlineEdit
                  busy={sessionBusy}
                  disabled={interactionLocked}
                  label="重命名会话"
                  onSubmit={(title) => renameSession(currentSession, title)}
                  value={currentSession.title || ''}
                />
              ) : (
                <span className="chat-main__title-text">新对话</span>
              )}
              {archived && currentSession?.archivedAt && (
                <Badge tone="neutral">已归档 {formatDateTime(currentSession.archivedAt)}</Badge>
              )}
            </div>
            {automaticScope && <span className="chat-main__kb" title="每轮根据问题检索当前可访问的知识库"><Sparkles aria-hidden="true" />自动检索 · 每轮匹配知识库</span>}
            {!automaticScope && multiBase && <span className="chat-main__kb" title={activeKnowledgeBases.map((kb) => kb.name).join('、')}><span className="ui-truncate">跨库会话 · {activeKnowledgeBases.map((kb) => kb.name).join('、')}</span></span>}
            {!automaticScope && !multiBase && activeKnowledgeBase && (
              <Link className="chat-main__kb" to={`/knowledge-bases/${activeKnowledgeBase.id}`}>
                <Library aria-hidden="true" />
                <span className="ui-truncate">{activeKnowledgeBase.name}</span>
              </Link>
            )}
            {sessionId && <IconButton aria-expanded={messageSearch.open} label="查找会话消息" ref={messageSearch.triggerRef} onClick={messageSearch.openSearch}><Search aria-hidden="true" /></IconButton>}
          </header>

          {messageSearch.open && <ChatMessageSearch {...messageSearch} loading={thread.loading} />}
          {targetMessageId && messagesReady && !messageSearch.open && <div className="chat-find__location">
            <span>{messageSearch.missingTarget ? '指定消息已不存在或不属于当前会话。' : '已定位到指定消息。'}</span>
            <Button variant="ghost" onClick={() => { setSearchParams((current) => { const next = new URLSearchParams(current); next.delete('messageId'); return next; }, { replace: true }); messageSearch.triggerRef.current?.focus(); }}>取消定位</Button>
          </div>}

          {/*
            The one polite region for answer progress. Permanently mounted and outside
            every conditional below, because a live region that appears together with
            its text is announced unreliably -- what has to change is the contents, not
            the region. See useStreamAnnouncement for what it is allowed to say.
          */}
          <StreamAnnouncement streamText={thread.streamText} sending={thread.sending} citationCount={thread.streamingCitations.length}
            stopped={Boolean(thread.stoppedStream)} failed={Boolean(thread.failedSend)} />

          {sessionActionError && !confirmArchive && !confirmDelete && !renameTarget && <p className="ui-inline-error" role="alert">{sessionActionError}</p>}
          <RerankFallbackNotice fallback={thread.rerankFallback} />
          {thread.loadError && (
            <div className="ui-inline-notice" role="status">
              <span>{thread.loadError}</span>
              <Button variant="link" onClick={() => void thread.reload()}>重试</Button>
            </div>
          )}

          <div
            className="chat-thread"
            onScroll={(event) => {
              const element = event.currentTarget;
              stickToBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 80;
            }}
            ref={messagesRef}
          >
            {thread.loading ? (
              <LoadingSkeleton announce columns={1} compact rows={5} />
            ) : thread.messages.length === 0 && !thread.pendingQuestion && !thread.failedSend && !thread.unconfirmedSend && !thread.stoppedStream ? (
              sessionId ? null : (
                <ChatEmptyState
                  knowledgeBases={knowledgeBases}
                  loading={sessionStore.knowledgeBasesLoading}
                  onSelect={(id) => {
                    if (interactionLocked) return;
                    const ids = draftKnowledgeBaseIds.includes(id) ? draftKnowledgeBaseIds.filter((value) => value !== id) : [...draftKnowledgeBaseIds, id];
                    if (ids.length > 5) { toast.error('每个会话最多选择 5 个知识库。'); return; }
                    setSearchParams(ids.length ? { knowledgeBaseId: ids[0], ...(ids.length > 1 ? { knowledgeBaseIds: ids.join(',') } : {}) } : {});
                  }}
                  onAutomatic={() => { if (!interactionLocked) setSearchParams({}); }}
                  selectedIds={draftKnowledgeBaseIds}
                  disabled={interactionLocked}
                />
              )
            ) : (
              <>
                {answerVersions.rows.map(({ id, message, versions, index }) => (
                  <MessageBubble
                    canRegenerate={
                      message.id === latestAssistantId
                      && thread.regeneration?.messageId !== message.id
                      && !archived
                      && !interactionLocked
                    }
                    canEdit={!archived && !interactionLocked}
                    focusedCitationIndex={
                      focusedCitation?.messageId === message.id ? focusedCitation.index : null
                    }
                    key={id}
                    located={messageSearch.locatedId === message.id}
                    knowledgeBaseId={activeKnowledgeBaseId || undefined}
                    onOpenCitation={openSource}
                    message={message}
                    editDraft={editingMessageId === message.id ? editingDraft : ''}
                    editing={editingMessageId === message.id}
                    editSaving={thread.editingId === message.id}
                    feedbackSaving={feedbackSavingIds.has(message.id)}
                    versionIndex={index} versionCount={versions.length} versionGroupId={id} versionsDisabled={interactionLocked} onVersionChange={selectAnswerVersion}
                    onFeedback={onMessageFeedback}
                    onEditDraftChange={setEditingDraft}
                    onStartEdit={startEditing}
                    onCancelEdit={cancelEditing}
                    onSubmitEdit={submitEditing}
                    onFocusCitation={focusCitation}
                    onRegenerate={regenerateAnswer}
                    recovery={
                      thread.regeneration?.messageId === message.id
                        ? (
                          <RegenerationNotice
                            allowWrite={!archived}
                            blocked={sessionBusy}
                            onCheck={() => {
                              if (!sessionBusyRef.current) void thread.checkRegeneration();
                            }}
                            onRegenerate={regenerateAnswer}
                            thread={thread}
                          />
                        )
                        : undefined
                    }
                    regenerating={thread.regeneratingId === message.id}
                  />
                ))}

                <ChatStreamView streamText={thread.streamText} question={thread.pendingQuestion} citations={thread.streamingCitations}
                  focusedIndex={focusedCitation?.messageId === 'streaming' ? focusedCitation.index : null}
                  knowledgeBaseId={activeKnowledgeBaseId || undefined}
                  onFocus={(index) => setFocusedCitation({ messageId: 'streaming', index })} onOpen={openSource}
                  scrollRef={messagesRef} stickRef={stickToBottomRef} searching={Boolean(targetMessageId) || messageSearch.open} />
                {thread.stoppedStream && (
                  <>
                    <article className="chat-msg chat-msg--user is-pending">
                      <div className="chat-msg__body"><p className="chat-msg__content">{thread.stoppedStream.question}</p></div>
                    </article>
                    <article className="chat-msg chat-msg--assistant is-pending">
                      <div className="chat-msg__body">
                        <ChatAssistantLabel />
                        <ChatMarkdown
                          citations={thread.stoppedStream.citations}
                          content={thread.stoppedStream.answer || '已停止生成。'}
                          focusedIndex={focusedCitation?.messageId === 'stopped' ? focusedCitation.index : null}
                          onSelect={(index) => {
                            setFocusedCitation({ messageId: 'stopped', index });
                            openSource(thread.stoppedStream!.citations[index], index + 1);
                          }}
                        />
                        {/* No `role="status"`: the permanent region already announces
                            the stop. Two polite regions racing over one event is how a
                            reader ends up hearing it twice, or neither. */}
                        <div className="chat-recovery chat-recovery--stopped">
                          <strong>{thread.stoppedStream.checking ? '已停止，正在确认结果…' : '已停止生成'}</strong>
                          <p>{thread.stoppedStream.resumable ? '这段内容尚未写入历史，你可以继续提问。' : '确认完成后即可继续提问。'}</p>
                        </div>
                        {thread.stoppedStream.citations.length > 0 && (
                          <div aria-label="已停止回答的引用来源" className="chat-sources" role="group">
                            {thread.stoppedStream.citations.map((citation, index) => (
                              <CitationCard
                                citation={citation}
                                focused={focusedCitation?.messageId === 'stopped' && focusedCitation.index === index}
                                index={index + 1}
                                key={`${citation.documentId}-${citation.chunkId}-${index}`}
                                knowledgeBaseId={activeKnowledgeBaseId || undefined}
                                onOpen={() => openSource(citation, index + 1)}
                              />
                            ))}
                          </div>
                        )}
                      </div>
                    </article>
                  </>
                )}

                {thread.failedSend && (
                  <>
                    <article className="chat-msg chat-msg--user">
                      <div className="chat-msg__body"><p className="chat-msg__content">{thread.failedSend.question}</p></div>
                    </article>
                    <article className="chat-msg chat-msg--assistant" role="alert">
                      <div className="chat-msg__body">
                        <div className="chat-recovery chat-recovery--failed">
                          <strong>回答生成失败</strong>
                          <p>{thread.failedSend.message}</p>
                          <div className="chat-recovery__actions">
                            <Button
                              variant="secondary"
                              onClick={() => {
                                const question = thread.failedSend?.question ?? '';
                                thread.dismissFailedSend();
                                void thread.send(question);
                              }}
                            >
                              重试
                            </Button>
                            <Button
                              variant="ghost"
                              onClick={() => {
                                setDraft(thread.failedSend?.question ?? '');
                                thread.dismissFailedSend();
                              }}
                            >
                              修改问题
                            </Button>
                          </div>
                        </div>
                      </div>
                    </article>
                  </>
                )}

                {thread.unconfirmedSend && (
                  <>
                    <article className="chat-msg chat-msg--assistant">
                      <div className="chat-msg__body">
                        <UnconfirmedSendNotice
                          question={thread.unconfirmedSend.request.question}
                          blocked={sessionBusy}
                          checking={thread.unconfirmedSend.checking}
                          needsDecision={thread.needsResendDecision}
                          onCheck={() => {
                            if (!sessionBusyRef.current) void thread.checkSendNow();
                          }}
                          onResend={() => {
                            if (!sessionBusyRef.current) {
                              void thread.send(thread.unconfirmedSend?.request.question ?? '', { resend: true });
                            }
                          }}
                        />
                      </div>
                    </article>
                  </>
                )}
              </>
            )}
          </div>

          <ChatComposer
            disabled={!canSend || thread.sending || sessionBusy}
            error={thread.rateLimitError}
            retryNotice={thread.rateLimitNotice}
            hint={composerHint}
            onCancel={thread.cancelSend}
            onChange={(value) => {
              setDraft(value);
              thread.dismissRateLimitError();
            }}
            onSubmit={() => {
              if (sessionBusyRef.current) return;
              const question = draft.trim();
              if (!question) return;
              setDraft('');
              // A draft thread needs the knowledge base pinned in the URL before
              // the session is created.
              if (!sessionId && !urlKnowledgeBaseId && activeKnowledgeBaseId) {
                setSearchParams({ knowledgeBaseId: activeKnowledgeBaseId }, { replace: true });
              }
              void thread.send(question);
            }}
            placeholder={automaticScope ? '直接提问，自动检索相关知识库…' : multiBase ? `向 ${activeKnowledgeBaseIds.length} 个知识库提问…` : activeKnowledgeBase ? `向「${activeKnowledgeBase.name}」提问…` : '选择知识库后开始提问…'}
            sending={thread.sending}
            value={draft}
          />
        </section>
        {visibleSource && (
          <ChatSourcePreview
            canDownload={canUnlessUnknown(knowledgeBases.find((kb) => kb.id === (visibleSource.citation.knowledgeBaseId ?? activeKnowledgeBaseId)), 'document.download')}
            citation={visibleSource.citation}
            index={visibleSource.index}
            key={`${sourceScope}:${visibleSource.citation.documentId}`}
            knowledgeBaseId={visibleSource.citation.knowledgeBaseId ?? activeKnowledgeBaseId}
            onClose={closeSource}
          />
        )}
      </div>

      {renameTarget && <ChatSessionRenameDialog key={renameTarget.id} title={renameTarget.title || ''}
        busy={sessionBusy} error={sessionActionError}
        onClose={() => { if (!sessionBusyRef.current) { setRenameTarget(null); setSessionActionError(''); } }}
        onSubmit={(title) => renameSession(renameTarget, title)} />}

      {confirmArchive && (
        <ConfirmDialog
          busy={sessionBusy}
          confirmLabel="归档"
          description={`归档后“${confirmArchive.title || '未命名会话'}”将移至“已归档”列表，可随时取消归档继续对话。`}
          error={sessionActionError}
          onCancel={() => {
            setSessionActionError('');
            setConfirmArchive(null);
          }}
          onConfirm={confirmArchiveSession}
          title="归档会话"
        />
      )}

      {feedbackTarget && <ChatFeedbackDialog key={feedbackTarget.id} initial={feedbackTarget.feedback}
        onClose={() => setFeedbackTarget(null)} onSubmit={(details) => handleMessageFeedback(feedbackTarget.id, 'negative', details)} />}

      {confirmDelete && (
        <ConfirmDialog
          busy={sessionBusy}
          confirmLabel="删除"
          description={`确认删除“${confirmDelete.title || '未命名会话'}”？会话和消息将移入回收站，可在永久删除前恢复。`}
          error={sessionActionError}
          onCancel={() => {
            setSessionActionError('');
            setConfirmDelete(null);
          }}
          onConfirm={confirmDeleteSession}
          title="删除会话"
        />
      )}
    </AppShell>
  );
}

/**
 * Draft-state body. Absorbs what used to be a separate `/chat` landing page.
 */
function ChatEmptyState({
  knowledgeBases,
  loading,
  selectedIds,
  disabled,
  onSelect,
  onAutomatic,
}: {
  knowledgeBases: Array<{ id: string; name: string; description: string }>;
  loading: boolean;
  selectedIds: string[];
  disabled: boolean;
  onSelect: (id: string) => void;
  onAutomatic: () => void;
}) {
  if (loading) return <LoadingSkeleton announce columns={2} rows={3} />;

  if (knowledgeBases.length === 0) {
    return (
      <EmptyState
        action={<Link className="ui-button ui-button--primary" to="/knowledge-bases?intent=create"><span>新建知识库</span></Link>}
        description="AI 问答基于知识库中的文档作答。先创建一个知识库并导入文档。"
        title="还没有可提问的知识库"
      />
    );
  }

  return (
    <div className="chat-launcher">
      <span className="chat-launcher__mark"><Sparkles aria-hidden="true" /></span>
      <h2>{selectedIds.length ? '在指定知识库中提问' : '直接提问，自动查找资料'}</h2>
      <p>{selectedIds.length ? '本会话仅检索所选知识库，回答会标注资料来源。' : '每轮根据问题检索可访问的知识库，回答会标注资料来源。'}</p>
      <Button aria-pressed={selectedIds.length === 0} disabled={disabled} onClick={onAutomatic} variant={selectedIds.length === 0 ? 'primary' : 'secondary'}>自动检索全部可访问知识库</Button>
      <p>也可以指定范围：选择 1–5 个知识库。</p>
      <div aria-label="可提问的知识库" className="chat-launcher__list">
        {knowledgeBases.map((knowledgeBase) => (
          <button
            aria-pressed={selectedIds.includes(knowledgeBase.id)}
            className={selectedIds.includes(knowledgeBase.id) ? 'chat-launcher__item is-selected' : 'chat-launcher__item'}
            disabled={disabled || (selectedIds.length >= 5 && !selectedIds.includes(knowledgeBase.id))}
            key={knowledgeBase.id}
            onClick={() => onSelect(knowledgeBase.id)}
            type="button"
          >
            <Library aria-hidden="true" />
            <span className="ui-cell-stack">
              <strong>{knowledgeBase.name}</strong>
              <small>{knowledgeBase.description || '未填写描述'}</small>
            </span>
            {selectedIds.includes(knowledgeBase.id) && <Check aria-hidden="true" className="chat-launcher__selected" />}
          </button>
        ))}
      </div>
      <p className="chat-launcher__hint">{selectedIds.length ? `已指定 ${selectedIds.length} 个知识库，本会话仅在所选范围内检索。` : '当前为自动模式，可以直接提问；不同问题可以使用不同知识库。'}</p>
    </div>
  );
}

/**
 * Shown while a send whose outcome is unknown reconciles itself. The user is
 * only asked to decide after the automatic checks are exhausted.
 */
function UnconfirmedSendNotice({
  question,
  blocked,
  checking,
  needsDecision,
  onCheck,
  onResend,
}: {
  question: string;
  blocked: boolean;
  checking: boolean;
  needsDecision: boolean;
  onCheck: () => void;
  onResend: () => void;
}) {
  if (!needsDecision) {
    return (
      <div className="chat-recovery" role="status">
        <strong>正在确认这条消息…</strong>
        <p>网络结果暂时未知，正在自动核对。这条问题不会被重复发送。</p>
        <p className="chat-recovery__question" aria-label="正在核对的问题">“{question}”</p>
      </div>
    );
  }

  return (
    <div className="chat-recovery chat-recovery--decision" role="alert">
      <strong>没有找到这条消息</strong>
      <p>自动核对后仍未看到这条问题。确认后才会再次发送，原请求编号会保持不变。</p>
      <p className="chat-recovery__question" aria-label="待确认的问题">“{question}”</p>
      <div className="chat-recovery__actions">
        <Button disabled={checking || blocked} loading={checking} loadingLabel="检查中" variant="secondary" onClick={onCheck}>
          再检查一次
        </Button>
        <Button disabled={checking || blocked} variant="ghost" onClick={onResend}>确认重新发送</Button>
      </div>
    </div>
  );
}

function RegenerationNotice({
  allowWrite,
  blocked,
  onCheck,
  onRegenerate,
  thread,
}: {
  allowWrite: boolean;
  blocked: boolean;
  onCheck: () => void;
  onRegenerate: (messageId: string) => void;
  thread: ReturnType<typeof useChatThread>;
}) {
  const state = thread.regeneration;
  if (!state) return null;

  if (state.kind === 'failed') {
    return (
      <div className="chat-recovery chat-recovery--failed" role="alert">
        <strong>重新生成失败</strong>
        <p>{state.message}</p>
        {allowWrite && (
          <div className="chat-recovery__actions">
            <Button disabled={blocked} variant="secondary" onClick={() => onRegenerate(state.messageId)}>重试</Button>
          </div>
        )}
      </div>
    );
  }

  const needsDecision = state.autoChecksDone > 0;
  return (
    <div className={needsDecision ? 'chat-recovery chat-recovery--decision' : 'chat-recovery'} role={needsDecision ? 'alert' : 'status'}>
      <strong>{needsDecision ? '没有找到新的回答' : '正在确认重新生成结果…'}</strong>
      <p>{state.message}</p>
      <div className="chat-recovery__actions">
        <Button
          disabled={state.checking || blocked}
          loading={state.checking}
          loadingLabel="检查中"
          variant="secondary"
          onClick={onCheck}
        >
          再检查一次
        </Button>
        {needsDecision && allowWrite && (
          <Button disabled={state.checking || blocked} variant="ghost" onClick={() => onRegenerate(state.messageId)}>
            确认重新生成
          </Button>
        )}
      </div>
    </div>
  );
}
