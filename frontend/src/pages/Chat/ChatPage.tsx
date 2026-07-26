import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { BookOpen, PanelLeft, X } from 'lucide-react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';

import { ApiError } from '../../api/client';
import {
  archiveChatSession,
  createChatSession,
  deleteChatSession,
  getChatSession,
  listChatMessages,
  listChatSessions,
  listKnowledgeBases,
  regenerateChatMessage,
  sendChatMessage,
  updateChatSessionTitle,
} from '../../api/resources';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';
import { WorkspaceShell } from '../../components/WorkspaceShell';
import { RerankFallbackNotice } from '../../components/feedback/RerankFallbackNotice';
import { useModalFocus } from '../../components/ui/useModalFocus';
import type {
  ChatMessage,
  ChatSession,
  Citation,
  KnowledgeBase,
  KnowledgeBaseRerankFallback,
} from '../../types/api';
import { getErrorMessage } from '../../utils/errors';
import { pendingChatRequestStore } from './pendingChatRequestStore';
import type { PendingChatRequest } from './pendingChatRequestStore';

type ChatPageProps = {
  draftSession?: boolean;
};

export function ChatPage({ draftSession = false }: ChatPageProps) {
  const { sessionId: routedSessionId } = useParams();
  const sessionId = draftSession ? 'new' : routedSessionId;
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const activeSessionIdRef = useRef<string | undefined>(sessionId);
  const mountedRef = useRef(false);
  const draftSendSessionIdRef = useRef<string | null>(null);
  const sendOperationRef = useRef<symbol | null>(null);
  const sendCheckOperationRef = useRef<symbol | null>(null);
  const sessionMutationRef = useRef<symbol | null>(null);
  const regenerateOperationRef = useRef<symbol | null>(null);
  const messageLoadRequestRef = useRef(0);
  const sendCheckRequestRef = useRef(0);
  const sessionListRequestRef = useRef(0);
  const knowledgeBaseListRequestRef = useRef(0);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [currentSessionDetail, setCurrentSessionDetail] = useState<ChatSession | null>(null);
  const [draft, setDraft] = useState('');
  const [titleDraft, setTitleDraft] = useState('');
  const [pendingQuestion, setPendingQuestion] = useState('');
  const [failedQuestion, setFailedQuestion] = useState('');
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [knowledgeBasesLoading, setKnowledgeBasesLoading] = useState(true);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [checkingSendResult, setCheckingSendResult] = useState(false);
  const [regeneratingMessageId, setRegeneratingMessageId] = useState<string | null>(null);
  const [rerankFallback, setRerankFallback] = useState<KnowledgeBaseRerankFallback | null>(null);
  const [updatingSession, setUpdatingSession] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [sessionConfirmError, setSessionConfirmError] = useState('');
  const [error, setError] = useState('');
  const [sessionListError, setSessionListError] = useState('');
  const [knowledgeBaseListError, setKnowledgeBaseListError] = useState('');
  const [messageLoadError, setMessageLoadError] = useState('');
  const [activeCitationMessageId, setActiveCitationMessageId] = useState<string | null>(null);
  const [uncertainSend, setUncertainSend] = useState<PendingChatRequest | null>(null);
  const [auxiliaryPanel, setAuxiliaryPanel] = useState<'sessions' | 'citations' | null>(null);
  const isCompact = useMediaQuery('(max-width: 1439px)');
  const sessionsPanelRef = useModalFocus<HTMLElement>(auxiliaryPanel === 'sessions', () => setAuxiliaryPanel(null));
  const citationsPanelRef = useModalFocus<HTMLElement>(auxiliaryPanel === 'citations', () => setAuxiliaryPanel(null));
  const isDraftSession = sessionId === 'new';
  const draftKnowledgeBaseId = searchParams.get('knowledgeBaseId');

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      messageLoadRequestRef.current += 1;
      sendCheckRequestRef.current += 1;
      sessionListRequestRef.current += 1;
      knowledgeBaseListRequestRef.current += 1;
      sendOperationRef.current = null;
      sendCheckOperationRef.current = null;
      sessionMutationRef.current = null;
      regenerateOperationRef.current = null;
    };
  }, []);

  const loadSessions = useCallback(async () => {
    const request = ++sessionListRequestRef.current;
    setSessionsLoading(true);
    setSessionListError('');
    try {
      const response = await listChatSessions();
      if (mountedRef.current && sessionListRequestRef.current === request) {
        setSessions(response.items);
      }
    } catch (err) {
      if (mountedRef.current && sessionListRequestRef.current === request) {
        setSessionListError(errorMessage(err, '会话列表加载失败'));
      }
    } finally {
      if (mountedRef.current && sessionListRequestRef.current === request) {
        setSessionsLoading(false);
      }
    }
  }, []);

  const loadKnowledgeBases = useCallback(async () => {
    const request = ++knowledgeBaseListRequestRef.current;
    setKnowledgeBasesLoading(true);
    setKnowledgeBaseListError('');
    try {
      const response = await listKnowledgeBases({ pageSize: 100 });
      if (mountedRef.current && knowledgeBaseListRequestRef.current === request) {
        setKnowledgeBases(response.items);
      }
    } catch (err) {
      if (mountedRef.current && knowledgeBaseListRequestRef.current === request) {
        setKnowledgeBaseListError(errorMessage(err, '知识库列表加载失败'));
      }
    } finally {
      if (mountedRef.current && knowledgeBaseListRequestRef.current === request) {
        setKnowledgeBasesLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void loadSessions();
    void loadKnowledgeBases();
  }, [loadKnowledgeBases, loadSessions]);

  const loadSessionMessages = useCallback(async (requestedSessionId: string) => {
    const request = ++messageLoadRequestRef.current;
    setCurrentSessionDetail(null);
    setTitleDraft('');
    setMessages([]);
    setActiveCitationMessageId(null);
    setMessageLoadError('');
    setMessagesLoading(true);

    try {
      const [sessionResponse, messageResponse] = await Promise.all([
        getChatSession(requestedSessionId),
        listChatMessages(requestedSessionId),
      ]);
      if (
        mountedRef.current
        && activeSessionIdRef.current === requestedSessionId
        && messageLoadRequestRef.current === request
      ) {
        setCurrentSessionDetail(sessionResponse);
        setTitleDraft(sessionResponse.title || '');
        setMessages(messageResponse.items);
        setSessions((current) => mergeSession(current, sessionResponse));
        const persistedRequest = pendingChatRequestStore.get(requestedSessionId);
        if (persistedRequest && !sendOperationRef.current) {
          const requestWasAccepted = messageResponse.items.some(
            (message) => message.clientRequestId === persistedRequest.clientRequestId,
          );
          if (requestWasAccepted) {
            pendingChatRequestStore.clear(requestedSessionId, persistedRequest.clientRequestId);
            setUncertainSend(null);
            setDraft('');
            setError('');
          } else {
            setUncertainSend(persistedRequest);
            setDraft(persistedRequest.question);
            setError('发送结果暂时无法确认。请先再次检查；如仍未显示，再确认是否重新发送。');
          }
        }
      }
    } catch (err) {
      if (
        mountedRef.current
        && activeSessionIdRef.current === requestedSessionId
        && messageLoadRequestRef.current === request
      ) {
        setMessageLoadError(errorMessage(err, '消息加载失败'));
        setCurrentSessionDetail(null);
        setMessages([]);
      }
    } finally {
      if (
        mountedRef.current
        && activeSessionIdRef.current === requestedSessionId
        && messageLoadRequestRef.current === request
      ) {
        setMessagesLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    activeSessionIdRef.current = sessionId;
    sendCheckRequestRef.current += 1;
    const continuingDraftSend = draftSendSessionIdRef.current === sessionId;
    setConfirmArchive(false);
    setConfirmDelete(false);
    setSessionConfirmError('');
    regenerateOperationRef.current = null;
    setRegeneratingMessageId(null);
    setRerankFallback(null);
    if (!continuingDraftSend) {
      sendOperationRef.current = null;
      setDraft('');
      setPendingQuestion('');
      setFailedQuestion('');
      setUncertainSend(null);
      setSending(false);
    }
    if (!sessionId || isDraftSession) {
      messageLoadRequestRef.current += 1;
      setCurrentSessionDetail(null);
      setTitleDraft('');
      setMessages([]);
      setFailedQuestion('');
      setUncertainSend(null);
      setMessagesLoading(false);
      setMessageLoadError('');
      return;
    }

    setError('');
    void loadSessionMessages(sessionId);
  }, [draftKnowledgeBaseId, isDraftSession, loadSessionMessages, sessionId]);

  useEffect(() => {
    if (!isCompact) {
      setAuxiliaryPanel(null);
    }
  }, [isCompact]);

  useEffect(() => {
    messagesRef.current?.scrollTo({
      top: messagesRef.current.scrollHeight,
      behavior: 'smooth',
    });
  }, [messages, pendingQuestion]);

  useEffect(() => {
    setActiveCitationMessageId((current) => {
      if (current && messages.some((message) => message.id === current && message.role === 'assistant')) {
        return current;
      }
      return [...messages].reverse().find((message) => message.role === 'assistant')?.id ?? null;
    });
  }, [messages]);

  const sessionDetailsReady = !isDraftSession
    && currentSessionDetail?.id === sessionId
    && !messagesLoading;
  const currentSession = isDraftSession
    ? null
    : sessionDetailsReady
      ? currentSessionDetail
      : sessions.find((session) => session.id === sessionId) ?? null;
  const currentKnowledgeBase = knowledgeBases.find(
    (kb) => kb.id === (currentSession?.knowledgeBaseId ?? draftKnowledgeBaseId),
  );
  const sessionsForCurrentKnowledgeBase = useMemo(() => {
    if (!currentKnowledgeBase) {
      return sessions;
    }
    return sessions.filter((session) => session.knowledgeBaseId === currentKnowledgeBase.id);
  }, [currentKnowledgeBase, sessions]);

  const activeCitations = useMemo(() => {
    return messages.find((message) => message.id === activeCitationMessageId)?.citations ?? [];
  }, [activeCitationMessageId, messages]);
  const latestAssistantMessageId = useMemo(
    () => [...messages].reverse().find((message) => message.role === 'assistant')?.id ?? null,
    [messages],
  );

  const questionCount = messages.filter((message) => message.role === 'user').length;
  const citationCount = messages.reduce((sum, message) => sum + message.citations.length, 0);
  const messageStatsKnown = isDraftSession || (sessionDetailsReady && !messageLoadError);
  const archived = Boolean(currentSession?.archivedAt);
  const chatMutationBusy = sending || checkingSendResult || updatingSession || regeneratingMessageId !== null;
  const canSend = !archived
    && Boolean(currentKnowledgeBase)
    && Boolean(sessionId)
    && (isDraftSession || sessionDetailsReady)
    && !messagesLoading;

  async function handleUpdateTitle(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      !currentSession
      || !sessionDetailsReady
      || !titleDraft.trim()
      || sendOperationRef.current
      || sendCheckOperationRef.current
      || sessionMutationRef.current
      || regenerateOperationRef.current
    ) {
      return;
    }

    const targetSessionId = currentSession.id;
    const operation = Symbol('update-session-title');
    sessionMutationRef.current = operation;
    setUpdatingSession(true);
    setError('');

    try {
      const nextSession = await updateChatSessionTitle(targetSessionId, titleDraft.trim());
      if (
        mountedRef.current
        && activeSessionIdRef.current === targetSessionId
        && sessionMutationRef.current === operation
      ) {
        setSessions((current) => mergeSession(current, nextSession));
        setCurrentSessionDetail(nextSession);
      }
    } catch (err) {
      if (
        mountedRef.current
        && activeSessionIdRef.current === targetSessionId
        && sessionMutationRef.current === operation
      ) {
        setError(errorMessage(err, '会话标题更新失败'));
      }
    } finally {
      if (
        mountedRef.current
        && sessionMutationRef.current === operation
      ) {
        sessionMutationRef.current = null;
        setUpdatingSession(false);
      }
    }
  }

  async function handleArchiveSession() {
    if (!currentSession || !sessionDetailsReady || sendOperationRef.current || sendCheckOperationRef.current || sessionMutationRef.current) {
      return;
    }

    const targetSessionId = currentSession.id;
    const operation = Symbol('archive-session');
    sessionMutationRef.current = operation;
    setUpdatingSession(true);
    setError('');

    try {
      const archivedSession = await archiveChatSession(targetSessionId);
      if (activeSessionIdRef.current === targetSessionId && sessionMutationRef.current === operation) {
        sessionListRequestRef.current += 1;
        setSessionsLoading(false);
        setSessionListError('');
        setSessions((current) => current.filter((session) => session.id !== targetSessionId));
        setCurrentSessionDetail(archivedSession);
        setSessionConfirmError('');
        setConfirmArchive(false);
      }
    } catch (err) {
      if (activeSessionIdRef.current === targetSessionId && sessionMutationRef.current === operation) {
        setSessionConfirmError(errorMessage(err, '会话归档失败'));
      }
    } finally {
      if (sessionMutationRef.current === operation) {
        sessionMutationRef.current = null;
        setUpdatingSession(false);
      }
    }
  }

  async function handleDeleteSession() {
    if (!currentSession || !sessionDetailsReady || sendOperationRef.current || sendCheckOperationRef.current || sessionMutationRef.current) {
      return;
    }

    const targetSessionId = currentSession.id;
    const operation = Symbol('delete-session');
    sessionMutationRef.current = operation;
    setUpdatingSession(true);
    setError('');

    try {
      await deleteChatSession(targetSessionId);
      if (activeSessionIdRef.current === targetSessionId && sessionMutationRef.current === operation) {
        sessionListRequestRef.current += 1;
        setSessionsLoading(false);
        setSessionListError('');
        setSessions((current) => current.filter((session) => session.id !== targetSessionId));
        setSessionConfirmError('');
        setConfirmDelete(false);
        navigate('/chat', { replace: true });
      }
    } catch (err) {
      if (activeSessionIdRef.current === targetSessionId && sessionMutationRef.current === operation) {
        setSessionConfirmError(errorMessage(err, '会话删除失败'));
      }
    } finally {
      if (sessionMutationRef.current === operation) {
        sessionMutationRef.current = null;
        setUpdatingSession(false);
      }
    }
  }

  function handleCreateSession(knowledgeBaseId = currentKnowledgeBase?.id) {
    if (sendOperationRef.current || sendCheckOperationRef.current || sessionMutationRef.current) {
      return;
    }
    const targetKnowledgeBase =
      knowledgeBases.find((knowledgeBase) => knowledgeBase.id === knowledgeBaseId) ?? knowledgeBases[0];
    if (!targetKnowledgeBase) {
      setError('请先创建知识库，再开始新的问答会话。');
      return;
    }

    setError('');
    navigate(`/chat/new?knowledgeBaseId=${encodeURIComponent(targetKnowledgeBase.id)}`);
  }

  function handleKnowledgeBaseChange(knowledgeBaseId: string) {
    if (sendOperationRef.current || sendCheckOperationRef.current || sessionMutationRef.current) {
      return;
    }
    if (isDraftSession) {
      navigate(`/chat/new?knowledgeBaseId=${encodeURIComponent(knowledgeBaseId)}`, { replace: true });
      return;
    }
    const targetSessions = sessions
      .filter((session) => session.knowledgeBaseId === knowledgeBaseId)
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    if (targetSessions[0]) {
      navigate(`/chat/${targetSessions[0].id}`);
      return;
    }

    handleCreateSession(knowledgeBaseId);
  }

  async function submitQuestion(question: string, confirmedResend = false) {
    const requestToRetry = confirmedResend ? uncertainSend : null;
    if (
      !question
      || sending
      || sendOperationRef.current
      || sendCheckOperationRef.current
      || sessionMutationRef.current
      || !canSend
      || (uncertainSend && !confirmedResend)
    ) {
      return;
    }

    const operation = Symbol('send-message');
    sendOperationRef.current = operation;
    setSending(true);
    setError('');
    setRerankFallback(null);
    setFailedQuestion('');
    setUncertainSend(null);
    setPendingQuestion(question);
    const clientRequestId = requestToRetry?.clientRequestId ?? crypto.randomUUID();

    let activeSessionId = sessionId as string;
    let messageRequestStarted = false;
    try {
      if (isDraftSession) {
        if (!currentKnowledgeBase) {
          throw new Error('知识库不存在');
        }
        const session = await createChatSession(currentKnowledgeBase.id, '');
        if (
          !mountedRef.current
          || sendOperationRef.current !== operation
          || activeSessionIdRef.current !== activeSessionId
        ) {
          return;
        }
        activeSessionId = session.id;
        activeSessionIdRef.current = session.id;
        draftSendSessionIdRef.current = session.id;
        setCurrentSessionDetail(session);
        setSessions((current) => mergeSession(current, session));
        navigate(`/chat/${session.id}`, { replace: true });
      }

      messageRequestStarted = true;
      const pendingRequest: PendingChatRequest = {
        sessionId: activeSessionId,
        question,
        clientRequestId,
        createdAt: requestToRetry?.createdAt ?? new Date().toISOString(),
      };
      pendingChatRequestStore.set(pendingRequest);
      const response = await sendChatMessage(activeSessionId, { content: question, clientRequestId });
      pendingChatRequestStore.clear(activeSessionId, clientRequestId);
      setUncertainSend(null);
      if (
        mountedRef.current
        && sendOperationRef.current === operation
        && activeSessionIdRef.current === activeSessionId
      ) {
        setRerankFallback(response.rerankFallback?.used ? response.rerankFallback : null);
      }
    } catch (err) {
      if (
        !mountedRef.current
        || sendOperationRef.current !== operation
        || activeSessionIdRef.current !== activeSessionId
      ) {
        return;
      }
      sendOperationRef.current = null;
      if (draftSendSessionIdRef.current === activeSessionId) {
        draftSendSessionIdRef.current = null;
      }
      setDraft(question);
      if (err instanceof ApiError && isDefinitiveSendFailure(err)) {
        pendingChatRequestStore.clear(activeSessionId, clientRequestId);
        setError(errorMessage(err, '消息发送失败，请稍后重试。'));
        setFailedQuestion(question);
      } else if (messageRequestStarted) {
        setError('发送结果暂时无法确认。请先再次检查；如仍未显示，再确认是否重新发送。');
        setUncertainSend({
          sessionId: activeSessionId,
          question,
          clientRequestId,
          createdAt: requestToRetry?.createdAt ?? new Date().toISOString(),
        });
      } else {
        setError('会话创建结果暂时无法确认，请刷新会话列表后再试。');
      }
      setSending(false);
      setPendingQuestion('');
      return;
    }

    if (
      !mountedRef.current
      || sendOperationRef.current !== operation
      || activeSessionIdRef.current !== activeSessionId
    ) {
      if (draftSendSessionIdRef.current === activeSessionId) {
        draftSendSessionIdRef.current = null;
      }
      return;
    }
    setDraft('');
    setFailedQuestion('');
    const messageRefreshRequest = ++messageLoadRequestRef.current;
    try {
      const [messageResponse] = await Promise.all([listChatMessages(activeSessionId), loadSessions()]);
      if (
        mountedRef.current
        && activeSessionIdRef.current === activeSessionId
        && messageLoadRequestRef.current === messageRefreshRequest
      ) {
        setMessages(messageResponse.items);
        setMessageLoadError('');
      }
    } catch (err) {
      if (
        mountedRef.current
        && activeSessionIdRef.current === activeSessionId
        && messageLoadRequestRef.current === messageRefreshRequest
      ) {
        setError('问题已发送，但消息列表刷新失败，请刷新页面查看。');
      }
    } finally {
      if (
        mountedRef.current
        && activeSessionIdRef.current === activeSessionId
        && messageLoadRequestRef.current === messageRefreshRequest
      ) {
        setMessagesLoading(false);
      }
      if (
        mountedRef.current
        && sendOperationRef.current === operation
        && activeSessionIdRef.current === activeSessionId
      ) {
        sendOperationRef.current = null;
        if (draftSendSessionIdRef.current === activeSessionId) {
          draftSendSessionIdRef.current = null;
        }
        setSending(false);
        setPendingQuestion('');
      }
    }
  }

  async function handleCheckSendResult() {
    if (
      !uncertainSend
      || checkingSendResult
      || sendOperationRef.current
      || sendCheckOperationRef.current
      || sessionMutationRef.current
      || regenerateOperationRef.current
    ) {
      return;
    }

    const operation = Symbol('check-send-result');
    sendCheckOperationRef.current = operation;
    setCheckingSendResult(true);
    const request = ++sendCheckRequestRef.current;
    const messageLoadRequest = messageLoadRequestRef.current;
    const uncertainSnapshot = uncertainSend;
    const checkedSessionId = uncertainSnapshot.sessionId;
    const requestIsCurrent = () => (
      mountedRef.current
      && activeSessionIdRef.current === checkedSessionId
      && sendCheckOperationRef.current === operation
      && sendCheckRequestRef.current === request
      && messageLoadRequestRef.current === messageLoadRequest
    );
    try {
      const response = await listChatMessages(checkedSessionId);
      if (!requestIsCurrent()) {
        return;
      }
      setMessages(response.items);
      const submittedMessageExists = response.items
        .some((message) => message.clientRequestId === uncertainSnapshot.clientRequestId);
      if (submittedMessageExists) {
        pendingChatRequestStore.clear(checkedSessionId, uncertainSnapshot.clientRequestId);
        setDraft('');
        setError('');
        setUncertainSend(null);
        void loadSessions();
      } else {
        setError('暂未发现这条问题。你可以稍后再次检查，或确认重新发送。');
      }
    } catch {
      if (requestIsCurrent()) {
        setError('暂时无法检查发送结果，请稍后再次检查。');
      }
    } finally {
      if (sendCheckOperationRef.current === operation) {
        sendCheckOperationRef.current = null;
        if (mountedRef.current) {
          setCheckingSendResult(false);
        }
      }
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submitQuestion(draft.trim());
  }

  async function handleRegenerateMessage(messageId: string) {
    if (
      !sessionId
      || isDraftSession
      || !sessionDetailsReady
      || archived
      || sendOperationRef.current
      || sendCheckOperationRef.current
      || sessionMutationRef.current
      || regenerateOperationRef.current
    ) {
      return;
    }

    const targetSessionId = sessionId;
    const operation = Symbol('regenerate-message');
    regenerateOperationRef.current = operation;
    setRegeneratingMessageId(messageId);
    setError('');
    setRerankFallback(null);
    try {
      const response = await regenerateChatMessage(targetSessionId, messageId);
      if (
        !mountedRef.current
        || activeSessionIdRef.current !== targetSessionId
        || regenerateOperationRef.current !== operation
      ) {
        return;
      }
      setRerankFallback(response.rerankFallback?.used ? response.rerankFallback : null);
      const messageResponse = await listChatMessages(targetSessionId);
      if (
        mountedRef.current
        && activeSessionIdRef.current === targetSessionId
        && regenerateOperationRef.current === operation
      ) {
        setMessages(messageResponse.items);
        setMessageLoadError('');
        setActiveCitationMessageId(null);
      }
    } catch (err) {
      if (
        mountedRef.current
        && activeSessionIdRef.current === targetSessionId
        && regenerateOperationRef.current === operation
      ) {
        setError(errorMessage(err, '重新生成回答失败'));
      }
    } finally {
      if (regenerateOperationRef.current === operation) {
        regenerateOperationRef.current = null;
        if (mountedRef.current) {
          setRegeneratingMessageId(null);
        }
      }
    }
  }

  return (
    <WorkspaceShell active="chat">
      <div className="chat-workspace-page">
      <header className="page-header workspace-heading chat-workspace-header">
        <div>
          <p className="breadcrumb">知识库 / {currentKnowledgeBase?.name ?? '问答'} / 聊天</p>
          <h1>聊天问答</h1>
          <p className="page-description">围绕当前知识库提问，有依据时会在回答旁展示来源。</p>
        </div>
        <div className="toolbar">
          {currentKnowledgeBase && (
            <Link
              aria-disabled={chatMutationBusy || undefined}
              className="secondary-link"
              tabIndex={chatMutationBusy ? -1 : undefined}
              to={`/knowledge-bases/${currentKnowledgeBase.id}`}
              onClick={(event) => {
                if (sendOperationRef.current || sendCheckOperationRef.current || sessionMutationRef.current) {
                  event.preventDefault();
                }
              }}
            >
              返回知识库
            </Link>
          )}
          <button type="button" onClick={() => handleCreateSession()} disabled={chatMutationBusy}>
            新建会话
          </button>
        </div>
      </header>

      {error && !failedQuestion && !uncertainSend && (
        <div className="error-text" role="alert">
          <span>{error}</span>
        </div>
      )}

      <div className="chat-shell">
        <PortalWhenOpen active={auxiliaryPanel === 'sessions'}>
        <div
          className={`chat-aux chat-sessions-aux${auxiliaryPanel === 'sessions' ? ' is-open' : ''}`}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setAuxiliaryPanel(null);
          }}
        >
        <aside
          aria-label={auxiliaryPanel === 'sessions' ? '会话列表' : undefined}
          aria-modal={auxiliaryPanel === 'sessions' ? 'true' : undefined}
          className="chat-sidebar-panel"
          ref={sessionsPanelRef}
          role={auxiliaryPanel === 'sessions' ? 'dialog' : undefined}
          tabIndex={auxiliaryPanel === 'sessions' ? -1 : undefined}
        >
          <div className="chat-aux__header">
            <strong>会话列表</strong>
            <button aria-label="关闭会话列表" className="chat-aux__close" type="button" onClick={() => setAuxiliaryPanel(null)}>
              <X aria-hidden="true" size={18} />
            </button>
          </div>
          {knowledgeBaseListError && (
            <div className="empty-state" role="alert">
              <p>{knowledgeBaseListError}</p>
              <button className="secondary-button" type="button" onClick={() => void loadKnowledgeBases()}>
                重试知识库列表
              </button>
            </div>
          )}
          <label className="field-label">
            当前知识库
            <select
              value={currentKnowledgeBase?.id ?? ''}
              disabled={chatMutationBusy || knowledgeBasesLoading || knowledgeBases.length === 0}
              onChange={(event) => handleKnowledgeBaseChange(event.target.value)}
            >
              {!currentKnowledgeBase && <option value="">请选择知识库</option>}
              {knowledgeBases.map((knowledgeBase) => (
                <option key={knowledgeBase.id} value={knowledgeBase.id}>
                  {knowledgeBase.name}
                </option>
              ))}
            </select>
          </label>

          <div className="chat-kb-card">
            <span className={`kb-icon ${currentKnowledgeBase?.visibility === 'public' ? 'public' : 'private'}`} aria-hidden="true" />
            <div>
              <strong>{currentKnowledgeBase?.name ?? '未选择知识库'}</strong>
              <p>{currentKnowledgeBase?.description || '选择知识库后开始会话。'}</p>
            </div>
          </div>

          <button type="button" onClick={() => handleCreateSession()} disabled={chatMutationBusy}>
            基于此知识库提问
          </button>

          <div className="session-section-title">
            <strong>会话</strong>
            <span>{sessionsLoading || sessionListError ? '--' : sessionsForCurrentKnowledgeBase.length}</span>
          </div>

          <div className="session-list chat-session-list">
            {sessionsLoading ? (
              <LoadingSkeleton rows={4} columns={1} compact announce label="正在加载会话" />
            ) : sessionListError ? (
              <div className="empty-state" role="alert">
                <p>{sessionListError}</p>
                <button className="secondary-button" type="button" onClick={() => void loadSessions()}>
                  重试会话列表
                </button>
              </div>
            ) : sessionsForCurrentKnowledgeBase.length === 0 ? (
              <div className="empty-state">当前知识库暂无会话。</div>
            ) : (
              sessionsForCurrentKnowledgeBase.map((session) => (
                <Link
                  aria-disabled={chatMutationBusy || undefined}
                  aria-current={session.id === sessionId ? 'page' : undefined}
                  className={session.id === sessionId ? 'session-card active' : 'session-card'}
                  key={session.id}
                  tabIndex={chatMutationBusy ? -1 : undefined}
                  to={`/chat/${session.id}`}
                  onClick={(event) => {
                    if (sendOperationRef.current || sendCheckOperationRef.current || sessionMutationRef.current) {
                      event.preventDefault();
                      return;
                    }
                    setAuxiliaryPanel(null);
                  }}
                >
                  <strong>{session.title || '未命名会话'}</strong>
                  <span>{formatDateTime(session.updatedAt || session.createdAt)}</span>
                </Link>
              ))
            )}
          </div>
        </aside>
        </div>
        </PortalWhenOpen>

        <section className="chat-main-panel" aria-label="问答会话">
          <header className="chat-thread-head">
            <div>
              <h2>{currentSession?.title ?? '问答会话'}</h2>
              <p className="muted-text">
                {archived
                  ? `已归档于 ${formatDateTime(currentSession?.archivedAt ?? '')}，详情仍可查看。`
                  : '回答会根据当前知识库内容生成，并在有依据时展示来源。'}
              </p>
            </div>
            <div className="chat-thread-actions">
              <div className="chat-panel-controls">
                <button
                  aria-label="打开会话列表"
                  className="secondary-button chat-drawer-trigger chat-sessions-trigger"
                  type="button"
                  onClick={() => setAuxiliaryPanel('sessions')}
                >
                  <PanelLeft aria-hidden="true" size={18} />
                  <span>会话</span>
                </button>
                <button
                  aria-label="打开引用来源"
                  className="secondary-button chat-drawer-trigger chat-citations-trigger"
                  type="button"
                  onClick={() => setAuxiliaryPanel('citations')}
                >
                  <BookOpen aria-hidden="true" size={18} />
                  <span>引用</span>
                </button>
              </div>
              {!isDraftSession && (
                <>
                  <form className="chat-title-form" onSubmit={handleUpdateTitle}>
                    <input
                      aria-label="会话标题"
                      value={titleDraft}
                      onChange={(event) => setTitleDraft(event.target.value)}
                      disabled={!sessionDetailsReady || chatMutationBusy}
                    />
                    <button className="secondary-button" type="submit" disabled={!sessionDetailsReady || chatMutationBusy || !titleDraft.trim()}>
                      改名
                    </button>
                  </form>
                  <div className="chat-thread-stats" aria-label="会话统计">
                    <span>{messageStatsKnown ? questionCount : '--'} 问</span>
                    <span>{messageStatsKnown ? citationCount : '--'} 引用</span>
                  </div>
                  <div className="table-actions">
                    <button
                      className="secondary-button"
                      type="button"
                      onClick={() => {
                        if (sendOperationRef.current || sendCheckOperationRef.current || sessionMutationRef.current) {
                          return;
                        }
                        setSessionConfirmError('');
                        setConfirmArchive(true);
                      }}
                      disabled={!sessionDetailsReady || chatMutationBusy || archived}
                    >
                      归档
                    </button>
                    <button
                      className="danger-button"
                      type="button"
                      onClick={() => {
                        if (sendOperationRef.current || sendCheckOperationRef.current || sessionMutationRef.current) {
                          return;
                        }
                        setSessionConfirmError('');
                        setConfirmDelete(true);
                      }}
                      disabled={!sessionDetailsReady || chatMutationBusy}
                    >
                      删除
                    </button>
                  </div>
                </>
              )}
            </div>
          </header>

          <RerankFallbackNotice fallback={rerankFallback} />

          <div ref={messagesRef} className={messagesLoading ? 'messages chat-thread is-switching' : 'messages chat-thread'}>
            {messagesLoading ? (
              <div className="message-loading-state">
                <LoadingSkeleton rows={5} columns={1} compact announce label="正在加载消息" />
              </div>
            ) : messageLoadError ? (
              <div className="chat-empty-state" role="alert">
                <strong>无法显示会话消息</strong>
                <p>{messageLoadError}</p>
                <button className="secondary-button" type="button" onClick={() => sessionId && void loadSessionMessages(sessionId)}>
                  重试消息
                </button>
              </div>
            ) : messages.length === 0 && !pendingQuestion && !failedQuestion && !uncertainSend ? (
              <div className="chat-empty-state">
                <strong>开始提问</strong>
                <p>围绕当前知识库提问，回答会在右侧展示可追踪引用。</p>
              </div>
            ) : (
              messages.map((message) => (
                <MessageBubble
                  activeCitations={message.id === activeCitationMessageId}
                  message={message}
                  key={message.id}
                  onSelectCitations={() => {
                    setActiveCitationMessageId(message.id);
                    if (isCompact) setAuxiliaryPanel('citations');
                  }}
                  onRegenerate={message.id === latestAssistantMessageId && !archived ? handleRegenerateMessage : undefined}
                  regenerating={regeneratingMessageId === message.id}
                  regenerationDisabled={chatMutationBusy}
                />
              ))
            )}
            {pendingQuestion && (
              <>
                <article className="message-bubble user pending">
                  <span className="message-role">用户</span>
                  <p>{pendingQuestion}</p>
                </article>
                <article className="message-bubble assistant pending">
                  <span className="message-role">助手</span>
                  <p role="status">正在检索知识库并生成回答...</p>
                  <LoadingSkeleton rows={2} columns={1} compact />
                </article>
              </>
            )}
            {failedQuestion && (
              <>
                <article className="message-bubble user">
                  <span className="message-role">用户</span>
                  <p>{failedQuestion}</p>
                </article>
                <article className="message-bubble assistant chat-recovery-card" role="alert">
                  <span className="message-role">助手</span>
                  <strong>回答生成失败</strong>
                  <p>{error}</p>
                  <div className="message-actions chat-recovery-actions">
                    <button
                      className="secondary-button"
                      type="button"
                      onClick={() => void submitQuestion(draft.trim())}
                      disabled={chatMutationBusy || !draft.trim()}
                    >
                      重新生成
                    </button>
                    <button className="link-button" type="button" onClick={() => composerRef.current?.focus()}>
                      修改问题
                    </button>
                  </div>
                </article>
              </>
            )}
            {uncertainSend && (
              <>
                <article className="message-bubble user">
                  <span className="message-role">用户</span>
                  <p>{uncertainSend.question}</p>
                </article>
                <article className="message-bubble assistant chat-recovery-card" role="alert">
                  <span className="message-role">助手</span>
                  <strong>发送结果待确认</strong>
                  <p>{error}</p>
                  <div className="message-actions chat-recovery-actions">
                    <button
                      className="secondary-button"
                      type="button"
                      onClick={() => void handleCheckSendResult()}
                      disabled={checkingSendResult}
                    >
                      {checkingSendResult ? '检查中...' : '再次检查'}
                    </button>
                    <button
                      className="link-button"
                      type="button"
                      onClick={() => void submitQuestion(uncertainSend.question, true)}
                      disabled={chatMutationBusy || checkingSendResult || !uncertainSend.question}
                    >
                      确认重新发送
                    </button>
                  </div>
                </article>
              </>
            )}
          </div>

          <form className="composer chat-composer" onSubmit={handleSubmit}>
            <textarea
              ref={composerRef}
              aria-label="继续追问当前知识库"
              placeholder="继续追问当前知识库..."
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              disabled={chatMutationBusy || !canSend || Boolean(uncertainSend)}
              rows={2}
            />
            <button type="submit" disabled={chatMutationBusy || !draft.trim() || !canSend || Boolean(uncertainSend)}>
              {sending ? '发送中...' : '发送'}
            </button>
          </form>
        </section>

        <PortalWhenOpen active={auxiliaryPanel === 'citations'}>
        <div
          className={`chat-aux chat-citations-aux${auxiliaryPanel === 'citations' ? ' is-open' : ''}`}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setAuxiliaryPanel(null);
          }}
        >
        <aside
          aria-label="引用来源"
          aria-modal={auxiliaryPanel === 'citations' ? 'true' : undefined}
          className="citation-panel chat-citation-panel"
          ref={citationsPanelRef}
          role={auxiliaryPanel === 'citations' ? 'dialog' : undefined}
          tabIndex={auxiliaryPanel === 'citations' ? -1 : undefined}
        >
          <div className="chat-aux__header">
            <strong>引用来源</strong>
            <button aria-label="关闭引用来源" className="chat-aux__close" type="button" onClick={() => setAuxiliaryPanel(null)}>
              <X aria-hidden="true" size={18} />
            </button>
          </div>
          <div>
            <h2>引用来源</h2>
            <p className="muted-text">回答有依据时会在这里列出来源。</p>
          </div>

          <div className="citation-list" id="chat-citation-list">
            {messagesLoading ? (
              <LoadingSkeleton rows={3} columns={1} compact />
            ) : messageLoadError ? (
              <div className="empty-state">消息加载失败，引用暂不可用。</div>
            ) : pendingQuestion ? (
              <div className="empty-state">回答生成完成后会在这里显示引用。</div>
            ) : messages.length === 0 ? (
              <div className="empty-state">回答产生引用后会在这里显示。</div>
            ) : activeCitations.length === 0 ? (
              <div className="empty-state">当前知识库中未找到足够依据。</div>
            ) : (
              activeCitations.map((citation, index) => (
                <CitationCard
                  citation={citation}
                  index={index + 1}
                  key={`${citation.documentId}-${citation.chunkId}-${index}`}
                  knowledgeBaseId={currentKnowledgeBase?.id}
                />
              ))
            )}
          </div>
        </aside>
        </div>
        </PortalWhenOpen>
      </div>
      </div>
      {confirmArchive && currentSession && (
        <ConfirmDialog
          title="归档会话"
          description={`确认归档“${currentSession.title || '未命名会话'}”？归档后默认不再出现在会话列表中。`}
          confirmLabel="归档"
          busy={chatMutationBusy}
          error={sessionConfirmError}
          onCancel={() => {
            setSessionConfirmError('');
            setConfirmArchive(false);
          }}
          onConfirm={handleArchiveSession}
        />
      )}
      {confirmDelete && currentSession && (
        <ConfirmDialog
          title="删除会话"
          description={`确认删除“${currentSession.title || '未命名会话'}”？消息会一并删除且不可恢复。`}
          confirmLabel="删除"
          busy={chatMutationBusy}
          error={sessionConfirmError}
          onCancel={() => {
            setSessionConfirmError('');
            setConfirmDelete(false);
          }}
          onConfirm={handleDeleteSession}
        />
      )}
    </WorkspaceShell>
  );
}

function PortalWhenOpen({ active, children }: { active: boolean; children: ReactNode }) {
  return active ? createPortal(children, document.body) : children;
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(
    () => typeof window.matchMedia === 'function' && window.matchMedia(query).matches,
  );

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [query]);

  return matches;
}

function mergeSession(sessions: ChatSession[], nextSession: ChatSession): ChatSession[] {
  const exists = sessions.some((session) => session.id === nextSession.id);
  if (!exists) {
    return [nextSession, ...sessions];
  }
  return sessions.map((session) => (session.id === nextSession.id ? nextSession : session));
}

function MessageBubble({
  activeCitations,
  message,
  onSelectCitations,
  onRegenerate,
  regenerating = false,
  regenerationDisabled = false,
}: {
  activeCitations: boolean;
  message: ChatMessage;
  onSelectCitations: () => void;
  onRegenerate?: (messageId: string) => void;
  regenerating?: boolean;
  regenerationDisabled?: boolean;
}) {
  const citationSummary =
    message.citations.length > 0
      ? `引用 ${message.citations.length} 条`
      : '当前知识库中未找到足够依据。';

  return (
    <article className={message.role === 'assistant' ? 'message-bubble assistant' : 'message-bubble user'}>
      <span className="message-role">{message.role === 'assistant' ? '助手' : '用户'}</span>
      <p>{message.content}</p>
      {message.role === 'assistant' && (
        <button
          aria-controls="chat-citation-list"
          aria-label={`查看回答“${citationLabel(message.content)}”的引用`}
          aria-pressed={activeCitations}
          className="citation-summary citation-summary-button"
          type="button"
          onClick={onSelectCitations}
        >
          {citationSummary}
        </button>
      )}
      {message.role === 'assistant' && onRegenerate && (
        <div className="message-actions">
          <button
            className="secondary-button"
            disabled={regenerationDisabled}
            onClick={() => onRegenerate(message.id)}
            type="button"
          >
            {regenerating ? '重新生成中...' : '重新生成回答'}
          </button>
        </div>
      )}
    </article>
  );
}

function citationLabel(content: string): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, 40) : '该回答';
}

function CitationCard({
  citation,
  index,
  knowledgeBaseId,
}: {
  citation: Citation;
  index: number;
  knowledgeBaseId?: string;
}) {
  const pageLabel = citation.pageNumber ? `第 ${citation.pageNumber} 页` : '无页码';
  const sourcePath = knowledgeBaseId
    ? `/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/documents?documentId=${encodeURIComponent(citation.documentId)}&chunkId=${encodeURIComponent(citation.chunkId)}`
    : null;

  return (
    <article className="citation-card enhanced-citation-card">
      <header>
        {sourcePath ? (
          <Link
            aria-label={`打开来源：${citation.filename}，${pageLabel}`}
            className="citation-source-link"
            to={sourcePath}
          >
            <strong>{index}. {citation.filename}</strong>
            <span>{citation.pageNumber ? `p.${citation.pageNumber}` : '无页码'}</span>
          </Link>
        ) : (
          <>
            <strong>{index}. {citation.filename}</strong>
            <span>{citation.pageNumber ? `p.${citation.pageNumber}` : '无页码'}</span>
          </>
        )}
      </header>
      <p>{citation.content}</p>
      <div className="citation-score-grid">
        <span>相关度 {formatScore(citation.vectorScore)}</span>
        <span>排序分 {formatNullableScore(citation.rerankScore)}</span>
      </div>
    </article>
  );
}

function formatScore(value: number): string {
  return value.toFixed(2);
}

function formatNullableScore(value: number | null): string {
  return typeof value === 'number' ? value.toFixed(2) : '未精排';
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function errorMessage(err: unknown, fallback: string): string {
  return getErrorMessage(err, fallback);
}

function isDefinitiveSendFailure(error: ApiError): boolean {
  return error.status < 500 || error.code === 'CHAT_COMPLETION_FAILED' || error.code === 'RERANK_FAILED';
}
