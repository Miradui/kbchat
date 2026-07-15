import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ConfirmDialog } from './ConfirmDialog';

describe('ConfirmDialog', () => {
  it('blocks every close and submit path while busy', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        busy
        description="确认删除？"
        onCancel={onCancel}
        onConfirm={onConfirm}
        title="删除"
      />,
    );

    expect(screen.getByRole('button', { name: '取消' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '处理中' })).toBeDisabled();
    await user.keyboard('{Escape}');
    await user.click(screen.getByTestId('dialog-backdrop'));

    expect(onCancel).not.toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('shows a localized mutation error inside the dialog', () => {
    render(
      <ConfirmDialog
        description="确认删除？"
        error="标签仍被知识库引用"
        onCancel={() => undefined}
        onConfirm={() => undefined}
        title="删除标签"
      />,
    );

    expect(screen.getByRole('dialog', { name: '删除标签' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('标签仍被知识库引用');
  });
});
