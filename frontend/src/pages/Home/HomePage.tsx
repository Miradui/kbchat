import { AlertTriangle, ArrowRight, BookOpen, FileText, Library, Loader, MessageSquareText, Sparkles, Upload, UserRound } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { EmptyState } from '../../components/feedback/EmptyState';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';
import { Button } from '../../components/ui/Button';
import { useCurrentUser } from '../../hooks/useCurrentUser';
import { AppShell } from '../../layouts/AppShell';
import type {
  ActivityItemResponse,
  KnowledgeBaseStatsResponse,
} from '../../types/api';
import { formatCount, formatRelativeTime } from '../../utils/format';
import { getErrorMessage } from '../../utils/errors';
import { documentDisplayStatusLabel } from '../Documents/documentDisplay';
import { documentFailureCopy } from '../Documents/documentFailure';
import { homeQuestionState } from '../Chat/homeQuestionNavigation';
import { activityToItem } from './activityDisplay';
import { createHomeLoaders } from './homeData';
import type { HomeDocuments, HomeFailures, HomeSources } from './homeData';



/**
 * A workbench, not a dashboard.
 *
 * The previous home page was four stat cards over four independent panels, none
 * of which were actionable. This one leads with the primary action, surfaces
 * only work that needs attention, and merges the three "recent X" lists into one
 * timeline.
 */
export function HomePage({ sources }: { sources?: HomeSources }) {
  const navigate = useNavigate();
  const { user } = useCurrentUser();
  const loaders = useMemo(() => createHomeLoaders(sources), [sources]);
  const stats = useRegion(loaders.stats, null as KnowledgeBaseStatsResponse | null, '统计加载失败');
  const documents = useRegion(loaders.documents, { items: [], processingTotal: 0 } as HomeDocuments, '文档加载失败');
  const failedDocuments = useRegion(loaders.failedDocuments, { items: [], total: 0 } as HomeFailures, '失败文档加载失败');
  const activities = useRegion(loaders.activities, [] as ActivityItemResponse[], '动态加载失败');
  const [question, setQuestion] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const submittedRef = useRef(false);
  const composingRef = useRef(false);
  const questionId = useId();

  const actionableFailures = failedDocuments.data.items.filter((item) => item.jobStatus !== 'cancelled' && item.errorCode !== 'cancelled');

  // Real recorded events, not a merge of the three lists: deletes, restores and
  // membership changes have no row to reconstruct them from.
  // See docs/04-api-design.md (GET /activities).
  const activity = useMemo(
    () => activities.data.slice(0, 8).map(activityToItem),
    [activities.data],
  );

  function ask(event: FormEvent) {
    event.preventDefault();
    if (composingRef.current || submittedRef.current) return;
    const trimmed = question.trim();
    submittedRef.current = true;
    setSubmitting(true);
    if (!trimmed) navigate('/chat');
    else if (user) navigate('/chat', { state: homeQuestionState(trimmed, user.id) });
    else navigate(`/chat?q=${encodeURIComponent(trimmed)}`);
  }

  const activityLoading = activities.loading;
  const needsAttention = failedDocuments.data.total > 0 || documents.data.processingTotal > 0;

  return (
    <AppShell active="home" breadcrumbs={[{ label: '首页' }]}>
      <div className="home">
        <section aria-label="企业知识工作台" className="home-hero">
          <span className="ui-eyebrow"><Sparkles aria-hidden="true" />你的知识工作台</span>
          <h1>今天，想了解什么？</h1>
          <p className="home-hero__description">连接你的文档与答案，让每一次提问都有据可循。</p>
          <form className="home-ask" onSubmit={ask}>
            <div className="home-ask__input-row">
              <Sparkles aria-hidden="true" />
              <label className="sr-only" htmlFor={questionId}>向知识库提问</label>
              <input
                className="home-ask__input"
                enterKeyHint="send"
                id={questionId}
                onChange={(event) => setQuestion(event.target.value)}
                onCompositionStart={() => { composingRef.current = true; }}
                onCompositionEnd={() => { composingRef.current = false; }}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter') return;
                  event.preventDefault();
                  if (composingRef.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
                  event.currentTarget.form?.requestSubmit();
                }}
                placeholder="例如：新员工入职需要准备哪些材料？"
                value={question}
              />
            </div>
            <div className="home-ask__foot">
              <span><BookOpen aria-hidden="true" />从知识库中寻找答案</span>
              <Button disabled={submitting} trailingIcon={<ArrowRight aria-hidden="true" />} type="submit">提问</Button>
            </div>
          </form>
        </section>

        <nav aria-label="快捷操作" className="home-quick">
          <Link to="/knowledge-bases?intent=create">
            <span className="home-quick__icon"><Library aria-hidden="true" /></span>
            <span><strong>新建知识库</strong><small>为一个主题整理专属资料</small></span>
            <ArrowRight aria-hidden="true" />
          </Link>
          <Link to="/documents?intent=upload">
            <span className="home-quick__icon"><Upload aria-hidden="true" /></span>
            <span><strong>导入文档</strong><small>添加 PDF、DOCX、Markdown 或 TXT</small></span>
            <ArrowRight aria-hidden="true" />
          </Link>
          <Link to="/chat">
            <span className="home-quick__icon"><MessageSquareText aria-hidden="true" /></span>
            <span><strong>查看会话</strong><small>接着上次的问题继续探索</small></span>
            <ArrowRight aria-hidden="true" />
          </Link>
        </nav>

        {(needsAttention || documents.error || failedDocuments.error || documents.loading || failedDocuments.loading) && (
          <section aria-label="需要处理" className="home-attention">
            {(documents.loading || failedDocuments.loading) && !needsAttention && <LoadingSkeleton announce compact columns={1} rows={1} />}
            {documents.error && <div className="home-attention__error" role="alert"><span>处理中状态暂不可用：{documents.error}</span><Button variant="secondary" onClick={documents.reload}>重试处理中状态</Button></div>}
            {failedDocuments.error && <div className="home-attention__error" role="alert"><span>失败文档状态暂不可用：{failedDocuments.error}</span><Button variant="secondary" onClick={failedDocuments.reload}>重试失败文档状态</Button></div>}
            {failedDocuments.data.total > 0 && (
              <Link className="home-attention__row is-danger" to="/documents?status=failed">
                <AlertTriangle aria-hidden="true" />
                <span className="ui-cell-stack">
                  <strong>{formatCount(failedDocuments.data.total)} 个文档处理失败</strong>
                  <small>
                    {actionableFailures[0]
                      ? `${actionableFailures[0].filename} · ${documentFailureCopy(actionableFailures[0]).reason}`
                      : '打开文档列表查看失败原因。'}
                  </small>
                </span>
                <ArrowRight aria-hidden="true" />
              </Link>
            )}
            {documents.data.processingTotal > 0 && (
              <Link className="home-attention__row is-warn" to="/documents?status=processing">
                <Loader aria-hidden="true" />
                <span className="ui-cell-stack">
                  <strong>{formatCount(documents.data.processingTotal)} 个文档正在处理</strong>
                  <small>处理完成后即可用于问答。</small>
                </span>
                <ArrowRight aria-hidden="true" />
              </Link>
            )}
            {needsAttention && !documents.error && documents.data.items.length > 0 && (
              <div className="home-attention__recent">
                <h2>最近文档</h2>
                <ul aria-label="最近文档" className="home-attention__documents" role="list">
                  {documents.data.items.map((item) => (
                    <li key={item.id}>
                      <Link className="home-attention__document" to={`/knowledge-bases/${encodeURIComponent(item.knowledgeBaseId)}/documents?documentId=${encodeURIComponent(item.id)}`}>
                        <FileText aria-hidden="true" />
                        <span className="ui-cell-stack">
                          <strong>{item.filename}</strong>
                          <small>{item.knowledgeBaseName} · {documentDisplayStatusLabel(item.status, item.jobStatus ?? (item.status === 'failed' && item.errorCode === 'cancelled' ? 'cancelled' : undefined))}</small>
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        )}

        <section className="ui-panel home-activity">
          <div className="ui-panel__head">
            <h2>最近动态</h2>
            <span className="ui-panel__head-note">会话、知识库和文档的最新动态</span>
          </div>
          {activityLoading && activity.length === 0 ? (
            <LoadingSkeleton announce columns={1} compact rows={5} />
          ) : activities.error ? (
            <EmptyState
              action={<Button onClick={activities.reload}>重试</Button>}
              description={activities.error}
              title="动态暂不可用"
            />
          ) : activity.length === 0 ? (
            <EmptyState
              action={<Link className="ui-button ui-button--primary" to="/knowledge-bases?intent=create"><span>新建知识库</span></Link>}
              description="创建知识库并导入文档后，这里会显示最近的动态。"
              title="还没有动态"
            />
          ) : (
            <div className="home-activity__list">
              {activity.map((item) => (
                <Link className="home-activity__row" key={item.key} to={item.to}>
                  <span className={`home-activity__icon is-${item.kind}`} aria-hidden="true">
                    {item.kind === 'session' ? <MessageSquareText />
                      : item.kind === 'knowledgeBase' ? <Library />
                        : item.kind === 'member' ? <UserRound /> : <FileText />}
                  </span>
                  <span className="ui-cell-stack">
                    <strong>{item.title}</strong>
                    <small>{item.context}</small>
                  </span>
                  <span className="home-activity__time">{formatRelativeTime(item.at)}</span>
                  <ArrowRight aria-hidden="true" className="home-activity__arrow" />
                </Link>
              ))}
            </div>
          )}
        </section>

        {/* Counts as one line of text, not four decorated cards. */}
        <div className="home-stats">
          {stats.error ? (
            <span className="ui-muted">
              统计暂不可用
              <Button variant="link" onClick={stats.reload}>重试</Button>
            </span>
          ) : (
            <>
              <Stat label="个知识库" loading={stats.loading} value={stats.data?.knowledgeBases.value} />
              <Stat label="篇文档" loading={stats.loading} value={stats.data?.documents.value} />
              <Stat label="次浏览" loading={stats.loading} value={stats.data?.views.value} />
              <Stat label="条问答" loading={stats.loading} value={stats.data?.questions.value} />
            </>
          )}
        </div>
      </div>
    </AppShell>
  );
}

function Stat({ value, label, loading }: { value?: number; label: string; loading: boolean }) {
  return (
    <span className="home-stats__item">
      <strong className="ui-num">{loading && value === undefined ? '—' : formatCount(value)}</strong>
      <span>{label}</span>
    </span>
  );
}

type RegionState<T> = { data: T; loading: boolean; error: string };

/**
 * Each region loads and retries independently, so one failing endpoint never
 * blanks the sections that succeeded.
 */
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
      .catch((caught: unknown) => {
        if (activeRef.current && request === requestRef.current) {
          setState((current) => ({ ...current, loading: false, error: getErrorMessage(caught, failure) }));
        }
      });
  }, [failure, loader]);

  useEffect(() => {
    reload();
  }, [reload]);

  return { ...state, reload };
}
