import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { lazy, Suspense, useState } from 'react';
import { Route, Routes } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
import { getCurrentUser } from '../api/resources';
import { currentUserStore } from '../store/currentUserStore';
import { renderWithRouter } from '../test/render';
import { AppShell } from './AppShell';
import { WorkspaceLayout } from './WorkspaceLayout';

vi.mock('../api/resources', () => ({
  getCurrentUser: vi.fn(), logout: vi.fn(), searchSuggest: vi.fn().mockResolvedValue({ items: [] }),
}));
beforeEach(() => {
  currentUserStore.clear();
  vi.mocked(getCurrentUser).mockResolvedValue({ id: 'admin', username: 'admin', displayName: '管理员', role: 'admin' });
});

it('preserves the actual navigation element while a destination page loads and mounts', async () => {
  let finish!: (module: { default: typeof Documents }) => void;
  function Documents() { return <AppShell active="documents" breadcrumbs={[{ label: '文档' }]}><h1>文档内容</h1></AppShell>; }
  const load = vi.fn(() => new Promise<{ default: typeof Documents }>((resolve) => { finish = resolve; }));
  const Destination = lazy(load);
  const user = userEvent.setup();
  renderWithRouter(<Routes><Route element={<WorkspaceLayout />}>
    <Route path="/home" element={<AppShell active="home" topbarActions={<button>首页操作</button>}><h1>首页内容</h1></AppShell>} />
    <Route path="/documents" element={<Suspense fallback={<p>文档加载中</p>}><Destination /></Suspense>} />
  </Route></Routes>);
  await screen.findByRole('link', { name: '系统诊断' });
  const navigation = screen.getByRole('complementary', { name: '工作区导航' });
  await user.click(within(navigation).getByRole('link', { name: '文档' }));
  await waitFor(() => expect(load).toHaveBeenCalledOnce());
  expect(screen.getByRole('complementary', { name: '工作区导航' })).toBe(navigation);
  expect(navigation).toBeVisible();
  expect(within(navigation).getByRole('link', { name: '系统诊断' })).toBeVisible();
  await act(async () => finish({ default: Documents }));
  await screen.findByRole('heading', { name: '文档内容' });
  expect(screen.getByRole('complementary', { name: '工作区导航' })).toBe(navigation);
  expect(within(navigation).getByRole('link', { name: '文档' })).toHaveAttribute('aria-current', 'page');
  expect(screen.queryByRole('button', { name: '首页操作' })).not.toBeInTheDocument();
  expect(screen.getAllByRole('main')).toHaveLength(1);
  expect(getCurrentUser).toHaveBeenCalledOnce();
});

it('updates page controls in the persistent frame and clears them when leaving', async () => {
  function Chat() {
    const [count, setCount] = useState(0);
    return <AppShell active="chat" onNewChat={() => setCount((value) => value + 1)} newChatDisabled={count > 0}
      topbarLeading={<button>打开会话列表</button>}><p>创建次数：{count}</p></AppShell>;
  }
  const user = userEvent.setup();
  renderWithRouter(<Routes><Route element={<WorkspaceLayout />}>
    <Route path="/chat" element={<Chat />} />
    <Route path="/documents" element={<AppShell active="documents"><p>文档内容</p></AppShell>} />
  </Route></Routes>, ['/chat']);
  await user.click(screen.getByRole('button', { name: '新建对话' }));
  expect(screen.getByText('创建次数：1')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '新建对话' })).toBeDisabled();
  await user.click(screen.getByRole('link', { name: '文档' }));
  expect(screen.getByText('文档内容')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '打开会话列表' })).not.toBeInTheDocument();
  expect(screen.getByRole('link', { name: '新建对话' })).toHaveAttribute('href', '/chat');
});
