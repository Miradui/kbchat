import { Archive, ArchiveRestore, Check, Download, Library, MessageSquareText, PanelLeft, Sparkles, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';

import {
  archiveChatSession,
  deleteChatSession,
  exportChatSession,
  setChatMessageFeedback,
  unarchiveChatSession,
  updateChatSessionTitle,
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
import type { ChatFeedbackRating } from '../../types/api';
import { downloadBlob } from '../../utils/download';
import { formatDateTime } from '../../utils/format';
import { getErrorMessage } from '../../utils/errors';
import { ChatComposer } from './ChatComposer';
import { ChatAssistantLabel, CitationCard, MessageBubble } from './ChatMessage';
import { ChatSessionRail } from './ChatSessionRail';
import type { ChatSessionScope } from './ChatSessionRail';
import { useChatSessions } from './useChatSessions';
import { useChatThread } from './useChatThread';
import { useStreamAnnouncement } from './useStreamAnnouncement';

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
  const [draft, setDraft] = useState('');
  const [focusedCitation, setFocusedCitation] = useState<{ messageId: string; index: number | null } | null>(null);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [sessionActionError, setSessionActionError] = useState('');
  const [sessionBusy, setSessionBusy] = useState(false);
  const [sessionExporting, setSessionExporting] = useState(false);
  const [feedbackSavingIds, setFeedbackSavingIds] = useState<Set<string>>(() => new Set());
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingDraft, setEditingDraft] = useState('');
  const messagesRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const activeSessionIdRef = useRef(sessionId);
  const sessionActionOperationRef = useRef<symbol | null>(null);
  const sessionBusyRef = useRef(false);
  const sessionExportOperationRef = useRef<symbol | null>(null);
  const feedbackOperationsRef = useRef<Map<string, symbol>>(new Map());
  const skipSessionScopeSyncRef = useRef(false);

  const urlKnowledgeBaseId = searchParams.get('knowledgeBaseId') ?? '';
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
    draftKnowledgeBaseId: urlKnowledgeBaseId || knowledgeBases[0]?.id,
    onSessionCreated: (session) => {
      mergeSession(session);
      navigate(`/chat/${session.id}`, { replace: true });
    },
    onSessionsChanged: () => void reloadSessions(),
  });

  const currentSession = sessionId
    ? (
      thread.session?.id === sessionId
        ? thread.session
        : sessions.find((session) => session.id === sessionId) ?? null
    )
    : null;

  const activeKnowledgeBaseId = currentSession?.knowledgeBaseId
    ?? urlKnowledgeBaseId
    ?? '';
  const activeKnowledgeBase = knowledgeBases.find((item) => item.id === activeKnowledgeBaseId);

  // The rail is scoped to the conversation you are in, and that scope is now a
  // server-side filter, so the URL has to carry it. Opening a session from
  // another knowledge base re-points the filter instead of silently disagreeing
  // with the list. See docs/14-frontend-api-gaps.md G1.
  useEffect(() => {
    const sessionKnowledgeBaseId = currentSession?.knowledgeBaseId;
    if (!sessionKnowledgeBaseId || sessionKnowledgeBaseId === urlKnowledgeBaseId) return;
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      next.set('knowledgeBaseId', sessionKnowledgeBaseId);
      return next;
    }, { replace: true });
  }, [currentSession?.knowledgeBaseId, setSearchParams, urlKnowledgeBaseId]);

  useEffect(() => {
    if (!sessionId || !currentSession) return;
    if (skipSessionScopeSyncRef.current) {
      skipSessionScopeSyncRef.current = false;
      return;
    }
    const nextScope: ChatSessionScope = currentSession.archivedAt ? 'archived' : 'active';
    setRailScope((current) => current === nextScope ? current : nextScope);
  }, [currentSession?.archivedAt, currentSession?.id, sessionId]);

  useEffect(() => {
    if (!isNarrow) setRailOpen(false);
  }, [isNarrow]);

  useEffect(() => {
    setDraft('');
    setFocusedCitation(null);
    setEditingMessageId(null);
    setEditingDraft('');
    setConfirmArchive(false);
    setConfirmDelete(false);
    setSessionActionError('');
    sessionActionOperationRef.current = null;
    sessionBusyRef.current = false;
    setSessionBusy(false);
    sessionExportOperationRef.current = null;
    setSessionExporting(false);
    feedbackOperationsRef.current.clear();
    setFeedbackSavingIds(new Set());
    stickToBottomRef.current = true;
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
  }, [searchParams, setSearchParams]);

  useEffect(() => {
    if (!stickToBottomRef.current) return;
    // `auto` while streaming: a smooth scroll per token never settles.
    messagesRef.current?.scrollTo({
      top: messagesRef.current.scrollHeight,
      behavior: thread.streamingAnswer ? 'auto' : 'smooth',
    });
  }, [thread.messages, thread.pendingQuestion, thread.streamingAnswer]);

  const latestAssistantId = useMemo(
    () => [...thread.messages].reverse().find((message) => message.role === 'assistant')?.id ?? null,
    [thread.messages],
  );

  const streamAnnouncement = useStreamAnnouncement({
    sending: thread.sending,
    streamingAnswer: thread.streamingAnswer,
    streamingCitationCount: thread.streamingCitations.length,
    stopped: Boolean(thread.stoppedStream),
    failed: Boolean(thread.failedSend),
  });

  const archived = Boolean(currentSession?.archivedAt);
  const threadInteractionPending = thread.sending
    || Boolean(thread.regeneratingId)
    || Boolean(thread.editingId)
    || Boolean(thread.unconfirmedSend?.checking)
    || Boolean(thread.stoppedStream?.checking)
    || Boolean(thread.regeneration?.checking);
  const interactionLocked = thread.loading || sessionBusy || threadInteractionPending;
  const canSend = Boolean(activeKnowledgeBase)
    && !archived
    && !thread.loading
    && !sessionBusy
    && !thread.editingId
    && !thread.unconfirmedSend
    && (!thread.stoppedStream || thread.stoppedStream.resumable);

  const composerHint = !activeKnowledgeBase
    ? knowledgeBases.length === 0
      ? '还没有知识库。先创建一个知识库并导入文档。'
      : '先在左侧选择一个知识库。'
    : archived
      ? '这个会话已归档，内容仍可查看。'
      : undefined;

  const selectKnowledgeBase = useCallback((knowledgeBaseId: string) => {
    // From a thread, switching knowledge base starts a new draft rather than
    // silently jumping into some other session.
    if (knowledgeBaseId) navigate(`/chat?knowledgeBaseId=${encodeURIComponent(knowledgeBaseId)}`);
    else navigate('/chat');
  }, [navigate]);

  async function runSessionAction(action: () => Promise<void>, failure: string) {
    if (sessionBusyRef.current || thread.hasPendingWrite()) return;
    const operation = Symbol('session-action');
    const operationSessionId = sessionId;
    sessionActionOperationRef.current = operation;
    sessionBusyRef.current = true;
    setSessionBusy(true);
    setSessionActionError('');
    try {
      await action();
    } catch (caught) {
      if (
        sessionActionOperationRef.current === operation
        && activeSessionIdRef.current === operationSessionId
      ) {
        setSessionActionError(getErrorMessage(caught, failure));
      }
    } finally {
      if (sessionActionOperationRef.current === operation) {
        sessionActionOperationRef.current = null;
        sessionBusyRef.current = false;
        setSessionBusy(false);
      }
    }
  }

  async function handleMessageFeedback(messageId: string, rating: ChatFeedbackRating) {
    if (feedbackOperationsRef.current.has(messageId)) return;
    const operation = Symbol('chat-feedback');
    feedbackOperationsRef.current.set(messageId, operation);
    setFeedbackSavingIds((current) => new Set(current).add(messageId));
    try {
      const feedback = await setChatMessageFeedback(messageId, rating);
      if (feedbackOperationsRef.current.get(messageId) !== operation) return;
      thread.updateMessageFeedback(messageId, feedback);
      toast.success(rating === 'positive' ? '已记录“有帮助”' : '已记录“没有帮助”');
    } catch (caught) {
      if (feedbackOperationsRef.current.get(messageId) === operation) {
        toast.error(getErrorMessage(caught, '回答反馈保存失败'));
      }
    } finally {
      if (feedbackOperationsRef.current.get(messageId) === operation) {
        feedbackOperationsRef.current.delete(messageId);
        setFeedbackSavingIds((current) => {
          const next = new Set(current);
          next.delete(messageId);
          return next;
        });
      }
    }
  }

  async function handleSessionExport() {
    if (
      !currentSession
      || sessionExportOperationRef.current
      || sessionBusyRef.current
      || thread.hasPendingWrite()
    ) return;
    const targetSession = currentSession;
    const operation = Symbol('chat-session-export');
    sessionExportOperationRef.current = operation;
    setSessionExporting(true);
    setSessionActionError('');
    try {
      const blob = await exportChatSession(targetSession.id);
      if (sessionExportOperationRef.current !== operation) return;
      downloadBlob(blob, chatExportFilename(targetSession.title));
      toast.success('会话已导出');
    } catch (caught) {
      if (sessionExportOperationRef.current === operation) {
        setSessionActionError(getErrorMessage(caught, '会话导出失败'));
      }
    } finally {
      if (sessionExportOperationRef.current === operation) {
        sessionExportOperationRef.current = null;
        setSessionExporting(false);
      }
    }
  }

  const topbarActions = currentSession ? (
    <OverflowMenu
      disabled={interactionLocked || sessionExporting}
      label="会话操作"
      items={[
        archived
          ? {
            label: '取消归档',
            icon: <ArchiveRestore aria-hidden="true" />,
            onSelect: () => void runSessionAction(async () => {
              const target = currentSession;
              const restored = await unarchiveChatSession(target.id);
              removeSession(target.id);
              if (activeSessionIdRef.current === target.id) {
                skipSessionScopeSyncRef.current = true;
                thread.setSession(restored);
                void reloadSessions();
              }
              // The rail only holds one scope at a time, so refetch instead of
              // guessing which list the session now belongs to.
              toast.success('会话已取消归档');
            }, '取消归档失败'),
          }
          : {
            label: '归档会话',
            icon: <Archive aria-hidden="true" />,
            onSelect: () => {
              if (sessionBusyRef.current || thread.hasPendingWrite()) return;
              setSessionActionError('');
              setConfirmArchive(true);
            },
          },
        {
          label: '导出会话',
          icon: <Download aria-hidden="true" />,
          onSelect: () => void handleSessionExport(),
        },
        {
          label: '删除会话',
          icon: <Trash2 aria-hidden="true" />,
          tone: 'danger',
          onSelect: () => {
            if (sessionBusyRef.current || thread.hasPendingWrite()) return;
            setSessionActionError('');
            setConfirmDelete(true);
          },
        },
      ]}
    />
  ) : undefined;

  return (
    <AppShell
      active="chat"
      breadcrumbs={[
        { label: 'AI 问答', to: '/chat' },
        ...(activeKnowledgeBase ? [{ label: activeKnowledgeBase.name }] : []),
      ]}
      flush
      topbarActions={topbarActions}
    >
      <div className={railOpen ? 'chat-layout is-rail-open' : 'chat-layout'}>
        {isNarrow && railOpen && (
          <button aria-hidden="true" className="chat-layout__scrim" onClick={() => setRailOpen(false)} tabIndex={-1} type="button" />
        )}

        <ChatSessionRail
          activeSessionId={sessionId}
          disabled={interactionLocked}
          error={sessionStore.sessionsError}
          knowledgeBaseId={activeKnowledgeBaseId}
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
            selectKnowledgeBase(activeKnowledgeBaseId);
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
                  onSubmit={(title) => void runSessionAction(async () => {
                    const target = currentSession;
                    const updated = await updateChatSessionTitle(target.id, title);
                    mergeSession(updated);
                    if (activeSessionIdRef.current === target.id) thread.setSession(updated);
                  }, '会话标题更新失败')}
                  value={currentSession.title || ''}
                />
              ) : (
                <span className="chat-main__title-text">新对话</span>
              )}
              {archived && currentSession?.archivedAt && (
                <Badge tone="neutral">已归档 {formatDateTime(currentSession.archivedAt)}</Badge>
              )}
            </div>
            {activeKnowledgeBase && (
              <Link className="chat-main__kb" to={`/knowledge-bases/${activeKnowledgeBase.id}`}>
                <Library aria-hidden="true" />
                <span className="ui-truncate">{activeKnowledgeBase.name}</span>
              </Link>
            )}
          </header>

          {/*
            The one polite region for answer progress. Permanently mounted and outside
            every conditional below, because a live region that appears together with
            its text is announced unreliably -- what has to change is the contents, not
            the region. See useStreamAnnouncement for what it is allowed to say.
          */}
          <p aria-live="polite" className="sr-only" role="status">{streamAnnouncement}</p>

          {sessionActionError && <p className="ui-inline-error" role="alert">{sessionActionError}</p>}
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
                  onSelect={selectKnowledgeBase}
                  selectedId={activeKnowledgeBaseId}
                />
              )
            ) : (
              <>
                {thread.messages.map((message) => (
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
                    key={message.id}
                    knowledgeBaseId={activeKnowledgeBaseId || undefined}
                    message={message}
                    editDraft={editingDraft}
                    editing={editingMessageId === message.id}
                    editSaving={thread.editingId === message.id}
                    feedbackSaving={feedbackSavingIds.has(message.id)}
                    onFeedback={(messageId, rating) => void handleMessageFeedback(messageId, rating)}
                    onEditDraftChange={setEditingDraft}
                    onStartEdit={(messageId, content) => {
                      if (archived || interactionLocked || thread.editingId || message.role !== 'user') return;
                      setEditingMessageId(messageId);
                      setEditingDraft(content);
                    }}
                    onCancelEdit={() => {
                      if (thread.editingId) return;
                      setEditingMessageId(null);
                      setEditingDraft('');
                    }}
                    onSubmitEdit={(messageId, content) => {
                      if (archived || interactionLocked || thread.editingId || !content.trim()) return;
                      void thread.editMessage(messageId, content).then(() => {
                        if (activeSessionIdRef.current === sessionId && editingMessageId === messageId) {
                          setEditingMessageId(null);
                          setEditingDraft('');
                          toast.success('消息已更新并重新生成');
                        }
                      }).catch((caught) => {
                        toast.error(getErrorMessage(caught, '消息更新失败，请稍后重试'));
                      });
                    }}
                    onFocusCitation={(messageId, index) => setFocusedCitation({ messageId, index })}
                    onRegenerate={(id) => {
                      if (!sessionBusyRef.current) void thread.regenerate(id);
                    }}
                    recovery={
                      thread.regeneration?.messageId === message.id
                        ? (
                          <RegenerationNotice
                            allowWrite={!archived}
                            blocked={sessionBusy}
                            onCheck={() => {
                              if (!sessionBusyRef.current) void thread.checkRegeneration();
                            }}
                            onRegenerate={(messageId) => {
                              if (!sessionBusyRef.current) void thread.regenerate(messageId);
                            }}
                            thread={thread}
                          />
                        )
                        : undefined
                    }
                    regenerating={thread.regeneratingId === message.id}
                  />
                ))}

                {(thread.pendingQuestion || thread.streamingAnswer || thread.streamingCitations.length > 0) && (
                  <>
                    {thread.pendingQuestion && (
                      <article className="chat-msg chat-msg--user is-pending">
                        <div className="chat-msg__body"><p className="chat-msg__content">{thread.pendingQuestion}</p></div>
                      </article>
                    )}
                    <article className="chat-msg chat-msg--assistant is-pending">
                      <div className="chat-msg__body">
                        <ChatAssistantLabel />
                        {/*
                          Once the first token lands the answer replaces the
                          skeleton, so the wait is only unexplained for as long
                          as retrieval actually takes.
                          See docs/14-frontend-api-gaps.md G2.
                        */}
                        {thread.streamingAnswer ? (
                          <p className="chat-msg__content">
                            {thread.streamingAnswer}
                            <span aria-hidden="true" className="chat-msg__caret" />
                          </p>
                        ) : (
                          <>
                            {/* Visible text only. This element unmounts as soon as the
                                first token lands, so it cannot be the live region -- the
                                permanent one near the top of the page announces phases. */}
                            <p className="chat-msg__content">
                              {thread.streamingCitations.length > 0
                                ? '正在生成回答…'
                                : '正在检索知识库并生成回答…'}
                            </p>
                            <LoadingSkeleton columns={1} compact rows={2} />
                          </>
                        )}
                        {thread.streamingCitations.length > 0 && (
                          <div aria-label="本轮引用来源" className="chat-sources chat-sources--streaming" role="group">
                            {thread.streamingCitations.map((citation, index) => (
                              <CitationCard
                                citation={citation}
                                focused={false}
                                index={index + 1}
                                key={`${citation.documentId}-${citation.chunkId}-${index}`}
                                knowledgeBaseId={activeKnowledgeBaseId || undefined}
                              />
                            ))}
                          </div>
                        )}
                      </div>
                    </article>
                  </>
                )}

                {thread.stoppedStream && (
                  <>
                    <article className="chat-msg chat-msg--user is-pending">
                      <div className="chat-msg__body"><p className="chat-msg__content">{thread.stoppedStream.question}</p></div>
                    </article>
                    <article className="chat-msg chat-msg--assistant is-pending">
                      <div className="chat-msg__body">
                        <ChatAssistantLabel />
                        <p className="chat-msg__content">
                          {thread.stoppedStream.answer || '已停止生成。'}
                        </p>
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
                                focused={false}
                                index={index + 1}
                                key={`${citation.documentId}-${citation.chunkId}-${index}`}
                                knowledgeBaseId={activeKnowledgeBaseId || undefined}
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
            hint={composerHint}
            onCancel={thread.cancelSend}
            onChange={setDraft}
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
            placeholder={activeKnowledgeBase ? `向「${activeKnowledgeBase.name}」提问…` : '选择知识库后开始提问…'}
            sending={thread.sending}
            value={draft}
          />
        </section>
      </div>

      {confirmArchive && currentSession && (
        <ConfirmDialog
          busy={sessionBusy}
          confirmLabel="归档"
          description={`归档后“${currentSession.title || '未命名会话'}”默认不再出现在会话列表中，内容仍可通过链接查看。`}
          error={sessionActionError}
          onCancel={() => {
            setSessionActionError('');
            setConfirmArchive(false);
          }}
          onConfirm={() => void runSessionAction(async () => {
            const target = currentSession;
            const archivedSession = await archiveChatSession(target.id);
            removeSession(target.id);
            if (activeSessionIdRef.current === target.id) {
              skipSessionScopeSyncRef.current = true;
              thread.setSession(archivedSession);
            }
            setConfirmArchive(false);
            toast.success('会话已归档');
          }, '会话归档失败')}
          title="归档会话"
        />
      )}

      {confirmDelete && currentSession && (
        <ConfirmDialog
          busy={sessionBusy}
          confirmLabel="删除"
          description={`确认删除“${currentSession.title || '未命名会话'}”？会话和消息将移入回收站，可在永久删除前恢复。`}
          error={sessionActionError}
          onCancel={() => {
            setSessionActionError('');
            setConfirmDelete(false);
          }}
          onConfirm={() => void runSessionAction(async () => {
            const target = currentSession;
            await deleteChatSession(target.id);
            removeSession(target.id);
            setConfirmDelete(false);
            toast.success('会话已删除');
            if (activeSessionIdRef.current === target.id) navigate('/chat', { replace: true });
          }, '会话删除失败')}
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
  selectedId,
  onSelect,
}: {
  knowledgeBases: Array<{ id: string; name: string; description: string }>;
  loading: boolean;
  selectedId: string;
  onSelect: (id: string) => void;
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
      <h2>选择一个知识库开始提问</h2>
      <p>回答只依据所选知识库中的文档，并在下方标注来源。</p>
      <div aria-label="可提问的知识库" className="chat-launcher__list">
        {knowledgeBases.map((knowledgeBase) => (
          <button
            aria-pressed={selectedId === knowledgeBase.id}
            className={selectedId === knowledgeBase.id ? 'chat-launcher__item is-selected' : 'chat-launcher__item'}
            key={knowledgeBase.id}
            onClick={() => onSelect(knowledgeBase.id)}
            type="button"
          >
            <Library aria-hidden="true" />
            <span className="ui-cell-stack">
              <strong>{knowledgeBase.name}</strong>
              <small>{knowledgeBase.description || '未填写描述'}</small>
            </span>
            {selectedId === knowledgeBase.id && <Check aria-hidden="true" className="chat-launcher__selected" />}
          </button>
        ))}
      </div>
      <p className="chat-launcher__hint">{selectedId ? '已选择知识库，在下方输入你的第一个问题。' : '选择知识库后即可开始，历史会话保存在左侧。'}</p>
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

function chatExportFilename(title: string): string {
  const safeTitle = title
    .trim()
    .replace(/\.md$/i, '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .slice(0, 80)
    .trim();
  return `${safeTitle || '会话记录'}.md`;
}
