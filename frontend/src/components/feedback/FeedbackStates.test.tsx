import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { LoadingSkeleton } from '../LoadingSkeleton';
import { EmptyState } from './EmptyState';
import { ErrorState } from './ErrorState';

describe('feedback states', () => {
  it('renders an actionable empty state', () => {
    render(
      <EmptyState
        action={<button type="button">新建知识库</button>}
        description="创建后即可上传文档"
        title="暂无知识库"
      />,
    );

    expect(screen.getByRole('heading', { name: '暂无知识库' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '新建知识库' })).toBeInTheDocument();
  });

  it('lets the user retry a failed region', async () => {
    const onRetry = vi.fn();
    render(<ErrorState description="无法读取数据" onRetry={onRetry} title="加载失败" />);

    await userEvent.click(screen.getByRole('button', { name: '重试' }));

    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('announces only skeletons marked as region-level loading', () => {
    const { container, rerender } = render(<LoadingSkeleton announce rows={1} columns={1} />);

    expect(screen.getByRole('status', { name: '正在加载' })).toBeInTheDocument();
    expect(container.querySelector('.skeleton-row')).toHaveAttribute('aria-hidden', 'true');

    rerender(<LoadingSkeleton rows={1} columns={1} />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(container.querySelector('.skeleton-stack')).toHaveAttribute('aria-hidden', 'true');
  });
});
