import { Copy } from 'lucide-react';
import { useEffect, useState } from 'react';

import { createAdminUser, updateAdminUser } from '../../api/resources';
import { Button } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';
import { Field, Input, Select } from '../../components/ui/Field';
import { useSystemCapabilities } from '../../hooks/useSystemCapabilities';
import type { AdminUser } from '../../types/api';
import { copyText } from '../../utils/clipboard';
import { getErrorMessage } from '../../utils/errors';
import { validatePasswordLength } from '../../utils/password';

/**
 * Mirrors the server's username contract (`adminUsernamePattern` in
 * admin_user_service.go). The server remains the boundary; this only spares a
 * round trip for the obvious cases.
 */
const USERNAME_PATTERN = /^[A-Za-z0-9._@-]{3,64}$/;

export type PasswordResult = { username: string; password: string };

type CreateUserDialogProps = {
  open: boolean;
  onClose: () => void;
  onCreated: (result: PasswordResult) => void;
};

export function CreateUserDialog({ open, onClose, onCreated }: CreateUserDialogProps) {
  const { account } = useSystemCapabilities();
  const [form, setForm] = useState({ username: '', displayName: '', password: '' });
  const [errors, setErrors] = useState<{ username?: string; displayName?: string; password?: string }>({});
  const [submitError, setSubmitError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) {
      setForm({ username: '', displayName: '', password: '' });
      setErrors({});
      setSubmitError('');
      setBusy(false);
    }
  }, [open]);

  function validate(): boolean {
    const next: typeof errors = {};
    const username = form.username.trim();
    if (!username) {
      next.username = '请输入用户名';
    } else if (!USERNAME_PATTERN.test(username)) {
      next.username = '用户名须为 3-64 个字母、数字或 . _ @ - 字符，不能包含空格';
    }
    if (Array.from(form.displayName.trim()).length > account.maxDisplayNameLength) {
      next.displayName = `显示名不能超过 ${account.maxDisplayNameLength} 个字符`;
    }
    if (form.password) {
      const lengthError = validatePasswordLength(form.password, account.minPasswordLength, account.maxPasswordBytes);
      if (lengthError === 'tooShort') next.password = `密码至少 ${account.minPasswordLength} 个字符`;
      if (lengthError === 'tooLong') next.password = `密码不能超过 ${account.maxPasswordBytes} 个字节`;
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function submit() {
    setSubmitError('');
    if (!validate()) return;
    setBusy(true);
    try {
      const result = await createAdminUser({
        username: form.username.trim(),
        displayName: form.displayName.trim() || undefined,
        password: form.password || undefined,
      });
      onCreated({ username: result.user.username, password: result.initialPassword });
    } catch (caught) {
      setSubmitError(getErrorMessage(caught, '创建用户失败'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog description="用户名创建后不能修改。留空密码会生成一次性初始密码。" onClose={() => { if (!busy) onClose(); }} open={open} title="创建用户">
      <form
        onSubmit={(event) => { event.preventDefault(); void submit(); }}
        style={{ display: 'grid', gap: 'var(--s-3)' }}
      >
        <Field error={errors.username} htmlFor="admin-user-username" label="用户名">
          <Input
            autoComplete="off"
            id="admin-user-username"
            onChange={(event) => setForm({ ...form, username: event.target.value })}
            placeholder="例如 alice 或 alice@example.com"
            value={form.username}
          />
        </Field>
        <Field error={errors.displayName} htmlFor="admin-user-display-name" label="显示名（可选）">
          <Input
            id="admin-user-display-name"
            onChange={(event) => setForm({ ...form, displayName: event.target.value })}
            placeholder="留空时使用用户名"
            value={form.displayName}
          />
        </Field>
        <Field
          error={errors.password}
          hint={`留空则自动生成；指定时至少 ${account.minPasswordLength} 个字符`}
          htmlFor="admin-user-password"
          label="初始密码（可选）"
        >
          <Input
            autoComplete="new-password"
            id="admin-user-password"
            onChange={(event) => setForm({ ...form, password: event.target.value })}
            type="password"
            value={form.password}
          />
        </Field>
        {submitError && <p className="ui-dialog__error" role="alert">{submitError}</p>}
        <div className="ui-dialog__actions">
          <Button disabled={busy} onClick={onClose} variant="secondary">取消</Button>
          <Button loading={busy} loadingLabel="创建中" type="submit">创建</Button>
        </div>
      </form>
    </Dialog>
  );
}

type EditUserDialogProps = {
  user: AdminUser | null;
  /** The signed-in administrator cannot disable their own account here. */
  isSelf: boolean;
  onClose: () => void;
  onSaved: (user: AdminUser) => void;
};

export function EditUserDialog({ user, isSelf, onClose, onSaved }: EditUserDialogProps) {
  const { account } = useSystemCapabilities();
  const [displayName, setDisplayName] = useState('');
  const [status, setStatus] = useState<'active' | 'disabled'>('active');
  const [error, setError] = useState('');
  const [submitError, setSubmitError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setDisplayName(user?.displayName ?? '');
    setStatus(user?.status ?? 'active');
    setError('');
    setSubmitError('');
    setBusy(false);
  }, [user]);

  async function submit() {
    if (!user) return;
    const trimmed = displayName.trim();
    if (!trimmed) {
      setError('请输入显示名');
      return;
    }
    if (Array.from(trimmed).length > account.maxDisplayNameLength) {
      setError(`显示名不能超过 ${account.maxDisplayNameLength} 个字符`);
      return;
    }
    setError('');
    setSubmitError('');
    setBusy(true);
    try {
      onSaved(await updateAdminUser(user.id, { displayName: trimmed, status }));
    } catch (caught) {
      setSubmitError(getErrorMessage(caught, '保存用户失败'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      description={user ? `修改 ${user.username} 的显示名和状态。` : ''}
      onClose={() => { if (!busy) onClose(); }}
      open={Boolean(user)}
      title="编辑用户"
    >
      <form
        onSubmit={(event) => { event.preventDefault(); void submit(); }}
        style={{ display: 'grid', gap: 'var(--s-3)' }}
      >
        <Field error={error} htmlFor="admin-user-edit-display-name" label="显示名">
          <Input
            id="admin-user-edit-display-name"
            onChange={(event) => setDisplayName(event.target.value)}
            value={displayName}
          />
        </Field>
        <Field
          hint={isSelf ? '不能在这里禁用自己的账号' : undefined}
          htmlFor="admin-user-edit-status"
          label="状态"
        >
          <Select
            disabled={isSelf}
            id="admin-user-edit-status"
            onChange={(event) => setStatus(event.target.value as 'active' | 'disabled')}
            value={status}
          >
            <option value="active">启用</option>
            <option value="disabled">已禁用</option>
          </Select>
        </Field>
        {submitError && <p className="ui-dialog__error" role="alert">{submitError}</p>}
        <div className="ui-dialog__actions">
          <Button disabled={busy} onClick={onClose} variant="secondary">取消</Button>
          <Button loading={busy} loadingLabel="保存中" type="submit">保存</Button>
        </div>
      </form>
    </Dialog>
  );
}

type PasswordResultDialogProps = {
  result: PasswordResult | null;
  onClose: () => void;
};

/** Shown exactly once: the password is not retrievable after this closes. */
export function PasswordResultDialog({ result, onClose }: PasswordResultDialogProps) {
  const [copied, setCopied] = useState(false);
  useEffect(() => { setCopied(false); }, [result]);

  async function copy() {
    if (!result) return;
    try {
      await copyText(result.password);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <Dialog description="请立即复制并安全交付该密码；关闭后不会再次显示。" onClose={onClose} open={Boolean(result)} title="一次性密码">
      {result && (
        <div style={{ display: 'grid', gap: 'var(--s-3)' }}>
          <p>{result.username} 的新密码：</p>
          <code aria-label="一次性密码" style={{ fontSize: 'var(--t-lead)', userSelect: 'all' }}>{result.password}</code>
          {copied && <p className="ui-muted" role="status">已复制到剪贴板</p>}
          <div className="ui-dialog__actions">
            <Button leadingIcon={<Copy aria-hidden="true" />} onClick={() => void copy()}>复制密码</Button>
            <Button onClick={onClose} variant="secondary">关闭</Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
