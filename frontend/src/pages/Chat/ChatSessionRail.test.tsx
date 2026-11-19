import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState } from 'react';
import { expect, it } from 'vitest';
import { Dialog } from '../../components/ui/Dialog';
import { renderWithRouter } from '../../test/render';
import { ChatSessionRail } from './ChatSessionRail';

function Fixture() {
  const [open, setOpen] = useState(false);
  const [nested, setNested] = useState(false);
  const [overlay, setOverlay] = useState(true);
  const backdropRef = useRef<HTMLButtonElement>(null);
  return <>
    <button onClick={() => setOpen(true)}>打开会话</button>
    <button onClick={() => setOverlay(false)}>桌面布局</button>
    <input aria-label="主区输入" />
    {overlay && open && <button aria-hidden="true" tabIndex={-1} data-testid="scrim" ref={backdropRef} onClick={() => setOpen(false)} />}
    <ChatSessionRail overlay={overlay} open={open} backdropRef={backdropRef} onCollapse={() => setOpen(false)}
      sessions={[]} sessionTotal={0} hasMore={false} loadingMore={false} knowledgeBases={[]} knowledgeBaseId="" scope="active"
      getSessionActions={() => []} loading={false} error="" onKnowledgeBaseChange={() => undefined} onScopeChange={() => undefined}
      onNewChat={() => setNested(true)} onRetry={() => undefined} onLoadMore={() => undefined} onNavigate={() => setOpen(false)} />
    <Dialog open={nested} title="新对话确认" onClose={() => setNested(false)}><button>确认</button></Dialog>
  </>;
}

it('isolates the drawer, traps focus and restores the trigger on Escape', async () => {
  const user = userEvent.setup();
  renderWithRouter(<Fixture />);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.querySelector('.chat-rail')).toHaveAttribute('inert');
  const trigger = screen.getByRole('button', { name: '打开会话' });
  await user.click(trigger);
  const drawer = screen.getByRole('dialog', { name: '会话列表' });
  expect(drawer).toContainElement(document.activeElement as HTMLElement);
  expect(document.querySelector('input')).toHaveAttribute('inert');
  const first = within(drawer).getByRole('button', { name: '收起会话列表' });
  first.focus();
  await user.tab({ shift: true });
  expect(drawer).toContainElement(document.activeElement as HTMLElement);
  await user.keyboard('{Escape}');
  expect(trigger).toHaveFocus();
  expect(document.querySelector('.chat-rail')).toHaveAttribute('inert');
  expect(screen.getByLabelText('主区输入')).not.toHaveAttribute('inert');
});

it('closes only the top dialog and cleans isolation when returning to desktop', async () => {
  const user = userEvent.setup();
  renderWithRouter(<Fixture />);
  await user.click(screen.getByRole('button', { name: '打开会话' }));
  await user.click(screen.getByRole('button', { name: '新建对话' }));
  expect(screen.getByRole('dialog', { name: '新对话确认' })).toBeInTheDocument();
  expect(screen.getByTestId('scrim').closest('[inert]')).not.toBeNull();
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog', { name: '新对话确认' })).toBeNull();
  expect(screen.getByRole('dialog', { name: '会话列表' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '新建对话' })).toHaveFocus();
  expect(screen.getByTestId('scrim').closest('[inert]')).toBeNull();
  // Model a breakpoint transition even while the background is inert.
  fireEvent.click(screen.getByText('桌面布局'));
  expect(screen.getByRole('complementary', { name: '会话列表' })).not.toHaveAttribute('inert');
  expect(screen.getByLabelText('主区输入')).not.toHaveAttribute('inert');
});

it('keeps its backdrop clickable without adding it to the focus cycle', async () => {
  const user = userEvent.setup();
  renderWithRouter(<Fixture />);
  const trigger = screen.getByRole('button', { name: '打开会话' });
  await user.click(trigger);
  const scrim = screen.getByTestId('scrim');
  expect(scrim).not.toHaveAttribute('inert');
  expect(scrim).toHaveAttribute('tabindex', '-1');
  expect(scrim).toHaveAttribute('aria-hidden', 'true');
  await user.click(scrim);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(trigger).toHaveFocus();
  expect(screen.getByLabelText('主区输入')).not.toHaveAttribute('inert');
});
