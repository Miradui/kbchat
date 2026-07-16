import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { ApiError } from '../../api/client';
import { EmptyState } from '../../components/feedback/EmptyState';
import { ErrorState } from '../../components/feedback/ErrorState';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';
import { WorkspaceShell } from '../../components/WorkspaceShell';
import type {
  ChatSession,
  GlobalDocumentItem,
  KnowledgeBase,
  KnowledgeBaseStatsResponse,
} from '../../types/api';
import { createHomeLoaders } from './homeData';
import type { HomeSources } from './homeData';

type RegionState<T> = {
  data: T;
  loading: boolean;
  error: string;
};

type HomePageProps = {
  sources?: HomeSources;
};

export function HomePage({ sources }: HomePageProps) {
  const loaders = useMemo(() => createHomeLoaders(sources), [sources]);
  const stats = useRegion(loaders.stats, null as KnowledgeBaseStatsResponse | null, '统计加载失败');
  const knowledgeBases = useRegion(loaders.knowledgeBases, [] as KnowledgeBase[], '知识库动态加载失败');
  const documents = useRegion(loaders.documents, [] as GlobalDocumentItem[], '文档动态加载失败');
  const sessions = useRegion(loaders.sessions, [] as ChatSession[], '会话动态加载失败');

  const recentSessions = useMemo(
    () => [...sessions.data]
      .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime())
      .slice(0, 5),
    [sessions.data],
  );
  const failedDocuments = documents.data.filter((document) => document.status === 'failed');
  const processingDocuments = documents.data.filter(
    (document) => !['completed', 'failed'].includes(document.status),
  );

  return (
    <WorkspaceShell active="home">
      <div className="home-dashboard-page">
        <header className="page-header workspace-heading">
          <div>
            <p className="eyebrow">工作概览</p>
            <h1>工作台首页</h1>
            <p className="page-description">查看知识资产、处理任务和最近问答，不让单个接口故障阻塞整个页面。</p>
          </div>
        </header>

        <section className="home-quick-actions" aria-label="快捷入口">
          <QuickAction title="新建知识库" description="进入知识库工作台创建并配置检索。" to="/knowledge-bases" />
          <QuickAction title="导入文档" description="选择目标知识库并上传资料。" to="/documents" />
          <QuickAction title="开始问答" description="选择知识库继续或创建会话。" to="/chat" />
        </section>

        <DashboardRegion
          className="home-stats-region"
          error={stats.error}
          loading={stats.loading}
          onRetry={stats.reload}
          title="关键统计"
        >
          <section className="home-stat-grid" aria-label="关键统计">
            <StatCard label="知识库总数" value={stats.data?.knowledgeBases.value ?? knowledgeBases.data.length} />
            <StatCard label="文档总数" value={stats.data?.documents.value ?? documents.data.length} />
            <StatCard label="近期处理中 / 失败" value={`${processingDocuments.length} / ${failedDocuments.length}`} />
            <StatCard label="活跃会话" value={sessions.data.length} />
          </section>
        </DashboardRegion>

        <div className="home-overview-grid">
          <DashboardRegion
            error={knowledgeBases.error}
            href="/knowledge-bases"
            loading={knowledgeBases.loading}
            onRetry={knowledgeBases.reload}
            title="最近知识库"
          >
            {knowledgeBases.data.length === 0 ? (
              <EmptyState title="还没有知识库" description="创建知识库后即可导入文档。" />
            ) : knowledgeBases.data.map((item) => (
              <Link className="home-list-row" key={item.id} to={`/knowledge-bases/${item.id}`}>
                <strong>{item.name}</strong>
                <small>{item.description || '未填写描述'} · {formatDateTime(item.updatedAt || item.createdAt)}</small>
              </Link>
            ))}
          </DashboardRegion>

          <DashboardRegion
            error={sessions.error}
            href="/chat"
            loading={sessions.loading}
            onRetry={sessions.reload}
            title="最近会话"
          >
            {recentSessions.length === 0 ? (
              <EmptyState title="还没有问答会话" description="选择知识库开始第一次问答。" />
            ) : recentSessions.map((session) => (
              <Link className="home-list-row" key={session.id} to={`/chat/${session.id}`}>
                <strong>{session.title || '未命名会话'}</strong>
                <small>{formatDateTime(session.updatedAt || session.createdAt)}</small>
              </Link>
            ))}
          </DashboardRegion>

          <DashboardRegion
            error={documents.error}
            href="/documents"
            loading={documents.loading}
            onRetry={documents.reload}
            title="文档处理动态"
          >
            {documents.data.length === 0 ? (
              <EmptyState title="还没有文档" description="导入文档后可在这里查看处理状态。" />
            ) : documents.data.map((document) => <DocumentActivity document={document} key={document.id} />)}
          </DashboardRegion>

          <section className="home-panel home-failure-panel" aria-labelledby="failed-documents-title">
            <header><h2 id="failed-documents-title">失败任务</h2></header>
            {documents.loading && documents.data.length === 0 ? (
              <LoadingSkeleton announce compact rows={3} columns={1} />
            ) : documents.error ? (
              <p className="home-dependent-error">无法判断失败任务，请先重试文档动态。</p>
            ) : failedDocuments.length === 0 ? (
              <EmptyState title="暂无失败任务" description="最近文档处理状态正常。" />
            ) : failedDocuments.map((document) => (
              <Link className="home-list-row" key={document.id} to={`/knowledge-bases/${document.knowledgeBaseId}/documents`}>
                <strong>{document.filename}</strong>
                <small>{document.errorMessage || '处理失败，请进入文档管理查看详情'}</small>
              </Link>
            ))}
          </section>
        </div>
      </div>
    </WorkspaceShell>
  );
}

function useRegion<T>(loader: () => Promise<T>, initialData: T, failure: string) {
  const [state, setState] = useState<RegionState<T>>({ data: initialData, loading: true, error: '' });
  const activeRef = useRef(true);
  const requestRef = useRef(0);

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      requestRef.current += 1;
    };
  }, []);

  const reload = useCallback(() => {
    const request = ++requestRef.current;
    setState((current) => ({ ...current, loading: true, error: '' }));

    void loader()
      .then((data) => {
        if (activeRef.current && request === requestRef.current) {
          setState({ data, loading: false, error: '' });
        }
      })
      .catch((error: unknown) => {
        if (activeRef.current && request === requestRef.current) {
          setState((current) => ({ ...current, loading: false, error: errorMessage(error, failure) }));
        }
      });
  }, [failure, loader]);

  useEffect(() => {
    reload();
  }, [reload]);

  return { ...state, reload };
}

function QuickAction({ title, description, to }: { title: string; description: string; to: string }) {
  return <Link className="home-quick-action" to={to}><strong>{title}</strong><span>{description}</span></Link>;
}

function StatCard({ label, value }: { label: string; value: number | string }) {
  return <article className="home-stat-card"><span>{label}</span><strong>{value}</strong></article>;
}

function DashboardRegion({
  title,
  href,
  error,
  loading,
  onRetry,
  className = '',
  children,
}: {
  title: string;
  href?: string;
  error: string;
  loading: boolean;
  onRetry: () => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={`home-panel ${className}`.trim()}>
      <header>
        <h2>{title}</h2>
        {href && <Link to={href}>查看全部</Link>}
      </header>
      {loading && !error ? (
        <LoadingSkeleton announce compact rows={3} columns={1} />
      ) : error ? (
        <ErrorState title={error} description="请重试该区域，其他区域不受影响。" onRetry={onRetry} />
      ) : children}
    </section>
  );
}

function DocumentActivity({ document }: { document: GlobalDocumentItem }) {
  return (
    <Link className="home-list-row" to={`/knowledge-bases/${document.knowledgeBaseId}/documents`}>
      <strong>{document.filename}</strong>
      <small>{document.knowledgeBaseName} · {document.status} · {formatDateTime(document.updatedAt ?? document.createdAt)}</small>
    </Link>
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

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}
