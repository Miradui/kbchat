import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { listAdminActivities } from '../../api/resources';
import { AdminActivities } from './AdminActivities';

vi.mock('../../api/resources', () => ({ listAdminActivities: vi.fn() }));
beforeEach(() => { vi.mocked(listAdminActivities).mockReset(); });
const entry = { id: '1', action: 'admin.user.disabled', resourceType: 'user', resourceId: 'u1', resourceName: 'Alice', actor: { id: 'a1', username: 'bob', displayName: '管理员乙' }, createdAt: '2026-09-28T00:00:00Z' };
it('shows the actor and action, paginates and refreshes after mutations', async () => {
  vi.mocked(listAdminActivities).mockResolvedValue({ items: [entry], total: 21, page: 1, pageSize: 20 });
  const view = render(<AdminActivities revision={0} />);
  expect(await screen.findByText('禁用了用户')).toBeInTheDocument();
  expect(screen.getByText('管理员乙')).toBeInTheDocument();
  await userEvent.click(within(screen.getByRole('region', { name: '操作记录' })).getByRole('button', { name: '下一页' }));
  expect(listAdminActivities).toHaveBeenLastCalledWith({ page: 2, pageSize: 20 });
  view.rerender(<AdminActivities revision={1} />);
  expect(listAdminActivities).toHaveBeenCalledTimes(3);
});
it('ignores a stale response after a newer refresh and permits retry on failure', async () => {
  let finish!: (result: Awaited<ReturnType<typeof listAdminActivities>>) => void;
  vi.mocked(listAdminActivities).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  render(<AdminActivities revision={0} />);
  vi.mocked(listAdminActivities).mockRejectedValueOnce(new Error('暂不可用'));
  await userEvent.click(screen.getByRole('button', { name: '刷新操作记录' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('无法加载操作记录');
  await act(async () => finish({ items: [entry], total: 1, page: 1, pageSize: 20 }));
  expect(screen.queryByText('Alice')).not.toBeInTheDocument();
  vi.mocked(listAdminActivities).mockResolvedValueOnce({ items: [], total: 0, page: 1, pageSize: 20 });
  await userEvent.click(screen.getByRole('button', { name: '刷新操作记录' }));
  expect(await screen.findByText('暂无操作记录。')).toBeInTheDocument();
});
