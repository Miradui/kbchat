import { ArrowUpRight, BookOpen, Check, FileText, Files, Globe, Library, MessageSquareText, PanelLeft, Search, Sparkles } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';

import {
  setChatMessageFeedback,
} from '../../api/resources';
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
import { useCurrentUser } from '../../hooks/useCurrentUser';
import { AppShell } from '../../layouts/AppShell';
import type { ChatFeedbackDetails, ChatFeedbackRating, ChatMessage, Citation, KnowledgeBase } from '../../types/api';
import { knowledgeBaseOptionsKey, queryClient } from '../../store/queryClient';
import { formatDateTime } from '../../utils/format';
import { getErrorMessage } from '../../utils/errors';
import { ChatComposer } from './ChatComposer';
import { useEventCallback } from '../../hooks/useEventCallback';
import { ChatFeedbackDialog } from './ChatFeedbackDialog';
import { ChatMessageSearch, useChatMessageSearch } from './ChatMessageSearch';
import { ChatSearchDialog } from './ChatSearchDialog';
import { ChatBookmarkDialog, ChatBookmarksDialog } from './ChatBookmarks';
import { ChatMarkdown } from './ChatMarkdown';
import { ChatAssistantLabel, CitationCard, MessageBubble } from './ChatMessage';
import { ChatSessionRail } from './ChatSessionRail';
import { ChatSessionActionDialogs } from './ChatSessionActionDialogs';
import { ChatSourcePreview } from './ChatSourcePreview';
import { canUnlessUnknown } from '../../utils/access';
import type { ChatSessionScope } from './ChatSessionRail';
import { useChatSessions } from './useChatSessions';
import { useChatThread } from './useChatThread';
import { useChatInteractionState } from './useChatInteractionState';
import { chatDraftScope, useChatDraft } from './useChatDraft';
import { useSessionActions } from './useSessionActions';
import { useSessionRailPreferences } from './useSessionRailPreferences';
import { useChatAnswerVersions } from './useChatAnswerVersions';
import { ChatStreamView, StreamAnnouncement } from './ChatStreamView';
import { ChatDocumentPicker } from './ChatDocumentPicker';
import { documentChatUrl } from './documentChatScope';

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
  const isMediumDesktop = useMediaQuery('(min-width: 1280px) and (max-width: 1599px)');
  const [railOpen, setRailOpen] = useState(false);
  const railToggleRef = useRef<HTMLButtonElement>(null);
  const [searchDialogOpen, setSearchDialogOpen] = useState(false);
  const [bookmarksOpen, setBookmarksOpen] = useState(false);
  const [bookmarkTarget, setBookmarkTarget] = useState<ChatMessage | null>(null);
  const [documentPickerOpen, setDocumentPickerOpen] = useState(false);
  useEffect(() => { setBookmarkTarget(null); }, [sessionId]);
  const railBackdropRef = useRef<HTMLButtonElement>(null);
  const {
    focusedCitation, setFocusedCitation, sourcePreview, setSourcePreview,
    feedbackSavingIds, setFeedbackSavingIds, feedbackTarget, setFeedbackTarget,
    editingMessageId, setEditingMessageId, editingDraft, setEditingDraft,
  } = useChatInteractionState(sessionId);
  const sourceTriggerRef = useRef<HTMLElement | null>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const initialScrollRef = useRef<string | undefined>(undefined);
  const prependAnchorRef = useRef<{ sessionId?: string; id: string; top: number } | null>(null);
  const activeSessionIdRef = useRef(sessionId);
  const feedbackOperationsRef = useRef<Map<string, symbol>>(new Map());
  const skipSessionScopeSyncRef = useRef(false);
  const activeScopeRef = useRef<string[]>([]);

  const urlKnowledgeBaseId = searchParams.get('knowledgeBaseId') ?? '';
  const manyParam = searchParams.get('knowledgeBaseIds') ?? '';
  const documentParam = searchParams.get('documentIds') ?? '';
  const draftDocumentIds = useMemo(() => documentParam ? documentParam.split(',') : [], [documentParam]);
  const draftKnowledgeBaseIds = useMemo(() => manyParam ? [...new Set(manyParam.split(',').filter(Boolean))].slice(0, 5) : urlKnowledgeBaseId ? [urlKnowledgeBaseId] : [], [manyParam, urlKnowledgeBaseId]);
  const { user } = useCurrentUser();
  const { draft, setDraft, moveToSession, acknowledge } = useChatDraft(user?.id, chatDraftScope(sessionId, draftKnowledgeBaseIds, draftDocumentIds));
  const targetMessageId = searchParams.get('messageId') ?? '';
  const [railPreferences, setRailPreferences] = useSessionRailPreferences();
  const [railScope, setRailScope] = useState<ChatSessionScope>(railPreferences.scope);
  useLayoutEffect(() => {
    setRailPreferences({ ...railPreferences, knowledgeBaseId: urlKnowledgeBaseId, scope: railScope });
  }, [railPreferences, railScope, setRailPreferences, urlKnowledgeBaseId]);

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
    initialMessageId: targetMessageId,
    draftKnowledgeBaseId: urlKnowledgeBaseId || undefined,
    draftScopeMode: draftKnowledgeBaseIds.length ? 'manual' : 'auto',
    draftKnowledgeBaseIds: draftKnowledgeBaseIds.length > 1 ? draftKnowledgeBaseIds : undefined,
    draftDocumentIds: draftDocumentIds.length ? draftDocumentIds : undefined,
    onSessionCreated: (session) => {
      moveToSession(session.id);
      mergeSession(session);
      navigate(`/chat/${session.id}`, { replace: true });
    },
    onSessionsChanged: () => void reloadSessions(),
    onQuestionSaved: acknowledge,
    onAccessLost: (targetSessionId) => {
      setBookmarkTarget(null);
      setBookmarksOpen(false);
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

  const sessionActions = useSessionActions({
    sessionId, activeSessionIdRef, thread, mergeSession, removeSession, reloadSessions, skipSessionScopeSyncRef,
  });
  const {
    confirmArchive, confirmDelete, renameTarget, sessionActionError,
    sessionBusy, sessionBusyRef, sessionExporting, renameSession, getSessionActions,
  } = sessionActions;

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
  const railSuppressedForPreview = isMediumDesktop && Boolean(visibleSource);
  const historyVisible = isNarrow ? railOpen : (!railPreferences.collapsed && !railSuppressedForPreview);

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
  const threadInteractionPending = thread.sending || Boolean(thread.regeneratingId) || Boolean(thread.editingId)
    || Boolean(thread.unconfirmedSend?.checking) || Boolean(thread.stoppedStream?.checking) || Boolean(thread.regeneration?.checking);
  const interactionLocked = thread.loading || sessionBusy || threadInteractionPending;
  const historyLocked = interactionLocked || Boolean(thread.unconfirmedSend) || thread.regeneration?.kind === 'unconfirmed';
  const messageSearch = useChatMessageSearch({
    sessionId, messages: thread.messages, targetMessageId, onLocate: locateMessage,
    ready: messagesReady, complete: !thread.hasOlderMessages && !thread.hasNewerMessages,
    blocked: historyLocked, missingMessageId: thread.missingMessageId,
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

  const openSource = useEventCallback((citation: Citation, index: number, messageId?: string) => {
    if (!automaticScope && !activeKnowledgeBaseIds.includes(citation.knowledgeBaseId ?? activeKnowledgeBaseId)) return;
    sourceTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const messageIndex = thread.messages.findIndex((message) => message.id === messageId);
    const question = messageIndex >= 0 ? thread.messages.slice(0, messageIndex).reverse().find((message) => message.role === 'user')?.content : undefined;
    const relatedDocumentIds = messageIndex >= 0 ? thread.messages[messageIndex].citations.map((item) => item.documentId) : undefined;
    setSourcePreview({ citation, index, scope: sourceScope, question, relatedDocumentIds });
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
    if (!seeded || !user) return;
    setDraft((current) => current && current !== seeded ? `${current}\n\n${seeded}` : seeded);
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      next.delete('q');
      return next;
    }, { replace: true });
  }, [searchParams, setSearchParams, setDraft, user]);

  useLayoutEffect(() => { initialScrollRef.current = undefined; prependAnchorRef.current = null; }, [sessionId]);
  useLayoutEffect(() => {
    const container = messagesRef.current;
    if (!container || thread.loading || thread.loadingHistory || thread.session?.id !== sessionId) return;
    const anchor = prependAnchorRef.current;
    if (anchor) {
      prependAnchorRef.current = null;
      const element = document.getElementById(anchor.id);
      if (anchor.sessionId === sessionId && element && container.contains(element)) {
        container.scrollTo({ top: container.scrollTop + element.getBoundingClientRect().top - anchor.top, behavior: 'instant' });
        stickToBottomRef.current = false;
        return;
      }
    }
    const initial = initialScrollRef.current !== sessionId;
    if (thread.messages.length > 0) initialScrollRef.current = sessionId;
    if ((!initial && !stickToBottomRef.current) || targetMessageId || messageSearch.open) return;
    // `auto` while streaming: a smooth scroll per token never settles.
    container.scrollTo({
      top: container.scrollHeight,
      behavior: initial ? 'instant' : thread.sending ? 'auto' : 'smooth',
    });
  }, [thread.messages, thread.pendingQuestion, thread.sending, thread.loading, thread.loadingHistory, thread.session?.id, sessionId, targetMessageId, messageSearch.open]);

  const latestAssistantId = useMemo(
    () => thread.hasNewerMessages ? null : [...thread.messages].reverse().find((message) => message.role === 'assistant')?.id ?? null,
    [thread.messages, thread.hasNewerMessages],
  );

  const archived = Boolean(currentSession?.archivedAt);
  const { hasOlderMessages, hasNewerMessages, loadingHistory, historyError, loadOlderMessages, loadNewerMessages,
    loadMessageContext, cancelMessageContext, loadLatestMessages, handleAccessLost } = thread;
  const locationTarget = messageSearch.requestedId;
  const locationLoaded = thread.messages.some((message) => message.id === locationTarget);
  const historyOutsideWindow = hasOlderMessages || hasNewerMessages;
  const searchingHistory = messageSearch.open || Boolean(targetMessageId);
  const locationMissing = messageSearch.missingTarget;
  useEffect(() => {
    if (!messagesReady || historyLocked || !locationTarget || locationLoaded || locationMissing || !historyOutsideWindow) return;
    void loadMessageContext(locationTarget);
    return cancelMessageContext;
  }, [messagesReady, historyLocked, locationTarget, locationLoaded, locationMissing, historyOutsideWindow, loadMessageContext, cancelMessageContext]);
  useEffect(() => {
    if (messageSearch.cause && sessionId) handleAccessLost(messageSearch.cause, sessionId);
  }, [messageSearch.cause, sessionId, handleAccessLost]);
  const returnToLatest = useEventCallback(() => {
    if (historyLocked) return;
    leaveMessageLocation();
    initialScrollRef.current = undefined;
    prependAnchorRef.current = null;
    stickToBottomRef.current = true;
    void loadLatestMessages();
  });
  const loadEarlier = useCallback(() => {
    if (historyLocked) return;
    void loadOlderMessages(() => {
      const container = messagesRef.current;
      if (!container) return;
      const top = container.getBoundingClientRect().top;
      const first = Array.from(container.querySelectorAll<HTMLElement>('[id^="chat-message-"]')).find((element) => element.getBoundingClientRect().bottom > top);
      if (first) prependAnchorRef.current = { sessionId, id: first.id, top: first.getBoundingClientRect().top };
      stickToBottomRef.current = false;
    });
  }, [historyLocked, loadOlderMessages, sessionId]);
  const canSend = (automaticScope ? knowledgeBases.length > 0 : Boolean(activeKnowledgeBase) && activeKnowledgeBaseIds.every((id) => knowledgeBases.some((kb) => kb.id === id)))
    && !archived
    && !thread.loading
    && !hasNewerMessages
    && !loadingHistory
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

  const showLauncher = !sessionId && !thread.loading && thread.messages.length === 0
    && !thread.pendingQuestion && !thread.failedSend && !thread.unconfirmedSend && !thread.stoppedStream;

  function startNewChat() {
    if (sessionBusyRef.current || thread.hasPendingWrite()) return;
    setRailOpen(false);
    selectKnowledgeBase('');
  }

  const sessionRail = (
    <ChatSessionRail
      backdropRef={railBackdropRef}
      overlay={isNarrow}
      open={historyVisible}
      activeSessionId={sessionId}
      disabled={interactionLocked}
      actionsDisabled={interactionLocked || sessionExporting}
      getSessionActions={(target) => getSessionActions(target, true)}
      error={sessionStore.sessionsError}
      knowledgeBaseId={automaticScope ? '' : activeKnowledgeBaseId}
      knowledgeBases={knowledgeBases}
      knowledgeBasesError={sessionStore.knowledgeBasesError}
      loading={sessionStore.sessionsLoading}
      onCollapse={() => {
        if (isNarrow) setRailOpen(false);
        else {
          setRailPreferences({ ...railPreferences, collapsed: true });
          requestAnimationFrame(() => railToggleRef.current?.focus());
        }
      }}
      onKnowledgeBaseChange={(knowledgeBaseId) => {
        if (!sessionBusyRef.current && !thread.hasPendingWrite()) {
          selectKnowledgeBase(knowledgeBaseId);
        }
      }}
      onNavigate={() => setRailOpen(false)}
      onSearch={() => { if (!sessionBusyRef.current && !thread.hasPendingWrite()) setSearchDialogOpen(true); }}
      onBookmarks={() => { if (!sessionBusyRef.current && !thread.hasPendingWrite()) setBookmarksOpen(true); }}
      onNewChat={startNewChat}
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
  );

  const composer = (
    <ChatComposer
      tools={<>
        {!sessionId ? <Button aria-label="自动检索全部可访问知识库" aria-pressed={automaticScope && !draftDocumentIds.length}
          className="chat-composer__scope-button" disabled={interactionLocked} leadingIcon={<Globe aria-hidden="true" />}
          onClick={() => { if (!interactionLocked) setSearchParams({}); }} variant="ghost">自动跨库</Button>
          : <span className="chat-composer__scope-label"><Globe aria-hidden="true" />{currentSession?.documents?.length ? currentSession.documents.length + ' 份文档' : automaticScope ? '自动跨库' : multiBase ? activeKnowledgeBaseIds.length + ' 个知识库' : activeKnowledgeBase?.name || '当前范围'}</span>}
        {!sessionId && <Button className="chat-composer__scope-button" disabled={interactionLocked} leadingIcon={<FileText aria-hidden="true" />}
          onClick={() => setDocumentPickerOpen(true)} variant="ghost">指定文档提问</Button>}
      </>}
      disabled={!user || !canSend || thread.sending || sessionBusy}
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
        // A draft thread needs the knowledge base pinned in the URL before
        // the session is created.
        if (!sessionId && !urlKnowledgeBaseId && activeKnowledgeBaseId && !draftDocumentIds.length) {
          setSearchParams({ knowledgeBaseId: activeKnowledgeBaseId }, { replace: true });
        }
        void thread.send(question);
      }}
      placeholder={(currentSession?.documents?.length || draftDocumentIds.length) ? '针对所选文档提问…' : automaticScope ? '直接提问，自动检索相关知识库…' : multiBase ? `向 ${activeKnowledgeBaseIds.length} 个知识库提问…` : activeKnowledgeBase ? `向「${activeKnowledgeBase.name}」提问…` : '选择知识库后开始提问…'}
      sending={thread.sending}
      value={draft}
    />
  );

  return (
    <AppShell
      active="chat"
      breadcrumbs={[
        { label: 'AI 问答', to: '/chat' },
        ...(showLauncher ? [{ label: '新对话' }] : automaticScope ? [{ label: '自动检索' }] : activeKnowledgeBase ? [{ label: activeKnowledgeBase.name }] : []),
      ]}
      flush
      topbarActions={topbarActions}
      topbarLeading={(!historyVisible || isNarrow) && <IconButton label="打开会话列表" aria-expanded={historyVisible} ref={railToggleRef}
        onClick={() => {
          if (isNarrow) setRailOpen(true);
          else {
            if (railSuppressedForPreview) setSourcePreview(null);
            setRailPreferences({ ...railPreferences, collapsed: false });
          }
        }}><PanelLeft aria-hidden="true" /></IconButton>}
      onNewChat={startNewChat}
      newChatDisabled={interactionLocked}
    >
      <div className={`chat-layout${railOpen ? ' is-rail-open' : ''}${!isNarrow && historyVisible ? ' has-session-rail' : ''}${visibleSource ? ' has-source-preview' : ''}`}>
        {isNarrow && railOpen && (
          <button aria-hidden="true" className="chat-layout__scrim" onClick={() => setRailOpen(false)} ref={railBackdropRef} tabIndex={-1} type="button" />
        )}

        {sessionRail}

        <section aria-label="问答会话" className="chat-main">
          {!showLauncher && <header className="chat-main__head">
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
            {automaticScope && <span className="chat-main__kb" title="每轮根据问题检索当前可访问的知识库"><Sparkles aria-hidden="true" /><span className="ui-truncate">自动检索</span></span>}
            {!automaticScope && multiBase && <span className="chat-main__kb" title={activeKnowledgeBases.map((kb) => kb.name).join('、')}><span className="ui-truncate">手动 · {activeKnowledgeBaseIds.length} 个知识库</span></span>}
            {!automaticScope && !multiBase && activeKnowledgeBase && (
              <Link className="chat-main__kb" to={`/knowledge-bases/${activeKnowledgeBase.id}`}>
                <Library aria-hidden="true" />
                <span className="ui-truncate">手动 · {activeKnowledgeBase.name}</span>
              </Link>
            )}
            {sessionId && <IconButton disabled={historyLocked} aria-expanded={messageSearch.open} label="查找会话消息" ref={messageSearch.triggerRef} onClick={messageSearch.openSearch}><Search aria-hidden="true" /></IconButton>}
            {loadedSession?.branchFromSessionId && <Link className="ui-button ui-button--ghost" to={`/chat/${loadedSession.branchFromSessionId}${loadedSession.branchFromMessageId ? `?messageId=${encodeURIComponent(loadedSession.branchFromMessageId)}` : ''}`}>查看来源会话</Link>}
          </header>}
          {!sessionId && draftDocumentIds.length > 0 && <p className="ui-inline-notice">仅检索所选 {draftDocumentIds.length} 份文档的版本；切换知识库将重选范围。</p>}
          {currentSession?.documents?.length ? <details className="ui-inline-notice"><summary>仅检索指定的 {currentSession.documents.length} 份文档</summary><ul>{currentSession.documents.map((document) => <li key={document.id}><Link to={`/documents?documentId=${encodeURIComponent(document.id)}`}>{document.filename}</Link></li>)}</ul></details> : null}

          {messageSearch.open && <ChatMessageSearch {...messageSearch} loading={messageSearch.loading || loadingHistory} missingTarget={!loadingHistory && messageSearch.missingTarget} />}
          {targetMessageId && messagesReady && !messageSearch.open && <div className="chat-find__location">
            <span>{loadingHistory ? '正在读取目标附近的消息…' : messageSearch.missingTarget ? '指定消息已不存在或不属于当前会话。' : !locationLoaded ? '正在读取目标附近的消息…' : '已定位到指定消息。'}</span>
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
          {historyError && <div className="ui-inline-notice" role="status">
            <span>{historyError}</span>
            <Button disabled={historyLocked || loadingHistory} variant="link" onClick={() => {
              if (locationTarget && !locationLoaded && !locationMissing) void loadMessageContext(locationTarget);
              else if (historyError.includes('会话内容已变化')) void thread.reload();
              else void thread.retryHistory();
            }}>重试加载历史</Button>
          </div>}

          <div
            className="chat-thread"
            onScroll={(event) => {
              const element = event.currentTarget;
              stickToBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 80;
              if (element.scrollTop < 120 && hasOlderMessages && !loadingHistory && !historyError && !historyLocked && !searchingHistory) loadEarlier();
            }}
            ref={messagesRef}
          >
            {!thread.loading && hasOlderMessages && <div className="chat-history-load">
              <Button disabled={historyLocked || loadingHistory} variant="ghost" onClick={loadEarlier}>
                {loadingHistory ? '正在加载历史消息…' : '加载更早的消息'}
              </Button>
            </div>}
            {thread.loading ? (
              <LoadingSkeleton announce columns={1} compact rows={5} />
            ) : thread.messages.length === 0 && !thread.pendingQuestion && !thread.failedSend && !thread.unconfirmedSend && !thread.stoppedStream ? (
              sessionId ? null : (
                <ChatEmptyState
                  documentCount={draftDocumentIds.length}
                  composer={composer}
                  onSuggest={(text) => { if (!interactionLocked) setDraft((current) => current ? current + "\n\n" + text : text); }}
                  knowledgeBases={knowledgeBases}
                  loading={sessionStore.knowledgeBasesLoading}
                  onSelect={(id) => {
                    if (interactionLocked) return;
                    const ids = draftKnowledgeBaseIds.includes(id) ? draftKnowledgeBaseIds.filter((value) => value !== id) : [...draftKnowledgeBaseIds, id];
                    if (ids.length > 5) { toast.error('每个会话最多选择 5 个知识库。'); return; }
                    setSearchParams(ids.length ? { knowledgeBaseId: ids[0], ...(ids.length > 1 ? { knowledgeBaseIds: ids.join(',') } : {}) } : {});
                  }}
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
                    canEdit={!archived && !interactionLocked && !loadingHistory}
                    focusedCitationIndex={
                      focusedCitation?.messageId === message.id ? focusedCitation.index : null
                    }
                    key={id}
                    located={messageSearch.locatedId === message.id}
                    knowledgeBaseId={activeKnowledgeBaseId || undefined}
                    onOpenCitation={(citation, index) => openSource(citation, index, message.id)}
                    message={message}
                    editDraft={editingMessageId === message.id ? editingDraft : ''}
                    editing={editingMessageId === message.id}
                    editSaving={thread.editingId === message.id}
                    feedbackSaving={feedbackSavingIds.has(message.id)}
                    versionIndex={index} versionCount={versions.length} versionGroupId={id} versionsDisabled={interactionLocked} onVersionChange={selectAnswerVersion}
                    onFeedback={onMessageFeedback}
                    onBookmark={setBookmarkTarget}
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
            {!thread.loading && hasNewerMessages && <div className="chat-history-load">
              <Button disabled={historyLocked || loadingHistory} variant="ghost" onClick={() => {
                stickToBottomRef.current = false;
                void loadNewerMessages();
              }}>加载后续消息</Button>
            </div>}
          </div>
          {hasNewerMessages && <div className="chat-find__location">
            <span>正在查看历史片段，回到最新消息后可继续提问。</span>
            <Button disabled={historyLocked || loadingHistory} variant="ghost" onClick={returnToLatest}>回到最新消息</Button>
          </div>}

          {!showLauncher && composer}
        </section>
        {visibleSource && (
          <ChatSourcePreview
            canDownload={canUnlessUnknown(knowledgeBases.find((kb) => kb.id === (visibleSource.citation.knowledgeBaseId ?? activeKnowledgeBaseId)), 'document.download')}
            citation={visibleSource.citation}
            question={visibleSource.question}
            relatedDocumentIds={visibleSource.relatedDocumentIds}
            index={visibleSource.index}
            key={`${sourceScope}:${visibleSource.citation.documentId}`}
            knowledgeBaseId={visibleSource.citation.knowledgeBaseId ?? activeKnowledgeBaseId}
            onClose={closeSource}
          />
        )}
      </div>

      {documentPickerOpen && <ChatDocumentPicker knowledgeBases={knowledgeBases} onClose={() => setDocumentPickerOpen(false)} onSelect={(documents) => { setDocumentPickerOpen(false); navigate(documentChatUrl(documents)); }} />}
      {bookmarkTarget && <ChatBookmarkDialog key={bookmarkTarget.id} target={{ messageId: bookmarkTarget.id, sessionId: bookmarkTarget.sessionId, bookmark: bookmarkTarget.bookmark }}
        onClose={() => setBookmarkTarget(null)} onUpdated={thread.updateMessageBookmark} onInaccessible={thread.handleAccessLost} />}
      {bookmarksOpen && <ChatBookmarksDialog onClose={() => setBookmarksOpen(false)} onUpdated={thread.updateMessageBookmark} onInaccessible={thread.handleAccessLost} onSelect={(item) => {
        if (sessionBusyRef.current || thread.hasPendingWrite()) return;
        messageSearch.clear(); setBookmarksOpen(false); setRailOpen(false);
        if (item.sessionId === sessionId && thread.messages.some((message) => message.id === item.messageId)) void loadMessageContext(item.messageId);
        navigate(`/chat/${item.sessionId}?messageId=${encodeURIComponent(item.messageId)}`);
      }} />}
      {searchDialogOpen && <ChatSearchDialog onClose={() => setSearchDialogOpen(false)} onSelect={(item) => {
        if (sessionBusyRef.current || thread.hasPendingWrite()) return;
        messageSearch.clear();
        setSearchDialogOpen(false);
        setRailOpen(false);
        if (item.sessionId === sessionId && thread.messages.some((message) => message.id === item.messageId)) {
          void loadMessageContext(item.messageId);
        }
        navigate(`/chat/${item.sessionId}?messageId=${encodeURIComponent(item.messageId)}`);
      }} />}

      <ChatSessionActionDialogs actions={sessionActions} />

      {feedbackTarget && <ChatFeedbackDialog key={feedbackTarget.id} initial={feedbackTarget.feedback}
        onClose={() => setFeedbackTarget(null)} onSubmit={(details) => handleMessageFeedback(feedbackTarget.id, 'negative', details)} />}

    </AppShell>
  );
}

/**
 * Draft-state body. Absorbs what used to be a separate `/chat` landing page.
 */
function ChatEmptyState({
  documentCount = 0, knowledgeBases, loading, selectedIds, disabled, onSelect, composer, onSuggest,
}: {
  documentCount?: number;
  knowledgeBases: Array<{ id: string; name: string; description: string }>;
  loading: boolean;
  selectedIds: string[];
  disabled: boolean;
  onSelect: (id: string) => void;
  composer: ReactNode;
  onSuggest: (text: string) => void;
}) {
  return (
    <div className="chat-launcher">
      <span className="chat-launcher__mark"><Sparkles aria-hidden="true" />你的知识，随时可用</span>
      <h1>{documentCount ? '针对指定文档提问' : selectedIds.length ? '在指定知识库中提问' : '今天，想从资料中了解什么？'}</h1>
      <p>{documentCount ? '本会话只检索选定的 ' + documentCount + ' 份文档版本，回答会标注资料来源。' : selectedIds.length ? '本会话仅检索所选知识库，回答会标注资料来源。' : '把问题交给知汇，每一个答案都能找到出处。'}</p>
      {composer}
      <div aria-label="提问建议" className="chat-launcher__suggestions">
        <Button disabled={disabled} leadingIcon={<FileText aria-hidden="true" />} onClick={() => onSuggest('请总结资料中的关键要点，并标注引用来源。')} variant="secondary">总结一份资料</Button>
        <Button disabled={disabled} leadingIcon={<Files aria-hidden="true" />} onClick={() => onSuggest('请比较所选资料的主要差异，并列出相关依据。')} variant="secondary">对比文档差异</Button>
        <Button disabled={disabled} leadingIcon={<Search aria-hidden="true" />} onClick={() => onSuggest('请查找资料中的相关规定，说明适用条件并标注出处。')} variant="secondary">查找制度规定</Button>
      </div>
      <div className="chat-launcher__scope-heading"><span>继续探索你的知识库</span><Link to="/knowledge-bases">查看全部<ArrowUpRight aria-hidden="true" /></Link></div>
      {loading ? <LoadingSkeleton announce columns={3} rows={1} /> : knowledgeBases.length === 0 ? <EmptyState
        action={<Link className="ui-button ui-button--primary" to="/knowledge-bases?intent=create"><span>新建知识库</span></Link>}
        description="AI 问答基于知识库中的文档作答。先创建一个知识库并导入文档。"
        title="还没有可提问的知识库"
      /> : <>
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
              <span className="chat-launcher__book"><BookOpen aria-hidden="true" /></span>
              <span className="ui-cell-stack"><strong>{knowledgeBase.name}</strong><small>{knowledgeBase.description || '点击限定提问范围'}</small></span>
              {selectedIds.includes(knowledgeBase.id) && <Check aria-hidden="true" className="chat-launcher__selected" />}
            </button>
          ))}
        </div>
        <p className="chat-launcher__hint">{selectedIds.length > 0 && !documentCount ? '已指定 ' + selectedIds.length + ' 个知识库，本会话仅在所选范围内检索。' : '点击卡片限定提问范围，最多选择 5 个知识库。'}</p>
      </>}
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
