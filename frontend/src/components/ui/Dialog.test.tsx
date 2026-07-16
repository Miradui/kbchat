import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Dialog, useDialogModal } from './Dialog';

afterEach(() => {
  document.body.style.overflow = '';
});

describe('Dialog', () => {
  it('traps focus in both directions, closes on Escape, and restores state', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const opener = document.createElement('button');
    opener.textContent = '打开';
    document.body.append(opener);
    opener.focus();
    document.body.style.overflow = 'clip';

    const { rerender } = render(
      <Dialog open title="删除知识库" onClose={onClose}>
        <button type="button">取消</button><button type="button">删除</button>
      </Dialog>,
    );
    const cancel = screen.getByRole('button', { name: '取消' });
    const remove = screen.getByRole('button', { name: '删除' });
    expect(cancel).toHaveFocus();
    expect(document.body.style.overflow).toBe('hidden');

    await user.tab({ shift: true });
    expect(remove).toHaveFocus();
    await user.tab();
    expect(cancel).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();

    rerender(<Dialog open={false} title="删除知识库" onClose={onClose}><button type="button">取消</button></Dialog>);
    expect(document.body.style.overflow).toBe('clip');
    expect(opener).toHaveFocus();
    opener.remove();
  });

  it('skips hidden, inert, and effectively disabled controls during focus wrapping', async () => {
    const user = userEvent.setup();
    const { unmount } = render(
      <Dialog open title="编辑" onClose={() => undefined}>
        <div hidden><button type="button">隐藏按钮</button></div>
        <div inert><button type="button">惰性按钮</button></div>
        <fieldset disabled><button type="button">禁用按钮</button></fieldset>
        <button type="button">可见按钮一</button>
        <button type="button">可见按钮二</button>
      </Dialog>,
    );
    const first = screen.getByRole('button', { name: '可见按钮一' });
    const last = screen.getByRole('button', { name: '可见按钮二' });
    expect(first).toHaveFocus();
    await user.tab({ shift: true });
    expect(last).toHaveFocus();
    await user.tab();
    expect(first).toHaveFocus();

    unmount();
    render(<Dialog open title="空对话框" onClose={() => undefined}><p>没有控件</p></Dialog>);
    expect(screen.getByRole('dialog', { name: '空对话框' })).toHaveFocus();
  });

  it('closes from the backdrop but not from the panel', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Dialog open title="说明" onClose={onClose}><p>内容</p></Dialog>);

    await user.click(screen.getByText('内容'));
    expect(onClose).not.toHaveBeenCalled();
    await user.click(screen.getByTestId('dialog-backdrop'));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('does not try to focus a removed opener', () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const focusSpy = vi.spyOn(opener, 'focus');
    const { rerender } = render(<Dialog open title="说明" onClose={() => undefined}><p>内容</p></Dialog>);
    opener.remove();

    expect(() => rerender(<Dialog open={false} title="说明" onClose={() => undefined}><p>内容</p></Dialog>)).not.toThrow();
    expect(focusSpy).not.toHaveBeenCalled();
  });

  it('reuses modal keyboard behavior in drawer-shaped panels', async () => {
    const user = userEvent.setup();
    render(<DrawerHarness />);
    const opener = screen.getByRole('button', { name: '打开抽屉' });

    await user.click(opener);

    const close = screen.getByRole('button', { name: '关闭抽屉' });
    const input = screen.getByLabelText('抽屉字段');
    expect(close).toHaveFocus();
    expect(document.body.style.overflow).toBe('hidden');
    await user.tab({ shift: true });
    expect(input).toHaveFocus();
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog', { name: '测试抽屉' })).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
    expect(document.body.style.overflow).toBe('');
  });
});

function DrawerHarness() {
  const [open, setOpen] = useState(false);
  const panelRef = useDialogModal(open, () => setOpen(false));
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>打开抽屉</button>
      {open && (
        <aside>
          <section aria-label="测试抽屉" aria-modal="true" ref={panelRef} role="dialog" tabIndex={-1}>
            <button type="button" onClick={() => setOpen(false)}>关闭抽屉</button>
            <label>抽屉字段<input /></label>
          </section>
        </aside>
      )}
    </>
  );
}
