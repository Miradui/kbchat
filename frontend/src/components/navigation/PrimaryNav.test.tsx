import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { renderWithRouter } from '../../test/render';
import { PrimaryNav } from './PrimaryNav';

describe('PrimaryNav', () => {
  it('keeps the primary navigation focused on the three core user goals', async () => {
    const onNavigate = vi.fn();
    const user = userEvent.setup();
    renderWithRouter(<PrimaryNav active="documents" onNavigate={onNavigate} />);

    expect(screen.getAllByRole('link')).toHaveLength(4);
    expect(screen.getByRole('link', { name: '新建对话' })).toHaveAttribute('href', '/chat/new');
    expect(screen.getByRole('link', { name: '知识库' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'AI 问答' })).toHaveAttribute('href', '/chat');
    expect(screen.getAllByRole('link').filter((link) => link.hasAttribute('aria-current'))).toHaveLength(1);
    expect(screen.queryByRole('link', { name: '文档管理' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '标签管理' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '全局搜索' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('link', { name: 'AI 问答' }));
    expect(onNavigate).toHaveBeenCalledOnce();
  });
});
