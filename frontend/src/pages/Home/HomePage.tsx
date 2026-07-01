import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { ApiError } from '../../api/client';
import {
  getKnowledgeBaseStats,
  getWorkspacePreference,
  listChatSessions,
  listGlobalDocuments,
  listKnowledgeBaseCategories,
  listKnowledgeBases,
} from '../../api/resources';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';
import { WorkspaceShell } from '../../components/WorkspaceShell';
import type {
  ChatSession,
  GlobalDocumentItem,
  KnowledgeBase,
  KnowledgeBaseCategory,
  KnowledgeBaseStatsResponse,
  KnowledgeBaseWorkspacePreference,
} from '../../types/api';

const fallbackPreference: KnowledgeBaseWorkspacePreference = {
  viewMode: 'table',
  scope: 'all',
  sort: 'updatedAt_desc',
  visibility: 'all',
  expandedCategoryIds: [],
};

export function HomePage() {
  const [categories, setCategories] = useState<KnowledgeBaseCategory[]>([]);
  const [expandedIds, setExpandedIds] = useState<string[]>([]);
  const [stats, setStats] = useState<KnowledgeBaseStatsResponse | null>(null);
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([]);
  const [documents, setDocuments] = useState<GlobalDocumentItem[]>([]);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let mounted = true;

    Promise.all([
      listKnowledgeBaseCategories().catch(() => ({ items: [] })),
      getWorkspacePreference().catch(() => fallbackPreference),
      getKnowledgeBaseStats('month'),
      listKnowledgeBases({ sort: 'updatedAt_desc', pageSize: 5 }),
      listGlobalDocuments({ sort: 'updatedAt_desc', pageSize: 5 }),
      listChatSessions(),
    ])
      .then(([
        categoryResponse,
        preference,
        statsResponse,
        kbResponse,
        documentResponse,
        sessionResponse,
      ]) => {
        if (!mounted) {
          return;
        }
        setCategories(categoryResponse.items);
        setExpandedIds(preference.expandedCategoryIds);
        setStats(statsResponse);
        setKnowledgeBases(kbResponse.items);
        setDocuments(documentResponse.items);
        setSessions(sessionResponse.items);
      })
      .catch((err) => {
        if (mounted) {
          setError(errorMessage(err, '首页数据加载失败'));
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

  const recentSessions = useMemo(
    () => [...sessions].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()).slice(0, 5),
    [sessions],
  );

  return (
    <WorkspaceShell active="home" categories={categories} expandedIds={expandedIds}>
      <div className="home-dashboard-page">
        <header className="page-header workspace-heading">
          <div>
            <h1>工作台首页</h1>
            <p className="page-description">查看知识资产概览，并进入知识库、文档处理和问答管理。</p>
          </div>
          <div className="toolbar">
            <Link className="secondary-link" to="/search">全局搜索</Link>
            <Link className="button-link" to="/knowledge-bases">管理知识库</Link>
          </div>
        </header>

        {error && <p className="error-text">{error}</p>}

        {loading ? (
          <div className="panel">
            <LoadingSkeleton rows={5} columns={4} />
          </div>
        ) : (
          <>
            <div className="summary-grid detail-summary">
              <MetricCard label="知识库" value={stats?.knowledgeBases.value ?? knowledgeBases.length} />
              <MetricCard label="文档" value={stats?.documents.value ?? documents.length} />
              <MetricCard label="浏览量" value={stats?.views.value ?? 0} />
              <MetricCard label="问答" value={stats?.questions.value ?? sessions.length} />
            </div>

            <section className="home-action-grid" aria-label="快捷入口">
              <HomeActionCard title="知识库管理" description="创建、筛选、收藏和维护知识库。" to="/knowledge-bases" />
              <HomeActionCard title="文档管理" description="跨知识库查看处理状态并上传文档。" to="/documents" />
              <HomeActionCard title="问答管理" description="进入知识库会话并查看引用来源。" to="/chat" />
              <HomeActionCard title="标签管理" description="维护知识库可绑定的标签。" to="/tags" />
            </section>

            <div className="home-overview-grid">
              <section className="panel">
                <div className="panel-header">
                  <h2>最近知识库</h2>
                  <Link className="link-button" to="/knowledge-bases">查看全部</Link>
                </div>
                <div className="home-list">
                  {knowledgeBases.length === 0 ? (
                    <div className="empty-state">还没有知识库。</div>
                  ) : (
                    knowledgeBases.map((item) => (
                      <Link className="home-list-row" key={item.id} to={`/knowledge-bases/${item.id}`}>
                        <span className={`kb-icon ${item.visibility === 'public' ? 'public' : 'private'}`} aria-hidden="true" />
                        <span>
                          <strong>{item.name}</strong>
                          <small>{item.description || '未填写描述'} · {formatDateTime(item.updatedAt || item.createdAt)}</small>
                        </span>
                      </Link>
                    ))
                  )}
                </div>
              </section>

              <section className="panel">
                <div className="panel-header">
                  <h2>最近文档</h2>
                  <Link className="link-button" to="/documents">查看全部</Link>
                </div>
                <div className="home-list">
                  {documents.length === 0 ? (
                    <div className="empty-state">还没有文档。</div>
                  ) : (
                    documents.map((document) => (
                      <Link className="home-list-row" key={document.id} to={`/knowledge-bases/${document.knowledgeBaseId}/documents`}>
                        <span className="document-file-icon" aria-hidden="true" />
                        <span>
                          <strong>{document.filename}</strong>
                          <small>{document.knowledgeBaseName} · {document.status}</small>
                        </span>
                      </Link>
                    ))
                  )}
                </div>
              </section>

              <section className="panel">
                <div className="panel-header">
                  <h2>最近会话</h2>
                  <Link className="link-button" to="/chat">查看全部</Link>
                </div>
                <div className="home-list">
                  {recentSessions.length === 0 ? (
                    <div className="empty-state">还没有问答会话。</div>
                  ) : (
                    recentSessions.map((session) => (
                      <Link className="home-list-row simple" key={session.id} to={`/chat/${session.id}`}>
                        <strong>{session.title || '未命名会话'}</strong>
                        <small>{formatDateTime(session.updatedAt || session.createdAt)}</small>
                      </Link>
                    ))
                  )}
                </div>
              </section>

            </div>
          </>
        )}
      </div>
    </WorkspaceShell>
  );
}

function HomeActionCard({ title, description, to }: { title: string; description: string; to: string }) {
  return (
    <Link className="home-action-card" to={to}>
      <strong>{title}</strong>
      <span>{description}</span>
    </Link>
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
  if (err instanceof ApiError) {
    return err.message;
  }
  return fallback;
}
