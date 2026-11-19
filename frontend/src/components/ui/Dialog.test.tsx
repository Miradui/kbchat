import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Dialog, useDialogModal } from './Dialog';

afterEach(() => {
  document.body.style.overflow = '';
});

describe('Dialog', () => {
  it('isolates the application background for the first modal and restores its attributes', () => {
    const appRoot = document.createElement('div');
    appRoot.setAttribute('aria-hidden', 'false');
    document.body.append(appRoot);
    try {
      const { rerender } = render(
        <>
          <section data-testid="application-background">
            <button type="button">背景操作</button>
          </section>
          <Dialog open title="说明" onClose={() => undefined}><button type="button">确认</button></Dialog>
        </>,
        { container: appRoot },
      );
      const background = screen.getByTestId('application-background');

      expect(appRoot).toHaveAttribute('inert');
      expect(appRoot).toHaveAttribute('aria-hidden', 'true');
      expect(background.closest('[inert]')).toBe(appRoot);

      rerender(
        <>
          <section data-testid="application-background">
            <button type="button">背景操作</button>
          </section>
          <Dialog open={false} title="说明" onClose={() => undefined}><button type="button">确认</button></Dialog>
        </>,
      );

      expect(appRoot).not.toHaveAttribute('inert');
      expect(appRoot).toHaveAttribute('aria-hidden', 'false');
    } finally {
      appRoot.remove();
    }
  });

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

  it('focuses an available action while the autofocus field is disabled for loading', () => {
    const view = render(
      <Dialog open title="移动到分类" onClose={() => undefined}>
        <select data-autofocus disabled aria-label="目标分类"><option>正在加载</option></select>
        <button type="button">取消</button>
        <button type="button" disabled>确认移动</button>
      </Dialog>,
    );
    expect(screen.getByRole('button', { name: '取消' })).toHaveFocus();
    view.rerender(
      <Dialog open title="移动到分类" onClose={() => undefined}>
        <select data-autofocus aria-label="目标分类"><option>未分类</option></select>
        <button type="button">取消</button>
        <button type="button" disabled>确认移动</button>
      </Dialog>,
    );
    expect(screen.getByRole('button', { name: '取消' })).toHaveFocus();
  });

  it('skips CSS-hidden and negative-tabindex controls at both tab boundaries', async () => {
    const user = userEvent.setup();
    render(
      <Dialog open title="选择目标" onClose={() => undefined}>
        <div style={{ display: 'none' }}><input data-autofocus aria-label="隐藏字段" /></div>
        <button type="button" tabIndex={-2}>不在顺序中</button>
        <input type="hidden" />
        <button type="button">第一项</button>
        <button type="button">最后一项</button>
        <button type="button" style={{ visibility: 'hidden' }}>不可见</button>
        <button type="button" style={{ display: 'none' }}>不显示</button>
      </Dialog>,
    );
    expect(screen.getByRole('button', { name: '第一项' })).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole('button', { name: '最后一项' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: '第一项' })).toHaveFocus();
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

  it('preserves the outer opener when a lower modal unmounts before the top modal', () => {
    const opener = document.createElement('button');
    opener.textContent = '打开外层';
    document.body.append(opener);
    opener.focus();
    document.body.style.overflow = 'clip';

    const { rerender } = render(
      <>
        <Dialog open title="外层" onClose={() => undefined}><button type="button">打开内层</button></Dialog>
        <Dialog open={false} title="内层" onClose={() => undefined}><button type="button">取消</button></Dialog>
      </>,
    );
    rerender(
      <>
        <Dialog open title="外层" onClose={() => undefined}><button type="button">打开内层</button></Dialog>
        <Dialog open title="内层" onClose={() => undefined}><button type="button">取消</button></Dialog>
      </>,
    );
    rerender(
      <>
        <Dialog open={false} title="外层" onClose={() => undefined}><button type="button">打开内层</button></Dialog>
        <Dialog open title="内层" onClose={() => undefined}><button type="button">取消</button></Dialog>
      </>,
    );
    rerender(
      <>
        <Dialog open={false} title="外层" onClose={() => undefined}><button type="button">打开内层</button></Dialog>
        <Dialog open={false} title="内层" onClose={() => undefined}><button type="button">取消</button></Dialog>
      </>,
    );

    expect(document.body.style.overflow).toBe('clip');
    expect(opener).toHaveFocus();
    opener.remove();
  });

  it('keeps focus inside the remaining modal when a top modal was opened elsewhere', () => {
    const outsideOpener = document.createElement('button');
    outsideOpener.textContent = '外部触发器';
    document.body.append(outsideOpener);

    const { rerender } = render(
      <>
        <Dialog open title="底层" onClose={() => undefined}><button type="button">底层操作</button></Dialog>
        <Dialog open={false} title="顶层" onClose={() => undefined}><button type="button">顶层操作</button></Dialog>
      </>,
    );
    outsideOpener.focus();
    rerender(
      <>
        <Dialog open title="底层" onClose={() => undefined}><button type="button">底层操作</button></Dialog>
        <Dialog open title="顶层" onClose={() => undefined}><button type="button">顶层操作</button></Dialog>
      </>,
    );
    rerender(
      <>
        <Dialog open title="底层" onClose={() => undefined}><button type="button">底层操作</button></Dialog>
        <Dialog open={false} title="顶层" onClose={() => undefined}><button type="button">顶层操作</button></Dialog>
      </>,
    );

    expect(screen.getByRole('button', { name: '底层操作' })).toHaveFocus();
    expect(outsideOpener).not.toHaveFocus();
    outsideOpener.remove();
  });

  it('hides and inerts a lower modal while a nested modal is open', () => {
    const { rerender } = render(
      <>
        <Dialog open title="底层" onClose={() => undefined}><button type="button">底层操作</button></Dialog>
        <Dialog open={false} title="顶层" onClose={() => undefined}><button type="button">顶层操作</button></Dialog>
      </>,
    );
    const lowerDialog = screen.getByRole('dialog', { name: '底层' });

    rerender(
      <>
        <Dialog open title="底层" onClose={() => undefined}><button type="button">底层操作</button></Dialog>
        <Dialog open title="顶层" onClose={() => undefined}><button type="button">顶层操作</button></Dialog>
      </>,
    );
    expect(lowerDialog).toHaveAttribute('aria-hidden', 'true');
    expect(lowerDialog).toHaveAttribute('inert');

    rerender(
      <>
        <Dialog open title="底层" onClose={() => undefined}><button type="button">底层操作</button></Dialog>
        <Dialog open={false} title="顶层" onClose={() => undefined}><button type="button">顶层操作</button></Dialog>
      </>,
    );
    expect(lowerDialog).not.toHaveAttribute('aria-hidden');
    expect(lowerDialog).not.toHaveAttribute('inert');
  });

  it('keeps a top modal operable when it is rendered inside the lower modal DOM', () => {
    const { rerender } = render(
      <Dialog open title="外层" onClose={() => undefined}>
        <button type="button">打开内层</button>
      </Dialog>,
    );

    rerender(
      <Dialog open title="外层" onClose={() => undefined}>
        <button type="button">打开内层</button>
        <Dialog open title="内层" onClose={() => undefined}>
          <button type="button">确认内层</button>
        </Dialog>
      </Dialog>,
    );

    const innerDialog = screen.getByRole('dialog', { name: '内层', hidden: true });
    expect(innerDialog.parentElement?.closest('[inert]')).toBeNull();
    expect(innerDialog.parentElement?.closest('[aria-hidden="true"]')).toBeNull();
    expect(screen.getByRole('button', { name: '确认内层', hidden: true })).toHaveFocus();
  });

  it('portals to document.body so ancestor overflow or stacking contexts never clip it', () => {
    render(
      <div data-testid="clipped-ancestor" style={{ overflow: 'hidden', position: 'relative' }}>
        <Dialog open title="传送弹窗" onClose={() => undefined}>
          <button type="button">关闭</button>
        </Dialog>
      </div>,
    );

    const dialog = screen.getByRole('dialog', { name: '传送弹窗' });
    expect(dialog.closest('.ui-dialog-backdrop')?.parentElement).toBe(document.body);
    expect(screen.getByTestId('clipped-ancestor').contains(dialog)).toBe(false);
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

function NestedDialogHarness() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const panelRef = useDialogModal(drawerOpen, () => setDrawerOpen(false));
  return (
    <>
      <button type="button" onClick={() => setDrawerOpen(true)}>打开回收站</button>
      {drawerOpen && (
        <aside>
          <section aria-label="知识库回收站" aria-modal="true" ref={panelRef} role="dialog" tabIndex={-1}>
            <button type="button" onClick={() => setConfirmOpen(true)}>永久删除</button>
            <button type="button" onClick={() => setDrawerOpen(false)}>关闭回收站</button>
            <Dialog open={confirmOpen} title="确认永久删除" onClose={() => setConfirmOpen(false)}>
              <button type="button" onClick={() => setConfirmOpen(false)}>取消</button>
            </Dialog>
          </section>
        </aside>
      )}
    </>
  );
}
