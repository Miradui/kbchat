import { ExternalLink, RefreshCw, ThumbsDown } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import {
  getChatQualityOverview,
  listKnowledgeBases,
  listNegativeChatFeedback,
} from '../../api/resources';
import type {
  ChatQualityFeedbackItem,
  ChatQualityFeedbackParams,
  ChatQualityFeedbackListResponse,
  ChatQualityOverview,
  ChatQualityOverviewParams,
  ChatQualityPeriod,
  KnowledgeBase,
} from '../../types/api';
import { getErrorMessage } from '../../utils/errors';
import { formatRelativeTime } from '../../utils/format';
import { EmptyState } from '../../components/feedback/EmptyState';
import { ErrorState } from '../../components/feedback/ErrorState';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Field, Select } from '../../components/ui/Field';
import { MetricStrip } from '../../components/ui/MetricStrip';
import { Pagination } from '../../components/ui/Pagination';
import { SegmentedControl } from '../../components/ui/SegmentedControl';
import { AppShell } from '../../layouts/AppShell';

const PAGE_SIZE = 10;

type QualitySources = {
  loadOverview: (params: ChatQualityOverviewParams) => Promise<ChatQualityOverview>;
  loadFeedback: (params: ChatQualityFeedbackParams) => Promise<ChatQualityFeedbackListResponse>;
  loadKnowledgeBases: () => Promise<KnowledgeBase[]>;
};

const defaultSources: QualitySources = {
  loadOverview: getChatQualityOverview,
  loadFeedback: async (params) => listNegativeChatFeedback(params),
  loadKnowledgeBases: async () => (await listKnowledgeBases({ page: 1, pageSize: 100, sort: 'updatedAt_desc' })).items,
};

export function QualityPage({ sources = defaultSources }: { sources?: QualitySources }) {
  const [period, setPeriod] = useState<ChatQualityPeriod>('month');
  const [knowledgeBaseId, setKnowledgeBaseId] = useState('');
  const [hasCitations, setHasCitations] = useState('all');
  const [page, setPage] = useState(1);
  const [overview, setOverview] = useState<ChatQualityOverview | null>(null);
  const [feedback, setFeedback] = useState<ChatQualityFeedbackListResponse | null>(null);
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([]);
  const [overviewState, setOverviewState] = useState<LoadState>({ loading: true, error: '' });
  const [feedbackState, setFeedbackState] = useState<LoadState>({ loading: true, error: '' });
  const [kbError, setKbError] = useState('');
  const overviewRequest = useRef(0);
  const feedbackRequest = useRef(0);
  const mounted = useRef(true);

  useEffect(() => () => { mounted.current = false; }, []);

  const reloadKnowledgeBases = useCallback(() => {
    setKbError('');
    void sources.loadKnowledgeBases()
      .then((items) => { if (mounted.current) setKnowledgeBases(items); })
      .catch((error: unknown) => { if (mounted.current) setKbError(getErrorMessage(error, '知识库列表加载失败')); });
  }, [sources]);

  const reloadOverview = useCallback(() => {
    const request = ++overviewRequest.current;
    setOverviewState({ loading: true, error: '' });
    void sources.loadOverview({ period, ...(knowledgeBaseId ? { knowledgeBaseId } : {}) })
      .then((result) => {
        if (mounted.current && request === overviewRequest.current) {
          setOverview(result);
          setOverviewState({ loading: false, error: '' });
        }
      })
      .catch((error: unknown) => {
        if (mounted.current && request === overviewRequest.current) {
          setOverviewState({ loading: false, error: getErrorMessage(error, '质量概览加载失败') });
        }
      });
  }, [knowledgeBaseId, period, sources]);

  const reloadFeedback = useCallback(() => {
    const request = ++feedbackRequest.current;
    setFeedbackState({ loading: true, error: '' });
    const params: ChatQualityFeedbackParams = {
      period,
      page,
      pageSize: PAGE_SIZE,
      ...(knowledgeBaseId ? { knowledgeBaseId } : {}),
      ...(hasCitations !== 'all' ? { hasCitations: hasCitations === 'with' } : {}),
    };
    void sources.loadFeedback(params)
      .then((result) => {
        if (mounted.current && request === feedbackRequest.current) {
          setFeedback(result);
          setFeedbackState({ loading: false, error: '' });
        }
      })
      .catch((error: unknown) => {
        if (mounted.current && request === feedbackRequest.current) {
          setFeedbackState({ loading: false, error: getErrorMessage(error, '负反馈加载失败') });
        }
      });
  }, [hasCitations, knowledgeBaseId, page, period, sources]);

  useEffect(() => { reloadKnowledgeBases(); }, [reloadKnowledgeBases]);
  useEffect(() => { reloadOverview(); }, [reloadOverview]);
  useEffect(() => { reloadFeedback(); }, [reloadFeedback]);

  const selectedKnowledgeBase = useMemo(
    () => knowledgeBases.find((item) => item.id === knowledgeBaseId),
    [knowledgeBaseId, knowledgeBases],
  );

  function updatePeriod(value: ChatQualityPeriod) {
    setPeriod(value);
    setPage(1);
  }

  function updateKnowledgeBase(value: string) {
    setKnowledgeBaseId(value);
    setPage(1);
  }

  function updateCitationFilter(value: string) {
    setHasCitations(value);
    setPage(1);
  }

  return (
    <AppShell active="quality" breadcrumbs={[{ label: '质量运营' }]}> 
      <div className="quality-page">
        <header className="quality-page__header">
          <div>
            <h1>RAG 质量运营</h1>
            <p>从真实反馈定位回答问题、引用缺口和检索降级。</p>
          </div>
          <Button
            aria-label="刷新质量数据"
            leadingIcon={<RefreshCw aria-hidden="true" />}
            onClick={() => { reloadOverview(); reloadFeedback(); reloadKnowledgeBases(); }}
            variant="secondary"
          >
            刷新
          </Button>
        </header>

        <div className="quality-filters">
          <SegmentedControl
            label="统计周期"
            onChange={updatePeriod}
            options={[{ value: 'month', label: '本月' }, { value: 'day', label: '今天' }]}
            value={period}
          />
          <Field label="知识库">
            <Select aria-label="质量知识库" onChange={(event) => updateKnowledgeBase(event.target.value)} value={knowledgeBaseId}>
              <option value="">全部知识库</option>
              {knowledgeBases.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </Select>
          </Field>
          <Field label="引用筛选">
            <Select aria-label="负反馈引用筛选" onChange={(event) => updateCitationFilter(event.target.value)} value={hasCitations}>
              <option value="all">全部负反馈</option>
              <option value="with">有引用</option>
              <option value="without">无引用</option>
            </Select>
          </Field>
          {kbError && <span className="ui-inline-notice">{kbError}</span>}
          {selectedKnowledgeBase && <span className="ui-muted">当前：{selectedKnowledgeBase.name}</span>}
        </div>

        <section aria-label="质量概览" className="ui-panel quality-overview">
          {overviewState.loading && !overview ? <LoadingSkeleton announce columns={5} compact rows={1} />
            : overviewState.error ? <ErrorState description={overviewState.error} onRetry={reloadOverview} title="质量概览加载失败" />
              : overview && <MetricStrip label="质量概览指标" metrics={[
                { key: 'answers', label: '条回答', value: overview.answerCount },
                { key: 'coverage', label: '反馈覆盖率', value: formatPercent(overview.feedbackCoverage) },
                { key: 'positive', label: '好评率', value: formatPercent(overview.positiveRate), tone: overview.positiveRate < 0.5 ? 'warn' : 'default' },
                { key: 'negative', label: '负反馈', value: overview.negativeFeedbackCount, tone: overview.negativeFeedbackCount > 0 ? 'danger' : 'default' },
                { key: 'without', label: '无引用回答', value: overview.withoutCitationsCount, tone: overview.withoutCitationsCount > 0 ? 'warn' : 'default' },
              ]} />}
        </section>

        <section aria-label="负反馈列表" className="ui-panel quality-feedback">
          <div className="ui-panel__head">
            <div>
              <h2>负反馈</h2>
              <span className="ui-panel__head-note">按最近评价时间排序，保留原问题、回答和来源证据</span>
            </div>
            {feedback && <span className="ui-muted">共 {feedback.total} 条</span>}
          </div>
          {feedbackState.loading && !feedback ? <LoadingSkeleton announce columns={1} rows={4} />
            : feedbackState.error ? <ErrorState description={feedbackState.error} onRetry={reloadFeedback} title="负反馈加载失败" />
              : !feedback || feedback.items.length === 0 ? <EmptyState description="当前周期没有符合筛选条件的负反馈。" title="还没有负反馈" />
                : <>
                  <div className="quality-feedback__list">
                    {feedback.items.map((item) => <FeedbackItem item={item} key={item.messageId} />)}
                  </div>
                  <Pagination onPageChange={setPage} page={feedback.page} pageSize={feedback.pageSize} total={feedback.total} />
                </>}
        </section>
      </div>
    </AppShell>
  );
}

type LoadState = { loading: boolean; error: string };

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function FeedbackItem({ item }: { item: ChatQualityFeedbackItem }) {
  return (
    <article className="quality-feedback__item">
      <div className="quality-feedback__item-head">
        <span className="quality-feedback__icon" aria-hidden="true"><ThumbsDown /></span>
        <div className="ui-cell-stack">
          <strong>{item.knowledgeBaseName}</strong>
          <small>{item.sessionTitle} · 评价于 {formatRelativeTime(item.feedbackUpdatedAt)}</small>
        </div>
        <Link className="ui-button ui-button--link" to={`/chat/${encodeURIComponent(item.sessionId)}`}>
          查看会话 <ExternalLink aria-hidden="true" />
        </Link>
      </div>
      <dl className="quality-feedback__content">
        <div><dt>问题</dt><dd>{item.question || '未找到对应问题'}</dd></div>
        <div><dt>回答</dt><dd>{item.answer}</dd></div>
      </dl>
      <div className="quality-feedback__evidence">
        <div className="quality-feedback__evidence-head">
          <strong>来源证据</strong>
          {item.citations.length > 0 ? <Badge tone="info">{item.citations.length} 条引用</Badge> : <Badge tone="warn">无引用</Badge>}
          {item.rerankFallback?.used && <Badge tone="warn">Rerank fallback</Badge>}
        </div>
        {item.citations.length > 0 && <div className="quality-feedback__citations">
          {item.citations.map((citation) => (
            <Link
              className="quality-feedback__citation"
              key={`${citation.documentId}-${citation.chunkId}`}
              to={`/knowledge-bases/${encodeURIComponent(item.knowledgeBaseId)}/documents?documentId=${encodeURIComponent(citation.documentId)}&chunkId=${encodeURIComponent(citation.chunkId)}`}
            >
              <span>{citation.filename}{citation.pageNumber ? ` · 第 ${citation.pageNumber} 页` : ''}</span>
              <small>{citation.content}</small>
            </Link>
          ))}
        </div>}
        {item.rerankFallback?.used && <p className="ui-muted quality-feedback__fallback">精排未完成：{item.rerankFallback.reason || '使用了降级结果'}</p>}
      </div>
    </article>
  );
}
