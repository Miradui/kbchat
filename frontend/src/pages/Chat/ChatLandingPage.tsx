import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import {
  getWorkspacePreference,
  listChatSessions,
  listKnowledgeBaseCategories,
  listKnowledgeBases,
} from '../../api/resources';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';
import { WorkspaceShell } from '../../components/WorkspaceShell';
import type {
  ChatSession,
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

export function ChatLandingPage() {
  const navigate = useNavigate();
  const [categories, setCategories] = useState<KnowledgeBaseCategory[]>([]);
  const [expandedIds, setExpandedIds] = useState<string[]>([]);
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([]);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;

    Promise.all([
      listKnowledgeBases({ pageSize: 100 }),
      listChatSessions(),
      listKnowledgeBaseCategories().catch(() => ({ items: [] })),
      getWorkspacePreference().catch(() => fallbackPreference),
    ])
      .then(([kbResponse, sessionResponse, categoryResponse, preference]) => {
        if (mounted) {
          setKnowledgeBases(kbResponse.items);
          setSessions(sessionResponse.items);
          setCategories(categoryResponse.items);
          setExpandedIds(preference.expandedCategoryIds);
        }
      })
      .catch((err) => {
        if (mounted) {
          setError(errorMessage(err, '聊天入口加载失败'));
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

  function enterKnowledgeBase(knowledgeBase: KnowledgeBase) {
    const existingSession = latestSessionByKnowledgeBase.get(knowledgeBase.id);
    if (existingSession) {
      navigate(`/chat/${existingSession.id}`);
      return;
    }
    navigate(`/chat/new?knowledgeBaseId=${encodeURIComponent(knowledgeBase.id)}`);
  }

  return (
    <WorkspaceShell active="chat" categories={categories} expandedIds={expandedIds}>
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
        <MetricCard label="知识库" value={knowledgeBases.length} />
        <MetricCard label="会话" value={sessions.length} />
        <MetricCard label="可继续会话知识库" value={latestSessionByKnowledgeBase.size} />
      </div>

      {loading ? (
        <div className="panel">
          <LoadingSkeleton rows={4} columns={3} />
        </div>
      ) : error ? (
        <div className="empty-state">{error}</div>
      ) : knowledgeBases.length === 0 ? (
        <div className="empty-state">还没有知识库。请先新建知识库，再开始聊天问答。</div>
      ) : (
        <div className="overview-grid">
          <section className="panel">
            <div className="panel-header">
              <h2>按知识库开始</h2>
              <span className="muted-text">继续最近问答或开始新问答</span>
            </div>
            <div className="kb-launch-list">
              {knowledgeBases.map((knowledgeBase) => {
                const existingSession = latestSessionByKnowledgeBase.get(knowledgeBase.id);
                return (
                  <button
                    className="kb-launch-row"
                    key={knowledgeBase.id}
                    type="button"
                    onClick={() => enterKnowledgeBase(knowledgeBase)}
                  >
                    <span className={`kb-icon ${knowledgeBase.visibility === 'public' ? 'public' : 'private'}`} aria-hidden="true" />
                    <span>
                      <strong>{knowledgeBase.name}</strong>
                      <small>{knowledgeBase.description || '未填写描述'}</small>
                    </span>
                    <em>
                      {existingSession ? '进入最近会话' : '开始新问答'}
                    </em>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="panel">
            <div className="panel-header">
              <h2>最近会话</h2>
              <span className="muted-text">{recentSessions.length} 条</span>
            </div>
            <div className="recent-session-list">
              {recentSessions.length === 0 ? (
                <div className="empty-state">暂无会话。选择左侧知识库开始。</div>
              ) : (
                recentSessions.map((session) => {
                  const kb = knowledgeBases.find((item) => item.id === session.knowledgeBaseId);
                  return (
                    <Link className="recent-session-row" key={session.id} to={`/chat/${session.id}`}>
                      <strong>{session.title || '未命名会话'}</strong>
                      <span>{kb?.name ?? '未知知识库'} · {formatDateTime(session.updatedAt)}</span>
                    </Link>
                  );
                })
              )}
            </div>
          </section>
        </div>
      )}
      </div>
    </WorkspaceShell>
  );
}

function MetricCard({ label, value }: { label: string; value: number }) {
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
