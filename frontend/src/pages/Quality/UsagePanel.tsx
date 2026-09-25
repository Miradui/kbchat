import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { PointerEvent } from 'react';

import { getChatUsage } from '../../api/resources';
import type { ChatUsageParams } from '../../api/resources';
import type { ChatUsageGroupBy, ChatUsageItem, ChatUsageResponse } from '../../types/api';
import { getErrorMessage } from '../../utils/errors';
import { formatNumber } from '../../utils/format';
import { EmptyState } from '../../components/feedback/EmptyState';
import { ErrorState } from '../../components/feedback/ErrorState';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';
import { MetricStrip } from '../../components/ui/MetricStrip';
import type { Metric } from '../../components/ui/MetricStrip';
import { SegmentedControl } from '../../components/ui/SegmentedControl';

export type UsageRangePreset = '7d' | '30d';

const RANGE_OPTIONS: Array<{ value: UsageRangePreset; label: string; days: number }> = [
  { value: '7d', label: '最近 7 天', days: 7 },
  { value: '30d', label: '最近 30 天', days: 30 },
];

const GROUP_OPTIONS: Array<{ value: ChatUsageGroupBy; label: string }> = [
  { value: 'day', label: '按天' },
  { value: 'knowledgeBase', label: '按知识库' },
  { value: 'user', label: '按用户' },
  { value: 'model', label: '按模型' },
];

const GROUP_COLUMN_LABEL: Record<ChatUsageGroupBy, string> = {
  day: '日期', knowledgeBase: '知识库', user: '用户', model: '模型',
};

const DAY_MS = 24 * 60 * 60 * 1000;

type UsageLoader = (params: ChatUsageParams) => Promise<ChatUsageResponse>;

/**
 * The window is computed in UTC because the server buckets days in UTC: a local
 * midnight boundary would make the first and last bar cover partial days.
 */
export function usageRange(preset: UsageRangePreset, now = Date.now()): { from: string; to: string } {
  const days = RANGE_OPTIONS.find((option) => option.value === preset)?.days ?? 7;
  const end = new Date(now);
  const endDay = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  const from = new Date(endDay - (days - 1) * DAY_MS);
  const to = new Date(endDay + DAY_MS - 1);
  return { from: from.toISOString(), to: to.toISOString() };
}

function utcDayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Every day in [from, to] gets a row; days the server omitted become 0. A
 * missing day is still a day with no usage, and skipping it would draw the line
 * straight across the gap as if that day never happened.
 */
export function fillMissingDays(items: ChatUsageItem[], from: string, to: string): ChatUsageItem[] {
  const byKey = new Map(items.map((item) => [item.groupKey, item]));
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return items;
  const startDay = Date.UTC(new Date(start).getUTCFullYear(), new Date(start).getUTCMonth(), new Date(start).getUTCDate());
  const filled: ChatUsageItem[] = [];
  for (let day = startDay; day <= end; day += DAY_MS) {
    const key = utcDayKey(day);
    filled.push(byKey.get(key) ?? { groupKey: key, groupLabel: key, promptTokens: 0, completionTokens: 0, totalTokens: 0, calls: 0, estimatedCost: null });
  }
  // Keys the server sent that fall outside the window (clock skew, a wider
  // server-side range) still deserve a row rather than silently vanishing.
  const known = new Set(filled.map((item) => item.groupKey));
  items.filter((item) => !known.has(item.groupKey)).forEach((item) => filled.push(item));
  return filled.sort((a, b) => a.groupKey.localeCompare(b.groupKey));
}

/** 2 decimals once the amount reaches a whole unit; up to 4 below that so sub-cent costs do not round to 0.01. */
export function formatCost(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  const maximumFractionDigits = Math.abs(value) >= 1 ? 2 : 4;
  return value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits });
}

type UsagePanelProps = {
  knowledgeBaseId?: string;
  loadUsage?: UsageLoader;
  /** Injected for deterministic tests; defaults to the wall clock. */
  now?: () => number;
};

export function UsagePanel({ knowledgeBaseId = '', loadUsage = getChatUsage, now = Date.now }: UsagePanelProps) {
  const [range, setRange] = useState<UsageRangePreset>('7d');
  const [groupBy, setGroupBy] = useState<ChatUsageGroupBy>('day');
  const [usage, setUsage] = useState<ChatUsageResponse | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const request = useRef(0);

  useEffect(() => {
    const current = ++request.current;
    setError('');
    setLoading(true);
    const { from, to } = usageRange(range, now());
    void loadUsage({ groupBy, from, to, ...(knowledgeBaseId ? { knowledgeBaseId } : {}) })
      .then((result) => {
        if (current !== request.current) return;
        setUsage(result);
        setLoading(false);
      })
      .catch((cause: unknown) => {
        if (current !== request.current) return;
        setError(getErrorMessage(cause, '用量统计加载失败'));
        setLoading(false);
      });
  }, [groupBy, knowledgeBaseId, loadUsage, now, range]);

  const rows = useMemo(() => {
    if (!usage) return [];
    return groupBy === 'day' && usage.groupBy === 'day' ? fillMissingDays(usage.items, usage.from, usage.to) : usage.items;
  }, [groupBy, usage]);

  const showCost = Boolean(usage?.pricingConfigured);
  const showRowCost = showCost && groupBy === 'model';
  const rangeLabel = RANGE_OPTIONS.find((option) => option.value === range)?.label ?? '';

  return <section aria-label="模型用量" className="ui-panel quality-overview quality-usage">
    <div className="ui-panel__head">
      <div>
        <h2>模型用量</h2>
        <span className="ui-panel__head-note">{rangeLabel}，{GROUP_OPTIONS.find((option) => option.value === groupBy)?.label}汇总；Provider 未返回 usage 的调用不会估算</span>
      </div>
    </div>
    <div className="quality-usage__controls">
      <SegmentedControl label="统计范围" onChange={setRange} options={RANGE_OPTIONS.map(({ value, label }) => ({ value, label }))} value={range} />
      <SegmentedControl label="分组" onChange={setGroupBy} options={GROUP_OPTIONS} value={groupBy} />
    </div>
    {error ? <ErrorState description={error} title="用量统计加载失败" />
      : !usage ? <LoadingSkeleton announce columns={4} rows={2} />
        : <div aria-busy={loading || undefined} className={loading ? 'quality-usage__body is-refreshing' : 'quality-usage__body'}>
          <UsageTotals showCost={showCost} usage={usage} />
          {usage.items.length === 0
            ? <EmptyState description="所选范围内没有记录到模型调用。" title="暂无用量数据" />
            : <>
              {groupBy === 'day' && usage.groupBy === 'day' && <UsageLineChart rows={rows} />}
              <UsageTable groupBy={groupBy} rows={rows} showCost={showRowCost} />
            </>}
        </div>}
  </section>;
}

function UsageTotals({ usage, showCost }: { usage: ChatUsageResponse; showCost: boolean }) {
  const calls = usage.items.reduce((sum, item) => sum + item.calls, 0);
  const metrics: Metric[] = [
    { key: 'prompt', label: 'Prompt tokens', value: formatNumber(usage.totalPromptTokens) },
    { key: 'completion', label: 'Completion tokens', value: formatNumber(usage.totalCompletionTokens) },
    { key: 'total', label: 'Total tokens', value: formatNumber(usage.totalTokens) },
    { key: 'calls', label: '调用次数', value: formatNumber(calls) },
  ];
  if (showCost) metrics.push({ key: 'cost', label: '估算成本', value: formatCost(usage.estimatedCost) });
  return <>
    <MetricStrip label="用量总计" metrics={metrics} />
    {!usage.pricingConfigured
      ? <p className="ui-muted quality-overview__note">未配置 MODEL_PRICING，仅显示 token 数</p>
      : usage.unpricedModels.length > 0 && <p className="ui-muted quality-overview__note">
        以下模型未配置价格，其用量未计入估算成本：{usage.unpricedModels.join('、')}
      </p>}
  </>;
}

function UsageTable({ rows, groupBy, showCost }: { rows: ChatUsageItem[]; groupBy: ChatUsageGroupBy; showCost: boolean }) {
  return <div className="ui-table-wrap">
    <table className="ui-table quality-usage__table">
      <thead><tr>
        <th scope="col">{groupBy === 'day' ? GROUP_COLUMN_LABEL.day : '名称'}</th>
        <th scope="col">Prompt</th><th scope="col">Completion</th><th scope="col">Total</th><th scope="col">调用次数</th>
        {showCost && <th scope="col">估算成本</th>}
      </tr></thead>
      <tbody>{rows.map((item) => <tr key={item.groupKey}>
        <td title={groupBy === 'day' ? undefined : item.groupKey}>{groupBy === 'day' ? item.groupKey : item.groupLabel || item.groupKey}</td>
        <td>{formatNumber(item.promptTokens)}</td>
        <td>{formatNumber(item.completionTokens)}</td>
        <td>{formatNumber(item.totalTokens)}</td>
        <td>{formatNumber(item.calls)}</td>
        {showCost && <td>{formatCost(item.estimatedCost)}</td>}
      </tr>)}</tbody>
    </table>
  </div>;
}

/* ---- Line chart ---------------------------------------------------------- */

const CHART = { width: 720, height: 220, top: 16, right: 20, bottom: 32, left: 56 };

/** Round the axis ceiling up to a clean 1/2/5 × 10^n step so ticks read as whole numbers. */
function niceCeiling(max: number): { ceiling: number; step: number } {
  if (max <= 0) return { ceiling: 4, step: 1 };
  const rough = max / 4;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const candidates = [1, 2, 5, 10].map((factor) => factor * magnitude);
  const step = candidates.find((candidate) => candidate >= rough) ?? candidates[candidates.length - 1];
  return { ceiling: Math.ceil(max / step) * step, step };
}

function compactTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value % 1_000 === 0 ? 0 : 1)}K`;
  return String(value);
}

function shortDay(key: string): string {
  const parts = key.split('-');
  return parts.length === 3 ? `${Number(parts[1])}/${Number(parts[2])}` : key;
}

function UsageLineChart({ rows }: { rows: ChatUsageItem[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const titleId = useId();
  const max = rows.reduce((peak, item) => Math.max(peak, item.totalTokens), 0);
  const { ceiling, step } = niceCeiling(max);
  const plotWidth = CHART.width - CHART.left - CHART.right;
  const plotHeight = CHART.height - CHART.top - CHART.bottom;
  const x = (index: number) => CHART.left + (rows.length === 1 ? plotWidth / 2 : (index / (rows.length - 1)) * plotWidth);
  const y = (value: number) => CHART.top + plotHeight - (value / ceiling) * plotHeight;
  const points = rows.map((item, index) => ({ x: x(index), y: y(item.totalTokens), item }));
  const path = points.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(' ');
  const area = `${path} L${points[points.length - 1].x.toFixed(1)} ${(CHART.top + plotHeight).toFixed(1)} L${points[0].x.toFixed(1)} ${(CHART.top + plotHeight).toFixed(1)} Z`;
  const ticks: number[] = [];
  for (let value = 0; value <= ceiling; value += step) ticks.push(value);
  // Label at most ~8 dates so a 30-day axis does not collide.
  const labelEvery = Math.max(1, Math.ceil(rows.length / 8));
  const peakIndex = rows.reduce((best, item, index) => (item.totalTokens > rows[best].totalTokens ? index : best), 0);
  const active = hover === null ? null : points[hover];
  const label = `最近 ${rows.length} 天每日 token 用量折线图，${rows[0].groupKey} 至 ${rows[rows.length - 1].groupKey}，峰值 ${formatNumber(rows[peakIndex].totalTokens)} tokens（${rows[peakIndex].groupKey}）`;

  function onPointerMove(event: PointerEvent<SVGSVGElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width === 0) return;
    const localX = ((event.clientX - rect.left) / rect.width) * CHART.width;
    let nearest = 0;
    points.forEach((point, index) => { if (Math.abs(point.x - localX) < Math.abs(points[nearest].x - localX)) nearest = index; });
    setHover(nearest);
  }

  return <figure className="quality-usage__chart">
    <svg
      aria-labelledby={titleId}
      className="quality-usage__svg"
      onPointerLeave={() => setHover(null)}
      onPointerMove={onPointerMove}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      viewBox={`0 0 ${CHART.width} ${CHART.height}`}
    >
      <title id={titleId}>{label}</title>
      {ticks.map((value) => <g key={value}>
        <line className="quality-usage__grid" x1={CHART.left} x2={CHART.width - CHART.right} y1={y(value)} y2={y(value)} />
        <text className="quality-usage__tick" textAnchor="end" x={CHART.left - 8} y={y(value) + 4}>{compactTokens(value)}</text>
      </g>)}
      <line className="quality-usage__axis" x1={CHART.left} x2={CHART.width - CHART.right} y1={CHART.top + plotHeight} y2={CHART.top + plotHeight} />
      {points.map((point, index) => (index % labelEvery === 0 || index === points.length - 1) && (
        <text className="quality-usage__tick" key={point.item.groupKey} textAnchor="middle" x={point.x} y={CHART.height - 10}>{shortDay(point.item.groupKey)}</text>
      ))}
      <path className="quality-usage__area" d={area} />
      <path className="quality-usage__line" d={path} />
      {active && <line className="quality-usage__crosshair" x1={active.x} x2={active.x} y1={CHART.top} y2={CHART.top + plotHeight} />}
      {points.map((point, index) => (index === peakIndex || index === points.length - 1 || index === hover) && (
        <circle className="quality-usage__dot" cx={point.x} cy={point.y} key={point.item.groupKey} r={4} />
      ))}
      <text className="quality-usage__label" textAnchor={peakIndex === points.length - 1 ? 'end' : 'middle'} x={points[peakIndex].x} y={points[peakIndex].y - 10}>
        {formatNumber(rows[peakIndex].totalTokens)}
      </text>
    </svg>
    {active && <figcaption aria-live="polite" className="quality-usage__tooltip" style={{ left: `${(active.x / CHART.width) * 100}%` }}>
      <strong>{formatNumber(active.item.totalTokens)} tokens</strong>
      <span>{active.item.groupKey} · {formatNumber(active.item.calls)} 次调用</span>
    </figcaption>}
  </figure>;
}
