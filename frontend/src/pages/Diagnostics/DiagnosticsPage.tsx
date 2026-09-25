import { RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { getSystemDiagnostics } from '../../api/resources';
import { Link } from 'react-router-dom';
import { useCurrentUser } from '../../hooks/useCurrentUser';
import type { BadgeTone } from '../../components/ui/Badge';
import type {
  SystemDependencyState,
  SystemDiagnostics,
  SystemLatencyMetric,
} from '../../types/api';
import { getErrorMessage } from '../../utils/errors';
import { formatRelativeTime } from '../../utils/format';
import { EmptyState } from '../../components/feedback/EmptyState';
import { ErrorState } from '../../components/feedback/ErrorState';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { MetricStrip } from '../../components/ui/MetricStrip';
import { AppShell } from '../../layouts/AppShell';

type DiagnosticsSources = {
  loadDiagnostics: () => Promise<SystemDiagnostics>;
};

const defaultSources: DiagnosticsSources = {
  loadDiagnostics: getSystemDiagnostics,
};

const STATUS_LABELS: Record<SystemDependencyState, string> = {
  ok: '正常',
  degraded: '降级',
  down: '不可用',
  not_configured: '未配置',
};

const STATUS_TONES: Record<SystemDependencyState, BadgeTone> = {
  ok: 'ok',
  degraded: 'warn',
  down: 'danger',
  not_configured: 'neutral',
};

const DEPENDENCY_LABELS: Record<string, string> = {
  database: '数据库',
  redis: '缓存 Redis',
  storage: '对象存储',
};

const PROVIDER_LABELS: Record<string, string> = {
  chat: '对话模型',
  embedding: '向量模型',
  rerank: '重排模型',
  title: '标题模型',
};

const METRIC_LABELS: Record<string, string> = {
  retrieval: '检索总耗时',
  embedding: '向量化耗时',
  rerank: '重排耗时',
  chat_first_token: '首 token 延迟',
  chat_generation: '完整生成耗时',
};

/**
 * The server returns a closed reason set that deliberately excludes error text,
 * hosts and connection strings. Unknown codes fall back to neutral copy instead
 * of printing the raw code, so a future server value cannot turn this panel into
 * an accidental leak channel.
 */
const REASON_LABELS: Record<string, string> = {
  timeout: '探测超时',
  unreachable: '无法连接',
  auth_rejected: '认证被拒绝',
  not_configured: '未配置',
  not_found: '资源不存在',
  unavailable: '服务不可用',
};

/**
 * Rerank fallback reasons are a separate vocabulary from dependency failure
 * reasons, so they get their own map rather than sharing one that would silently
 * mislabel them.
 */
const FALLBACK_LABELS: Record<string, string> = {
  provider_unavailable: '重排服务不可用',
  unknown: '未知原因',
};

function fallbackLabel(reason: string): string {
  return FALLBACK_LABELS[reason] ?? '其他原因';
}

function reasonLabel(reason?: string): string {
  if (!reason) {
    return '';
  }
  return REASON_LABELS[reason] ?? '异常（详情见服务端日志）';
}

function statusLabel(status: SystemDependencyState): string {
  return STATUS_LABELS[status] ?? '未知';
}

function formatLatency(latencyMs: number | null): string {
  if (latencyMs === null || latencyMs === undefined) {
    return '—';
  }
  return `${latencyMs} ms`;
}

function formatDuration(seconds: number | null): string {
  if (seconds === null || seconds === undefined) {
    return '—';
  }
  if (seconds < 60) {
    return `${seconds} 秒`;
  }
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)} 分钟`;
  }
  if (seconds < 86400) {
    return `${Math.floor(seconds / 3600)} 小时`;
  }
  return `${Math.floor(seconds / 86400)} 天`;
}

function formatRate(rate: number | null): string {
  // Null and zero are different answers: an idle window has no rate at all, and
  // showing 0% would claim a clean record the server never reported.
  if (rate === null || rate === undefined) {
    return '暂无数据';
  }
  return `${Math.round(rate * 1000) / 10}%`;
}

function metricLabel(metric: string): string {
  return METRIC_LABELS[metric] ?? metric;
}

function latencyRow(metric: SystemLatencyMetric) {
  return (
    <tr key={metric.metric}>
      <th scope="row">{metricLabel(metric.metric)}</th>
      <td>{metric.count}</td>
      <td>{metric.p50Ms} ms</td>
      <td>{metric.p95Ms} ms</td>
      <td>{metric.maxMs} ms</td>
      <td>{metric.sampleCount}</td>
    </tr>
  );
}

export function DiagnosticsPage({ sources = defaultSources }: { sources?: DiagnosticsSources }) {
  const { user, loading, error, reload } = useCurrentUser();
  if (loading || error || user?.role !== 'admin') {
    return (
      <AppShell active="diagnostics" breadcrumbs={[{ label: '系统诊断' }]}>
        <h1>系统诊断</h1>
        {loading ? <LoadingSkeleton announce columns={3} rows={4} />
          : error ? <ErrorState title="无法确认访问权限" description={error} onRetry={reload} />
            : <>
              <ErrorState title="需要系统管理员权限" description="当前账号无法查看系统诊断。请联系系统管理员处理服务问题。" />
              <Link className="ui-button ui-button--secondary" to="/home">返回首页</Link>
            </>}
      </AppShell>
    );
  }
  return <DiagnosticsContent key={user.id} sources={sources} onForbidden={reload} />;
}

function DiagnosticsContent({ sources, onForbidden }: { sources: DiagnosticsSources; onForbidden: () => void }) {
  const [diagnostics, setDiagnostics] = useState<SystemDiagnostics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const requestRef = useRef(0);

  const reload = useCallback(async () => {
    const request = ++requestRef.current;
    setLoading(true);
    setError('');
    try {
      const response = await sources.loadDiagnostics();
      if (requestRef.current === request) setDiagnostics(response);
    } catch (loadError) {
      if (requestRef.current === request) {
        if ((loadError as { code?: string } | null)?.code === 'SYSTEM_ADMIN_REQUIRED') {
          setDiagnostics(null);
          onForbidden();
        }
        setError(getErrorMessage(loadError, '无法加载系统诊断数据'));
      }
    } finally {
      if (requestRef.current === request) setLoading(false);
    }
  }, [sources, onForbidden]);

  useEffect(() => {
    void reload();
    const epoch = requestRef;
    return () => { epoch.current += 1; };
  }, [reload]);

  const documents = diagnostics?.queues.documents;
  const cleanup = diagnostics?.queues.cleanup;
  const fallbackEntries = Object.entries(diagnostics?.rerankFallbacks ?? {});
  const rateLimitTriggers = diagnostics?.rateLimitTriggers ?? {};
  const embeddingCache = diagnostics?.embeddingCache;

  return (
    <AppShell active="diagnostics" breadcrumbs={[{ label: '系统诊断' }]}>
      <div className="diagnostics-page">
        <header className="ui-page-heading diagnostics-page__header">
          <div className="ui-page-heading__copy">
            <h1>系统诊断</h1>
            <p>依赖可用性、任务队列积压与模型调用耗时。</p>
          </div>
          <Button
            aria-label="刷新诊断数据"
            leadingIcon={<RefreshCw aria-hidden="true" />}
            loading={loading}
            loadingLabel="刷新中"
            onClick={() => { reload(); }}
            variant="secondary"
          >
            刷新
          </Button>
        </header>

        <p className={loading && diagnostics ? 'ui-muted' : 'sr-only'} role="status">{loading && diagnostics ? '正在刷新诊断数据…' : ''}</p>

        {loading && !diagnostics ? <LoadingSkeleton announce columns={3} rows={4} />
          : error ? <ErrorState description={error} onRetry={reload} title="诊断数据加载失败" />
            : diagnostics && (
              <>
                <p className="ui-muted diagnostics-page__checked-at">
                  {`检查时间：${formatRelativeTime(diagnostics.checkedAt)} · 环境：${diagnostics.env} · 整体状态：${statusLabel(diagnostics.status)}`}
                </p>

                <section aria-label="依赖状态" className="ui-panel diagnostics-section diagnostics-dependencies">
                  <h2>依赖状态</h2>
                  <ul className="diagnostics-dependencies__list">
                    {diagnostics.dependencies.map((dependency) => (
                      <li className="diagnostics-dependency" key={dependency.name}>
                        <span className="diagnostics-dependency__name">
                          {DEPENDENCY_LABELS[dependency.name] ?? dependency.name}
                        </span>
                        <Badge tone={STATUS_TONES[dependency.status] ?? 'neutral'}>
                          {statusLabel(dependency.status)}
                        </Badge>
                        <span className="ui-muted">{formatLatency(dependency.latencyMs)}</span>
                        {dependency.reason && dependency.status !== 'not_configured' && (
                          <span className="ui-inline-notice">{reasonLabel(dependency.reason)}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>

                <section aria-label="任务队列" className="ui-panel diagnostics-section diagnostics-queues">
                  <h2>任务队列</h2>
                  {documents && (
                    <MetricStrip label="文档处理队列指标" metrics={[
                      { key: 'pending', label: '排队中', value: documents.pending, tone: documents.pending > 0 ? 'warn' : 'default' },
                      { key: 'running', label: '处理中', value: documents.running },
                      { key: 'failed', label: '累计失败', value: documents.failed, tone: documents.failed > 0 ? 'danger' : 'default' },
                      { key: 'oldest', label: '最老排队时间', value: formatDuration(documents.oldestPendingSeconds) },
                      {
                        key: 'rate',
                        label: `近 ${documents.failureWindowHours} 小时失败率`,
                        value: formatRate(documents.recentFailureRate),
                        tone: (documents.recentFailureRate ?? 0) > 0.1 ? 'danger' : 'default',
                      },
                    ]} />
                  )}
                  {documents && (
                    <p className="ui-muted">
                      {`已完成 ${documents.completed} · 已取消 ${documents.cancelled} · 窗口内完成 ${documents.finishedInWindow}（失败 ${documents.failedInWindow}）· 最老处理中 ${formatDuration(documents.oldestRunningSeconds)}`}
                    </p>
                  )}
                  {cleanup && (
                    <p className="ui-muted">
                      {`对象清理队列：待处理 ${cleanup.backlog} · 重试中 ${cleanup.retrying} · 已锁定 ${cleanup.locked} · 最老等待 ${formatDuration(cleanup.oldestPendingSeconds)}`}
                    </p>
                  )}
                </section>

                <section aria-label="当前进程指标" className="ui-panel diagnostics-section diagnostics-runtime">
                  <h2>当前进程指标</h2>
                  <p className="ui-muted">限流与查询向量缓存统计随服务重启归零。</p>
                  <MetricStrip label="限流触发次数" metrics={[
                    {
                      key: 'login-rate-limit',
                      label: '登录限流',
                      value: rateLimitTriggers.login ?? 0,
                      tone: (rateLimitTriggers.login ?? 0) > 0 ? 'warn' : 'default',
                    },
                    {
                      key: 'chat-rate-limit',
                      label: '聊天限流',
                      value: rateLimitTriggers.chat ?? 0,
                      tone: (rateLimitTriggers.chat ?? 0) > 0 ? 'warn' : 'default',
                    },
                  ]} />
                  <MetricStrip label="查询向量缓存指标" metrics={[
                    { key: 'embedding-cache-hits', label: '缓存命中', value: embeddingCache?.hits ?? 0 },
                    { key: 'embedding-cache-misses', label: '缓存未命中', value: embeddingCache?.misses ?? 0 },
                    {
                      key: 'embedding-cache-errors',
                      label: '缓存错误',
                      value: embeddingCache?.errors ?? 0,
                      tone: (embeddingCache?.errors ?? 0) > 0 ? 'danger' : 'default',
                    },
                    {
                      key: 'embedding-cache-hit-rate',
                      label: '缓存命中率',
                      value: formatRate(embeddingCache?.hitRate ?? null),
                    },
                  ]} />
                </section>

                <section aria-label="模型 Provider" className="ui-panel diagnostics-section diagnostics-providers">
                  <h2>模型 Provider</h2>
                  {/* Stated plainly, because a panel that looks like a probe result
                      but is not would mislead exactly when it matters. */}
                  <p className="ui-muted">
                    这里展示配置完整性与真实调用结果，不会为了检查而额外发起计费请求。
                  </p>
                  <ul className="diagnostics-providers__list">
                    {diagnostics.providers.map((provider) => (
                      <li className="diagnostics-provider" key={provider.name}>
                        <span className="diagnostics-provider__name">
                          {PROVIDER_LABELS[provider.name] ?? provider.name}
                        </span>
                        <Badge tone={STATUS_TONES[provider.status] ?? 'neutral'}>
                          {statusLabel(provider.status)}
                        </Badge>
                        {provider.model && <span className="ui-muted">{provider.model}</span>}
                        <span className="ui-muted">
                          {`成功 ${provider.successCount} · 失败 ${provider.failureCount}`}
                        </span>
                        {provider.lastSuccessAt && (
                          <span className="ui-muted">{`最近成功 ${formatRelativeTime(provider.lastSuccessAt)}`}</span>
                        )}
                        {provider.lastFailureAt && (
                          <span className="ui-inline-notice">
                            {`最近失败 ${formatRelativeTime(provider.lastFailureAt)}${provider.lastFailureReason ? ` · ${reasonLabel(provider.lastFailureReason)}` : ''}`}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>

                <section aria-label="调用耗时" className="ui-panel diagnostics-section diagnostics-latency">
                  <h2>调用耗时</h2>
                  {diagnostics.metricsSinceRestart && (
                    <p className="ui-muted">
                      耗时与降级次数为当前进程内统计，服务重启后归零，不代表历史全量数据。
                    </p>
                  )}
                  {diagnostics.latency.length === 0
                    ? <EmptyState description="服务重启后还没有检索或生成请求。" title="暂无耗时样本" />
                    : (
                      <table className="ui-table diagnostics-latency__table">
                        <caption className="ui-visually-hidden">各阶段调用耗时分位数</caption>
                        <thead>
                          <tr>
                            <th scope="col">阶段</th>
                            <th scope="col">次数</th>
                            <th scope="col">P50</th>
                            <th scope="col">P95</th>
                            <th scope="col">最大</th>
                            <th scope="col">样本数</th>
                          </tr>
                        </thead>
                        <tbody>{diagnostics.latency.map(latencyRow)}</tbody>
                      </table>
                    )}
                  {fallbackEntries.length > 0 && (
                    <p className="ui-inline-notice">
                      {`重排降级：${fallbackEntries.map(([reason, count]) => `${fallbackLabel(reason)} ${count} 次`).join(' · ')}`}
                    </p>
                  )}
                </section>
              </>
            )}
      </div>
    </AppShell>
  );
}
