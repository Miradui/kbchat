import type { ReactNode } from 'react';

import { classNames } from '../../utils/classNames';

export type Metric = {
  key: string;
  label: string;
  value: number | string | null;
  tone?: 'default' | 'warn' | 'danger';
  /** When present the metric becomes a filter toggle instead of static text. */
  onToggle?: () => void;
  active?: boolean;
};

type MetricStripProps = {
  label: string;
  metrics: Metric[];
  trailing?: ReactNode;
};

/**
 * A single line of counts. Replaces the decorated stat-card grids that used to
 * sit on top of every list page without being actionable.
 */
export function MetricStrip({ label, metrics, trailing }: MetricStripProps) {
  return (
    <div aria-label={label} className="ui-metrics" role="group">
      {metrics.map((metric, index) => {
        const body = (
          <>
            <strong className="ui-num">{metric.value ?? '—'}</strong>
            <span>{metric.label}</span>
          </>
        );
        const className = classNames(
          'ui-metrics__item',
          metric.tone === 'warn' && 'ui-metrics__item--warn',
          metric.tone === 'danger' && 'ui-metrics__item--danger',
        );
        return (
          <span key={metric.key} style={{ display: 'contents' }}>
            {index > 0 && <span aria-hidden="true" className="ui-metrics__sep">·</span>}
            {metric.onToggle ? (
              <button
                aria-pressed={metric.active}
                className={className}
                onClick={metric.onToggle}
                type="button"
              >
                {body}
              </button>
            ) : (
              <span className={className}>{body}</span>
            )}
          </span>
        );
      })}
      {trailing}
    </div>
  );
}
