import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { Popover } from './Popover';

/**
 * The panel is portaled to the end of `body`, so every close path has to say where focus
 * goes. Closing without doing so leaves focus on an unmounted element, which becomes
 * `body` -- and the user has to tab from the top of the page to get back to where they
 * were. Nothing looks wrong on screen when this happens.
 */
function renderPopover() {
  render(
    <>
      <button type="button">前一个</button>
      <Popover
        label="账户菜单"
        trigger={(props) => <button type="button" {...props}>打开菜单</button>}
      >
        {(close) => (
          <>
            <button type="button" onClick={close}>菜单项</button>
            <button type="button">另一项</button>
          </>
        )}
      </Popover>
      <button type="button">后一个</button>
    </>,
  );
  return { trigger: () => screen.getByRole('button', { name: '打开菜单' }) };
}

describe('Popover focus', () => {
  it('returns focus to the trigger when a child closes it', async () => {
    const user = userEvent.setup();
    const { trigger } = renderPopover();

    await user.click(trigger());
    await user.click(screen.getByRole('button', { name: '菜单项' }));

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger()).toHaveFocus();
  });

  it('returns focus to the trigger on Escape', async () => {
    const user = userEvent.setup();
    const { trigger } = renderPopover();

    await user.click(trigger());
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger()).toHaveFocus();
  });

  it('does not lose focus when tabbing out of the panel', async () => {
    const user = userEvent.setup();
    const { trigger } = renderPopover();

    await user.click(trigger());
    await user.keyboard('{Tab}');

    // Tab out closes and lands on the trigger, so the next Tab continues through the
    // page from there. The default action is prevented on purpose: React has not
    // unmounted the panel when the browser computes Tab's destination, so allowing it
    // moves focus into the panel that is about to vanish and focus is lost to `body`.
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger()).toHaveFocus();
  });

  it('does not pull focus back when dismissed by a click elsewhere', async () => {
    const user = userEvent.setup();
    const { trigger } = renderPopover();

    await user.click(trigger());
    await user.click(screen.getByRole('button', { name: '后一个' }));

    // Clicking away is a move to somewhere else. Yanking focus back to the trigger
    // would fight the user, so only keyboard dismissal restores.
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '后一个' })).toHaveFocus();
  });

  it('moves focus into the panel when it opens', async () => {
    const user = userEvent.setup();
    const { trigger } = renderPopover();

    await user.click(trigger());

    // Without this the panel is unreachable by keyboard: it is portaled to the end of
    // `body`, so Tab from the trigger skips past it to the next element in the document.
    // Escape was broken for the same reason -- the keydown never reached the panel.
    expect(screen.getByRole('button', { name: '菜单项' })).toHaveFocus();
  });

  it('reports its state on the trigger', async () => {
    const user = userEvent.setup();
    const { trigger } = renderPopover();

    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
    await user.click(trigger());
    expect(trigger()).toHaveAttribute('aria-expanded', 'true');
  });

  it('navigates enabled menuitem and menuitemradio controls with Arrow, Home, and End keys', async () => {
    const user = userEvent.setup();
    render(
      <Popover
        label="测试菜单"
        trigger={(props) => <button {...props} type="button">打开菜单</button>}
      >
        {() => (
          <>
            <button role="menuitemradio" aria-checked="true" type="button">浅色</button>
            <button role="menuitemradio" aria-checked="false" disabled type="button">禁用项</button>
            <button role="menuitem" type="button">设置</button>
            <button role="menuitem" type="button">退出</button>
          </>
        )}
      </Popover>,
    );

    await user.click(screen.getByRole('button', { name: '打开菜单' }));
    const radio = screen.getByRole('menuitemradio', { name: '浅色' });
    const settings = screen.getByRole('menuitem', { name: '设置' });
    const logout = screen.getByRole('menuitem', { name: '退出' });

    expect(radio).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(settings).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(logout).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(radio).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(logout).toHaveFocus();
    await user.keyboard('{Home}');
    expect(radio).toHaveFocus();
    await user.keyboard('{End}');
    expect(logout).toHaveFocus();
  });
});
