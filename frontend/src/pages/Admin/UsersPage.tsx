import { Copy, Plus, RefreshCw, RotateCcw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';

import { createAdminUser, listAdminUsers, resetAdminUserPassword, updateAdminUser, updateAdminUserRole } from '../../api/resources';
import { useCurrentUser } from '../../hooks/useCurrentUser';
import type { AdminUser } from '../../types/api';
import { getErrorMessage } from '../../utils/errors';
import { copyText } from '../../utils/clipboard';
import { AppShell } from '../../layouts/AppShell';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';
import { Input, Select } from '../../components/ui/Field';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';

export function UsersPage() {
  const { user, loading, error } = useCurrentUser();
  if (loading) return <AppShell active="admin-users"><LoadingSkeleton announce columns={4} rows={6} /></AppShell>;
  if (error || user?.role !== 'admin') return <Navigate replace to="/home" />;
  return <AdminUsersContent />;
}

function AdminUsersContent() {
  const [items, setItems] = useState<AdminUser[]>([]);
  const [total, setTotal] = useState(0);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [role, setRole] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [resetResult, setResetResult] = useState<{ username: string; password: string } | null>(null);
  const [form, setForm] = useState({ username: '', displayName: '', password: '' });

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const result = await listAdminUsers({ q: query, status, role, pageSize: 100 });
      setItems(result.items); setTotal(result.total);
    } catch (caught) { setError(getErrorMessage(caught, '无法加载用户列表')); }
    finally { setLoading(false); }
  }, [query, role, status]);

  useEffect(() => { void load(); }, [load]);

  async function create() {
    try {
      const result = await createAdminUser({ username: form.username, displayName: form.displayName || undefined, password: form.password || undefined });
      setCreateOpen(false); setForm({ username: '', displayName: '', password: '' });
      setResetResult({ username: result.user.username, password: result.initialPassword });
      await load();
    } catch (caught) { setError(getErrorMessage(caught, '创建用户失败')); }
  }

  async function toggleStatus(item: AdminUser) {
    try { await updateAdminUser(item.id, { displayName: item.displayName, status: item.status === 'active' ? 'disabled' : 'active' }); await load(); }
    catch (caught) { setError(getErrorMessage(caught, '更新用户状态失败')); }
  }

  async function toggleRole(item: AdminUser) {
    try { await updateAdminUserRole(item.id, item.role === 'admin' ? 'user' : 'admin'); await load(); }
    catch (caught) { setError(getErrorMessage(caught, '更新用户角色失败')); }
  }

  async function reset(item: AdminUser) {
    try { const result = await resetAdminUserPassword(item.id); setResetResult({ username: item.username, password: result.password }); }
    catch (caught) { setError(getErrorMessage(caught, '重置密码失败')); }
  }

  return (
    <AppShell active="admin-users" breadcrumbs={[{ label: '系统', to: '/diagnostics' }, { label: '用户管理' }]}>
      <div className="ui-page-heading">
        <div><h1>用户管理</h1><p>创建账号、管理状态和系统管理员角色。密码只在创建或重置后显示一次。</p></div>
        <Button leadingIcon={<Plus aria-hidden="true" />} onClick={() => setCreateOpen(true)}>创建用户</Button>
      </div>
      <section className="ui-panel">
        <div className="ui-panel__head" style={{ gap: 'var(--s-2)', flexWrap: 'wrap' }}>
          <Input aria-label="搜索用户" onChange={(event) => setQuery(event.target.value)} placeholder="搜索用户名或显示名" value={query} />
          <Select aria-label="状态筛选" onChange={(event) => setStatus(event.target.value)} value={status}><option value="">全部状态</option><option value="active">启用</option><option value="disabled">已禁用</option></Select>
          <Select aria-label="角色筛选" onChange={(event) => setRole(event.target.value)} value={role}><option value="">全部角色</option><option value="admin">管理员</option><option value="user">普通用户</option></Select>
          <Button leadingIcon={<RefreshCw aria-hidden="true" />} onClick={() => void load()} variant="secondary">刷新</Button>
        </div>
        {error && <p className="ui-inline-error" role="alert">{error}</p>}
        {loading ? <LoadingSkeleton announce columns={5} rows={5} /> : (
          <div className="ui-table-wrap"><table className="ui-table"><caption className="ui-visually-hidden">用户列表，共 {total} 个用户</caption><thead><tr><th>用户名</th><th>显示名</th><th>角色</th><th>状态</th><th>最后登录</th><th>操作</th></tr></thead><tbody>
            {items.map((item) => <tr key={item.id}><td>{item.username}</td><td>{item.displayName}</td><td><Badge tone={item.role === 'admin' ? 'accent' : 'neutral'}>{item.role === 'admin' ? '管理员' : '普通用户'}</Badge></td><td><Badge tone={item.status === 'active' ? 'ok' : 'warn'}>{item.status === 'active' ? '启用' : '已禁用'}</Badge></td><td>{item.lastLoginAt ? new Date(item.lastLoginAt).toLocaleString() : '从未登录'}</td><td><div style={{ display: 'flex', gap: 'var(--s-1)', flexWrap: 'wrap' }}><Button onClick={() => void toggleStatus(item)} variant="ghost">{item.status === 'active' ? '禁用' : '启用'}</Button><Button onClick={() => void toggleRole(item)} variant="ghost">{item.role === 'admin' ? '撤销管理员' : '授予管理员'}</Button><Button leadingIcon={<RotateCcw aria-hidden="true" />} onClick={() => void reset(item)} variant="ghost">重置密码</Button></div></td></tr>)}
          </tbody></table>{items.length === 0 && <p className="ui-muted" style={{ padding: 'var(--s-4)' }}>没有匹配的用户。</p>}</div>
        )}
      </section>
      <Dialog description="用户名创建后不能修改。留空密码会生成一次性初始密码。" onClose={() => setCreateOpen(false)} open={createOpen} title="创建用户">
        <div style={{ display: 'grid', gap: 'var(--s-3)' }}><Input aria-label="用户名" onChange={(event) => setForm({ ...form, username: event.target.value })} placeholder="用户名" value={form.username} /><Input aria-label="显示名" onChange={(event) => setForm({ ...form, displayName: event.target.value })} placeholder="显示名（可选）" value={form.displayName} /><Input aria-label="初始密码" onChange={(event) => setForm({ ...form, password: event.target.value })} placeholder="初始密码（可选）" type="password" value={form.password} /><div className="ui-dialog__actions"><Button onClick={() => setCreateOpen(false)} variant="secondary">取消</Button><Button disabled={!form.username.trim()} onClick={() => void create()}>创建</Button></div></div>
      </Dialog>
      <Dialog description="请立即复制并安全交付该密码；关闭后不会再次显示。" onClose={() => setResetResult(null)} open={Boolean(resetResult)} title="一次性密码">
        {resetResult && <div style={{ display: 'grid', gap: 'var(--s-3)' }}><p>{resetResult.username} 的新密码：</p><code style={{ fontSize: 'var(--t-lead)', userSelect: 'all' }}>{resetResult.password}</code><div className="ui-dialog__actions"><Button leadingIcon={<Copy aria-hidden="true" />} onClick={() => void copyText(resetResult.password)}>复制密码</Button><Button onClick={() => setResetResult(null)} variant="secondary">关闭</Button></div></div>}
      </Dialog>
    </AppShell>
  );
}
