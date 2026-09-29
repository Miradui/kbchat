import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../api/client';
import {
  createAdminUser,
  getCurrentUser,
  listAdminUsers,
  listAdminActivities,
  searchUsers,
  transferUserKnowledgeBases,
  resetAdminUserPassword,
  updateAdminUser,
  updateAdminUserRole,
} from '../../api/resources';
import { currentUserStore } from '../../store/currentUserStore';
import { renderWithRouter } from '../../test/render';
import type { AdminUser } from '../../types/api';
import { UsersPage } from './UsersPage';

vi.mock('../../api/resources', () => ({
  getCurrentUser: vi.fn(),
  logout: vi.fn().mockResolvedValue(undefined),
  searchSuggest: vi.fn().mockResolvedValue({ items: [] }),
  listAdminUsers: vi.fn(),
  listAdminActivities: vi.fn(),
  searchUsers: vi.fn(),
  transferUserKnowledgeBases: vi.fn(),
  createAdminUser: vi.fn(),
  updateAdminUser: vi.fn(),
  resetAdminUserPassword: vi.fn(),
  updateAdminUserRole: vi.fn(),
}));

const clipboardMocks = vi.hoisted(() => ({ copyText: vi.fn() }));
vi.mock('../../utils/clipboard', () => clipboardMocks);

vi.mock('../../hooks/useSystemCapabilities', () => ({
  useSystemCapabilities: () => ({
    rerankEnabled: false,
    keywordSearchEnabled: true,
    chatModels: [],
    upload: { maxFileBytes: 1, allowedExtensions: ['txt'] },
    retrieval: { maxVectorTopN: 100, maxRerankTopK: 20 },
    account: {
      // Deliberately not the default 8, so a test that passes is proof the
      // page reads the server value rather than a hardcoded one.
      minPasswordLength: 10,
      maxPasswordBytes: 72,
      maxDisplayNameLength: 128,
      maxAvatarUrlLength: 512,
      maxAvatarBytes: 2097152,
      avatarSize: 256,
      avatarContentTypes: ['image/png', 'image/jpeg'],
    },
  }),
}));

const admin = { id: 'admin-1', username: 'admin', displayName: '管理员', role: 'admin' };

function user(overrides: Partial<AdminUser> = {}): AdminUser {
  return {
    id: 'user-1',
    username: 'alice',
    displayName: 'Alice',
    role: 'user',
    status: 'active',
    lastLoginAt: null,
    createdAt: '2026-09-01T00:00:00Z',
    ownedKnowledgeBaseCount: 0,
    ...overrides,
  };
}

const selfRow = user({ id: admin.id, username: admin.username, displayName: admin.displayName, role: 'admin' });

function mockList(items: AdminUser[], total = items.length, page = 1, pageSize = 20) {
  vi.mocked(listAdminUsers).mockResolvedValue({ items, total, page, pageSize });
}

function renderUsersPage() {
  return renderWithRouter(
    <Routes>
      <Route element={<UsersPage />} path="/admin/users" />
      <Route element={<h1>首页</h1>} path="/home" />
    </Routes>,
    ['/admin/users'],
  );
}

beforeEach(() => {
  currentUserStore.clear();
  vi.mocked(getCurrentUser).mockReset().mockResolvedValue(admin);
  vi.mocked(listAdminUsers).mockReset();
  vi.mocked(createAdminUser).mockReset();
  vi.mocked(updateAdminUser).mockReset();
  vi.mocked(resetAdminUserPassword).mockReset();
  vi.mocked(updateAdminUserRole).mockReset();
  clipboardMocks.copyText.mockReset().mockResolvedValue(undefined);
  vi.mocked(listAdminActivities).mockReset().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });
  mockList([selfRow, user()]);
});

describe('UsersPage', () => {
  it('warns about owned knowledge bases before disabling and can transfer them', async () => {
    mockList([user({ ownedKnowledgeBaseCount: 2 })]);
    vi.mocked(searchUsers).mockResolvedValue({ items: [{ id: 'new', username: 'new', displayName: '新所有者' }] });
    vi.mocked(transferUserKnowledgeBases).mockResolvedValue({ transferredCount: 2 });
    renderUsersPage();
    const actor = userEvent.setup();
    await actor.click(await screen.findByRole('button', { name: '禁用 alice' }));
    const confirmation = screen.getByRole('dialog', { name: '禁用用户' });
    expect(confirmation).toHaveTextContent('拥有 2 个知识库（含回收站）');
    await actor.click(within(confirmation).getByRole('button', { name: '取消' }));
    await actor.click(screen.getByRole('button', { name: '转移 alice 的知识库' }));
    expect(screen.getByRole('dialog', { name: '转移所有权' })).toHaveTextContent('全部 2 个知识库');
    await screen.findByRole('option', { name: '新所有者（new）' });
    await actor.selectOptions(screen.getByLabelText('新所有者'), 'new');
    await actor.click(screen.getByRole('button', { name: '确认转移' }));
    await waitFor(() => expect(transferUserKnowledgeBases).toHaveBeenCalledWith('user-1', { newOwnerId: 'new', keepPreviousOwnerAsManager: true }));
  });
  it.each(['success', 'failure'])('ignores an older list %s after a newer search finishes', async (outcome) => {
    let resolveOld!: (value: Awaited<ReturnType<typeof listAdminUsers>>) => void;
    let rejectOld!: (error: Error) => void;
    vi.mocked(listAdminUsers).mockImplementationOnce(() => new Promise((resolve, reject) => { resolveOld = resolve; rejectOld = reject; }));
    renderUsersPage();
    const input = await screen.findByRole('searchbox', { name: '搜索用户' });
    const actor = userEvent.setup();
    mockList([user({ username: 'newest' })]);
    await actor.type(input, 'newest{Enter}');
    expect(await screen.findByText('newest')).toBeInTheDocument();
    await act(async () => {
      if (outcome === 'success') resolveOld({ items: [user({ username: 'stale' })], total: 99, page: 1, pageSize: 20 });
      else rejectOld(new Error('旧请求失败'));
    });
    expect(screen.queryByText('stale')).not.toBeInTheDocument();
    expect(screen.queryByText('旧请求失败')).not.toBeInTheDocument();
    expect(screen.getByText('newest')).toBeInTheDocument();
  });

  it('refreshes current filters after a slow user update completes', async () => {
    let finishUpdate!: (value: AdminUser) => void;
    vi.mocked(updateAdminUser).mockImplementationOnce(() => new Promise((resolve) => { finishUpdate = resolve; }));
    mockList([user({ status: 'disabled' })]);
    renderUsersPage();
    const actor = userEvent.setup();
    await actor.click(await screen.findByRole('button', { name: '启用 alice' }));
    mockList([user({ username: 'newest' })]);
    await actor.type(screen.getByRole('searchbox', { name: '搜索用户' }), 'newest{Enter}');
    await screen.findByText('newest');
    const readsBeforeUpdate = vi.mocked(listAdminUsers).mock.calls.length;
    await act(async () => finishUpdate(user()));
    await waitFor(() => expect(listAdminUsers).toHaveBeenCalledTimes(readsBeforeUpdate + 1));
    expect(listAdminUsers).toHaveBeenLastCalledWith(expect.objectContaining({ q: 'newest', page: 1 }));
  });
  it('redirects an ordinary user away and shows no admin navigation', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue({ id: 'u-9', username: 'reader', displayName: '普通用户', role: 'user' });
    renderUsersPage();
    expect(await screen.findByRole('heading', { name: '首页' })).toBeInTheDocument();
    expect(listAdminUsers).not.toHaveBeenCalled();
    expect(screen.queryByRole('link', { name: '用户管理' })).not.toBeInTheDocument();
  });

  it('redirects when the current account cannot be determined', async () => {
    vi.mocked(getCurrentUser).mockRejectedValue(new Error('unavailable'));
    renderUsersPage();
    expect(await screen.findByRole('heading', { name: '首页' })).toBeInTheDocument();
    expect(listAdminUsers).not.toHaveBeenCalled();
  });

  it('renders the list for an administrator and shows the nav entry', async () => {
    renderUsersPage();
    expect(await screen.findByRole('heading', { name: '用户管理' })).toBeInTheDocument();
    const table = await screen.findByRole('table', { name: /用户列表/ });
    expect(within(table).getByText('alice')).toBeInTheDocument();
    expect(within(table).getByText('Alice')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '用户管理' })).toHaveAttribute('href', '/admin/users');
    expect(listAdminUsers).toHaveBeenCalledWith({ q: '', status: '', role: '', page: 1, pageSize: 20 });
  });

  it('sends q, status and role filters to the API and resets to the first page', async () => {
    const typing = userEvent.setup();
    mockList([selfRow, user()], 45);
    renderUsersPage();
    await screen.findByRole('table', { name: /用户列表/ });

    await typing.click(screen.getByRole('button', { name: '下一页' }));
    await waitFor(() => {
      expect(listAdminUsers).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 }));
    });

    await typing.type(screen.getByLabelText('搜索用户'), 'ali');
    await waitFor(() => {
      expect(listAdminUsers).toHaveBeenLastCalledWith(expect.objectContaining({ q: 'ali', page: 1 }));
    });

    await typing.selectOptions(screen.getByLabelText('状态筛选'), 'disabled');
    await waitFor(() => {
      expect(listAdminUsers).toHaveBeenLastCalledWith(expect.objectContaining({ q: 'ali', status: 'disabled', page: 1 }));
    });

    await typing.selectOptions(screen.getByLabelText('角色筛选'), 'admin');
    await waitFor(() => {
      expect(listAdminUsers).toHaveBeenLastCalledWith(expect.objectContaining({ q: 'ali', status: 'disabled', role: 'admin', page: 1 }));
    });
  });

  it('paginates with the server total and page size', async () => {
    const clicking = userEvent.setup();
    mockList([user()], 45, 1, 20);
    renderUsersPage();
    await screen.findByRole('table', { name: /用户列表/ });
    const pagination = screen.getByRole('navigation', { name: '分页' });
    expect(within(pagination).getByText('共 45 条')).toBeInTheDocument();
    expect(within(pagination).getByRole('button', { name: '上一页' })).toBeDisabled();
    expect(within(pagination).getByRole('button', { name: '第 3 页' })).toBeInTheDocument();

    await clicking.selectOptions(within(pagination).getByLabelText('每页数量'), '50');
    await waitFor(() => {
      expect(listAdminUsers).toHaveBeenLastCalledWith(expect.objectContaining({ page: 1, pageSize: 50 }));
    });
  });

  it('hides disable, role and reset actions on the current administrator row', async () => {
    renderUsersPage();
    const table = await screen.findByRole('table', { name: /用户列表/ });
    const rows = within(table).getAllByRole('row');
    const selfRowElement = rows.find((row) => within(row).queryByText('admin'));
    const otherRow = rows.find((row) => within(row).queryByText('alice'));
    expect(selfRowElement).toBeDefined();
    expect(otherRow).toBeDefined();

    expect(within(selfRowElement as HTMLElement).getByRole('button', { name: '编辑 admin' })).toBeInTheDocument();
    expect(within(selfRowElement as HTMLElement).queryByRole('button', { name: /禁用 admin/ })).not.toBeInTheDocument();
    expect(within(selfRowElement as HTMLElement).queryByRole('button', { name: /撤销 admin/ })).not.toBeInTheDocument();
    expect(within(selfRowElement as HTMLElement).queryByRole('button', { name: /重置 admin/ })).not.toBeInTheDocument();

    expect(within(otherRow as HTMLElement).getByRole('button', { name: '禁用 alice' })).toBeInTheDocument();
    expect(within(otherRow as HTMLElement).getByRole('button', { name: '授予 alice 管理员' })).toBeInTheDocument();
    expect(within(otherRow as HTMLElement).getByRole('button', { name: '重置 alice 的密码' })).toBeInTheDocument();
  });

  describe('create dialog', () => {
    it('requires a username and enforces the server minimum password length', async () => {
      const typing = userEvent.setup();
      renderUsersPage();
      await screen.findByRole('table', { name: /用户列表/ });
      await typing.click(screen.getByRole('button', { name: '创建用户' }));
      const dialog = await screen.findByRole('dialog', { name: '创建用户' });

      await typing.click(within(dialog).getByRole('button', { name: '创建' }));
      expect(await within(dialog).findByText('请输入用户名')).toBeInTheDocument();
      expect(createAdminUser).not.toHaveBeenCalled();

      await typing.type(within(dialog).getByLabelText('用户名'), 'has space');
      await typing.click(within(dialog).getByRole('button', { name: '创建' }));
      expect(await within(dialog).findByText(/不能包含空格/)).toBeInTheDocument();
      expect(createAdminUser).not.toHaveBeenCalled();

      await typing.clear(within(dialog).getByLabelText('用户名'));
      await typing.type(within(dialog).getByLabelText('用户名'), 'bob');
      // 9 characters: valid against the default 8 but short of the mocked 10.
      await typing.type(within(dialog).getByLabelText('初始密码（可选）'), 'abcdefghi');
      await typing.click(within(dialog).getByRole('button', { name: '创建' }));
      expect(await within(dialog).findByText('密码至少 10 个字符')).toBeInTheDocument();
      expect(createAdminUser).not.toHaveBeenCalled();
    });

    it('creates the user and shows the one-time password with a copy button', async () => {
      const typing = userEvent.setup();
      vi.mocked(createAdminUser).mockResolvedValue({
        user: user({ id: 'user-2', username: 'bob', displayName: 'bob' }),
        initialPassword: 'Generated#Pass1',
      });
      renderUsersPage();
      await screen.findByRole('table', { name: /用户列表/ });
      await typing.click(screen.getByRole('button', { name: '创建用户' }));
      const dialog = await screen.findByRole('dialog', { name: '创建用户' });
      await typing.type(within(dialog).getByLabelText('用户名'), 'bob');
      await typing.click(within(dialog).getByRole('button', { name: '创建' }));

      expect(createAdminUser).toHaveBeenCalledWith({ username: 'bob', displayName: undefined, password: undefined });
      const result = await screen.findByRole('dialog', { name: '一次性密码' });
      expect(within(result).getByLabelText('一次性密码')).toHaveTextContent('Generated#Pass1');
      expect(within(result).getByText(/bob 的新密码/)).toBeInTheDocument();
      await typing.click(within(result).getByRole('button', { name: '复制密码' }));
      expect(clipboardMocks.copyText).toHaveBeenCalledWith('Generated#Pass1');
      expect(await within(result).findByRole('status')).toHaveTextContent('已复制到剪贴板');

      // Closing the dialog is the last time the password is visible.
      await typing.click(within(result).getByRole('button', { name: '关闭' }));
      await waitFor(() => {
        expect(screen.queryByRole('dialog', { name: '一次性密码' })).not.toBeInTheDocument();
      });
      expect(screen.queryByText('Generated#Pass1')).not.toBeInTheDocument();
      expect(vi.mocked(listAdminUsers).mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('surfaces a USERNAME_EXISTS conflict inside the dialog', async () => {
      const typing = userEvent.setup();
      vi.mocked(createAdminUser).mockRejectedValue(new ApiError(409, { code: 'USERNAME_EXISTS', message: '用户名已存在' }));
      renderUsersPage();
      await screen.findByRole('table', { name: /用户列表/ });
      await typing.click(screen.getByRole('button', { name: '创建用户' }));
      const dialog = await screen.findByRole('dialog', { name: '创建用户' });
      await typing.type(within(dialog).getByLabelText('用户名'), 'alice');
      await typing.click(within(dialog).getByRole('button', { name: '创建' }));
      expect(await within(dialog).findByRole('alert')).toHaveTextContent('用户名已存在');
    });
  });

  it('asks for confirmation before resetting a password and shows the result once', async () => {
    const clicking = userEvent.setup();
    vi.mocked(resetAdminUserPassword).mockResolvedValue({ user: user(), password: 'Reset#Pass9' });
    renderUsersPage();
    await screen.findByRole('table', { name: /用户列表/ });
    await clicking.click(screen.getByRole('button', { name: '重置 alice 的密码' }));

    const confirm = await screen.findByRole('dialog', { name: '重置密码' });
    expect(resetAdminUserPassword).not.toHaveBeenCalled();
    await clicking.click(within(confirm).getByRole('button', { name: '取消' }));
    expect(resetAdminUserPassword).not.toHaveBeenCalled();

    await clicking.click(screen.getByRole('button', { name: '重置 alice 的密码' }));
    await clicking.click(within(await screen.findByRole('dialog', { name: '重置密码' })).getByRole('button', { name: '重置密码' }));
    expect(resetAdminUserPassword).toHaveBeenCalledWith('user-1');
    const result = await screen.findByRole('dialog', { name: '一次性密码' });
    expect(within(result).getByLabelText('一次性密码')).toHaveTextContent('Reset#Pass9');
    expect(within(result).getByRole('button', { name: '复制密码' })).toBeInTheDocument();
  });

  it('asks for confirmation before disabling and before revoking an administrator', async () => {
    const clicking = userEvent.setup();
    mockList([selfRow, user({ role: 'admin' })]);
    vi.mocked(updateAdminUser).mockResolvedValue(user({ status: 'disabled' }));
    vi.mocked(updateAdminUserRole).mockResolvedValue(user());
    renderUsersPage();
    await screen.findByRole('table', { name: /用户列表/ });

    await clicking.click(screen.getByRole('button', { name: '禁用 alice' }));
    const disable = await screen.findByRole('dialog', { name: '禁用用户' });
    expect(updateAdminUser).not.toHaveBeenCalled();
    await clicking.click(within(disable).getByRole('button', { name: '禁用' }));
    await waitFor(() => {
      expect(updateAdminUser).toHaveBeenCalledWith('user-1', { displayName: 'Alice', status: 'disabled' });
    });

    await clicking.click(await screen.findByRole('button', { name: '撤销 alice 的管理员' }));
    const revoke = await screen.findByRole('dialog', { name: '撤销管理员' });
    expect(updateAdminUserRole).not.toHaveBeenCalled();
    await clicking.click(within(revoke).getByRole('button', { name: '撤销管理员' }));
    await waitFor(() => {
      expect(updateAdminUserRole).toHaveBeenCalledWith('user-1', 'user');
    });
  });

  it('keeps the confirmation open and shows the server refusal for the last administrator', async () => {
    const clicking = userEvent.setup();
    mockList([selfRow, user({ role: 'admin' })]);
    vi.mocked(updateAdminUserRole).mockRejectedValue(new ApiError(409, { code: 'LAST_ADMIN_REQUIRED', message: '不能撤销最后一位系统管理员' }));
    renderUsersPage();
    await screen.findByRole('table', { name: /用户列表/ });
    await clicking.click(screen.getByRole('button', { name: '撤销 alice 的管理员' }));
    const revoke = await screen.findByRole('dialog', { name: '撤销管理员' });
    await clicking.click(within(revoke).getByRole('button', { name: '撤销管理员' }));
    expect(await within(revoke).findByRole('alert')).toHaveTextContent('不能撤销最后一位系统管理员');
    expect(screen.getByRole('dialog', { name: '撤销管理员' })).toBeInTheDocument();
  });

  it('edits the display name and status through the edit dialog', async () => {
    const typing = userEvent.setup();
    vi.mocked(updateAdminUser).mockResolvedValue(user({ displayName: 'Alice Liddell', status: 'disabled' }));
    renderUsersPage();
    await screen.findByRole('table', { name: /用户列表/ });
    await typing.click(screen.getByRole('button', { name: '编辑 alice' }));
    const dialog = await screen.findByRole('dialog', { name: '编辑用户' });

    const nameInput = within(dialog).getByLabelText('显示名');
    expect(nameInput).toHaveValue('Alice');
    await typing.clear(nameInput);
    await typing.click(within(dialog).getByRole('button', { name: '保存' }));
    expect(await within(dialog).findByText('请输入显示名')).toBeInTheDocument();
    expect(updateAdminUser).not.toHaveBeenCalled();

    await typing.type(nameInput, 'Alice Liddell');
    await typing.selectOptions(within(dialog).getByLabelText('状态'), 'disabled');
    await typing.click(within(dialog).getByRole('button', { name: '保存' }));
    await waitFor(() => {
      expect(updateAdminUser).toHaveBeenCalledWith('user-1', { displayName: 'Alice Liddell', status: 'disabled' });
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '编辑用户' })).not.toBeInTheDocument();
    });
  });

  it('locks the status control when editing the current administrator', async () => {
    const clicking = userEvent.setup();
    renderUsersPage();
    await screen.findByRole('table', { name: /用户列表/ });
    await clicking.click(screen.getByRole('button', { name: '编辑 admin' }));
    const dialog = await screen.findByRole('dialog', { name: '编辑用户' });
    expect(within(dialog).getByLabelText('状态')).toBeDisabled();
    expect(within(dialog).getByText('不能在这里禁用自己的账号')).toBeInTheDocument();
  });
});
