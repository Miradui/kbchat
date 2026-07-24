import { describe, expect, it } from 'vitest';

import { formatMetricComparison } from './statsFormatting';

describe('formatMetricComparison', () => {
  it('shows new activity when the previous period has no baseline', () => {
    expect(formatMetricComparison({ value: 3, changeRatio: null }, 'month')).toBe('本月新增');
  });

  it('shows no comparison when both periods have no data', () => {
    expect(formatMetricComparison({ value: 0, changeRatio: null }, 'month')).toBe('暂无可比数据');
  });

  it('formats a comparable percentage', () => {
    expect(formatMetricComparison({ value: 6, changeRatio: 1 }, 'month')).toBe('较上月 ↑ 100%');
  });
});
