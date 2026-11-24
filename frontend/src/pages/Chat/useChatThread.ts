import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { ApiError, isRateLimitError } from '../../api/client';
import { retryNotice } from '../../components/feedback/RetryCountdown';
import type { RetryNotice } from '../../components/feedback/RetryCountdown';
import {
  createChatSession,
  editChatMessage,
  getChatSession,
  listChatMessages,
  regenerateChatMessage,
  sendChatMessageStream,
} from '../../api/resources';
import type {
  ChatBookmark,
  ChatMessage,
  ChatMessageFeedback,
  ChatSession,
  Citation,
  KnowledgeBaseRerankFallback,
} from '../../types/api';
import { getErrorMessage } from '../../utils/errors';
import { tokenStore } from '../../store/tokenStore';
import { pendingChatRequestStore } from './pendingChatRequestStore';
import type { PendingChatRequest } from './pendingChatRequestStore';
import { pendingChatEditStore } from './pendingChatEditStore';
import { pendingRegenerationStore } from './pendingRegenerationStore';
import { createStreamText } from './streamText';
import { HISTORY_PAGE_SIZE, useChatHistory } from './useChatHistory';
import {
  AUTO_CHECK_DELAYS_MS,
  applyEditedMessageResponse,
  applyMessageBookmark,
  applyMessageFeedback,
  findNewAssistantMessage,
  isDefinitiveSendFailure,
  type RegenerationState,
  type StoppedStream,
  type UnconfirmedSend,
} from './chatThreadHelpers';

export type { RegenerationState, StoppedStream, UnconfirmedSend };

type ReconcileResult = 'accepted' | 'absent' | 'unknown';

type RateLimitNotice = RetryNotice & {
  question: string | null;
};

type UseChatThreadOptions = {
  sessionId?: string;
  initialMessageId?: string;
  draftKnowledgeBaseId?: string;
  draftKnowledgeBaseIds?: string[];
  draftDocumentIds?: string[];
  draftScopeMode?: 'auto' | 'manual';
  onSessionCreated: (session: ChatSession) => void;
  onSessionsChanged: () => void;
  onAccessLost?: (sessionId: string) => void;
  onQuestionSaved?: (sessionId: string, question: string) => void;
};

/**
 * Owns the message thread, sending and regeneration.
 *
 * The idempotency contract is unchanged: every first send mints a UUID
 * `clientRequestId`, the pending request is persisted so a reload can reconcile
 * it, and an explicit resend reuses the original id. What changed is the
 * presentation of an unconfirmed result — the thread now reconciles itself twice
 * in the background before asking the user to decide anything.
 */
export function useChatThread({
  sessionId,
  initialMessageId,
  draftKnowledgeBaseId,
  draftKnowledgeBaseIds,
  draftDocumentIds,
  draftScopeMode = 'manual',
  onSessionCreated,
  onSessionsChanged,
  onAccessLost,
  onQuestionSaved,
}: UseChatThreadOptions) {
  const isDraft = !sessionId;
  const authRevision = useSyncExternalStore(tokenStore.subscribe, tokenStore.getRevision);
  const [session, setSession] = useState<ChatSession | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [sending, setSending] = useState(false);
  const [pendingQuestion, setPendingQuestion] = useState('');
  const [failedSend, setFailedSend] = useState<{ question: string; message: string } | null>(null);
  const [unconfirmedSend, setUnconfirmedSend] = useState<UnconfirmedSend | null>(null);
  const [regeneration, setRegeneration] = useState<RegenerationState | null>(null);
  const [regeneratingId, setRegeneratingId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [rerankFallback, setRerankFallback] = useState<KnowledgeBaseRerankFallback | null>(null);
  /** Answer text accumulated from the current stream; empty when not streaming. */
  const [streamText] = useState(createStreamText);
  const setStreamingAnswer = streamText.set;
  const [streamingCitations, setStreamingCitations] = useState<Citation[]>([]);
  const [stoppedStream, setStoppedStream] = useState<StoppedStream | null>(null);
  const [rateLimitNotice, setRateLimitNotice] = useState<RateLimitNotice | null>(null);

  const activeSessionRef = useRef<string | undefined>(sessionId);
  const initialMessageRef = useRef(initialMessageId);
  initialMessageRef.current = initialMessageId;
  const mountedRef = useRef(true);
  const loadRequestRef = useRef(0);
  const sendTokenRef = useRef<symbol | null>(null);
  const boundSendRevisionRef = useRef<number | undefined>(undefined);
  const regenerateTokenRef = useRef<symbol | null>(null);
  const editTokenRef = useRef<symbol | null>(null);
  const sendCheckTokenRef = useRef<symbol | null>(null);
  const regenerationCheckTokenRef = useRef<symbol | null>(null);
  const draftSendSessionRef = useRef<string | null>(null);
  const sendAbortRef = useRef<AbortController | null>(null);
  const cancelRequestedRef = useRef<symbol | null>(null);
  const streamingAnswerRef = useRef('');
  const streamingCitationsRef = useRef<Citation[]>([]);
  const autoCheckTimersRef = useRef<number[]>([]);
  const reconcileSequenceRef = useRef(0);
  const onSessionsChangedRef = useRef(onSessionsChanged);
  onSessionsChangedRef.current = onSessionsChanged;
  const onAccessLostRef = useRef(onAccessLost);
  onAccessLostRef.current = onAccessLost;
  const onQuestionSavedRef = useRef(onQuestionSaved);
  onQuestionSavedRef.current = onQuestionSaved;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      streamText.dispose();
      loadRequestRef.current += 1;
      sendTokenRef.current = null;
      regenerateTokenRef.current = null;
      editTokenRef.current = null;
      sendCheckTokenRef.current = null;
      regenerationCheckTokenRef.current = null;
      autoCheckTimersRef.current.forEach((timer) => window.clearTimeout(timer));
      autoCheckTimersRef.current = [];
      sendAbortRef.current?.abort();
      sendAbortRef.current = null;
      cancelRequestedRef.current = null;
    };
  }, [streamText]);

  const clearAutoChecks = useCallback(() => {
    autoCheckTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    autoCheckTimersRef.current = [];
    reconcileSequenceRef.current += 1;
    sendCheckTokenRef.current = null;
  }, []);

  const discardAccountSend = useCallback(() => {
    // A replaced account is not an access-loss response. In particular, do not
    // call the new account's draft-clearing callback for the old operation.
    sendTokenRef.current = null;
    sendAbortRef.current?.abort();
    sendAbortRef.current = null;
    draftSendSessionRef.current = null;
    cancelRequestedRef.current = null;
    clearAutoChecks();
    setSending(false);
    setPendingQuestion('');
    setFailedSend(null);
    setUnconfirmedSend(null);
    setStoppedStream(null);
    setRateLimitNotice(null);
    setStreamingAnswer('');
    setStreamingCitations([]);
    streamingAnswerRef.current = '';
    streamingCitationsRef.current = [];
  }, [clearAutoChecks, setStreamingAnswer]);

  useEffect(() => {
    if (sendTokenRef.current && boundSendRevisionRef.current !== undefined && boundSendRevisionRef.current !== authRevision) {
      discardAccountSend();
    }
  }, [authRevision, discardAccountSend]);

  const handleAccessLost = useCallback((caught: unknown, targetSessionId: string) => {
    if (!(caught instanceof ApiError) || (caught.status !== 403 && caught.status !== 404)) return false;
    clearAutoChecks();
    pendingChatRequestStore.clear(targetSessionId);
    pendingChatEditStore.clear(targetSessionId);
    pendingRegenerationStore.clear(targetSessionId);
    setMessages([]);
    setSession(null);
    setFailedSend(null);
    setUnconfirmedSend(null);
    setRegeneration(null);
    setStoppedStream(null);
    setSending(false);
    setPendingQuestion('');
    setStreamingAnswer('');
    setStreamingCitations([]);
    setLoadError('会话已不可访问，可能已删除或访问权限发生变化。');
    onAccessLostRef.current?.(targetSessionId);
    return true;
  }, [clearAutoChecks, setStreamingAnswer]);

  const history = useChatHistory(sessionId, setMessages, handleAccessLost);
  const { replaceHistory, resetHistory, invalidateHistory, readCurrentHistory, updateHistoryRevision, markMissingMessage } = history;

  const loadThread = useCallback(async (targetSessionId: string) => {
    const request = ++loadRequestRef.current;
    resetHistory();
    setLoading(true);
    setLoadError('');
    setMessages([]);
    setSession(null);

    const current = () => mountedRef.current
      && activeSessionRef.current === targetSessionId
      && loadRequestRef.current === request;

    try {
      const initialTarget = initialMessageRef.current;
      let missingTarget = '';
      const readInitialMessages = async () => {
        // Unknown writes require complete evidence before being declared absent.
        if (pendingChatRequestStore.get(targetSessionId) || pendingChatEditStore.get(targetSessionId) || pendingRegenerationStore.get(targetSessionId)) {
          return listChatMessages(targetSessionId);
        }
        try {
          return await listChatMessages(targetSessionId, { limit: HISTORY_PAGE_SIZE, ...(initialTarget ? { around: initialTarget } : {}) });
        } catch (error) {
          if (initialTarget && error instanceof ApiError && (error.code === 'CHAT_MESSAGE_NOT_FOUND' || error.code === 'VALIDATION_ERROR')) {
            missingTarget = initialTarget;
            return listChatMessages(targetSessionId, { limit: HISTORY_PAGE_SIZE });
          }
          throw error;
        }
      };
      const [sessionResponse, messageResponse] = await Promise.all([
        getChatSession(targetSessionId),
        readInitialMessages(),
      ]);
      if (!current()) return;

      setSession(sessionResponse);
      replaceHistory(targetSessionId, messageResponse);
      if (missingTarget) markMissingMessage(missingTarget);

      const pendingEdit = pendingChatEditStore.get(targetSessionId);
      if (pendingEdit && messageResponse.items.some(
        (message) => message.clientRequestId === pendingEdit.clientRequestId,
      )) {
        pendingChatEditStore.clear(targetSessionId, pendingEdit.clientRequestId);
      }

      // Reconcile a write whose result was unknown when the tab last closed.
      const storedRequest = pendingChatRequestStore.get(targetSessionId);
      if (storedRequest && !sendTokenRef.current) {
        const accepted = messageResponse.items.some(
          (message) => message.clientRequestId === storedRequest.clientRequestId,
        );
        if (accepted) {
          onQuestionSavedRef.current?.(targetSessionId, storedRequest.question);
          pendingChatRequestStore.clear(targetSessionId, storedRequest.clientRequestId);
          setUnconfirmedSend(null);
          setStoppedStream(null);
        } else {
          setUnconfirmedSend({ request: storedRequest, autoChecksDone: 0, checking: false });
        }
      }

      const storedRegeneration = pendingRegenerationStore.get(targetSessionId);
      if (storedRegeneration && !regenerateTokenRef.current) {
        const produced = findNewAssistantMessage(messageResponse.items, storedRegeneration.baselineMessageIds);
        const target = messageResponse.items.find(
          (message) => message.id === storedRegeneration.messageId && message.role === 'assistant',
        );
        if (produced || !target) {
          pendingRegenerationStore.clear(targetSessionId, storedRegeneration.messageId);
        } else {
          setRegeneration({
            messageId: storedRegeneration.messageId,
            kind: 'unconfirmed',
            message: '这条回答的重新生成结果还没确认。',
            baselineMessageIds: storedRegeneration.baselineMessageIds,
            autoChecksDone: storedRegeneration.checked ? AUTO_CHECK_DELAYS_MS.length : 0,
            checking: false,
          });
        }
      }
    } catch (caught) {
      if (current()) {
        if (handleAccessLost(caught, targetSessionId)) { resetHistory(); return; }
        setLoadError(getErrorMessage(caught, '消息加载失败'));
        setMessages([]);
        setSession(null);
      }
    } finally {
      if (current()) setLoading(false);
    }
  }, [replaceHistory, resetHistory, markMissingMessage, handleAccessLost]);

  // Switching sessions invalidates every in-flight request and transient state.
  useEffect(() => {
    const continuingDraftSend = draftSendSessionRef.current === sessionId;
    activeSessionRef.current = sessionId;
    clearAutoChecks();
    setRegeneration(null);
    setRegeneratingId(null);
    setEditingId(null);
    regenerateTokenRef.current = null;
    regenerationCheckTokenRef.current = null;

    if (!continuingDraftSend) {
      setRerankFallback(null);
      setStreamingAnswer('');
      setStreamingCitations([]);
      setRateLimitNotice(null);
      streamingAnswerRef.current = '';
      streamingCitationsRef.current = [];
      sendAbortRef.current?.abort();
      sendAbortRef.current = null;
      sendTokenRef.current = null;
      setSending(false);
      setPendingQuestion('');
      setFailedSend(null);
      setUnconfirmedSend(null);
      setStoppedStream(null);
    }

    if (!sessionId) {
      loadRequestRef.current += 1;
      setSession(null);
      setMessages([]);
      setLoading(false);
      setLoadError('');
      return;
    }

    void loadThread(sessionId);
  }, [clearAutoChecks, loadThread, sessionId, setStreamingAnswer]);

  /**
   * Refetches the thread and reports whether the pending request landed.
   * Used by both the automatic checks and the explicit "check again" action.
   */
  const reconcileSendResult = useCallback(async (
    pending: PendingChatRequest,
    sequence: number,
  ): Promise<ReconcileResult> => {
    const targetSessionId = pending.sessionId;
    if ((activeSessionRef.current ?? '') !== targetSessionId) return 'unknown';

    try {
      const response = await readCurrentHistory(targetSessionId);
      if (
        !mountedRef.current
        || (activeSessionRef.current ?? '') !== targetSessionId
        || reconcileSequenceRef.current !== sequence
      ) return 'unknown';
      replaceHistory(targetSessionId, response);
      const accepted = response.items.some(
        (message) => message.clientRequestId === pending.clientRequestId,
      );
      if (accepted) {
        onQuestionSavedRef.current?.(targetSessionId, pending.question);
        pendingChatRequestStore.clear(targetSessionId, pending.clientRequestId);
        setUnconfirmedSend(null);
        setStoppedStream(null);
        onSessionsChangedRef.current();
      }
      return accepted ? 'accepted' : 'absent';
    } catch {
      return 'unknown';
    }
  }, [readCurrentHistory, replaceHistory]);

  const reconcileSend = useCallback(async (
    pending: PendingChatRequest,
    sequence: number,
  ): Promise<boolean> => (await reconcileSendResult(pending, sequence)) === 'accepted', [reconcileSendResult]);

  /** Schedules the background reconciliation attempts for an unconfirmed send. */
  const scheduleAutoChecks = useCallback((pending: PendingChatRequest) => {
    clearAutoChecks();
    AUTO_CHECK_DELAYS_MS.forEach((delay, index) => {
      const timer = window.setTimeout(() => {
        const sequence = ++reconcileSequenceRef.current;
        setUnconfirmedSend((current) => (
          current && current.request.clientRequestId === pending.clientRequestId
            ? { ...current, checking: true }
            : current
        ));
        void reconcileSend(pending, sequence).then((accepted) => {
          if (!mountedRef.current || accepted || reconcileSequenceRef.current !== sequence) return;
          setUnconfirmedSend((current) => (
            current && current.request.clientRequestId === pending.clientRequestId
              ? {
                ...current,
                autoChecksDone: Math.max(current.autoChecksDone, index + 1),
                checking: false,
              }
              : current
          ));
        });
      }, delay);
      autoCheckTimersRef.current.push(timer);
    });
  }, [clearAutoChecks, reconcileSend]);

  const pendingSendRequest = unconfirmedSend?.request ?? null;
  useEffect(() => {
    if (!pendingSendRequest) return undefined;
    scheduleAutoChecks(pendingSendRequest);
    return clearAutoChecks;
  }, [clearAutoChecks, pendingSendRequest, scheduleAutoChecks]);

  const send = useCallback(async (question: string, options: { resend?: boolean; expectedAuthRevision?: number } = {}) => {
    const retryOf = options.resend ? unconfirmedSend?.request ?? null : null;
    if (
      !question
      || sending
      || sendTokenRef.current
      || regenerateTokenRef.current
      || editTokenRef.current
    ) return;
    if (unconfirmedSend && !options.resend) return;
    if (stoppedStream && !stoppedStream.resumable && !options.resend) return;
    if (isDraft && draftScopeMode !== 'auto' && !draftKnowledgeBaseId && !draftKnowledgeBaseIds?.length) return;
    if (options.expectedAuthRevision !== undefined && options.expectedAuthRevision !== tokenStore.getRevision()) return;

    const token = Symbol('send-message');
    invalidateHistory();
    sendTokenRef.current = token;
    boundSendRevisionRef.current = options.expectedAuthRevision;
    clearAutoChecks();
    setSending(true);
    setFailedSend(null);
    setUnconfirmedSend(null);
    setRerankFallback(null);
    setStreamingAnswer('');
    setStreamingCitations([]);
    setStoppedStream(null);
    setRateLimitNotice(null);
    streamingAnswerRef.current = '';
    streamingCitationsRef.current = [];
    cancelRequestedRef.current = null;
    setPendingQuestion(question);

    // An explicit resend must reuse the original id so the server can dedupe it.
    const clientRequestId = retryOf?.clientRequestId ?? crypto.randomUUID();
    const confirmQuestion = onQuestionSavedRef.current;
    let targetSessionId = sessionId ?? '';
    let messageRequestStarted = false;
    let streamController: AbortController | null = null;

    try {
      if (isDraft) {
        const scope = draftScopeMode === 'auto' ? undefined : draftKnowledgeBaseIds?.length ? draftKnowledgeBaseIds : draftKnowledgeBaseId;
        const created = await (draftDocumentIds?.length ? createChatSession(scope, '', draftDocumentIds) : createChatSession(scope, ''));
        if (!mountedRef.current || sendTokenRef.current !== token) return;
        if (options.expectedAuthRevision !== undefined && options.expectedAuthRevision !== tokenStore.getRevision()) {
          discardAccountSend();
          return;
        }
        targetSessionId = created.id;
        activeSessionRef.current = created.id;
        draftSendSessionRef.current = created.id;
        setSession(created);
        onSessionCreated(created);
      }

      messageRequestStarted = true;
      const pending: PendingChatRequest = {
        sessionId: targetSessionId,
        question,
        clientRequestId,
        createdAt: retryOf?.createdAt ?? new Date().toISOString(),
      };
      pendingChatRequestStore.set(pending);

      // Streaming changes only how the answer arrives, not the contract: the
      // pending request is still recorded before the write, and a failure below
      // still lands in the same "unknown result" reconciliation.
      // See docs/04-api-design.md (POST /chat/sessions/:id/messages/stream).
      const isCurrent = () => mountedRef.current
        && sendTokenRef.current === token
        && activeSessionRef.current === targetSessionId;

      streamController = new AbortController();
      sendAbortRef.current = streamController;
      const response = await sendChatMessageStream(
        targetSessionId,
        { content: question, clientRequestId },
        {
          onDelta: (text) => {
            if (isCurrent()) {
              streamingAnswerRef.current += text;
              setStreamingAnswer(streamingAnswerRef.current);
            }
          },
          onCitations: (citations) => {
            if (isCurrent()) {
              streamingCitationsRef.current = citations;
              setStreamingCitations(citations);
            }
          },
        },
        streamController.signal,
      );
      if (sendAbortRef.current === streamController) sendAbortRef.current = null;
      cancelRequestedRef.current = null;
      confirmQuestion?.(targetSessionId, question);
      pendingChatRequestStore.clear(targetSessionId, clientRequestId);
      if (isCurrent()) {
        setRerankFallback(response.rerankFallback?.used ? response.rerankFallback : null);
        // Title refresh is independent of the message-list read below, which
        // may fail even though the first question and its title were saved.
        onSessionsChangedRef.current();
      }
    } catch (caught) {
      if (streamController && sendAbortRef.current === streamController) sendAbortRef.current = null;
      if (!mountedRef.current || sendTokenRef.current !== token || (activeSessionRef.current ?? '') !== targetSessionId) {
        return;
      }
      const userCancelled = cancelRequestedRef.current === token;
      cancelRequestedRef.current = null;
      sendTokenRef.current = null;
      if (draftSendSessionRef.current === targetSessionId) draftSendSessionRef.current = null;

      if (handleAccessLost(caught, targetSessionId)) return;

      if (userCancelled && messageRequestStarted) {
        const pending: PendingChatRequest = {
          sessionId: targetSessionId,
          question,
          clientRequestId,
          createdAt: retryOf?.createdAt ?? new Date().toISOString(),
        };
        setStoppedStream({
          question,
          answer: streamingAnswerRef.current,
          citations: streamingCitationsRef.current,
          checking: true,
          resumable: false,
        });
        setSending(false);
        setPendingQuestion('');
        setStreamingAnswer('');
        setStreamingCitations([]);
        const result = await reconcileSendResult(pending, ++reconcileSequenceRef.current);
        if (mountedRef.current && activeSessionRef.current === targetSessionId) {
          if (result === 'absent') {
            pendingChatRequestStore.clear(targetSessionId, clientRequestId);
            setStoppedStream((current) => current ? { ...current, checking: false, resumable: true } : current);
          } else if (result === 'unknown') {
            setStoppedStream(null);
            setUnconfirmedSend({ request: pending, autoChecksDone: 0, checking: false });
          }
        }
        streamingAnswerRef.current = '';
        streamingCitationsRef.current = [];
        return;
      }

      // Nothing is persisted until generation finishes, so a partial answer on
      // screen would claim something the server does not have.
      setStreamingAnswer('');
      setStreamingCitations([]);
      streamingAnswerRef.current = '';
      streamingCitationsRef.current = [];

      if (isRateLimitError(caught)) {
        pendingChatRequestStore.clear(targetSessionId, clientRequestId);
        setRateLimitNotice({ ...retryNotice(caught), question });
      } else if (caught instanceof ApiError && isDefinitiveSendFailure(caught)) {
        // The server rejected it outright, so the id is safe to discard.
        pendingChatRequestStore.clear(targetSessionId, clientRequestId);
        setFailedSend({ question, message: getErrorMessage(caught, '回答生成失败，请稍后重试。') });
      } else if (messageRequestStarted) {
        const pending: PendingChatRequest = {
          sessionId: targetSessionId,
          question,
          clientRequestId,
          createdAt: retryOf?.createdAt ?? new Date().toISOString(),
        };
        setUnconfirmedSend({ request: pending, autoChecksDone: 0, checking: false });
      } else {
        setFailedSend({ question, message: '会话创建结果暂时无法确认，请刷新后再试。' });
      }
      setSending(false);
      setPendingQuestion('');
      return;
    }

    if (!mountedRef.current || sendTokenRef.current !== token || (activeSessionRef.current ?? '') !== targetSessionId) {
      if (draftSendSessionRef.current === targetSessionId) draftSendSessionRef.current = null;
      return;
    }

    const refreshRequest = ++loadRequestRef.current;
    try {
      const response = await readCurrentHistory(targetSessionId);
      if (mountedRef.current && activeSessionRef.current === targetSessionId && loadRequestRef.current === refreshRequest) {
        replaceHistory(targetSessionId, response);
        setLoadError('');
        setLoading(false);
      }
    } catch {
      // The write succeeded; only the refresh failed. Reported separately so the
      // user is never nudged into sending the same question twice.
      if (mountedRef.current && activeSessionRef.current === targetSessionId) {
        setLoadError('回答已生成，但消息列表刷新失败。刷新页面即可看到。');
        setLoading(false);
      }
    } finally {
      if (mountedRef.current && sendTokenRef.current === token) {
        sendTokenRef.current = null;
        if (draftSendSessionRef.current === targetSessionId) draftSendSessionRef.current = null;
        setSending(false);
        setPendingQuestion('');
        // The persisted message now carries the answer, so the transient copy
        // must go or the thread would render it twice.
        setStreamingAnswer('');
        setStreamingCitations([]);
        streamingAnswerRef.current = '';
        streamingCitationsRef.current = [];
      }
    }
  }, [
    clearAutoChecks,
    discardAccountSend,
    handleAccessLost,
    draftKnowledgeBaseId,
    draftKnowledgeBaseIds,
    draftDocumentIds,
    draftScopeMode,
    isDraft,
    onSessionCreated,
    setStreamingAnswer,
    sending,
    sessionId,
    stoppedStream,
    unconfirmedSend,
    reconcileSendResult,
    invalidateHistory, readCurrentHistory, replaceHistory,
  ]);

  const checkSendNow = useCallback(async () => {
    if (!unconfirmedSend || unconfirmedSend.checking || sendCheckTokenRef.current) return;
    const token = Symbol('check-send');
    sendCheckTokenRef.current = token;
    setUnconfirmedSend((current) => (current ? { ...current, checking: true } : current));
    const sequence = ++reconcileSequenceRef.current;
    try {
      const accepted = await reconcileSend(unconfirmedSend.request, sequence);
      if (
        !mountedRef.current
        || sendCheckTokenRef.current !== token
        || accepted
        || reconcileSequenceRef.current !== sequence
      ) return;
      setUnconfirmedSend((current) => (
        current ? { ...current, autoChecksDone: AUTO_CHECK_DELAYS_MS.length, checking: false } : current
      ));
    } finally {
      if (sendCheckTokenRef.current === token) sendCheckTokenRef.current = null;
    }
  }, [reconcileSend, unconfirmedSend]);

  const regenerate = useCallback(async (messageId: string) => {
    if (!sessionId || regenerateTokenRef.current || sendTokenRef.current || editTokenRef.current) return;

    const targetSessionId = sessionId;
    const baselineMessageIds = messages.map((message) => message.id);
    // Without persistence there is no way to tell a lost response from a lost
    // request after a reload, so the non-idempotent write is not attempted.
    const stored = pendingRegenerationStore.set({
      sessionId: targetSessionId,
      messageId,
      baselineMessageIds,
      checked: false,
      createdAt: new Date().toISOString(),
    });
    if (!stored) {
      setRegeneration({
        messageId,
        kind: 'failed',
        message: '浏览器存储不可用，无法安全地重新生成。请检查隐私设置后重试。',
        baselineMessageIds,
        autoChecksDone: 0,
        checking: false,
      });
      return;
    }

    const token = Symbol('regenerate-message');
    invalidateHistory();
    regenerateTokenRef.current = token;
    setRegeneratingId(messageId);
    setRegeneration(null);
    setRerankFallback(null);
    setRateLimitNotice(null);

    try {
      const response = await regenerateChatMessage(targetSessionId, messageId);
      pendingRegenerationStore.clear(targetSessionId, messageId);
      if (!mountedRef.current || (activeSessionRef.current ?? '') !== targetSessionId || regenerateTokenRef.current !== token) {
        return;
      }
      setRerankFallback(response.rerankFallback?.used ? response.rerankFallback : null);
      // The response carries the new message, so a later list refresh failing
      // must not turn a successful write into a reported failure.
      setMessages((current) => (
        current.some((message) => message.id === response.message.id)
          ? current.map((message) => (message.id === response.message.id ? response.message : message))
          : [...current, response.message]
      ));
      updateHistoryRevision(targetSessionId, response.message.id);
      setLoadError('');
      onSessionsChanged();
    } catch (caught) {
      const rateLimited = isRateLimitError(caught);
      const definitive = rateLimited || (caught instanceof ApiError && isDefinitiveSendFailure(caught));
      if (definitive) pendingRegenerationStore.clear(targetSessionId, messageId);
      if (mountedRef.current && activeSessionRef.current === targetSessionId && regenerateTokenRef.current === token) {
        if (handleAccessLost(caught, targetSessionId)) return;
        if (rateLimited) {
          setRateLimitNotice({ ...retryNotice(caught), question: null });
          setRegeneration(null);
        } else {
          setRegeneration({
            messageId,
            kind: definitive ? 'failed' : 'unconfirmed',
            message: definitive
              ? getErrorMessage(caught, '重新生成失败')
              : '重新生成结果还没确认。',
            baselineMessageIds,
            autoChecksDone: 0,
            checking: false,
          });
        }
      }
    } finally {
      if (regenerateTokenRef.current === token) {
        regenerateTokenRef.current = null;
        if (mountedRef.current) setRegeneratingId(null);
      }
    }
  }, [handleAccessLost, messages, onSessionsChanged, sessionId, invalidateHistory, updateHistoryRevision]);

  /**
   * Refetches the thread and reports whether the regeneration produced a new
   * answer.
   *
   * `attempt` is how many checks have now run for this regeneration. It is what
   * moves the panel into its decision state, so the manual check counts as the
   * last attempt and always reaches it.
   */
  const runRegenerationCheck = useCallback(async (snapshot: RegenerationState, attempt: number) => {
    if (!sessionId) return;
    const token = Symbol('check-regeneration');
    regenerationCheckTokenRef.current = token;
    try {
      const response = await readCurrentHistory(sessionId);
      if (
        !mountedRef.current
        || activeSessionRef.current !== sessionId
        || regenerationCheckTokenRef.current !== token
      ) return;
      replaceHistory(sessionId, response);
      const produced = findNewAssistantMessage(response.items, snapshot.baselineMessageIds);
      if (produced) {
        pendingRegenerationStore.clear(sessionId, snapshot.messageId);
        setRegeneration(null);
        // Via the ref: a callback that changed identity on every render would
        // re-arm the automatic checks below each time they update their own state.
        onSessionsChangedRef.current();
        return;
      }
      const exhausted = attempt >= AUTO_CHECK_DELAYS_MS.length;
      pendingRegenerationStore.set({
        sessionId,
        messageId: snapshot.messageId,
        baselineMessageIds: snapshot.baselineMessageIds,
        checked: exhausted,
        createdAt: new Date().toISOString(),
      });
      setRegeneration((current) => (
        current && current.kind === 'unconfirmed' && current.messageId === snapshot.messageId
          ? {
            ...current,
            message: exhausted ? '检查后仍未发现新的回答。' : current.message,
            autoChecksDone: Math.max(current.autoChecksDone, attempt),
            checking: false,
          }
          : current
      ));
    } catch {
      setRegeneration((current) => (
        current && current.kind === 'unconfirmed' && current.messageId === snapshot.messageId
          ? {
            ...current,
            message: attempt >= AUTO_CHECK_DELAYS_MS.length ? '暂时无法检查，请稍后再试。' : current.message,
            checking: false,
          }
          : current
      ));
    } finally {
      if (regenerationCheckTokenRef.current === token) regenerationCheckTokenRef.current = null;
    }
  }, [readCurrentHistory, replaceHistory, sessionId]);

  const checkRegeneration = useCallback(async () => {
    if (
      !sessionId
      || !regeneration
      || regeneration.kind !== 'unconfirmed'
      || regeneration.checking
      || regenerationCheckTokenRef.current
    ) return;

    const snapshot = regeneration;
    setRegeneration({ ...snapshot, checking: true });
    await runRegenerationCheck(snapshot, AUTO_CHECK_DELAYS_MS.length);
  }, [regeneration, runRegenerationCheck, sessionId]);

  const regenerationRef = useRef<RegenerationState | null>(regeneration);
  regenerationRef.current = regeneration;
  const pendingRegenerationId = regeneration?.kind === 'unconfirmed' ? regeneration.messageId : '';

  /**
   * Reconciles an unconfirmed regeneration on the same 2s/5s schedule as an
   * unconfirmed send.
   *
   * Regeneration only set `{kind:'unconfirmed', autoChecksDone:0}` and scheduled
   * nothing, and the decision state is keyed on `autoChecksDone`, so the panel sat
   * on "正在确认重新生成结果…" until the user retried or reloaded. The timer set is
   * keyed on the pending message id alone: the checks themselves update the state,
   * and re-arming on every update would restart the schedule forever.
   */
  useEffect(() => {
    if (!pendingRegenerationId) return undefined;
    const timers = AUTO_CHECK_DELAYS_MS.map((delay, index) => window.setTimeout(() => {
      const snapshot = regenerationRef.current;
      if (
        !snapshot
        || snapshot.kind !== 'unconfirmed'
        || snapshot.messageId !== pendingRegenerationId
        || snapshot.checking
        // A manual check counts as the last attempt and can conclude before these
        // timers fire; without this the schedule would refetch again for nothing.
        || snapshot.autoChecksDone >= AUTO_CHECK_DELAYS_MS.length
        || regenerationCheckTokenRef.current
      ) return;
      setRegeneration({ ...snapshot, checking: true });
      void runRegenerationCheck(snapshot, index + 1);
    }, delay));
    return () => { timers.forEach((timer) => window.clearTimeout(timer)); };
  }, [pendingRegenerationId, runRegenerationCheck]);

  const updateMessageFeedback = useCallback((messageId: string, feedback: ChatMessageFeedback) => {
    setMessages((current) => applyMessageFeedback(current, messageId, feedback));
  }, []);

  const updateMessageBookmark = useCallback((messageId: string, bookmark: ChatBookmark | null) => {
    setMessages((current) => applyMessageBookmark(current, messageId, bookmark));
  }, []);

  const editMessage = useCallback(async (messageId: string, content: string) => {
    if (!sessionId || !content.trim() || sendTokenRef.current || regenerateTokenRef.current || editTokenRef.current) return;
    const targetSessionId = sessionId;
    const normalizedContent = content.trim();
    const previousPending = pendingChatEditStore.get(targetSessionId);
    if (previousPending && (
      previousPending.messageId !== messageId || previousPending.content !== normalizedContent
    )) {
      throw new ApiError(409, {
        code: 'CHAT_EDIT_UNCONFIRMED',
        message: '上一次编辑结果尚未确认，请刷新会话后再试。',
      });
    }
    const token = Symbol('edit-message');
    invalidateHistory();
    editTokenRef.current = token;
    setEditingId(messageId);
    const clientRequestId = previousPending?.clientRequestId ?? crypto.randomUUID();
    pendingChatEditStore.set({
      sessionId: targetSessionId,
      messageId,
      content: normalizedContent,
      clientRequestId,
      createdAt: previousPending?.createdAt ?? new Date().toISOString(),
    });
    try {
      const response = await editChatMessage(targetSessionId, messageId, {
        content: normalizedContent,
        clientRequestId,
      });
      pendingChatEditStore.clear(targetSessionId, clientRequestId);
      if (!mountedRef.current || (activeSessionRef.current ?? '') !== targetSessionId || editTokenRef.current !== token) return;
      setMessages((current) => applyEditedMessageResponse(current, messageId, response.userMessage, response.assistantMessage));
      updateHistoryRevision(targetSessionId, response.assistantMessage.id);
      setLoadError('');
      setRerankFallback(response.rerankFallback?.used ? response.rerankFallback : null);
      onSessionsChangedRef.current();
    } catch (caught) {
      if (mountedRef.current && activeSessionRef.current === targetSessionId && editTokenRef.current === token
        && handleAccessLost(caught, targetSessionId)) return;
      if (caught instanceof ApiError && isDefinitiveSendFailure(caught)) {
        pendingChatEditStore.clear(targetSessionId, clientRequestId);
        throw caught;
      }
      try {
        const response = await readCurrentHistory(targetSessionId);
        const accepted = response.items.some((message) => message.clientRequestId === clientRequestId);
        if (accepted) {
          pendingChatEditStore.clear(targetSessionId, clientRequestId);
          if (mountedRef.current && activeSessionRef.current === targetSessionId && editTokenRef.current === token) {
            replaceHistory(targetSessionId, response);
            setLoadError('');
            onSessionsChangedRef.current();
          }
          return;
        }
      } catch {
        // Keep the original error and pending id for a later retry/reload.
      }
      throw new ApiError(0, {
        code: 'CHAT_EDIT_UNCONFIRMED',
        message: '编辑结果暂未确认，已保留原请求编号。请刷新会话后再试。',
      });
    } finally {
      if (editTokenRef.current === token) {
        editTokenRef.current = null;
        if (mountedRef.current) setEditingId(null);
      }
    }
  }, [handleAccessLost, sessionId, invalidateHistory, readCurrentHistory, replaceHistory, updateHistoryRevision]);

  const cancelSend = useCallback(() => {
    if (!sendAbortRef.current || !sendTokenRef.current) return;
    cancelRequestedRef.current = sendTokenRef.current;
    sendAbortRef.current.abort();
  }, []);

  const hasPendingWrite = useCallback(() => Boolean(
    sendTokenRef.current
    || regenerateTokenRef.current
    || editTokenRef.current
    || sendCheckTokenRef.current
    || regenerationCheckTokenRef.current
    || Boolean(activeSessionRef.current && pendingChatRequestStore.get(activeSessionRef.current))
  ), []);

  return {
    session,
    setSession,
    messages,
    loading,
    loadError,
    hasOlderMessages: history.hasOlderMessages,
    hasNewerMessages: history.hasNewerMessages,
    loadingHistory: history.loadingHistory,
    historyError: history.historyError,
    missingMessageId: history.missingMessageId,
    loadOlderMessages: history.loadOlderMessages,
    loadAllMessages: history.loadAllMessages,
    loadNewerMessages: history.loadNewerMessages,
    loadMessageContext: history.loadMessageContext,
    cancelMessageContext: history.cancelMessageContext,
    retryHistory: history.retryHistory,
    loadLatestMessages: history.loadLatestMessages,
    invalidateHistory: history.invalidateHistory,
    handleAccessLost,
    sending,
    pendingQuestion,
    failedSend,
    unconfirmedSend,
    /** True once the automatic checks are exhausted and the user must decide. */
    needsResendDecision: Boolean(
      unconfirmedSend && unconfirmedSend.autoChecksDone >= AUTO_CHECK_DELAYS_MS.length,
    ),
    regeneration,
    regeneratingId,
    editingId,
    rerankFallback,
    streamText,
    streamingCitations,
    stoppedStream,
    rateLimitError: rateLimitNotice?.message ?? '',
    rateLimitNotice,
    rateLimitedQuestion: rateLimitNotice?.question ?? null,
    reload: () => (sessionId ? loadThread(sessionId) : Promise.resolve()),
    send,
    cancelSend,
    checkSendNow,
    regenerate,
    editMessage,
    checkRegeneration,
    hasPendingWrite,
    updateMessageFeedback,
    updateMessageBookmark,
    dismissFailedSend: () => setFailedSend(null),
    dismissRateLimitError: () => setRateLimitNotice(null),
  };
}
