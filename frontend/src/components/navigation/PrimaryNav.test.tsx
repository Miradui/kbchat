import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { renderWithRouter } from '../../test/render';
import { PrimaryNav } from './PrimaryNav';

describe('PrimaryNav', () => {
  it('renders six MVP destinations with exactly one current page', async () => {
    const onNavigate = vi.fn();
    const user = userEvent.setup();
    renderWithRouter(<PrimaryNav active="documents" onNavigate={onNavigate} />);

    expect(screen.getAllByRole('link')).toHaveLength(6);
    expect(screen.getByRole('link', { name: '文档管理' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getAllByRole('link').filter((link) => link.hasAttribute('aria-current'))).toHaveLength(1);
    expect(screen.queryByText('权限管理')).not.toBeInTheDocument();

    await user.click(screen.getByRole('link', { name: '全局搜索' }));
    expect(onNavigate).toHaveBeenCalledOnce();
  });
});
