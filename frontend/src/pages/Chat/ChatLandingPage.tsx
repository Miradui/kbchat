import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import {
  listChatSessions,
  listKnowledgeBases,
} from '../../api/resources';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';
import { WorkspaceShell } from '../../components/WorkspaceShell';
import type {
  ChatSession,
  KnowledgeBase,
} from '../../types/api';
import { getErrorMessage } from '../../utils/errors';

export function ChatLandingPage() {
  const knowledgeBaseRequestRef = useRef(0);
  const sessionRequestRef = useRef(0);
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([]);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [knowledgeBaseError, setKnowledgeBaseError] = useState('');
  const [sessionError, setSessionError] = useState('');
  const [knowledgeBasesLoading, setKnowledgeBasesLoading] = useState(true);
  const [sessionsLoading, setSessionsLoading] = useState(true);

  const loadKnowledgeBases = useCallback(async () => {
    const request = ++knowledgeBaseRequestRef.current;
    setKnowledgeBasesLoading(true);
    setKnowledgeBaseError('');
    try {
      const response = await listKnowledgeBases({ pageSize: 100 });
      if (knowledgeBaseRequestRef.current === request) {
        setKnowledgeBases(response.items);
      }
    } catch (err) {
      if (knowledgeBaseRequestRef.current === request) {
        setKnowledgeBaseError(errorMessage(err, '知识库加载失败'));
      }
    } finally {
      if (knowledgeBaseRequestRef.current === request) {
        setKnowledgeBasesLoading(false);
      }
    }
  }, []);

  const loadSessions = useCallback(async () => {
    const request = ++sessionRequestRef.current;
    setSessionsLoading(true);
    setSessionError('');
    try {
      const response = await listChatSessions();
      if (sessionRequestRef.current === request) {
        setSessions(response.items);
      }
    } catch (err) {
      if (sessionRequestRef.current === request) {
        setSessionError(errorMessage(err, '最近会话加载失败'));
      }
    } finally {
      if (sessionRequestRef.current === request) {
        setSessionsLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void loadKnowledgeBases();
    void loadSessions();
    return () => {
      knowledgeBaseRequestRef.current += 1;
      sessionRequestRef.current += 1;
    };
  }, [loadKnowledgeBases, loadSessions]);

  const latestSessionByKnowledgeBase = useMemo(() => {
    const map = new Map<string, ChatSession>();
    for (const session of sessions) {
      const current = map.get(session.knowledgeBaseId);
      if (!current || new Date(session.updatedAt).getTime() > new Date(current.updatedAt).getTime()) {
        map.set(session.knowledgeBaseId, session);
      }
    }
    return map;
  }, [sessions]);

  const recentSessions = useMemo(
    () => [...sessions].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()).slice(0, 6),
    [sessions],
  );

  return (
    <WorkspaceShell active="chat">
      <div className="chat-overview-page">
      <header className="page-header workspace-heading">
        <div>
          <p className="breadcrumb">首页 / 聊天问答</p>
          <h1>聊天问答</h1>
          <p className="page-description">选择知识库继续已有问答，或开始一次新问答。</p>
        </div>
        <Link className="button-link" to="/knowledge-bases">
          新建知识库
        </Link>
      </header>

      <div className="summary-grid">
        <MetricCard label="知识库" value={knowledgeBasesLoading || knowledgeBaseError ? '--' : knowledgeBases.length} />
        <MetricCard label="会话" value={sessionsLoading || sessionError ? '--' : sessions.length} />
        <MetricCard label="可继续会话知识库" value={sessionsLoading || sessionError ? '--' : latestSessionByKnowledgeBase.size} />
      </div>

      <div className="overview-grid">
          <section className="panel">
            <div className="panel-header">
              <h2>按知识库开始</h2>
              <span className="muted-text">继续最近问答或开始新问答</span>
            </div>
            {knowledgeBasesLoading ? (
              <LoadingSkeleton rows={4} columns={2} announce />
            ) : knowledgeBaseError ? (
              <div className="empty-state" role="alert">
                <p>{knowledgeBaseError}</p>
                <button className="secondary-button" type="button" onClick={() => void loadKnowledgeBases()}>
                  重试知识库
                </button>
              </div>
            ) : knowledgeBases.length === 0 ? (
              <div className="empty-state">
                <p>还没有知识库。请先新建知识库，再开始聊天问答。</p>
                <Link className="button-link" to="/knowledge-bases?intent=create">新建知识库</Link>
              </div>
            ) : (
              <div className="kb-launch-list">
                {knowledgeBases.map((knowledgeBase) => {
                const existingSession = latestSessionByKnowledgeBase.get(knowledgeBase.id);
                return (
                  <article
                    aria-label={knowledgeBase.name}
                    className="kb-launch-row"
                    key={knowledgeBase.id}
                  >
                    <span className={`kb-icon ${knowledgeBase.visibility === 'public' ? 'public' : 'private'}`} aria-hidden="true" />
                    <span>
                      <strong>{knowledgeBase.name}</strong>
                      <small>{knowledgeBase.description || '未填写描述'}</small>
                    </span>
                    <span className="kb-launch-actions">
                      {sessionsLoading ? (
                        <span className="muted-text">会话加载中</span>
                      ) : sessionError ? (
                        <span className="muted-text">最近会话不可用</span>
                      ) : existingSession && (
                        <Link className="secondary-link" to={`/chat/${existingSession.id}`}>
                          继续最近会话
                        </Link>
                      )}
                      <Link
                        className={existingSession ? 'link-button' : 'button-link'}
                        to={`/chat/new?knowledgeBaseId=${encodeURIComponent(knowledgeBase.id)}`}
                      >
                        新建问答
                      </Link>
                    </span>
                  </article>
                );
                })}
              </div>
            )}
          </section>

          <section className="panel">
            <div className="panel-header">
              <h2>最近会话</h2>
              <span className="muted-text">{recentSessions.length} 条</span>
            </div>
            <div className="recent-session-list">
              {sessionsLoading ? (
                <LoadingSkeleton rows={4} columns={1} compact announce />
              ) : sessionError ? (
                <div className="empty-state" role="alert">
                  <p>{sessionError}</p>
                  <button className="secondary-button" type="button" onClick={() => void loadSessions()}>
                    重试最近会话
                  </button>
                </div>
              ) : recentSessions.length === 0 ? (
                <div className="empty-state">暂无会话。选择左侧知识库开始。</div>
              ) : (
                recentSessions.map((session) => {
                  const kb = knowledgeBases.find((item) => item.id === session.knowledgeBaseId);
                  return (
                    <Link
                      aria-label={session.title || '未命名会话'}
                      className="recent-session-row"
                      key={session.id}
                      to={`/chat/${session.id}`}
                    >
                      <strong>{session.title || '未命名会话'}</strong>
                      <span>{kb?.name ?? '未知知识库'} · {formatDateTime(session.updatedAt)}</span>
                    </Link>
                  );
                })
              )}
            </div>
          </section>
        </div>
      </div>
    </WorkspaceShell>
  );
}

function MetricCard({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="stat-card">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
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
