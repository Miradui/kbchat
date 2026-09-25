import { ExternalLink, RefreshCw, Repeat, SearchX, ServerCrash, ShieldAlert, ThumbsDown } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import {
  getChatQualityOverview,
  listChatKnowledgeGaps,
  listNegativeChatFeedback,
} from '../../api/resources';
import type {
  ChatKnowledgeGapItem,
  ChatKnowledgeGapListResponse,
  ChatKnowledgeGapParams,
  ChatQualityFeedbackItem,
  ChatQualityFeedbackParams,
  ChatQualityFeedbackListResponse,
  ChatQualityOverview,
  ChatQualityOverviewParams,
  ChatQualityPeriod,
  KnowledgeBase,
} from '../../types/api';
import { canUnlessUnknown } from '../../utils/access';
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
import { useCurrentUser } from '../../hooks/useCurrentUser';
import { EvaluationCaseDialog } from './EvaluationCaseDialog';
import { EvaluationPanel } from './EvaluationPanel';
import { UsagePanel } from './UsagePanel';
import { useKnowledgeBaseOptions, loadKnowledgeBaseOptions } from '../../hooks/useKnowledgeBaseOptions';
import { chatFeedbackReasonLabel } from '../../utils/chatFeedback';

const PAGE_SIZE = 10;

type QualitySources = {
  loadOverview: (params: ChatQualityOverviewParams) => Promise<ChatQualityOverview>;
  loadFeedback: (params: ChatQualityFeedbackParams) => Promise<ChatQualityFeedbackListResponse>;
  loadKnowledgeGaps: (params: ChatKnowledgeGapParams) => Promise<ChatKnowledgeGapListResponse>;
  loadKnowledgeBases: () => Promise<KnowledgeBase[]>;
};

const defaultSources: QualitySources = {
  loadOverview: getChatQualityOverview,
  loadFeedback: async (params) => listNegativeChatFeedback(params),
  loadKnowledgeGaps: async (params) => listChatKnowledgeGaps(params),
  loadKnowledgeBases: loadKnowledgeBaseOptions,
};

/**
 * Each category gets its own label, tone and remedy because the fix differs, and
 * that difference is the whole point of splitting them. Sending someone to upload
 * documents for a retrieval outage or a model refusal wastes their time on work
 * that cannot resolve the problem.
 */
type GapPresentation = {
  label: string;
  tone: 'warn' | 'danger' | 'info';
  icon: typeof SearchX;
  /** Omitted where no navigation would help; the row then shows advice only. */
  action?: { label: string; to: (item: ChatKnowledgeGapItem) => string };
  advice: string;
};

const GAP_PRESENTATION: Record<ChatKnowledgeGapItem['category'], GapPresentation> = {
  no_citations: {
    label: '检索无结果',
    tone: 'warn',
    icon: SearchX,
    action: {
      label: '补充资料',
      to: (item) => `/knowledge-bases/${encodeURIComponent(item.knowledgeBaseId)}/documents`,
    },
    advice: '知识库里没有能回答这个问题的内容，补充资料后可以再试。',
  },
  retrieval_failed: {
    label: '检索失败',
    tone: 'danger',
    icon: ServerCrash,
    // Deliberately points at diagnostics, not at documents: the knowledge base may
    // be perfectly well stocked and uploading more would change nothing.
    action: { label: '查看系统状态', to: () => '/diagnostics' },
    advice: '检索或向量服务当时不可用，与知识库内容无关。确认服务恢复后重试即可。',
  },
  model_refused: {
    label: '模型拒答',
    tone: 'info',
    icon: ShieldAlert,
    advice: '模型判断该问题本身不适合回答。补充资料不会改变结果，通常无需处理。',
  },
  repeated_rewrite: {
    label: '反复改写',
    tone: 'info',
    icon: Repeat,
    action: {
      label: '补充资料',
      to: (item) => `/knowledge-bases/${encodeURIComponent(item.knowledgeBaseId)}/documents`,
    },
    advice: '同一问题被反复改写，通常说明回答没有命中用户真正想问的内容。',
  },
};

/**
 * An unrecognised category still has to render. The server's set can grow before
 * this client knows the new member, and dropping the row would hide a real gap.
 */
const UNKNOWN_GAP_PRESENTATION: GapPresentation = {
  label: '其他',
  tone: 'warn',
  icon: SearchX,
  advice: '这是当前版本界面还不认识的缺口类型。',
};

function gapPresentation(category: string): GapPresentation {
  return GAP_PRESENTATION[category as ChatKnowledgeGapItem['category']] ?? UNKNOWN_GAP_PRESENTATION;
}

export function QualityPage({ sources = defaultSources }: { sources?: QualitySources }) {
  const { user } = useCurrentUser();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = searchParams.get('tab') === 'evaluation' ? 'evaluation' : searchParams.get('tab') === 'usage' ? 'usage' : 'feedback';
  const knowledgeBaseId = searchParams.get('knowledgeBaseId') || '';
  const [period, setPeriod] = useState<ChatQualityPeriod>('month');
  const [caseDraft, setCaseDraft] = useState<ChatQualityFeedbackItem | null>(null);
  const [hasCitations, setHasCitations] = useState('all');
  const [page, setPage] = useState(1);
  const [gapCategory, setGapCategory] = useState<NonNullable<ChatKnowledgeGapParams['category']>>('all');
  const [gapPage, setGapPage] = useState(1);
  const [overview, setOverview] = useState<ChatQualityOverview | null>(null);
  const [feedback, setFeedback] = useState<ChatQualityFeedbackListResponse | null>(null);
  const [gaps, setGaps] = useState<ChatKnowledgeGapListResponse | null>(null);
  const { items: knowledgeBases, error: kbError, reload: reloadKnowledgeBases } = useKnowledgeBaseOptions(sources.loadKnowledgeBases);
  const [overviewState, setOverviewState] = useState<LoadState>({ loading: true, error: '' });
  const [feedbackState, setFeedbackState] = useState<LoadState>({ loading: true, error: '' });
  const [gapState, setGapState] = useState<LoadState>({ loading: true, error: '' });
  const overviewRequest = useRef(0);
  const feedbackRequest = useRef(0);
  const gapRequest = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);


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

  const reloadGaps = useCallback(() => {
    const request = ++gapRequest.current;
    setGapState({ loading: true, error: '' });
    const params: ChatKnowledgeGapParams = {
      period,
      page: gapPage,
      pageSize: PAGE_SIZE,
      ...(knowledgeBaseId ? { knowledgeBaseId } : {}),
      ...(gapCategory !== 'all' ? { category: gapCategory } : {}),
    };
    void sources.loadKnowledgeGaps(params)
      .then((result) => {
        if (mounted.current && request === gapRequest.current) {
          setGaps(result);
          setGapState({ loading: false, error: '' });
        }
      })
      .catch((error: unknown) => {
        if (mounted.current && request === gapRequest.current) {
          setGapState({ loading: false, error: getErrorMessage(error, '知识缺口加载失败') });
        }
      });
  }, [gapCategory, gapPage, knowledgeBaseId, period, sources]);


  useEffect(() => { reloadOverview(); }, [reloadOverview]);
  useEffect(() => { reloadFeedback(); }, [reloadFeedback]);
  useEffect(() => { reloadGaps(); }, [reloadGaps]);

  // Only bases the caller can read quality data for. The unfiltered view already
  // aggregates exactly these, so offering the others would turn the filter into the
  // one control on this page that answers 403 -- and it is a filter on data the user
  // is already looking at.
  const qualityKnowledgeBases = useMemo(
    () => knowledgeBases.filter((item) => canUnlessUnknown(item, 'quality.read')),
    [knowledgeBases],
  );

  const selectedKnowledgeBase = useMemo(
    () => qualityKnowledgeBases.find((item) => item.id === knowledgeBaseId),
    [knowledgeBaseId, qualityKnowledgeBases],
  );

  function updatePeriod(value: ChatQualityPeriod) {
    setPeriod(value);
    setPage(1);
    setGapPage(1);
  }

  function updateKnowledgeBase(value: string) {
    setSearchParams((current) => { const next = new URLSearchParams(current); if (value) next.set('knowledgeBaseId', value); else next.delete('knowledgeBaseId'); return next; });
    setPage(1);
    setGapPage(1);
  }

  function updateCitationFilter(value: string) {
    setHasCitations(value);
    setPage(1);
  }

  function updateGapCategory(value: string) {
    setGapCategory(value as NonNullable<ChatKnowledgeGapParams['category']>);
    // The two categories have independent lengths, so a page number from the
    // previous filter would usually land past the end of the new one.
    setGapPage(1);
  }

  return (
    <AppShell active="quality" breadcrumbs={[{ label: '质量运营' }]}>
      <div className="quality-page">
        <header className="ui-page-heading quality-page__header">
          <div className="ui-page-heading__copy">
            <h1>RAG 质量运营</h1>
            <p>从真实反馈定位回答问题、引用缺口和检索降级。</p>
          </div>
          {activeTab === 'feedback' && <Button
            aria-label="刷新质量数据"
            leadingIcon={<RefreshCw aria-hidden="true" />}
            onClick={() => { reloadOverview(); reloadFeedback(); reloadGaps(); reloadKnowledgeBases(); }}
            variant="secondary"
          >
            刷新
          </Button>}
        </header>

        <SegmentedControl label="质量视图" value={activeTab} options={[{ value: 'feedback', label: '反馈与缺口' }, { value: 'usage', label: '用量统计' }, { value: 'evaluation', label: '回归评测' }]}
          onChange={(value) => setSearchParams((current) => { const next = new URLSearchParams(current); next.set('tab', value); return next; })} />

        <div className="quality-filters">
          {activeTab === 'feedback' && <SegmentedControl
            label="统计周期"
            onChange={updatePeriod}
            options={[{ value: 'month', label: '本月' }, { value: 'day', label: '今天' }]}
            value={period}
          />}
          <Field label="知识库">
            <Select aria-label="质量知识库" onChange={(event) => updateKnowledgeBase(event.target.value)} value={knowledgeBaseId}>
              <option value="">全部知识库</option>
              {qualityKnowledgeBases.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </Select>
          </Field>
          {activeTab === 'feedback' && <Field label="引用筛选">
            <Select aria-label="负反馈引用筛选" onChange={(event) => updateCitationFilter(event.target.value)} value={hasCitations}>
              <option value="all">全部负反馈</option>
              <option value="with">有引用</option>
              <option value="without">无引用</option>
            </Select>
          </Field>}
          {kbError && <span className="ui-inline-notice">{kbError}</span>}
          {selectedKnowledgeBase && <span className="ui-muted">当前：{selectedKnowledgeBase.name}</span>}
        </div>

        {activeTab === 'usage' ? <UsagePanel knowledgeBaseId={knowledgeBaseId} /> : activeTab === 'evaluation' ? selectedKnowledgeBase
          ? <EvaluationPanel key={selectedKnowledgeBase.id} knowledgeBase={selectedKnowledgeBase} />
          : <EmptyState title="选择一个知识库开始评测" description="测试问题与运行记录按知识库保存。" />
          : <><section aria-label="质量概览" className="ui-panel quality-overview">
          {overviewState.loading && !overview ? <LoadingSkeleton announce columns={5} compact rows={1} />
            : overviewState.error ? <ErrorState description={overviewState.error} onRetry={reloadOverview} title="质量概览加载失败" />
              : overview && <>
                <MetricStrip label="质量概览指标" metrics={[
                  { key: 'answers', label: '条回答', value: overview.answerCount },
                  { key: 'coverage', label: '反馈覆盖率', value: formatPercent(overview.feedbackCoverage) },
                  { key: 'positive', label: '好评率', value: formatPercent(overview.positiveRate), tone: overview.positiveRate < 0.5 ? 'warn' : 'default' },
                  { key: 'negative', label: '负反馈', value: overview.negativeFeedbackCount, tone: overview.negativeFeedbackCount > 0 ? 'danger' : 'default' },
                  {
                    key: 'without',
                    label: '无引用知识型回答',
                    value: `${overview.withoutCitationsCount} · ${formatPercent(overview.withoutCitationsRate)}`,
                    tone: overview.withoutCitationsCount > 0 ? 'warn' : 'default',
                  },
                ]} />
                {overview.unclassifiedAnswerCount > 0 && (
                  <p className="ui-muted quality-overview__note">
                    其中 {overview.unclassifiedAnswerCount} 条回答早于意图记录，无法判断是否属于知识型提问，已从「无引用知识型回答」及其占比中排除。
                  </p>
                )}
              </>}
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
                    {feedback.items.map((item) => <FeedbackItem item={item} key={item.messageId} onSave={() => setCaseDraft(item)} />)}
                  </div>
                  <Pagination onPageChange={setPage} page={feedback.page} pageSize={feedback.pageSize} total={feedback.total} />
                </>}
        </section>

        <section aria-label="知识缺口列表" className="ui-panel quality-gaps">
          <div className="ui-panel__head">
            <div>
              <h2>知识缺口</h2>
              <span className="ui-panel__head-note">
按原因区分：知识库没有依据、检索失败、模型拒答，以及同一会话内被反复改写的问题（不含重新生成）
              </span>
            </div>
            <Field label="缺口类型">
              <Select aria-label="知识缺口类型" onChange={(event) => updateGapCategory(event.target.value)} value={gapCategory}>
                <option value="all">全部类型{gaps ? ` (${gaps.total})` : ''}</option>
                <option value="no_citations">检索无结果{gaps ? ` (${gaps.noCitationsTotal})` : ''}</option>
                <option value="retrieval_failed">检索失败{gaps ? ` (${gaps.retrievalFailedTotal})` : ''}</option>
                <option value="model_refused">模型拒答{gaps ? ` (${gaps.modelRefusedTotal})` : ''}</option>
                <option value="repeated_rewrite">反复改写{gaps ? ` (${gaps.repeatedRewriteTotal})` : ''}</option>
              </Select>
            </Field>
          </div>
          {gapState.loading && !gaps ? <LoadingSkeleton announce columns={1} rows={4} />
            : gapState.error ? <ErrorState description={gapState.error} onRetry={reloadGaps} title="知识缺口加载失败" />
              : !gaps || gaps.items.length === 0 ? <EmptyState description={gapEmptyDescription(gapCategory)} title="没有发现知识缺口" />
                : <>
                  <div className="quality-gaps__list">
                    {gaps.items.map((item) => <KnowledgeGapItem item={item} canViewDiagnostics={user?.role === 'admin'} key={gapKey(item)} />)}
                  </div>
                  <Pagination onPageChange={setGapPage} page={gaps.page} pageSize={gaps.pageSize} total={gaps.total} />
                </>}
        </section>
        </>}
      </div>
      {caseDraft && <EvaluationCaseDialog knowledgeBaseId={caseDraft.knowledgeBaseId} initial={{ question: caseDraft.question }} onClose={() => setCaseDraft(null)}
        onSaved={() => setSearchParams({ knowledgeBaseId: caseDraft.knowledgeBaseId, tab: 'evaluation' })} />}
    </AppShell>
  );
}

/**
 * A cluster has no message id, so identity is its group key: the session plus the
 * question it normalizes to.
 */
function gapKey(item: ChatKnowledgeGapItem): string {
  return item.messageId ?? `${item.category}:${item.sessionId}:${item.retrievalQuery}`;
}

function gapEmptyDescription(category: NonNullable<ChatKnowledgeGapParams['category']>): string {
  if (category === 'no_citations') {
    return '当前周期内的知识型提问都检索到了内容。';
  }
  if (category === 'retrieval_failed') {
    return '当前周期内没有检索失败的提问。';
  }
  if (category === 'model_refused') {
    return '当前周期内没有被模型拒答的提问。';
  }
  if (category === 'repeated_rewrite') {
    return '当前周期内没有被反复改写的问题。';
  }
  return '当前周期内没有发现知识缺口。';
}

type LoadState = { loading: boolean; error: string };

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function FeedbackItem({ item, onSave }: { item: ChatQualityFeedbackItem; onSave: () => void }) {
  return (
    <article className="quality-feedback__item">
      <div className="quality-feedback__item-head">
        <span className="quality-feedback__icon" aria-hidden="true"><ThumbsDown /></span>
        <div className="ui-cell-stack">
          <strong>{item.knowledgeBaseName}</strong>
          <small>{item.sessionTitle} · 评价于 {formatRelativeTime(item.feedbackUpdatedAt)}</small>
        </div>
        <Link className="ui-button ui-button--link" to={`/chat/${encodeURIComponent(item.sessionId)}?messageId=${encodeURIComponent(item.messageId)}`}>
          查看会话 <ExternalLink aria-hidden="true" />
        </Link>
      </div>
      <dl className="quality-feedback__content">
        <div><dt>原因</dt><dd>{chatFeedbackReasonLabel(item.reason)}{item.comment && `：${item.comment}`}</dd></div>
        <div><dt>问题</dt><dd>{item.question || '未找到对应问题'}</dd></div>
        <div><dt>回答</dt><dd>{item.answer}</dd></div>
      </dl>
      <div><Button disabled={!item.question} onClick={onSave} variant="secondary">保存为测试问题</Button></div>
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

function KnowledgeGapItem({ item, canViewDiagnostics }: { item: ChatKnowledgeGapItem; canViewDiagnostics: boolean }) {
  const isCluster = item.category === 'repeated_rewrite';
  const presentation = gapPresentation(item.category);
  const Icon = presentation.icon;
  return (
    <article className="quality-gaps__item">
      <div className="quality-gaps__item-head">
        <span className={`quality-gaps__icon quality-gaps__icon--${presentation.tone}`} aria-hidden="true">
          <Icon />
        </span>
        <div className="ui-cell-stack">
          <strong>{item.knowledgeBaseName}</strong>
          <small>{item.sessionTitle} · 最近 {formatRelativeTime(item.lastSeenAt)}</small>
        </div>
        <Badge tone={presentation.tone}>{presentation.label}</Badge>
        <Link className="ui-button ui-button--link" to={`/chat/${encodeURIComponent(item.sessionId)}${item.messageId ? `?messageId=${encodeURIComponent(item.messageId)}` : ''}`}>
          查看会话 <ExternalLink aria-hidden="true" />
        </Link>
      </div>
      <dl className="quality-gaps__content">
        <div><dt>问题</dt><dd>{item.question || '未找到对应问题'}</dd></div>
        {item.retrievalQuery && item.retrievalQuery !== item.question && (
          <div><dt>检索式</dt><dd>{item.retrievalQuery}</dd></div>
        )}
      </dl>
      <p className="ui-muted quality-gaps__advice">{item.category === 'retrieval_failed' && !canViewDiagnostics
        ? '检索服务当时不可用，请联系系统管理员检查服务状态，恢复后重试。'
        : presentation.advice}</p>
      <div className="quality-gaps__meta">
        {isCluster
          ? <>
            <Badge tone="info">改写 {item.occurrenceCount} 次</Badge>
            {item.ungroundedCount > 0 && <Badge tone="warn">其中 {item.ungroundedCount} 次无引用</Badge>}
          </>
          : <Badge tone={presentation.tone}>{presentation.label}</Badge>}
        <span className="ui-muted">
          首次 {formatRelativeTime(item.firstSeenAt)}
        </span>
        {presentation.action && (item.category !== 'retrieval_failed' || canViewDiagnostics) && (
          <Link className="ui-button ui-button--link" to={presentation.action.to(item)}>
            {presentation.action.label} <ExternalLink aria-hidden="true" />
          </Link>
        )}
      </div>
    </article>
  );
}
