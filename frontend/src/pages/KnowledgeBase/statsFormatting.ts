import type { WorkspaceMetric } from '../../types/api';

export function formatMetricComparison(metric: WorkspaceMetric, period: 'day' | 'month'): string {
  if (metric.changeRatio === null) {
    if (metric.value > 0) {
      return period === 'day' ? '今日新增' : '本月新增';
    }
    return '暂无可比数据';
  }

  const percentage = Math.round(metric.changeRatio * 100);
  const previousPeriod = period === 'day' ? '昨日' : '上月';
  return `较${previousPeriod} ${percentage >= 0 ? '↑' : '↓'} ${Math.abs(percentage)}%`;
}
