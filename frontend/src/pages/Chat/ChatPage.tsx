import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';

import { ApiError } from '../../api/client';
import {
  archiveChatSession,
  createChatSession,
  deleteChatSession,
  getChatSession,
  getWorkspacePreference,
  listChatMessages,
  listChatSessions,
  listKnowledgeBaseCategories,
  listKnowledgeBases,
  regenerateChatMessage,
  sendChatMessage,
  updateChatSessionTitle,
} from '../../api/resources';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';
import { WorkspaceShell } from '../../components/WorkspaceShell';
import { RerankFallbackNotice } from '../../components/feedback/RerankFallbackNotice';
import type {
  ChatMessage,
  ChatSession,
  Citation,
  KnowledgeBase,
  KnowledgeBaseCategory,
  KnowledgeBaseRerankFallback,
  KnowledgeBaseWorkspacePreference,
} from '../../types/api';
import { getErrorMessage } from '../../utils/errors';

const fallbackPreference: KnowledgeBaseWorkspacePreference = {
  viewMode: 'table',
  scope: 'all',
  sort: 'updatedAt_desc',
  visibility: 'all',
  expandedCategoryIds: [],
};

export function ChatPage() {
  const { sessionId } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const activeSessionIdRef = useRef(sessionId);
  const expectedSessionTransitionRef = useRef<string | null>(null);
  const messageOperationIdRef = useRef(0);
  const messageOperationInFlightRef = useRef(false);
  activeSessionIdRef.current = sessionId;
  const [categories, setCategories] = useState<KnowledgeBaseCategory[]>([]);
  const [expandedIds, setExpandedIds] = useState<string[]>([]);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [selectedCitationMessageId, setSelectedCitationMessageId] = useState<string | null>(null);
  const [currentSessionDetail, setCurrentSessionDetail] = useState<ChatSession | null>(null);
  const [draft, setDraft] = useState('');
  const [titleDraft, setTitleDraft] = useState('');
  const [pendingQuestion, setPendingQuestion] = useState('');
  const [failedQuestion, setFailedQuestion] = useState('');
  const [loading, setLoading] = useState(true);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [checkingSendResult, setCheckingSendResult] = useState(false);
  const [regeneratingMessageId, setRegeneratingMessageId] = useState<string | null>(null);
  const [rerankFallback, setRerankFallback] = useState<KnowledgeBaseRerankFallback | null>(null);
  const [updatingSession, setUpdatingSession] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState('');
  const [uncertainSend, setUncertainSend] = useState<{
    sessionId: string;
    question: string;
    previousMessageCount: number;
  } | null>(null);
  const isDraftSession = sessionId === 'new';
  const draftKnowledgeBaseId = searchParams.get('knowledgeBaseId');

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    setError('');

    Promise.all([
      listChatSessions(),
      listKnowledgeBases({ pageSize: 100 }),
      listKnowledgeBaseCategories().catch(() => ({ items: [] })),
      getWorkspacePreference().catch(() => fallbackPreference),
    ])
      .then(([sessionResponse, kbResponse, categoryResponse, preference]) => {
        if (mounted) {
          setSessions(sessionResponse.items);
          setKnowledgeBases(kbResponse.items);
          setCategories(categoryResponse.items);
          setExpandedIds(preference.expandedCategoryIds);
        }
      })
      .catch((err) => {
        if (mounted) {
          setError(errorMessage(err, '会话列表加载失败'));
        }
      })
      .finally(() => {
        if (mounted) {
          setLoading(false);
        }
      });

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    const preservesMessageOperation = expectedSessionTransitionRef.current === sessionId;
    expectedSessionTransitionRef.current = null;

    if (!preservesMessageOperation) {
      messageOperationIdRef.current += 1;
      messageOperationInFlightRef.current = false;
      setSending(false);
      setPendingQuestion('');
      setFailedQuestion('');
      setCheckingSendResult(false);
      setRegeneratingMessageId(null);
      setUncertainSend(null);
      setError('');
      setRerankFallback(null);
    }

    setSelectedCitationMessageId(null);

    if (!sessionId || isDraftSession) {
      setCurrentSessionDetail(null);
      setTitleDraft('');
      setMessages([]);
      setMessagesLoading(false);
      return;
    }

    let mounted = true;
    setMessagesLoading(true);

    Promise.all([getChatSession(sessionId), listChatMessages(sessionId)])
      .then(([sessionResponse, messageResponse]) => {
        if (mounted) {
          setCurrentSessionDetail(sessionResponse);
          setTitleDraft(sessionResponse.title || '');
          setMessages(messageResponse.items);
          setSessions((current) => mergeSession(current, sessionResponse));
        }
      })
      .catch((err) => {
        if (mounted) {
          setError(errorMessage(err, '消息加载失败'));
          setCurrentSessionDetail(null);
          setMessages([]);
        }
      })
      .finally(() => {
        if (mounted) {
          setMessagesLoading(false);
        }
      });

    return () => {
      mounted = false;
    };
  }, [draftKnowledgeBaseId, isDraftSession, sessionId]);

  useEffect(() => {
    messagesRef.current?.scrollTo({
      top: messagesRef.current.scrollHeight,
      behavior: 'smooth',
    });
  }, [messages, pendingQuestion]);

  const currentSession = isDraftSession
    ? null
    : currentSessionDetail ?? sessions.find((session) => session.id === sessionId) ?? null;
  const currentKnowledgeBase = knowledgeBases.find(
    (kb) => kb.id === (currentSession?.knowledgeBaseId ?? draftKnowledgeBaseId),
  );
  const sessionsForCurrentKnowledgeBase = useMemo(() => {
    if (!currentKnowledgeBase) {
      return sessions;
    }
    return sessions.filter((session) => session.knowledgeBaseId === currentKnowledgeBase.id);
  }, [currentKnowledgeBase, sessions]);

  const latestAssistantMessage = useMemo(
    () => [...messages]
      .reverse()
      .find((message) => message.role === 'assistant') ?? null,
    [messages],
  );
  const selectedCitationMessage = messages.find(
    (message) => message.id === selectedCitationMessageId && message.role === 'assistant',
  );
  const activeCitationMessage = selectedCitationMessage ?? latestAssistantMessage;
  const activeCitations = activeCitationMessage?.citations ?? [];
  const latestAssistantMessageId = latestAssistantMessage?.id ?? null;

  const questionCount = messages.filter((message) => message.role === 'user').length;
  const citationCount = messages.reduce((sum, message) => sum + message.citations.length, 0);
  const archived = Boolean(currentSession?.archivedAt);
  const canSend = !archived && Boolean(currentKnowledgeBase) && Boolean(sessionId);

  async function reloadSessions() {
    const response = await listChatSessions();
    setSessions(response.items);
  }

  async function handleUpdateTitle(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!currentSession || !titleDraft.trim()) {
      return;
    }

    setUpdatingSession(true);
    setError('');

    try {
      const nextSession = await updateChatSessionTitle(currentSession.id, titleDraft.trim());
      setCurrentSessionDetail(nextSession);
      setSessions((current) => mergeSession(current, nextSession));
    } catch (err) {
      setError(errorMessage(err, '会话标题更新失败'));
    } finally {
      setUpdatingSession(false);
    }
  }

  async function handleArchiveSession() {
    if (!currentSession) {
      return;
    }

    setUpdatingSession(true);
    setError('');

    try {
      const archivedSession = await archiveChatSession(currentSession.id);
      setCurrentSessionDetail(archivedSession);
      setConfirmArchive(false);
      await reloadSessions();
    } catch (err) {
      setError(errorMessage(err, '会话归档失败'));
    } finally {
      setUpdatingSession(false);
    }
  }

  async function handleDeleteSession() {
    if (!currentSession) {
      return;
    }

    setUpdatingSession(true);
    setError('');

    try {
      await deleteChatSession(currentSession.id);
      setConfirmDelete(false);
      await reloadSessions();
      navigate('/chat', { replace: true });
    } catch (err) {
      setError(errorMessage(err, '会话删除失败'));
    } finally {
      setUpdatingSession(false);
    }
  }

  function handleCreateSession(knowledgeBaseId = currentKnowledgeBase?.id) {
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
    if (
      !question
      || !sessionId
      || !canSend
      || messageOperationInFlightRef.current
      || (uncertainSend && !confirmedResend)
    ) {
      return;
    }

    const routeSessionId = sessionId;
    const operationId = messageOperationIdRef.current + 1;
    messageOperationIdRef.current = operationId;
    messageOperationInFlightRef.current = true;
    setSending(true);
    setError('');
    setRerankFallback(null);
    setFailedQuestion('');
    setUncertainSend(null);
    setPendingQuestion(question);

    let targetSessionId = routeSessionId;
    let messageRequestStarted = false;
    try {
      if (isDraftSession) {
        if (!currentKnowledgeBase) {
          throw new Error('知识库不存在');
        }

        const session = await createChatSession(currentKnowledgeBase.id, '');
        if (!isCurrentMessageOperation(operationId, routeSessionId)) {
          return;
        }

        targetSessionId = session.id;
        expectedSessionTransitionRef.current = targetSessionId;
        activeSessionIdRef.current = targetSessionId;
        setCurrentSessionDetail(session);
        setSessions((current) => mergeSession(current, session));
        navigate(`/chat/${session.id}`, { replace: true });
      }

      messageRequestStarted = true;
      const response = await sendChatMessage(targetSessionId, question);
      if (!isCurrentMessageOperation(operationId, targetSessionId)) {
        return;
      }

      setRerankFallback(response.rerankFallback?.used ? response.rerankFallback : null);
      setDraft('');
      setFailedQuestion('');
      setUncertainSend(null);

      try {
        const [messageResponse, sessionResponse] = await Promise.all([
          listChatMessages(targetSessionId),
          listChatSessions(),
        ]);
        if (!isCurrentMessageOperation(operationId, targetSessionId)) {
          return;
        }
        setMessages(messageResponse.items);
        setSelectedCitationMessageId(null);
        setSessions(sessionResponse.items);
      } catch {
        if (isCurrentMessageOperation(operationId, targetSessionId)) {
          setError('问题已发送，但消息列表刷新失败，请刷新页面查看。');
        }
      }
    } catch (err) {
      if (isCurrentMessageOperation(operationId, targetSessionId)) {
        setDraft(question);
        if (err instanceof ApiError) {
          setError(errorMessage(err, '消息发送失败，请稍后重试。'));
          setFailedQuestion(question);
        } else if (messageRequestStarted) {
          setError('发送结果暂时无法确认。请先再次检查；如仍未显示，再确认是否重新发送。');
          setUncertainSend({
            sessionId: targetSessionId,
            question,
            previousMessageCount: messages.length,
          });
        } else {
          setError('会话创建结果暂时无法确认，请刷新会话列表后再试。');
        }
      }
    } finally {
      if (isCurrentMessageOperation(operationId, targetSessionId)) {
        messageOperationInFlightRef.current = false;
        setSending(false);
        setPendingQuestion('');
      }
    }
  }

  async function handleCheckSendResult() {
    if (!uncertainSend || messageOperationInFlightRef.current) {
      return;
    }

    const reconciliation = uncertainSend;
    const operationId = messageOperationIdRef.current + 1;
    messageOperationIdRef.current = operationId;
    messageOperationInFlightRef.current = true;
    setCheckingSendResult(true);

    try {
      const response = await listChatMessages(reconciliation.sessionId);
      if (!isCurrentMessageOperation(operationId, reconciliation.sessionId)) {
        return;
      }

      setMessages(response.items);
      setSelectedCitationMessageId(null);
      const submittedMessageExists = response.items
        .slice(reconciliation.previousMessageCount)
        .some((message) => message.role === 'user' && message.content === reconciliation.question);
      if (submittedMessageExists) {
        setDraft('');
        setError('');
        setUncertainSend(null);
        void reloadSessions().catch(() => undefined);
      } else {
        setError('暂未发现这条问题。你可以稍后再次检查，或确认重新发送。');
      }
    } catch {
      if (isCurrentMessageOperation(operationId, reconciliation.sessionId)) {
        setError('暂时无法检查发送结果，请稍后再次检查。');
      }
    } finally {
      if (isCurrentMessageOperation(operationId, reconciliation.sessionId)) {
        messageOperationInFlightRef.current = false;
        setCheckingSendResult(false);
      }
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submitQuestion(draft.trim());
  }

  async function handleRegenerateMessage(messageId: string) {
    if (!sessionId || isDraftSession || uncertainSend || messageOperationInFlightRef.current) {
      return;
    }

    const targetSessionId = sessionId;
    const operationId = messageOperationIdRef.current + 1;
    messageOperationIdRef.current = operationId;
    messageOperationInFlightRef.current = true;
    setRegeneratingMessageId(messageId);
    setError('');
    setRerankFallback(null);
    try {
      const response = await regenerateChatMessage(targetSessionId, messageId);
      if (!isCurrentMessageOperation(operationId, targetSessionId)) {
        return;
      }
      setRerankFallback(response.rerankFallback?.used ? response.rerankFallback : null);
      const messageResponse = await listChatMessages(targetSessionId);
      if (!isCurrentMessageOperation(operationId, targetSessionId)) {
        return;
      }
      setMessages(messageResponse.items);
      setSelectedCitationMessageId(null);
    } catch (err) {
      if (isCurrentMessageOperation(operationId, targetSessionId)) {
        setError(errorMessage(err, '重新生成回答失败'));
      }
    } finally {
      if (isCurrentMessageOperation(operationId, targetSessionId)) {
        messageOperationInFlightRef.current = false;
        setRegeneratingMessageId(null);
      }
    }
  }

  function isCurrentMessageOperation(operationId: number, targetSessionId: string): boolean {
    return messageOperationIdRef.current === operationId && activeSessionIdRef.current === targetSessionId;
  }

  return (
    <WorkspaceShell active="chat" categories={categories} expandedIds={expandedIds}>
      <div className="chat-workspace-page">
      <header className="page-header workspace-heading chat-workspace-header">
        <div>
          <p className="breadcrumb">知识库 / {currentKnowledgeBase?.name ?? '问答'} / 聊天</p>
          <h1>聊天问答</h1>
          <p className="page-description">答案与引用全部来自真实后端消息接口；无引用时明确提示依据不足。</p>
        </div>
        <div className="toolbar">
          {currentKnowledgeBase && (
            <Link className="secondary-link" to={`/knowledge-bases/${currentKnowledgeBase.id}`}>
              返回知识库
            </Link>
          )}
          <button type="button" onClick={() => handleCreateSession()}>
            新建会话
          </button>
        </div>
      </header>

      {error && (
        <div className="error-text" role="alert">
          <span>{error}</span>
          {failedQuestion && (
            <button
              className="link-button"
              type="button"
              onClick={() => void submitQuestion(draft.trim())}
              disabled={sending || checkingSendResult || regeneratingMessageId !== null || !draft.trim()}
            >
              重试发送
            </button>
          )}
          {uncertainSend && (
            <>
              <button
                className="link-button"
                type="button"
                onClick={() => void handleCheckSendResult()}
                disabled={checkingSendResult || sending || regeneratingMessageId !== null}
              >
                {checkingSendResult ? '检查中...' : '再次检查'}
              </button>
              <button
                className="link-button"
                type="button"
                onClick={() => void submitQuestion(draft.trim(), true)}
                disabled={checkingSendResult || sending || regeneratingMessageId !== null || !draft.trim()}
              >
                确认重新发送
              </button>
            </>
          )}
        </div>
      )}

      <div className="chat-shell">
        <aside className="chat-sidebar-panel">
          <label className="field-label">
            当前知识库
            <select
              value={currentKnowledgeBase?.id ?? ''}
              disabled={knowledgeBases.length === 0}
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

          <button type="button" onClick={() => handleCreateSession()}>
            新建当前知识库会话
          </button>

          <div className="session-section-title">
            <strong>会话</strong>
            <span>{sessionsForCurrentKnowledgeBase.length}</span>
          </div>

          <div className="session-list chat-session-list">
            {loading ? (
              <LoadingSkeleton rows={4} columns={1} compact />
            ) : sessionsForCurrentKnowledgeBase.length === 0 ? (
              <div className="empty-state">当前知识库暂无会话。</div>
            ) : (
              sessionsForCurrentKnowledgeBase.map((session) => (
                <Link
                  className={session.id === sessionId ? 'session-card active' : 'session-card'}
                  key={session.id}
                  to={`/chat/${session.id}`}
                >
                  <strong>{session.title || '未命名会话'}</strong>
                  <span>{formatDateTime(session.updatedAt || session.createdAt)}</span>
                </Link>
              ))
            )}
          </div>
        </aside>

        <section className="chat-main-panel" aria-label="问答会话">
          <header className="chat-thread-head">
            <div>
              <h2>{currentSession?.title ?? '问答会话'}</h2>
              <p className="muted-text">
                {archived
                  ? `已归档于 ${formatDateTime(currentSession?.archivedAt ?? '')}，详情仍可查看。`
                  : 'Rerank 开启时，引用按后端进入回答 prompt 的结果展示。'}
              </p>
            </div>
            <div className="chat-thread-actions">
              <form className="chat-title-form" onSubmit={handleUpdateTitle}>
                <input
                  aria-label="会话标题"
                  value={titleDraft}
                  onChange={(event) => setTitleDraft(event.target.value)}
                  disabled={!currentSession || updatingSession}
                />
                <button className="secondary-button" type="submit" disabled={!currentSession || updatingSession || !titleDraft.trim()}>
                  改名
                </button>
              </form>
              <div className="chat-thread-stats" aria-label="会话统计">
                <span>{questionCount} 问</span>
                <span>{citationCount} 引用</span>
              </div>
              <div className="table-actions">
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => setConfirmArchive(true)}
                  disabled={!currentSession || updatingSession || archived}
                >
                  归档
                </button>
                <button
                  className="danger-button"
                  type="button"
                  onClick={() => setConfirmDelete(true)}
                  disabled={!currentSession || updatingSession}
                >
                  删除
                </button>
              </div>
            </div>
          </header>

          <RerankFallbackNotice fallback={rerankFallback} />

          <div ref={messagesRef} className={messagesLoading ? 'messages chat-thread is-switching' : 'messages chat-thread'}>
            {messagesLoading ? (
              <div className="message-loading-state">
                <LoadingSkeleton rows={5} columns={1} compact />
              </div>
            ) : messages.length === 0 && !pendingQuestion ? (
              <div className="chat-empty-state">
                <strong>开始提问</strong>
                <p>围绕当前知识库提问，回答会在右侧展示可追踪引用。</p>
              </div>
            ) : (
              messages.map((message) => (
                <MessageBubble
                  key={message.id}
                  message={message}
                  citationsSelected={message.id === activeCitationMessage?.id}
                  onSelectCitations={setSelectedCitationMessageId}
                  onRegenerate={message.id === latestAssistantMessageId && !archived ? handleRegenerateMessage : undefined}
                  regenerating={regeneratingMessageId === message.id}
                  regenerationDisabled={
                    sending
                    || checkingSendResult
                    || Boolean(uncertainSend)
                    || regeneratingMessageId !== null
                  }
                />
              ))
            )}
            {pendingQuestion && (
              <>
                <article className="message-bubble user pending">
                  <span className="message-role">User</span>
                  <p>{pendingQuestion}</p>
                </article>
                <article className="message-bubble assistant pending">
                  <span className="message-role">Assistant</span>
                  <p>正在检索知识库并生成回答...</p>
                  <LoadingSkeleton rows={2} columns={1} compact />
                </article>
              </>
            )}
          </div>

          <form className="composer chat-composer" onSubmit={handleSubmit}>
            <textarea
              aria-label="继续追问当前知识库"
              placeholder="继续追问当前知识库..."
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              disabled={sending || regeneratingMessageId !== null || !canSend}
              rows={2}
            />
            <button
              type="submit"
              disabled={
                sending
                || checkingSendResult
                || regeneratingMessageId !== null
                || !draft.trim()
                || !canSend
                || Boolean(uncertainSend)
              }
            >
              {sending ? '发送中...' : '发送'}
            </button>
          </form>
        </section>

        <aside className="citation-panel chat-citation-panel">
          <div>
            <h2>引用来源</h2>
            <p className="muted-text">仅展示后端返回的 citations。</p>
          </div>

          <div className="citation-list" id="chat-citation-list">
            {activeCitations.length === 0 ? (
              <div className="empty-state">当前知识库中未找到足够依据。</div>
            ) : (
              activeCitations.map((citation, index) => (
                <CitationCard citation={citation} index={index + 1} key={`${citation.documentId}-${citation.chunkId}-${index}`} />
              ))
            )}
          </div>
        </aside>
      </div>
      </div>
      {confirmArchive && currentSession && (
        <ConfirmDialog
          title="归档会话"
          description={`确认归档“${currentSession.title || '未命名会话'}”？归档后默认不再出现在会话列表中。`}
          confirmLabel="归档"
          busy={updatingSession}
          onCancel={() => setConfirmArchive(false)}
          onConfirm={handleArchiveSession}
        />
      )}
      {confirmDelete && currentSession && (
        <ConfirmDialog
          title="删除会话"
          description={`确认删除“${currentSession.title || '未命名会话'}”？消息会一并删除且不可恢复。`}
          confirmLabel="删除"
          busy={updatingSession}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={handleDeleteSession}
        />
      )}
    </WorkspaceShell>
  );
}

function mergeSession(sessions: ChatSession[], nextSession: ChatSession): ChatSession[] {
  const exists = sessions.some((session) => session.id === nextSession.id);
  if (!exists) {
    return [nextSession, ...sessions];
  }
  return sessions.map((session) => (session.id === nextSession.id ? nextSession : session));
}

function MessageBubble({
  message,
  citationsSelected = false,
  onSelectCitations,
  onRegenerate,
  regenerating = false,
  regenerationDisabled = false,
}: {
  message: ChatMessage;
  citationsSelected?: boolean;
  onSelectCitations?: (messageId: string) => void;
  onRegenerate?: (messageId: string) => void;
  regenerating?: boolean;
  regenerationDisabled?: boolean;
}) {
  const citationSummary =
    message.citations.length > 0
      ? `引用 ${message.citations.length} 条 · 最高 rerankScore ${formatNullableScore(highestRerankScore(message.citations))}`
      : '当前知识库中未找到足够依据。';
  const messageClassName = [
    'message-bubble',
    message.role === 'assistant' ? 'assistant' : 'user',
    message.role === 'assistant' && citationsSelected ? 'is-citation-active' : '',
  ].filter(Boolean).join(' ');

  return (
    <article className={messageClassName}>
      <span className="message-role">{message.role === 'assistant' ? 'Assistant' : 'User'}</span>
      <p>{message.content}</p>
      {message.role === 'assistant' && (
        <button
          aria-controls="chat-citation-list"
          aria-label={`查看回答“${citationLabel(message.content)}”的引用`}
          aria-pressed={citationsSelected}
          className="citation-summary citation-summary-button"
          onClick={() => onSelectCitations?.(message.id)}
          type="button"
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

function CitationCard({ citation, index }: { citation: Citation; index: number }) {
  return (
    <article className="citation-card enhanced-citation-card">
      <header>
        <strong>{index}. {citation.filename}</strong>
        <span>{citation.pageNumber ? `p.${citation.pageNumber}` : '无页码'}</span>
      </header>
      <p>{citation.content}</p>
      <div className="citation-score-grid">
        <span>vector {formatScore(citation.vectorScore)}</span>
        <span>rerank {formatNullableScore(citation.rerankScore)}</span>
      </div>
    </article>
  );
}

function highestRerankScore(citations: Citation[]): number | null {
  const values = citations
    .map((citation) => citation.rerankScore)
    .filter((score): score is number => typeof score === 'number');
  if (values.length === 0) {
    return null;
  }
  return Math.max(...values);
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
