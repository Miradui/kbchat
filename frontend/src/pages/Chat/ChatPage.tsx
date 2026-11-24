import { FileText, Globe, Library, PanelLeft, Search, Sparkles } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { SetStateAction } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';

import {
  setChatMessageFeedback,
} from '../../api/resources';
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
import { tokenStore } from '../../store/tokenStore';
import { chatDraftStore } from '../../store/chatDraftStore';
import { formatDateTime } from '../../utils/format';
import { getErrorMessage } from '../../utils/errors';
import { ChatScopedComposer } from './ChatScopedComposer';
import { ChatEmptyState } from './ChatEmptyState';
import { ChatModals } from './ChatModals';
import { RegenerationNotice, UnconfirmedSendNotice } from './ChatRecoveryNotices';
import { useEventCallback } from '../../hooks/useEventCallback';
import { ChatMessageSearch, useChatMessageSearch } from './ChatMessageSearch';
import { ChatMarkdown } from './ChatMarkdown';
import { ChatAssistantLabel, CitationCard, MessageBubble } from './ChatMessage';
import { ChatSessionRail } from './ChatSessionRail';
import { canUnlessUnknown } from '../../utils/access';
import type { ChatSessionScope } from './ChatSessionRail';
import { useChatSessions } from './useChatSessions';
import { useChatThread } from './useChatThread';
import { useChatInteractionState } from './useChatInteractionState';
import { chatDraftScope } from './useChatDraft';
import { useSessionActions } from './useSessionActions';
import { useSessionRailPreferences } from './useSessionRailPreferences';
import { useChatAnswerVersions } from './useChatAnswerVersions';
import { ChatStreamView, StreamAnnouncement } from './ChatStreamView';
import { documentChatUrl } from './documentChatScope';
import { chatSessionUrl } from './chatSessionUrl';
import { consumeHomeQuestion, readHomeQuestion } from './homeQuestionNavigation';
import type { ChatTaskKind, ChatTaskResult } from './ChatTaskDialog';
import { useDraftDocuments } from './useDraftDocuments';
import { answerQuestions } from './answerQuestions';
import type { ChatDocument } from './documentChatScope';

const LazyChatSourcePreview = lazy(() =>
  import('./ChatSourcePreview').then((m) => ({ default: m.ChatSourcePreview })),
);

/**
 * `/chat` is the draft state and `/chat/:sessionId` is a thread.
 *
 * There used to be three routes: a landing page, a `/chat/new` draft and the
 * thread itself. The landing page's content is now this page's empty state, so
 * choosing a knowledge base and asking a question never changes screens.
 */
export function ChatPage() {
  const { sessionId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const homeQuestion = useMemo(() => readHomeQuestion(location.state), [location.state]);
  const [pendingHomeQuestion, setPendingHomeQuestion] = useState(() => !sessionId && homeQuestion?.question ? homeQuestion : null);
  const claimedHomeQuestionRef = useRef('');
  const sentHomeQuestionRef = useRef('');
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
  const [documentPickerQuestion, setDocumentPickerQuestion] = useState<string | null>(null);
  const [taskKind, setTaskKind] = useState<ChatTaskKind | null>(null);
  useEffect(() => { setBookmarkTarget(null); }, [sessionId]);
  const railBackdropRef = useRef<HTMLButtonElement>(null);
  const {
    focusedCitation, setFocusedCitation, sourcePreview, setSourcePreview,
    feedbackSavingIds, setFeedbackSavingIds, feedbackTarget, setFeedbackTarget,
    editingMessageId, setEditingMessageId, editingDraft, setEditingDraft,
    editConfirm, setEditConfirm,
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
  const draftDocuments = useDraftDocuments(draftDocumentIds, draftKnowledgeBaseIds, !sessionId && Boolean(user));
  useEffect(() => {
    setDocumentPickerOpen(false);
    setDocumentPickerQuestion(null);
    setTaskKind(null);
  }, [sessionId, user?.id]);
  // An explicit home submission must not overwrite or send an older draft.
  const draftScope = !sessionId && homeQuestion?.userId === user?.id && homeQuestion
    ? `home:${homeQuestion.id}` : chatDraftScope(sessionId, draftKnowledgeBaseIds, draftDocumentIds);
  const draftNavigationState = useMemo(() => !sessionId && homeQuestion?.userId === user?.id && homeQuestion
    ? consumeHomeQuestion(location.state, homeQuestion) : undefined, [homeQuestion, location.state, sessionId, user?.id]);
  const readDraft = useCallback(
    () => (user?.id ? chatDraftStore.get(user.id, draftScope) : ''),
    [draftScope, user?.id],
  );
  const setDraft = useCallback((value: SetStateAction<string>) => {
    if (!user?.id) return;
    const next = typeof value === 'function' ? value(chatDraftStore.get(user.id, draftScope)) : value;
    chatDraftStore.set(user.id, draftScope, next);
  }, [draftScope, user?.id]);
  const moveToSession = useCallback((targetSessionId: string) => {
    if (user?.id) chatDraftStore.move(user.id, draftScope, `session:${targetSessionId}`);
  }, [draftScope, user?.id]);
  const acknowledge = useCallback((targetSessionId: string, question: string) => {
    if (user?.id) chatDraftStore.acknowledge(user.id, `session:${targetSessionId}`, question);
  }, [user?.id]);
  const preparingHomeQuestion = !sessionId && homeQuestion?.id === pendingHomeQuestion?.id && user?.id === pendingHomeQuestion?.userId
    ? pendingHomeQuestion : null;
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
      navigate(chatSessionUrl(session.id, urlKnowledgeBaseId), { replace: true });
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
  const interactionLocked = thread.loading || sessionBusy || threadInteractionPending || Boolean(preparingHomeQuestion);
  const historyLocked = interactionLocked || Boolean(thread.unconfirmedSend) || thread.regeneration?.kind === 'unconfirmed';
  const messageSearch = useChatMessageSearch({
    sessionId, messages: thread.messages, targetMessageId, onLocate: locateMessage,
    ready: messagesReady, complete: !thread.hasOlderMessages && !thread.hasNewerMessages,
    blocked: historyLocked, missingMessageId: thread.missingMessageId,
  });
  const answerVersions = useChatAnswerVersions(thread.messages, sessionId, messageSearch.locatedId);
  const originalQuestions = useMemo(() => answerQuestions(thread.messages, sessionId), [thread.messages, sessionId]);

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

  // Ordinary query links only prefill the composer; they never authorize sending.
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

  useEffect(() => {
    if (!homeQuestion || !user || sessionId) return;
    if (homeQuestion.userId !== user.id) {
      navigate({ pathname: location.pathname, search: location.search, hash: location.hash }, {
        replace: true, state: consumeHomeQuestion(location.state, null),
      });
      return;
    }
    if (!homeQuestion.question || claimedHomeQuestionRef.current === homeQuestion.id) return;
    claimedHomeQuestionRef.current = homeQuestion.id;
    setDraft(homeQuestion.question);
    // Keep only draft recovery metadata in this history entry. Refresh/Back can
    // restore the question, but cannot repeat the explicit submission.
    navigate({ pathname: location.pathname, search: location.search, hash: location.hash }, {
      replace: true, state: consumeHomeQuestion(location.state, homeQuestion),
    });
  }, [homeQuestion, location, navigate, sessionId, setDraft, user]);

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
    && !draftDocuments.loading && !draftDocuments.error
    && !archived
    && !thread.loading
    && !hasNewerMessages
    && !loadingHistory
    && !sessionBusy
    && !thread.editingId
    && !thread.unconfirmedSend
    && (!thread.stoppedStream || thread.stoppedStream.resumable);

  const { send, sending } = thread;
  useEffect(() => {
    if (!preparingHomeQuestion?.question || homeQuestion?.question || sessionStore.knowledgeBasesLoading) return;
    const { id, question } = preparingHomeQuestion;
    const revision = tokenStore.getRevision();
    let active = true;
    // Do not dispatch a write from a StrictMode effect that is about to replay.
    queueMicrotask(() => {
      if (!active || sentHomeQuestionRef.current === id || tokenStore.getRevision() !== revision) return;
      sentHomeQuestionRef.current = id;
      setPendingHomeQuestion(null);
      if (canSend && !sending && !sessionStore.knowledgeBasesError) {
        void send(question, { expectedAuthRevision: revision });
      }
    });
    return () => { active = false; };
  }, [canSend, homeQuestion?.question, preparingHomeQuestion, send, sending, sessionStore.knowledgeBasesError, sessionStore.knowledgeBasesLoading]);

  const composerHint = draftDocuments.loading ? '正在确认所选文档…'
    : draftDocuments.error ? '所选资料暂不可用，请重试或重新选择；提问范围不会自动扩大。'
    : preparingHomeQuestion ? '正在加载可提问的知识库…'
    : knowledgeBases.length === 0 && sessionStore.knowledgeBasesError ? '知识库暂不可用，请重试加载。'
    : knowledgeBases.length === 0 ? '还没有知识库。先创建一个知识库并导入文档。' : !activeKnowledgeBase && !automaticScope
    ? knowledgeBases.length === 0
      ? '还没有知识库。先创建一个知识库并导入文档。'
      : '先选择 1–5 个知识库。'
    : archived
      ? '这个会话已归档，内容仍可查看。'
      : undefined;

  const selectKnowledgeBase = useCallback((knowledgeBaseId: string) => {
    // From a thread, switching knowledge base starts a new draft rather than
    // silently jumping into some other session.
    if (knowledgeBaseId) navigate(`/chat?knowledgeBaseId=${encodeURIComponent(knowledgeBaseId)}`, { state: draftNavigationState });
    else navigate('/chat', { state: draftNavigationState });
  }, [draftNavigationState, navigate]);

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
  const runEdit = useEventCallback((messageId: string, content: string) => {
    void thread.editMessage(messageId, content).then(() => {
      if (activeSessionIdRef.current === sessionId && editingMessageId === messageId) {
        setEditingMessageId(null); setEditingDraft(''); toast.success('消息已更新并重新生成');
      }
    }).catch((caught) => toast.error(getErrorMessage(caught, '消息更新失败，请稍后重试')));
  });
  const submitEditing = useEventCallback((messageId: string, content: string) => {
    if (archived || interactionLocked || thread.editingId || !content.trim()) return;
    // The server replaces the whole tail. A partial history window cannot prove
    // this is the last question, so it also requires confirmation.
    const index = thread.messages.findIndex((message) => message.id === messageId);
    const tail = index < 0 ? [] : thread.messages.slice(index + 1);
    if (hasNewerMessages || tail.some((message) => message.role === 'user')) {
      setEditConfirm({ messageId, content });
      return;
    }
    runEdit(messageId, content);
  });
  const focusCitation = useEventCallback((messageId: string, index: number | null) => setFocusedCitation({ messageId, index }));
  const handleChooseDocumentsForQuestion = useEventCallback((question: string) => {
    setDocumentPickerQuestion(question);
    setDocumentPickerOpen(true);
  });
  const handleRefineQuestion = useEventCallback((question: string) => {
    setDraft((current) => current && current !== question ? `${current}\n\n${question}` : question);
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.chat-composer textarea')?.focus());
  });
  const checkRegenerationNow = useEventCallback(() => {
    if (!sessionBusyRef.current) void thread.checkRegeneration();
  });

  const topbarActions = useMemo(() => (
    currentSession
      ? <OverflowMenu disabled={interactionLocked || sessionExporting} label="会话操作" items={getSessionActions(currentSession)} />
      : undefined
  ), [currentSession, getSessionActions, interactionLocked, sessionExporting]);

  const openSessionRail = useEventCallback(() => {
    if (isNarrow) setRailOpen(true);
    else {
      if (railSuppressedForPreview) setSourcePreview(null);
      setRailPreferences({ ...railPreferences, collapsed: false });
    }
  });

  const topbarLeading = useMemo(() => (
    (!historyVisible || isNarrow) ? (
      <IconButton
        aria-expanded={historyVisible}
        label="打开会话列表"
        onClick={openSessionRail}
        ref={railToggleRef}
      >
        <PanelLeft aria-hidden="true" />
      </IconButton>
    ) : undefined
  ), [historyVisible, isNarrow, openSessionRail]);

  const showLauncher = !sessionId && !thread.loading && thread.messages.length === 0
    && !preparingHomeQuestion && !thread.pendingQuestion && !thread.failedSend && !thread.unconfirmedSend && !thread.stoppedStream;

  const startNewChat = useEventCallback(() => {
    if (sessionBusyRef.current || thread.hasPendingWrite()) return;
    setRailOpen(false);
    navigate('/chat');
  });

  function openDocumentDraft(documents: ChatDocument[], question: string) {
    if (!user || interactionLocked || thread.hasPendingWrite()) return;
    const bases = [...new Set(documents.map((document) => document.knowledgeBaseId))];
    const ids = documents.map((document) => document.id);
    const targetScope = draftNavigationState ? draftScope : chatDraftScope(undefined, bases, ids);
    const previous = chatDraftStore.get(user.id, targetScope);
    // Keep an existing destination draft visible too; neither draft is sent here.
    const text = targetScope === draftScope || !previous || previous === question
      ? question : question ? `${previous}\n\n${question}` : previous;
    chatDraftStore.set(user.id, targetScope, text);
    navigate(documentChatUrl(documents), { state: draftNavigationState });
  }

  function applyTask(result: ChatTaskResult) {
    if (interactionLocked) return;
    const current = readDraft();
    const question = current ? `${current}\n\n${result.question}` : result.question;
    if (result.documents) openDocumentDraft(result.documents, question);
    else setDraft(question);
    setTaskKind(null);
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
      refetchError={sessionStore.sessionsRefetchError}
      knowledgeBaseId={urlKnowledgeBaseId}
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

  const submitQuestion = useEventCallback((question: string) => {
    if (sessionBusyRef.current) return;
    // A draft thread needs the knowledge base pinned in the URL before
    // the session is created.
    if (!sessionId && !urlKnowledgeBaseId && activeKnowledgeBaseId && !draftDocumentIds.length) {
      setSearchParams({ knowledgeBaseId: activeKnowledgeBaseId }, { replace: true, state: draftNavigationState });
    }
    void thread.send(question);
  });

  const composer = (
    <ChatScopedComposer
      tools={<>
        {!sessionId ? <Button aria-label="自动检索全部可访问知识库" aria-pressed={automaticScope && !draftDocumentIds.length}
          className="chat-composer__scope-button" disabled={interactionLocked} leadingIcon={<Globe aria-hidden="true" />}
          onClick={() => { if (!interactionLocked) setSearchParams({}, { state: draftNavigationState }); }} variant="ghost">自动跨库</Button>
          : <span className="chat-composer__scope-label"><Globe aria-hidden="true" />{currentSession?.documents?.length ? currentSession.documents.length + ' 份文档' : automaticScope ? '自动跨库' : multiBase ? activeKnowledgeBaseIds.length + ' 个知识库' : activeKnowledgeBase?.name || '当前范围'}</span>}
        {!sessionId && <Button className="chat-composer__scope-button" disabled={interactionLocked} leadingIcon={<FileText aria-hidden="true" />}
          onClick={() => { setDocumentPickerQuestion(null); setDocumentPickerOpen(true); }} variant="ghost">指定文档提问</Button>}
      </>}
      disabled={!user || !canSend || thread.sending || sessionBusy || Boolean(preparingHomeQuestion)}
      draftScope={draftScope}
      error={thread.rateLimitError}
      retryNotice={thread.rateLimitNotice}
      hint={composerHint}
      onCancel={thread.cancelSend}
      onDismissRateLimitError={thread.dismissRateLimitError}
      onSubmitQuestion={submitQuestion}
      placeholder={(currentSession?.documents?.length || draftDocumentIds.length) ? '针对所选文档提问…' : automaticScope ? '直接提问，自动检索相关知识库…' : multiBase ? `向 ${activeKnowledgeBaseIds.length} 个知识库提问…` : activeKnowledgeBase ? `向「${activeKnowledgeBase.name}」提问…` : '选择知识库后开始提问…'}
      sending={thread.sending}
      userId={user?.id}
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
      topbarLeading={topbarLeading}
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
                  // Remount per session: the field stays open until its save is
                  // confirmed, so switching sessions must not leave the previous
                  // session's draft in the header.
                  key={currentSession.id}
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
            {loadedSession?.branchFromSessionId && <Link className="ui-button ui-button--ghost" to={chatSessionUrl(loadedSession.branchFromSessionId, urlKnowledgeBaseId, loadedSession.branchFromMessageId)}>查看来源会话</Link>}
          </header>}
          {!sessionId && draftDocumentIds.length > 0 && <div className="ui-inline-notice chat-draft-documents">
            <span>仅检索所选 {draftDocumentIds.length} 份文档的版本；切换知识库将重选范围。</span>
            {draftDocuments.loading && <span>正在确认所选文档…</span>}
            {draftDocuments.error && <p className="ui-inline-error" role="alert">{draftDocuments.error} <Button variant="link" onClick={draftDocuments.retry}>重试文档范围</Button></p>}
            {draftDocuments.documents.length > 0 && <ul>{draftDocuments.documents.map((document, index) => <li key={document.id}><Link to={`/documents?documentId=${encodeURIComponent(document.id)}`}>{index + 1}. {document.filename}</Link></li>)}</ul>}
          </div>}
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
            ) : thread.messages.length === 0 && !preparingHomeQuestion && !thread.pendingQuestion && !thread.failedSend && !thread.unconfirmedSend && !thread.stoppedStream ? (
              sessionId ? null : (
                <ChatEmptyState
                  documentCount={draftDocumentIds.length}
                  composer={composer}
                  onSuggest={(kind) => { if (!interactionLocked) setTaskKind(kind); }}
                  knowledgeBases={knowledgeBases}
                  loading={sessionStore.knowledgeBasesLoading}
                  error={sessionStore.knowledgeBasesError}
                  onRetry={() => void reloadKnowledgeBases()}
                  onSelect={(id) => {
                    if (interactionLocked) return;
                    const ids = draftKnowledgeBaseIds.includes(id) ? draftKnowledgeBaseIds.filter((value) => value !== id) : [...draftKnowledgeBaseIds, id];
                    if (ids.length > 5) { toast.error('每个会话最多选择 5 个知识库。'); return; }
                    setSearchParams(ids.length ? { knowledgeBaseId: ids[0], ...(ids.length > 1 ? { knowledgeBaseIds: ids.join(',') } : {}) } : {}, { state: draftNavigationState });
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
                    onOpenCitation={openSource}
                    message={message}
                    noBasisSession={loadedSession}
                    noBasisQuestion={originalQuestions.get(message.id)}
                    noBasisDisabled={interactionLocked || archived || Boolean(thread.hasPendingWrite())}
                    onChooseDocuments={handleChooseDocumentsForQuestion}
                    onRefineQuestion={handleRefineQuestion}
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
                            onCheck={checkRegenerationNow}
                            onRegenerate={regenerateAnswer}
                            regeneration={thread.regeneration}
                          />
                        )
                        : undefined
                    }
                    regenerating={thread.regeneratingId === message.id}
                  />
                ))}

                {preparingHomeQuestion && <>
                  <article className="chat-msg chat-msg--user is-pending">
                    <div className="chat-msg__body"><p className="chat-msg__content">{preparingHomeQuestion.question}</p></div>
                  </article>
                  <article className="chat-msg chat-msg--assistant is-pending">
                    <div className="chat-msg__body">
                      <ChatAssistantLabel />
                      <p className="chat-msg__content">正在准备对话…</p>
                      <LoadingSkeleton columns={1} compact rows={2} />
                    </div>
                  </article>
                </>}

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
          <Suspense fallback={null}>
            <LazyChatSourcePreview
              canDownload={canUnlessUnknown(knowledgeBases.find((kb) => kb.id === (visibleSource.citation.knowledgeBaseId ?? activeKnowledgeBaseId)), 'document.download')}
              citation={visibleSource.citation}
              question={visibleSource.question}
              relatedDocumentIds={visibleSource.relatedDocumentIds}
              index={visibleSource.index}
              key={`${sourceScope}:${visibleSource.citation.documentId}`}
              knowledgeBaseId={visibleSource.citation.knowledgeBaseId ?? activeKnowledgeBaseId}
              onClose={closeSource}
            />
          </Suspense>
        )}
      </div>

      <ChatModals
        bookmarksOpen={bookmarksOpen}
        bookmarkTarget={bookmarkTarget}
        documentPickerOpen={documentPickerOpen}
        editBusy={Boolean(thread.editingId)}
        editConfirm={editConfirm}
        feedbackTarget={feedbackTarget}
        knowledgeBases={knowledgeBases}
        onApplyTask={applyTask}
        onCancelEditConfirm={() => setEditConfirm(null)}
        onCloseBookmarkTarget={() => setBookmarkTarget(null)}
        onCloseBookmarks={() => setBookmarksOpen(false)}
        onCloseDocumentPicker={() => setDocumentPickerOpen(false)}
        onCloseFeedback={() => setFeedbackTarget(null)}
        onCloseSearchDialog={() => setSearchDialogOpen(false)}
        onCloseTask={() => setTaskKind(null)}
        onConfirmEdit={(pending) => {
          setEditConfirm(null);
          runEdit(pending.messageId, pending.content);
        }}
        onInaccessible={thread.handleAccessLost}
        onNavigateToHit={(item, closeDialog) => {
          if (sessionBusyRef.current || thread.hasPendingWrite()) return;
          messageSearch.clear();
          closeDialog();
          setRailOpen(false);
          if (item.sessionId === sessionId && thread.messages.some((message) => message.id === item.messageId)) {
            void loadMessageContext(item.messageId);
          }
          navigate(chatSessionUrl(item.sessionId, urlKnowledgeBaseId, item.messageId));
        }}
        onSelectDocuments={(documents) => {
          setDocumentPickerOpen(false);
          openDocumentDraft(documents, documentPickerQuestion ?? readDraft());
        }}
        onSubmitFeedback={(messageId, details) => handleMessageFeedback(messageId, 'negative', details)}
        onUpdateMessageBookmark={thread.updateMessageBookmark}
        searchDialogOpen={searchDialogOpen}
        sessionActions={sessionActions}
        taskKind={taskKind}
      />

    </AppShell>
  );
}
