import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { OverflowMenu } from './OverflowMenu';

describe('OverflowMenu', () => {
  it('supports keyboard navigation and restores focus after Escape', async () => {
    const user = userEvent.setup();
    render(
      <OverflowMenu
        label="更多操作"
        items={[
          { label: '编辑', onSelect: vi.fn() },
          { label: '删除', tone: 'danger', onSelect: vi.fn() },
        ]}
      />,
    );

    const trigger = screen.getByRole('button', { name: '更多操作' });
    await user.click(trigger);
    expect(screen.getByRole('menuitem', { name: '编辑' })).toHaveFocus();

    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: '删除' })).toHaveFocus();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('closes before invoking the selected action', async () => {
    const onSelect = vi.fn(() => {
      expect(screen.getByRole('button', { name: '更多操作' })).toHaveFocus();
    });
    const user = userEvent.setup();
    render(<OverflowMenu label="更多操作" items={[{ label: '编辑', onSelect }]} />);

    await user.click(screen.getByRole('button', { name: '更多操作' }));
    await user.click(screen.getByRole('menuitem', { name: '编辑' }));

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(onSelect).toHaveBeenCalledOnce();
  });

  it('lets users close a menu whose items are all disabled', async () => {
    const user = userEvent.setup();
    render(
      <OverflowMenu
        label="更多操作"
        items={[{ label: '编辑', disabled: true, onSelect: vi.fn() }]}
      />,
    );

    const trigger = screen.getByRole('button', { name: '更多操作' });
    await user.click(trigger);
    expect(screen.getByRole('menu')).toHaveFocus();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('does not lose focus when tabbing out of the menu', async () => {
    const user = userEvent.setup();
    render(
      <>
        <OverflowMenu label="更多操作" items={[{ label: '编辑', onSelect: vi.fn() }]} />
        <button type="button">后一个</button>
      </>,
    );

    const trigger = screen.getByRole('button', { name: '更多操作' });
    await user.click(trigger);
    await user.keyboard('{Tab}');

    // Tab closed the menu and left focus on the trigger, so the next Tab continues from
    // there. Allowing the default instead moves focus into the panel React is about to
    // unmount, and it ends up on `body` -- from where the user must tab the page again.
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});
