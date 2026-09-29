import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { searchUsers } from '../api/resources';
import { TransferOwnershipDialog } from './TransferOwnershipDialog';

vi.mock('../api/resources', () => ({ searchUsers: vi.fn() }));
beforeEach(() => { vi.mocked(searchUsers).mockReset(); });
it('excludes the current owner and confirms the chosen user and retention option', async () => {
  vi.mocked(searchUsers).mockResolvedValue({ items: [{ id: 'old', username: 'old', displayName: '旧用户' }, { id: 'new', username: 'new', displayName: '新用户' }] });
  const transfer = vi.fn().mockResolvedValue({ transferredCount: 2 });
  const done = vi.fn();
  render(<TransferOwnershipDialog ownerId="old" description="包括回收站中的知识库" onTransfer={transfer} onClose={vi.fn()} onDone={done} />);
  const actor = userEvent.setup();
  expect(screen.getByRole('button', { name: '确认转移' })).toBeDisabled();
  await screen.findByRole('option', { name: '新用户（new）' });
  expect(screen.queryByRole('option', { name: '旧用户（old）' })).not.toBeInTheDocument();
  await actor.selectOptions(screen.getByLabelText('新所有者'), 'new');
  await actor.click(screen.getByRole('checkbox'));
  await actor.click(screen.getByRole('button', { name: '确认转移' }));
  expect(transfer).toHaveBeenCalledWith({ newOwnerId: 'new', keepPreviousOwnerAsManager: false });
  await waitFor(() => expect(done).toHaveBeenCalledOnce());
});
