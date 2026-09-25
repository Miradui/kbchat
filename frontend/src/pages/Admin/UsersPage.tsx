import { Pencil, Plus, RefreshCw, RotateCcw, Search } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Navigate } from 'react-router-dom';

import { listAdminUsers, resetAdminUserPassword, updateAdminUser, updateAdminUserRole } from '../../api/resources';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Select } from '../../components/ui/Field';
import { DebouncedSearchInput } from '../../components/ui/DebouncedSearchInput';
import { Pagination } from '../../components/ui/Pagination';
import { useCurrentUser } from '../../hooks/useCurrentUser';
import { AppShell } from '../../layouts/AppShell';
import type { AdminUser } from '../../types/api';
import { getErrorMessage } from '../../utils/errors';
import { CreateUserDialog, EditUserDialog, PasswordResultDialog } from './UserDialogs';
import type { PasswordResult } from './UserDialogs';

const DEFAULT_PAGE_SIZE = 20;

export function UsersPage() {
  const { user, loading, error } = useCurrentUser();
  if (loading) return <AppShell active="admin-users"><LoadingSkeleton announce columns={4} rows={6} /></AppShell>;
  if (error || user?.role !== 'admin') return <Navigate replace to="/home" />;
  return <AdminUsersContent currentUserId={user.id} />;
}

/**
 * Destructive actions ask for confirmation. The pending action is one value so
 * at most one dialog is open, and the row it targets is captured at click time
 * rather than re-read from a list that may have refreshed meanwhile.
 */
type PendingAction =
  | { kind: 'disable'; user: AdminUser }
  | { kind: 'revokeAdmin'; user: AdminUser }
  | { kind: 'resetPassword'; user: AdminUser };

const actionCopy: Record<PendingAction['kind'], { title: string; description: (user: AdminUser) => string; confirm: string; failure: string }> = {
  disable: {
    title: '禁用用户',
    description: (user) => `禁用 ${user.username} 后，该账号无法登录，已登录的会话会在下一次请求时失效。数据会保留，可以随时重新启用。`,
    confirm: '禁用',
    failure: '禁用用户失败',
  },
  revokeAdmin: {
    title: '撤销管理员',
    description: (user) => `撤销 ${user.username} 的系统管理员角色后，该账号将不能再访问系统管理页面。`,
    confirm: '撤销管理员',
    failure: '更新用户角色失败',
  },
  resetPassword: {
    title: '重置密码',
    description: (user) => `将为 ${user.username} 生成新密码并使旧密码立即失效。新密码只显示一次。`,
    confirm: '重置密码',
    failure: '重置密码失败',
  },
};

function AdminUsersContent({ currentUserId }: { currentUserId: string }) {
  const [items, setItems] = useState<AdminUser[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [role, setRole] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<AdminUser | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [pendingBusy, setPendingBusy] = useState(false);
  const [pendingError, setPendingError] = useState('');
  const [passwordResult, setPasswordResult] = useState<PasswordResult | null>(null);
  const requestRef = useRef(0);
  const mountedRef = useRef(true);
  const queryRef = useRef({ q: query, status, role, page, pageSize });

  useLayoutEffect(() => {
    queryRef.current = { q: query, status, role, page, pageSize };
    requestRef.current += 1;
  }, [query, status, role, page, pageSize]);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; requestRef.current += 1; };
  }, []);

  const load = useCallback(async () => {
    if (!mountedRef.current) return;
    const request = ++requestRef.current;
    const current = () => mountedRef.current && requestRef.current === request;
    setLoading(true);
    setError('');
    try {
      const result = await listAdminUsers(queryRef.current);
      if (!current()) return;
      setItems(result.items);
      setTotal(result.total);
    } catch (caught) {
      if (current()) setError(getErrorMessage(caught, '无法加载用户列表'));
    } finally {
      if (current()) setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load, page, pageSize, query, role, status]);

  // A filter change restarts from the first page; otherwise a narrower result
  // set could leave the user parked on an empty page.
  function updateFilter(setter: (value: string) => void) {
    return (value: string) => { setter(value); setPage(1); };
  }

  async function enable(item: AdminUser) {
    setError('');
    try {
      await updateAdminUser(item.id, { displayName: item.displayName, status: 'active' });
      await load();
    } catch (caught) {
      setError(getErrorMessage(caught, '启用用户失败'));
    }
  }

  async function grantAdmin(item: AdminUser) {
    setError('');
    try {
      await updateAdminUserRole(item.id, 'admin');
      await load();
    } catch (caught) {
      setError(getErrorMessage(caught, '更新用户角色失败'));
    }
  }

  async function runPending() {
    if (!pending) return;
    setPendingBusy(true);
    setPendingError('');
    try {
      if (pending.kind === 'disable') {
        await updateAdminUser(pending.user.id, { displayName: pending.user.displayName, status: 'disabled' });
      } else if (pending.kind === 'revokeAdmin') {
        await updateAdminUserRole(pending.user.id, 'user');
      } else {
        const result = await resetAdminUserPassword(pending.user.id);
        setPasswordResult({ username: pending.user.username, password: result.password });
      }
      setPending(null);
      await load();
    } catch (caught) {
      setPendingError(getErrorMessage(caught, actionCopy[pending.kind].failure));
    } finally {
      setPendingBusy(false);
    }
  }

  function closePending() {
    setPending(null);
    setPendingError('');
  }

  return (
    <AppShell active="admin-users" breadcrumbs={[{ label: '系统', to: '/diagnostics' }, { label: '用户管理' }]}>
      <div className="ui-page-heading">
        <div><h1>用户管理</h1><p>创建账号、管理状态和系统管理员角色。密码只在创建或重置后显示一次。</p></div>
        <Button leadingIcon={<Plus aria-hidden="true" />} onClick={() => setCreateOpen(true)}>创建用户</Button>
      </div>
      <section className="ui-panel">
        <div className="ui-panel__head" style={{ gap: 'var(--s-2)', flexWrap: 'wrap' }}>
          <DebouncedSearchInput aria-label="搜索用户" icon={<Search aria-hidden="true" />} onCommit={updateFilter(setQuery)} placeholder="搜索用户名或显示名" value={query} />
          <Select aria-label="状态筛选" onChange={(event) => updateFilter(setStatus)(event.target.value)} value={status}>
            <option value="">全部状态</option>
            <option value="active">启用</option>
            <option value="disabled">已禁用</option>
          </Select>
          <Select aria-label="角色筛选" onChange={(event) => updateFilter(setRole)(event.target.value)} value={role}>
            <option value="">全部角色</option>
            <option value="admin">管理员</option>
            <option value="user">普通用户</option>
          </Select>
          <Button leadingIcon={<RefreshCw aria-hidden="true" />} onClick={() => void load()} variant="secondary">刷新</Button>
        </div>
        {error && <p className="ui-inline-error" role="alert">{error}</p>}
        {loading ? <LoadingSkeleton announce columns={5} rows={5} /> : (
          <div className="ui-table-wrap">
            <table className="ui-table">
              <caption className="ui-visually-hidden">用户列表，共 {total} 个用户</caption>
              <thead>
                <tr><th>用户名</th><th>显示名</th><th>角色</th><th>状态</th><th>最后登录</th><th>操作</th></tr>
              </thead>
              <tbody>
                {items.map((item) => {
                  const isSelf = item.id === currentUserId;
                  return (
                    <tr key={item.id}>
                      <td data-label="用户名">{item.username}{isSelf && <span className="ui-muted"> （我）</span>}</td>
                      <td data-label="显示名">{item.displayName}</td>
                      <td data-label="角色"><Badge tone={item.role === 'admin' ? 'accent' : 'neutral'}>{item.role === 'admin' ? '管理员' : '普通用户'}</Badge></td>
                      <td data-label="状态"><Badge tone={item.status === 'active' ? 'ok' : 'warn'}>{item.status === 'active' ? '启用' : '已禁用'}</Badge></td>
                      <td data-label="最后登录">{item.lastLoginAt ? new Date(item.lastLoginAt).toLocaleString() : '从未登录'}</td>
                      <td data-label="操作">
                        <div style={{ display: 'flex', gap: 'var(--s-1)', flexWrap: 'wrap' }}>
                          <Button aria-label={`编辑 ${item.username}`} leadingIcon={<Pencil aria-hidden="true" />} onClick={() => setEditing(item)} variant="ghost">编辑</Button>
                          {/* The signed-in administrator cannot disable, demote or
                              reset themselves; the server refuses these with
                              ADMIN_SELF_MUTATION, so the buttons are not offered. */}
                          {!isSelf && (
                            <>
                              {item.status === 'active'
                                ? <Button aria-label={`禁用 ${item.username}`} onClick={() => setPending({ kind: 'disable', user: item })} variant="ghost">禁用</Button>
                                : <Button aria-label={`启用 ${item.username}`} onClick={() => void enable(item)} variant="ghost">启用</Button>}
                              {item.role === 'admin'
                                ? <Button aria-label={`撤销 ${item.username} 的管理员`} onClick={() => setPending({ kind: 'revokeAdmin', user: item })} variant="ghost">撤销管理员</Button>
                                : <Button aria-label={`授予 ${item.username} 管理员`} onClick={() => void grantAdmin(item)} variant="ghost">授予管理员</Button>}
                              <Button aria-label={`重置 ${item.username} 的密码`} leadingIcon={<RotateCcw aria-hidden="true" />} onClick={() => setPending({ kind: 'resetPassword', user: item })} variant="ghost">重置密码</Button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {items.length === 0 && <p className="ui-muted" style={{ padding: 'var(--s-4)' }}>没有匹配的用户。</p>}
            <Pagination
              onPageChange={setPage}
              onPageSizeChange={(size) => { setPageSize(size); setPage(1); }}
              page={page}
              pageSize={pageSize}
              pageSizeOptions={[10, 20, 50, 100]}
              total={total}
            />
          </div>
        )}
      </section>

      <CreateUserDialog
        onClose={() => setCreateOpen(false)}
        onCreated={(result) => { setCreateOpen(false); setPasswordResult(result); void load(); }}
        open={createOpen}
      />
      <EditUserDialog
        isSelf={editing?.id === currentUserId}
        onClose={() => setEditing(null)}
        onSaved={() => { setEditing(null); void load(); }}
        user={editing}
      />
      {pending && (
        <ConfirmDialog
          busy={pendingBusy}
          confirmLabel={actionCopy[pending.kind].confirm}
          description={actionCopy[pending.kind].description(pending.user)}
          error={pendingError}
          onCancel={closePending}
          onConfirm={() => void runPending()}
          title={actionCopy[pending.kind].title}
        />
      )}
      <PasswordResultDialog onClose={() => setPasswordResult(null)} result={passwordResult} />
    </AppShell>
  );
}
