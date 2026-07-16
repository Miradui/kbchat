import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

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

const fallbackPreference: KnowledgeBaseWorkspacePreference = {
  viewMode: 'table',
  scope: 'all',
  sort: 'updatedAt_desc',
  visibility: 'all',
  expandedCategoryIds: [],
};

export function ChatPage() {
  const { sessionId } = useParams();
  const navigate = useNavigate();
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const activeSessionIdRef = useRef(sessionId);
  const messageOperationIdRef = useRef(0);
  const messageOperationInFlightRef = useRef(false);
  activeSessionIdRef.current = sessionId;
  const [categories, setCategories] = useState<KnowledgeBaseCategory[]>([]);
  const [expandedIds, setExpandedIds] = useState<string[]>([]);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [currentSessionDetail, setCurrentSessionDetail] = useState<ChatSession | null>(null);
  const [draft, setDraft] = useState('');
  const [titleDraft, setTitleDraft] = useState('');
  const [pendingQuestion, setPendingQuestion] = useState('');
  const [loading, setLoading] = useState(true);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [regeneratingMessageId, setRegeneratingMessageId] = useState<string | null>(null);
  const [rerankFallback, setRerankFallback] = useState<KnowledgeBaseRerankFallback | null>(null);
  const [creatingSession, setCreatingSession] = useState(false);
  const [updatingSession, setUpdatingSession] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState('');

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
    messageOperationIdRef.current += 1;
    messageOperationInFlightRef.current = false;
    setSending(false);
    setPendingQuestion('');
    setRegeneratingMessageId(null);

    if (!sessionId) {
      return;
    }

    let mounted = true;
    setError('');
    setMessagesLoading(true);
    setRerankFallback(null);

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
  }, [sessionId]);

  useEffect(() => {
    messagesRef.current?.scrollTo({
      top: messagesRef.current.scrollHeight,
      behavior: 'smooth',
    });
  }, [messages, pendingQuestion]);

  const currentSession = currentSessionDetail ?? sessions.find((session) => session.id === sessionId) ?? null;
  const currentKnowledgeBase = knowledgeBases.find(
    (kb) => kb.id === currentSession?.knowledgeBaseId,
  );
  const sessionsForCurrentKnowledgeBase = useMemo(() => {
    if (!currentKnowledgeBase) {
      return sessions;
    }
    return sessions.filter((session) => session.knowledgeBaseId === currentKnowledgeBase.id);
  }, [currentKnowledgeBase, sessions]);

  const activeCitations = useMemo(() => {
    const lastAssistant = [...messages]
      .reverse()
      .find((message) => message.role === 'assistant');
    return lastAssistant?.citations ?? [];
  }, [messages]);
  const latestAssistantMessageId = useMemo(
    () => [...messages].reverse().find((message) => message.role === 'assistant')?.id ?? null,
    [messages],
  );

  const questionCount = messages.filter((message) => message.role === 'user').length;
  const citationCount = messages.reduce((sum, message) => sum + message.citations.length, 0);
  const archived = Boolean(currentSession?.archivedAt);

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

  async function handleCreateSession(knowledgeBaseId = currentKnowledgeBase?.id) {
    const targetKnowledgeBase =
      knowledgeBases.find((knowledgeBase) => knowledgeBase.id === knowledgeBaseId) ?? knowledgeBases[0];
    if (!targetKnowledgeBase) {
      setError('请先创建知识库，再开始新的问答会话。');
      return;
    }

    setCreatingSession(true);
    setError('');

    try {
      const session = await createChatSession(targetKnowledgeBase.id, `${targetKnowledgeBase.name} 问答`);
      await reloadSessions();
      navigate(`/chat/${session.id}`);
    } catch (err) {
      setError(errorMessage(err, '新建会话失败'));
    } finally {
      setCreatingSession(false);
    }
  }

  async function handleKnowledgeBaseChange(knowledgeBaseId: string) {
    const targetSessions = sessions
      .filter((session) => session.knowledgeBaseId === knowledgeBaseId)
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    if (targetSessions[0]) {
      navigate(`/chat/${targetSessions[0].id}`);
      return;
    }

    await handleCreateSession(knowledgeBaseId);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!sessionId || !draft.trim() || archived || messageOperationInFlightRef.current) {
      return;
    }

    const targetSessionId = sessionId;
    const operationId = messageOperationIdRef.current + 1;
    messageOperationIdRef.current = operationId;
    messageOperationInFlightRef.current = true;
    setSending(true);
    setError('');
    setRerankFallback(null);
    const question = draft.trim();
    setDraft('');
    setPendingQuestion(question);

    try {
      const response = await sendChatMessage(targetSessionId, question);
      if (!isCurrentMessageOperation(operationId, targetSessionId)) {
        return;
      }
      setRerankFallback(response.rerankFallback?.used ? response.rerankFallback : null);
      const [messageResponse, sessionResponse] = await Promise.all([
        listChatMessages(targetSessionId),
        listChatSessions(),
      ]);
      if (!isCurrentMessageOperation(operationId, targetSessionId)) {
        return;
      }
      setMessages(messageResponse.items);
      setSessions(sessionResponse.items);
    } catch (err) {
      if (isCurrentMessageOperation(operationId, targetSessionId)) {
        setError(errorMessage(err, '消息发送失败'));
      }
    } finally {
      if (isCurrentMessageOperation(operationId, targetSessionId)) {
        messageOperationInFlightRef.current = false;
        setSending(false);
        setPendingQuestion('');
      }
    }
  }

  async function handleRegenerateMessage(messageId: string) {
    if (!sessionId || messageOperationInFlightRef.current) {
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
          <button type="button" onClick={() => void handleCreateSession()} disabled={creatingSession}>
            {creatingSession ? '创建中...' : '新建会话'}
          </button>
        </div>
      </header>

      {error && <p className="error-text">{error}</p>}

      <div className="chat-shell">
        <aside className="chat-sidebar-panel">
          <label className="field-label">
            当前知识库
            <select
              value={currentKnowledgeBase?.id ?? ''}
              disabled={creatingSession || knowledgeBases.length === 0}
              onChange={(event) => void handleKnowledgeBaseChange(event.target.value)}
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

          <button type="button" onClick={() => void handleCreateSession()} disabled={creatingSession}>
            {creatingSession ? '创建中...' : '新建当前知识库会话'}
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
                  onRegenerate={message.id === latestAssistantMessageId && !archived ? handleRegenerateMessage : undefined}
                  regenerating={regeneratingMessageId === message.id}
                  regenerationDisabled={sending || regeneratingMessageId !== null}
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
              disabled={sending || regeneratingMessageId !== null || !sessionId || archived}
              rows={2}
            />
            <button type="submit" disabled={sending || regeneratingMessageId !== null || !draft.trim() || !sessionId || archived}>
              {sending ? '发送中...' : '发送'}
            </button>
          </form>
        </section>

        <aside className="citation-panel chat-citation-panel">
          <div>
            <h2>引用来源</h2>
            <p className="muted-text">仅展示后端返回的 citations。</p>
          </div>

          <div className="citation-list">
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
  onRegenerate,
  regenerating = false,
  regenerationDisabled = false,
}: {
  message: ChatMessage;
  onRegenerate?: (messageId: string) => void;
  regenerating?: boolean;
  regenerationDisabled?: boolean;
}) {
  const citationSummary =
    message.citations.length > 0
      ? `引用 ${message.citations.length} 条 · 最高 rerankScore ${formatNullableScore(highestRerankScore(message.citations))}`
      : '当前知识库中未找到足够依据。';

  return (
    <article className={message.role === 'assistant' ? 'message-bubble assistant' : 'message-bubble user'}>
      <span className="message-role">{message.role === 'assistant' ? 'Assistant' : 'User'}</span>
      <p>{message.content}</p>
      {message.role === 'assistant' && <div className="citation-summary">{citationSummary}</div>}
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
  if (err instanceof ApiError) {
    return err.message;
  }
  return fallback;
}
