import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError } from '../../api/client';
import {
  createChatSession,
  editChatMessage,
  getChatSession,
  listChatMessages,
  regenerateChatMessage,
  sendChatMessageStream,
} from '../../api/resources';
import type {
  ChatMessage,
  ChatMessageFeedback,
  ChatSession,
  Citation,
  KnowledgeBaseRerankFallback,
} from '../../types/api';
import { getErrorMessage } from '../../utils/errors';
import { pendingChatRequestStore } from './pendingChatRequestStore';
import type { PendingChatRequest } from './pendingChatRequestStore';
import { pendingChatEditStore } from './pendingChatEditStore';
import { pendingRegenerationStore } from './pendingRegenerationStore';

/** Delays for the automatic reconciliation attempts after an unconfirmed write. */
const AUTO_CHECK_DELAYS_MS = [2000, 5000];

export type UnconfirmedSend = {
  request: PendingChatRequest;
  /** Automatic checks already performed. The user is only asked once this is exhausted. */
  autoChecksDone: number;
  checking: boolean;
};

export type StoppedStream = {
  question: string;
  answer: string;
  citations: Citation[];
  checking: boolean;
  resumable: boolean;
};

type ReconcileResult = 'accepted' | 'absent' | 'unknown';

export type RegenerationState = {
  messageId: string;
  kind: 'failed' | 'unconfirmed';
  message: string;
  baselineMessageIds: string[];
  autoChecksDone: number;
  checking: boolean;
};

type UseChatThreadOptions = {
  sessionId?: string;
  draftKnowledgeBaseId?: string;
  onSessionCreated: (session: ChatSession) => void;
  onSessionsChanged: () => void;
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
  draftKnowledgeBaseId,
  onSessionCreated,
  onSessionsChanged,
}: UseChatThreadOptions) {
  const isDraft = !sessionId;
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
  const [streamingAnswer, setStreamingAnswer] = useState('');
  const [streamingCitations, setStreamingCitations] = useState<Citation[]>([]);
  const [stoppedStream, setStoppedStream] = useState<StoppedStream | null>(null);

  const activeSessionRef = useRef<string | undefined>(sessionId);
  const mountedRef = useRef(true);
  const loadRequestRef = useRef(0);
  const sendTokenRef = useRef<symbol | null>(null);
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

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
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
  }, []);

  const clearAutoChecks = useCallback(() => {
    autoCheckTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    autoCheckTimersRef.current = [];
    reconcileSequenceRef.current += 1;
    sendCheckTokenRef.current = null;
  }, []);

  const loadThread = useCallback(async (targetSessionId: string) => {
    const request = ++loadRequestRef.current;
    setLoading(true);
    setLoadError('');
    setMessages([]);
    setSession(null);

    const current = () => mountedRef.current
      && activeSessionRef.current === targetSessionId
      && loadRequestRef.current === request;

    try {
      const [sessionResponse, messageResponse] = await Promise.all([
        getChatSession(targetSessionId),
        listChatMessages(targetSessionId),
      ]);
      if (!current()) return;

      setSession(sessionResponse);
      setMessages(messageResponse.items);

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
        setLoadError(getErrorMessage(caught, '消息加载失败'));
        setMessages([]);
        setSession(null);
      }
    } finally {
      if (current()) setLoading(false);
    }
  }, []);

  // Switching sessions invalidates every in-flight request and transient state.
  useEffect(() => {
    const continuingDraftSend = draftSendSessionRef.current === sessionId;
    activeSessionRef.current = sessionId;
    clearAutoChecks();
    setRegeneration(null);
    setRegeneratingId(null);
    setEditingId(null);
    setRerankFallback(null);
    setStreamingAnswer('');
    setStreamingCitations([]);
    setStoppedStream(null);
    streamingAnswerRef.current = '';
    streamingCitationsRef.current = [];
    regenerateTokenRef.current = null;
    regenerationCheckTokenRef.current = null;

    if (!continuingDraftSend) {
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
  }, [clearAutoChecks, loadThread, sessionId]);

  /**
   * Refetches the thread and reports whether the pending request landed.
   * Used by both the automatic checks and the explicit "check again" action.
   */
  const reconcileSendResult = useCallback(async (
    pending: PendingChatRequest,
    sequence: number,
  ): Promise<ReconcileResult> => {
    const targetSessionId = pending.sessionId;
    if (activeSessionRef.current !== targetSessionId) return 'unknown';

    try {
      const response = await listChatMessages(targetSessionId);
      if (
        !mountedRef.current
        || activeSessionRef.current !== targetSessionId
        || reconcileSequenceRef.current !== sequence
      ) return 'unknown';
      setMessages(response.items);
      const accepted = response.items.some(
        (message) => message.clientRequestId === pending.clientRequestId,
      );
      if (accepted) {
        pendingChatRequestStore.clear(targetSessionId, pending.clientRequestId);
        setUnconfirmedSend(null);
        setStoppedStream(null);
        onSessionsChangedRef.current();
      }
      return accepted ? 'accepted' : 'absent';
    } catch {
      return 'unknown';
    }
  }, []);

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

  const send = useCallback(async (question: string, options: { resend?: boolean } = {}) => {
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
    if (isDraft && !draftKnowledgeBaseId) return;

    const token = Symbol('send-message');
    sendTokenRef.current = token;
    clearAutoChecks();
    setSending(true);
    setFailedSend(null);
    setUnconfirmedSend(null);
    setRerankFallback(null);
    setStreamingAnswer('');
    setStreamingCitations([]);
    setStoppedStream(null);
    streamingAnswerRef.current = '';
    streamingCitationsRef.current = [];
    cancelRequestedRef.current = null;
    setPendingQuestion(question);

    // An explicit resend must reuse the original id so the server can dedupe it.
    const clientRequestId = retryOf?.clientRequestId ?? crypto.randomUUID();
    let targetSessionId = sessionId ?? '';
    let messageRequestStarted = false;
    let streamController: AbortController | null = null;

    try {
      if (isDraft) {
        const created = await createChatSession(draftKnowledgeBaseId as string, '');
        if (!mountedRef.current || sendTokenRef.current !== token) return;
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
      // See docs/14-frontend-api-gaps.md G2.
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
      pendingChatRequestStore.clear(targetSessionId, clientRequestId);
      if (isCurrent()) {
        setRerankFallback(response.rerankFallback?.used ? response.rerankFallback : null);
        // Title refresh is independent of the message-list read below, which
        // may fail even though the first question and its title were saved.
        onSessionsChangedRef.current();
      }
    } catch (caught) {
      if (streamController && sendAbortRef.current === streamController) sendAbortRef.current = null;
      if (!mountedRef.current || sendTokenRef.current !== token || activeSessionRef.current !== targetSessionId) {
        return;
      }
      const userCancelled = cancelRequestedRef.current === token;
      cancelRequestedRef.current = null;
      sendTokenRef.current = null;
      if (draftSendSessionRef.current === targetSessionId) draftSendSessionRef.current = null;

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

      if (caught instanceof ApiError && isDefinitiveSendFailure(caught)) {
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

    if (!mountedRef.current || sendTokenRef.current !== token || activeSessionRef.current !== targetSessionId) {
      if (draftSendSessionRef.current === targetSessionId) draftSendSessionRef.current = null;
      return;
    }

    const refreshRequest = ++loadRequestRef.current;
    try {
      const response = await listChatMessages(targetSessionId);
      if (mountedRef.current && activeSessionRef.current === targetSessionId && loadRequestRef.current === refreshRequest) {
        setMessages(response.items);
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
    draftKnowledgeBaseId,
    isDraft,
    onSessionCreated,
    onSessionsChanged,
    sending,
    sessionId,
    stoppedStream,
    unconfirmedSend,
    reconcileSendResult,
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
    regenerateTokenRef.current = token;
    setRegeneratingId(messageId);
    setRegeneration(null);
    setRerankFallback(null);

    try {
      const response = await regenerateChatMessage(targetSessionId, messageId);
      pendingRegenerationStore.clear(targetSessionId, messageId);
      if (!mountedRef.current || activeSessionRef.current !== targetSessionId || regenerateTokenRef.current !== token) {
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
      setLoadError('');
      onSessionsChanged();
    } catch (caught) {
      const definitive = caught instanceof ApiError && isDefinitiveSendFailure(caught);
      if (definitive) pendingRegenerationStore.clear(targetSessionId, messageId);
      if (mountedRef.current && activeSessionRef.current === targetSessionId && regenerateTokenRef.current === token) {
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
    } finally {
      if (regenerateTokenRef.current === token) {
        regenerateTokenRef.current = null;
        if (mountedRef.current) setRegeneratingId(null);
      }
    }
  }, [messages, onSessionsChanged, sessionId]);

  const checkRegeneration = useCallback(async () => {
    if (
      !sessionId
      || !regeneration
      || regeneration.kind !== 'unconfirmed'
      || regeneration.checking
      || regenerationCheckTokenRef.current
    ) return;

    const snapshot = regeneration;
    const token = Symbol('check-regeneration');
    regenerationCheckTokenRef.current = token;
    setRegeneration({ ...snapshot, checking: true });
    try {
      const response = await listChatMessages(sessionId);
      if (
        !mountedRef.current
        || activeSessionRef.current !== sessionId
        || regenerationCheckTokenRef.current !== token
      ) return;
      setMessages(response.items);
      const produced = findNewAssistantMessage(response.items, snapshot.baselineMessageIds);
      if (produced) {
        pendingRegenerationStore.clear(sessionId, snapshot.messageId);
        setRegeneration(null);
        onSessionsChanged();
        return;
      }
      pendingRegenerationStore.set({
        sessionId,
        messageId: snapshot.messageId,
        baselineMessageIds: snapshot.baselineMessageIds,
        checked: true,
        createdAt: new Date().toISOString(),
      });
      setRegeneration({
        ...snapshot,
        message: '检查后仍未发现新的回答。',
        autoChecksDone: AUTO_CHECK_DELAYS_MS.length,
        checking: false,
      });
    } catch {
      if (mountedRef.current && regenerationCheckTokenRef.current === token) {
        setRegeneration({ ...snapshot, message: '暂时无法检查，请稍后再试。', checking: false });
      }
    } finally {
      if (regenerationCheckTokenRef.current === token) regenerationCheckTokenRef.current = null;
    }
  }, [onSessionsChanged, regeneration, sessionId]);

  const updateMessageFeedback = useCallback((messageId: string, feedback: ChatMessageFeedback) => {
    setMessages((current) => current.map((message) => (
      message.id === messageId ? { ...message, feedback } : message
    )));
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
      if (!mountedRef.current || activeSessionRef.current !== targetSessionId || editTokenRef.current !== token) return;
      setMessages((current) => {
        const index = current.findIndex((message) => message.id === messageId);
        if (index < 0) return [response.userMessage, response.assistantMessage];
        return [...current.slice(0, index), response.userMessage, response.assistantMessage];
      });
      setLoadError('');
      setRerankFallback(response.rerankFallback?.used ? response.rerankFallback : null);
      onSessionsChangedRef.current();
    } catch (caught) {
      if (caught instanceof ApiError && isDefinitiveSendFailure(caught)) {
        pendingChatEditStore.clear(targetSessionId, clientRequestId);
        throw caught;
      }
      try {
        const response = await listChatMessages(targetSessionId);
        const accepted = response.items.some((message) => message.clientRequestId === clientRequestId);
        if (accepted) {
          pendingChatEditStore.clear(targetSessionId, clientRequestId);
          if (mountedRef.current && activeSessionRef.current === targetSessionId && editTokenRef.current === token) {
            setMessages(response.items);
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
  }, [sessionId]);

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
    streamingAnswer,
    streamingCitations,
    stoppedStream,
    reload: () => (sessionId ? loadThread(sessionId) : Promise.resolve()),
    send,
    cancelSend,
    checkSendNow,
    regenerate,
    editMessage,
    checkRegeneration,
    hasPendingWrite,
    updateMessageFeedback,
    dismissFailedSend: () => setFailedSend(null),
  };
}

function findNewAssistantMessage(messages: ChatMessage[], baselineIds: string[]): ChatMessage | undefined {
  const known = new Set(baselineIds);
  return [...messages].reverse().find((message) => message.role === 'assistant' && !known.has(message.id));
}

/**
 * Only an unambiguous server-side rejection allows a plain retry. Network faults
 * and unclassified 5xx must go through reconciliation instead.
 */
function isDefinitiveSendFailure(error: ApiError): boolean {
  return (error.status >= 400 && error.status < 500)
    || error.code === 'CHAT_COMPLETION_FAILED'
    || error.code === 'RERANK_FAILED';
}
