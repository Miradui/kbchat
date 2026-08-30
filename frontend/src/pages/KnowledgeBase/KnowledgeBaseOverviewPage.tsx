import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { getKnowledgeBaseDetailStats, listDocuments, listKnowledgeBaseCategories } from '../../api/resources';
import { EmptyState } from '../../components/feedback/EmptyState';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';
import { AppShell } from '../../layouts/AppShell';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { SegmentedControl } from '../../components/ui/SegmentedControl';
import type {
  DocumentItem,
  KnowledgeBaseCategory,
  KnowledgeBaseDetailStatsResponse,
} from '../../types/api';
import { formatBytes, formatCount, formatDateTime } from '../../utils/format';
import { getErrorMessage } from '../../utils/errors';
import { documentStatusLabel, documentStatusTone } from '../Documents/documentDisplay';
import { documentStalenessHint } from '../Documents/documentFailure';
import { KnowledgeBaseLayout, KnowledgeBaseLoadFailure } from './KnowledgeBaseLayout';
import { findCategoryName } from './categoryTreeUtils';
import { formatMetricComparison } from './statsFormatting';
import { useKnowledgeBase } from './useKnowledgeBase';

const RECENT_DOCUMENT_LIMIT = 6;

type DocumentCounts = {
  completed: number;
  failed: number;
  processing: number;
};

export function KnowledgeBaseOverviewPage() {
  const { id, knowledgeBase, setKnowledgeBase, loading, error, reload } = useKnowledgeBase();
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [counts, setCounts] = useState<DocumentCounts | null>(null);
  const [documentsLoading, setDocumentsLoading] = useState(true);
  const [documentError, setDocumentError] = useState('');
  const [categories, setCategories] = useState<KnowledgeBaseCategory[]>([]);
  const [stats, setStats] = useState<KnowledgeBaseDetailStatsResponse | null>(null);
  const [statsPeriod, setStatsPeriod] = useState<'day' | 'month'>('month');
  const [statsError, setStatsError] = useState('');

  const loadDocuments = useCallback(async () => {
    if (!id) return;
    setDocumentsLoading(true);
    try {
      // The document list is paginated, so the status tiles come from filtered
      // totals rather than from counting a page. `processing` is the remainder:
      // every status is either completed, failed, or one of the in-flight ones.
      const [recent, completed, failed] = await Promise.all([
        listDocuments(id, { pageSize: RECENT_DOCUMENT_LIMIT }),
        listDocuments(id, { status: 'completed', pageSize: 1 }),
        listDocuments(id, { status: 'failed', pageSize: 1 }),
      ]);
      setDocuments(recent.items);
      setCounts({
        completed: completed.total,
        failed: failed.total,
        processing: Math.max(0, recent.total - completed.total - failed.total),
      });
      setDocumentError('');
    } catch (caught) {
      setDocuments([]);
      setCounts(null);
      setDocumentError(getErrorMessage(caught, '文档摘要加载失败'));
    } finally {
      setDocumentsLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void loadDocuments();
  }, [loadDocuments]);

  const loadStats = useCallback(async () => {
    if (!id) return;
    try {
      setStats(await getKnowledgeBaseDetailStats(id, statsPeriod));
      setStatsError('');
    } catch (caught) {
      setStats(null);
      setStatsError(getErrorMessage(caught, '统计加载失败'));
    }
  }, [id, statsPeriod]);

  useEffect(() => {
    void loadStats();
  }, [loadStats]);

  useEffect(() => {
    void listKnowledgeBaseCategories()
      .then((response) => setCategories(response.items))
      .catch(() => setCategories([]));
  }, []);

  if (loading && !knowledgeBase) {
    return (
      <AppShell active="knowledge-bases" breadcrumbs={[{ label: '知识库', to: '/knowledge-bases' }]}>
        <div className="ui-panel"><LoadingSkeleton announce columns={4} rows={5} /></div>
      </AppShell>
    );
  }

  if (!knowledgeBase) {
    return <KnowledgeBaseLoadFailure message={error || '知识库不存在或无权访问。'} onRetry={() => void reload()} />;
  }

  const known = counts !== null;
  const documentsHref = `/knowledge-bases/${encodeURIComponent(knowledgeBase.id)}/documents`;
  const categoryName = knowledgeBase.categoryId
    ? findCategoryName(categories, knowledgeBase.categoryId) ?? '未分类'
    : '未分类';

  return (
    <KnowledgeBaseLayout active="overview" knowledgeBase={knowledgeBase} onUpdated={setKnowledgeBase}>
      <div className="kb-detail__grid">
        <div style={{ display: 'grid', gap: 'var(--s-4)' }}>
          <section className="ui-panel">
            <div className="ui-panel__head">
              <h2>文档处理</h2>
              <Link className="ui-button ui-button--link" to={documentsHref}><span>管理文档</span></Link>
            </div>
            {documentError ? (
              <div className="ui-panel__body">
                <div className="ui-inline-error" role="alert">
                  <span>{documentError}</span>
                  <Button variant="link" onClick={() => void loadDocuments()}>重试</Button>
                </div>
              </div>
            ) : (
              <div className="kb-status-tiles">
                {/* Each tile is a link into the document list pre-filtered to that status. */}
                <Link className="kb-status-tile kb-status-tile--ok" to={`${documentsHref}?status=completed`}>
                  <strong>{known ? counts.completed : '—'}</strong>
                  <span>可用于问答</span>
                </Link>
                <Link className="kb-status-tile kb-status-tile--warn" to={`${documentsHref}?status=parsing`}>
                  <strong>{known ? counts.processing : '—'}</strong>
                  <span>处理中</span>
                </Link>
                <Link className="kb-status-tile kb-status-tile--danger" to={`${documentsHref}?status=failed`}>
                  <strong>{known ? counts.failed : '—'}</strong>
                  <span>处理失败</span>
                </Link>
              </div>
            )}
          </section>

          <section className="ui-panel">
            <div className="ui-panel__head">
              <h2>最近文档</h2>
              <Link className="ui-button ui-button--link" to={documentsHref}><span>查看全部</span></Link>
            </div>
            {documentsLoading && documents.length === 0 ? (
              <LoadingSkeleton announce compact columns={2} rows={3} />
            ) : documents.length === 0 ? (
              <EmptyState
                action={<Link className="ui-button ui-button--primary" to={`${documentsHref}?intent=upload`}><span>导入文档</span></Link>}
                description="导入 txt、md 或 pdf 后即可开始问答。"
                title="还没有文档"
              />
            ) : (
              <div className="kb-doc-list">
                {documents.map((document) => {
                  const stalenessHint = documentStalenessHint(document);
                  return (
                  <Link
                    className="kb-doc-row"
                    key={document.id}
                    to={`${documentsHref}?documentId=${encodeURIComponent(document.id)}`}
                  >
                    <span className="ui-cell-stack">
                      <strong>{document.filename}</strong>
                      <small>{formatBytes(document.fileSize)} · {document.fileType}</small>
                    </span>
                    {/* Staleness sits beside the status rather than replacing it: a stale
                        document is still completed, and hiding that would read as broken. */}
                    {stalenessHint && (
                      <Badge aria-label={stalenessHint} title={stalenessHint} tone="warn">可能过期</Badge>
                    )}
                    <Badge tone={documentStatusTone(document.status)}>
                      {documentStatusLabel(document.status)}
                    </Badge>
                  </Link>
                  );
                })}
              </div>
            )}
          </section>
        </div>

        <section className="ui-panel">
          <div className="ui-panel__head"><h2>基础信息</h2></div>
          <div className="ui-panel__body" style={{ display: 'grid', gap: 'var(--s-4)' }}>
            <div className="kb-info-grid">
              <InfoItem label="分类" value={categoryName} />
              <InfoItem label="更新时间" value={formatDateTime(knowledgeBase.updatedAt)} />
              <InfoItem label="创建时间" value={formatDateTime(knowledgeBase.createdAt)} />
              <InfoItem
                label="最后更新人"
                value={knowledgeBase.updatedBy?.displayName || knowledgeBase.updatedBy?.username || '未知'}
              />
            </div>

            {/*
              Views and questions come from GET /knowledge-bases/:id/stats, not from
              the detail payload — detail responses stay free of list-only
              aggregates. See docs/14-frontend-api-gaps.md G13.
            */}
            <div>
              <div className="ui-panel__head" style={{ padding: 0 }}>
                <p className="ui-field__label">本{statsPeriod === 'day' ? '日' : '月'}趋势</p>
                <SegmentedControl<'day' | 'month'>
                  label="统计周期"
                  onChange={setStatsPeriod}
                  options={[{ value: 'day', label: '日' }, { value: 'month', label: '月' }]}
                  value={statsPeriod}
                />
              </div>
              {statsError ? (
                <div className="ui-inline-error" role="alert">
                  <span>{statsError}</span>
                  <Button variant="link" onClick={() => void loadStats()}>重试</Button>
                </div>
              ) : (
                <div className="kb-info-grid">
                  <InfoItem
                    hint={stats ? formatMetricComparison(stats.documents, stats.period) : undefined}
                    label="新增文档"
                    value={stats ? formatCount(stats.documents.value) : '—'}
                  />
                  <InfoItem
                    hint={stats ? formatMetricComparison(stats.views, stats.period) : undefined}
                    label="浏览量"
                    value={stats ? formatCount(stats.views.value) : '—'}
                  />
                  <InfoItem
                    hint={stats ? formatMetricComparison(stats.questions, stats.period) : undefined}
                    label="问答数"
                    value={stats ? formatCount(stats.questions.value) : '—'}
                  />
                </div>
              )}
            </div>

            <div>
              <p className="ui-field__label" style={{ marginBottom: 'var(--s-2)' }}>标签</p>
              {knowledgeBase.tags && knowledgeBase.tags.length > 0 ? (
                <div className="kb-card__tags">
                  {knowledgeBase.tags.map((tag) => <span className="ui-tag" key={tag.id}>{tag.name}</span>)}
                </div>
              ) : (
                <p className="ui-field__hint">暂无标签</p>
              )}
            </div>
          </div>
        </section>
      </div>
    </KnowledgeBaseLayout>
  );
}

function InfoItem({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="kb-info-item">
      <span>{label}</span>
      <strong title={value}>{value}</strong>
      {hint && <small className="ui-field__hint">{hint}</small>}
    </div>
  );
}
