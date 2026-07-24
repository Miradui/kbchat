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
  sendChatMessage,
  updateChatSessionTitle,
} from '../../api/resources';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';
import { WorkspaceShell } from '../../components/WorkspaceShell';
import type {
  ChatMessage,
  ChatSession,
  Citation,
  KnowledgeBase,
  KnowledgeBaseCategory,
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
  const [categories, setCategories] = useState<KnowledgeBaseCategory[]>([]);
  const [expandedIds, setExpandedIds] = useState<string[]>([]);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [currentSessionDetail, setCurrentSessionDetail] = useState<ChatSession | null>(null);
  const [draft, setDraft] = useState('');
  const [titleDraft, setTitleDraft] = useState('');
  const [pendingQuestion, setPendingQuestion] = useState('');
  const [failedQuestion, setFailedQuestion] = useState('');
  const [loading, setLoading] = useState(true);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [checkingSendResult, setCheckingSendResult] = useState(false);
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
    if (!sessionId || isDraftSession) {
      setCurrentSessionDetail(null);
      setTitleDraft('');
      setMessages([]);
      setFailedQuestion('');
      setUncertainSend(null);
      setMessagesLoading(false);
      return;
    }

    let mounted = true;
    setError('');
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

  const activeCitations = useMemo(() => {
    const lastAssistant = [...messages]
      .reverse()
      .find((message) => message.role === 'assistant');
    return lastAssistant?.citations ?? [];
  }, [messages]);

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
    if (!question || sending || !canSend || (uncertainSend && !confirmedResend)) {
      return;
    }

    setSending(true);
    setError('');
    setFailedQuestion('');
    setUncertainSend(null);
    setPendingQuestion(question);

    let activeSessionId = sessionId as string;
    let messageRequestStarted = false;
    try {
      if (isDraftSession) {
        if (!currentKnowledgeBase) {
          throw new Error('知识库不存在');
        }
        const session = await createChatSession(currentKnowledgeBase.id, '');
        activeSessionId = session.id;
        setCurrentSessionDetail(session);
        setSessions((current) => mergeSession(current, session));
        navigate(`/chat/${session.id}`, { replace: true });
      }

      messageRequestStarted = true;
      await sendChatMessage(activeSessionId, question);
    } catch (err) {
      setDraft(question);
      if (err instanceof ApiError) {
        setError(errorMessage(err, '消息发送失败，请稍后重试。'));
        setFailedQuestion(question);
      } else if (messageRequestStarted) {
        setError('发送结果暂时无法确认。请先再次检查；如仍未显示，再确认是否重新发送。');
        setUncertainSend({
          sessionId: activeSessionId,
          question,
          previousMessageCount: messages.length,
        });
      } else {
        setError('会话创建结果暂时无法确认，请刷新会话列表后再试。');
      }
      setSending(false);
      setPendingQuestion('');
      return;
    }

    setDraft('');
    setFailedQuestion('');
    try {
      const [messageResponse] = await Promise.all([listChatMessages(activeSessionId), reloadSessions()]);
      setMessages(messageResponse.items);
    } catch (err) {
      setError('问题已发送，但消息列表刷新失败，请刷新页面查看。');
    } finally {
      setSending(false);
      setPendingQuestion('');
    }
  }

  async function handleCheckSendResult() {
    if (!uncertainSend || checkingSendResult) {
      return;
    }

    setCheckingSendResult(true);
    try {
      const response = await listChatMessages(uncertainSend.sessionId);
      setMessages(response.items);
      const submittedMessageExists = response.items
        .slice(uncertainSend.previousMessageCount)
        .some((message) => message.role === 'user' && message.content === uncertainSend.question);
      if (submittedMessageExists) {
        setDraft('');
        setError('');
        setUncertainSend(null);
        void reloadSessions().catch(() => undefined);
      } else {
        setError('暂未发现这条问题。你可以稍后再次检查，或确认重新发送。');
      }
    } catch {
      setError('暂时无法检查发送结果，请稍后再次检查。');
    } finally {
      setCheckingSendResult(false);
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submitQuestion(draft.trim());
  }

  return (
    <WorkspaceShell active="chat" categories={categories} expandedIds={expandedIds}>
      <div className="chat-workspace-page">
      <header className="page-header workspace-heading chat-workspace-header">
        <div>
          <p className="breadcrumb">知识库 / {currentKnowledgeBase?.name ?? '问答'} / 聊天</p>
          <h1>聊天问答</h1>
          <p className="page-description">围绕当前知识库提问，有依据时会在回答旁展示来源。</p>
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
              disabled={sending || !draft.trim()}
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
                disabled={checkingSendResult}
              >
                {checkingSendResult ? '检查中...' : '再次检查'}
              </button>
              <button
                className="link-button"
                type="button"
                onClick={() => void submitQuestion(draft.trim(), true)}
                disabled={sending || !draft.trim()}
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
                  : '回答会根据当前知识库内容生成，并在有依据时展示来源。'}
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
                <MessageBubble message={message} key={message.id} />
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
              disabled={sending || !canSend}
              rows={2}
            />
            <button type="submit" disabled={sending || !draft.trim() || !canSend || Boolean(uncertainSend)}>
              {sending ? '发送中...' : '发送'}
            </button>
          </form>
        </section>

        <aside className="citation-panel chat-citation-panel">
          <div>
            <h2>引用来源</h2>
            <p className="muted-text">回答有依据时会在这里列出来源。</p>
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

function MessageBubble({ message }: { message: ChatMessage }) {
  const citationSummary =
    message.citations.length > 0
      ? `引用 ${message.citations.length} 条`
      : '当前知识库中未找到足够依据。';

  return (
    <article className={message.role === 'assistant' ? 'message-bubble assistant' : 'message-bubble user'}>
      <span className="message-role">{message.role === 'assistant' ? '助手' : '用户'}</span>
      <p>{message.content}</p>
      {message.role === 'assistant' && <div className="citation-summary">{citationSummary}</div>}
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
