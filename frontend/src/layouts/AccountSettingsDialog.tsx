import { ImagePlus, KeyRound, Trash2, UserRound } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { FormEvent } from 'react';

import { ApiError } from '../api/client';
import { changePassword, getCurrentUser, removeAvatar, updateProfile, uploadAvatar } from '../api/resources';
import { UserAvatar } from '../components/UserAvatar';
import { useToast } from '../components/feedback/ToastProvider';
import { Button } from '../components/ui/Button';
import { Dialog } from '../components/ui/Dialog';
import { Field, Input } from '../components/ui/Field';
import { SegmentedControl } from '../components/ui/SegmentedControl';
import { useSystemCapabilities } from '../hooks/useSystemCapabilities';
import { currentUserStore } from '../store/currentUserStore';
import { tokenStore } from '../store/tokenStore';
import { prepareAvatarUpload } from '../utils/avatar';
import { getErrorMessage } from '../utils/errors';
import { validatePasswordLength } from '../utils/password';
import { countUnicodeCodePoints } from '../utils/text';
import type { User } from '../types/api';

type Props = { open: boolean; onClose: () => void; onProfileSaved?: (user: User) => void };
type PasswordForm = { currentPassword: string; newPassword: string; confirmPassword: string };
type AvatarDraft = { file: File; previewURL: string; name: string };
type WriteKind = 'profile' | 'password' | 'avatar' | 'remove' | 'prepare';
const emptyPassword: PasswordForm = { currentPassword: '', newPassword: '', confirmPassword: '' };

export function AccountSettingsDialog({ open, ...props }: Props) {
  const revision = useSyncExternalStore(tokenStore.subscribe, tokenStore.getRevision);
  // Each opening/account gets its own drafts and response guards.
  return open ? <AccountSettingsContent key={revision} {...props} revision={revision} /> : null;
}

function AccountSettingsContent({ onClose, onProfileSaved, revision }: Omit<Props, 'open'> & { revision: number }) {
  const toast = useToast();
  const capabilities = useSystemCapabilities();
  const maxAvatarBytes = capabilities.account.maxAvatarBytes ?? 2 * 1024 * 1024;
  const avatarSize = capabilities.account.avatarSize ?? 256;
  const [section, setSection] = useState<'profile' | 'password'>('profile');
  const [account, setAccount] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [nameError, setNameError] = useState('');
  const [profileError, setProfileError] = useState('');
  const [draft, setDraft] = useState<AvatarDraft | null>(null);
  const [avatarError, setAvatarError] = useState('');
  const [password, setPassword] = useState<PasswordForm>(emptyPassword);
  const [passwordErrors, setPasswordErrors] = useState<PasswordForm>(emptyPassword);
  const [passwordError, setPasswordError] = useState('');
  const [busy, setBusy] = useState<WriteKind | null>(null);
  const pendingRef = useRef<WriteKind | null>(null);
  const mountedRef = useRef(false);
  const readRef = useRef(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const chooseRef = useRef<HTMLButtonElement>(null);
  const saveAvatarRef = useRef<HTMLButtonElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const currentPasswordRef = useRef<HTMLInputElement>(null);
  const newPasswordRef = useRef<HTMLInputElement>(null);
  const confirmPasswordRef = useRef<HTMLInputElement>(null);
  const focusAfterWrite = useRef<'avatar' | 'saveAvatar' | 'currentPassword' | null>(null);

  const isCurrent = useCallback(() => mountedRef.current && tokenStore.getRevision() === revision, [revision]);
  const loadProfile = useCallback(async () => {
    const request = ++readRef.current;
    setLoading(true);
    setLoadError('');
    try {
      const user = await getCurrentUser();
      if (!isCurrent() || request !== readRef.current) return;
      setAccount(user);
      setDisplayName(user.displayName ?? '');
    } catch (error) {
      if (isCurrent() && request === readRef.current) setLoadError(getErrorMessage(error, '账户信息加载失败'));
    } finally {
      if (isCurrent() && request === readRef.current) setLoading(false);
    }
  }, [isCurrent]);

  useEffect(() => {
    mountedRef.current = true;
    void loadProfile();
    return () => { mountedRef.current = false; readRef.current++; };
  }, [loadProfile]);

  useEffect(() => () => { if (draft) URL.revokeObjectURL(draft.previewURL); }, [draft]);
  useEffect(() => {
    if (busy || !focusAfterWrite.current) return;
    const target = focusAfterWrite.current;
    focusAfterWrite.current = null;
    if (target === 'avatar') chooseRef.current?.focus();
    else if (target === 'saveAvatar') saveAvatarRef.current?.focus();
    else currentPasswordRef.current?.focus();
  }, [busy, draft]);

  function beginWrite(kind: WriteKind) {
    if (!isCurrent() || pendingRef.current || loading || !account) return false;
    pendingRef.current = kind;
    setBusy(kind);
    return true;
  }
  function endWrite() {
    if (!isCurrent()) return;
    pendingRef.current = null;
    setBusy(null);
  }
  function acceptProfile(user: User) {
    if (tokenStore.getRevision() === revision) currentUserStore.clear();
    if (!isCurrent()) return false;
    setAccount(user);
    onProfileSaved?.(user);
    return true;
  }
  function close() { if (!pendingRef.current) onClose(); }

  async function chooseAvatar(file: File) {
    if (!beginWrite('prepare')) return;
    setAvatarError('');
    try {
      const prepared = await prepareAvatarUpload(file, maxAvatarBytes, avatarSize);
      if (!isCurrent()) return;
      setDraft({ file: prepared, previewURL: URL.createObjectURL(prepared), name: file.name });
      focusAfterWrite.current = 'saveAvatar';
    } catch (error) {
      if (isCurrent()) setAvatarError(error instanceof Error ? error.message : '图片处理失败，请重试');
    } finally { endWrite(); }
  }

  async function saveAvatar() {
    if (!draft || !beginWrite('avatar')) return;
    setAvatarError('');
    try {
      const updated = await uploadAvatar(draft.file);
      if (!acceptProfile(updated)) return;
      setDraft(null);
      focusAfterWrite.current = 'avatar';
      toast.success('头像已更新');
    } catch (error) {
      if (isCurrent()) setAvatarError(getErrorMessage(error, '头像保存失败，请重试'));
    } finally { endWrite(); }
  }

  async function clearAvatar() {
    if (!account?.avatarUrl || !beginWrite('remove')) return;
    setAvatarError('');
    try {
      const updated = await removeAvatar();
      if (!acceptProfile(updated)) return;
      focusAfterWrite.current = 'avatar';
      toast.success('头像已移除');
    } catch (error) {
      if (isCurrent()) setAvatarError(getErrorMessage(error, '头像移除失败，请重试'));
    } finally { endWrite(); }
  }

  async function submitProfile(event: FormEvent) {
    event.preventDefault();
    if (pendingRef.current || !account) return;
    const name = displayName.trim();
    const error = !name ? '显示名称不能为空'
      : countUnicodeCodePoints(name) > capabilities.account.maxDisplayNameLength ? `显示名称不能超过 ${capabilities.account.maxDisplayNameLength} 个字符` : '';
    setNameError(error);
    if (error) { nameRef.current?.focus(); return; }
    if (!beginWrite('profile')) return;
    setProfileError('');
    try {
      // Omission preserves the current avatar, including uploads in another tab.
      const updated = await updateProfile({ displayName: name });
      if (!acceptProfile(updated)) return;
      setDisplayName(updated.displayName);
      toast.success('账户资料已更新');
    } catch (error) {
      if (isCurrent()) setProfileError(getErrorMessage(error, '账户资料更新失败'));
    } finally { endWrite(); }
  }

  async function submitPassword(event: FormEvent) {
    event.preventDefault();
    if (pendingRef.current || !account) return;
    setPasswordErrors(emptyPassword);
    setPasswordError('');
    if (password.newPassword !== password.confirmPassword) {
      setPasswordErrors({ ...emptyPassword, confirmPassword: '两次输入的新密码不一致' });
      confirmPasswordRef.current?.focus();
      return;
    }
    const lengthError = validatePasswordLength(password.newPassword, capabilities.account.minPasswordLength, capabilities.account.maxPasswordBytes);
    if (lengthError) {
      setPasswordErrors({ ...emptyPassword, newPassword: lengthError === 'tooShort'
        ? `新密码至少需要 ${capabilities.account.minPasswordLength} 个字符`
        : `新密码不能超过 ${capabilities.account.maxPasswordBytes} 个 UTF-8 字节` });
      newPasswordRef.current?.focus();
      return;
    }
    if (!beginWrite('password')) return;
    try {
      await changePassword({ currentPassword: password.currentPassword, newPassword: password.newPassword });
      if (!isCurrent()) return;
      setPassword(emptyPassword);
      focusAfterWrite.current = 'currentPassword';
      toast.success('密码已修改');
    } catch (error) {
      if (!isCurrent()) return;
      if (error instanceof ApiError && error.code === 'INVALID_CURRENT_PASSWORD') {
        setPasswordErrors({ ...emptyPassword, currentPassword: getErrorMessage(error, '当前密码不正确') });
        focusAfterWrite.current = 'currentPassword';
      } else setPasswordError(getErrorMessage(error, '密码修改失败'));
    } finally { endWrite(); }
  }

  return (
    <Dialog open className="account-settings" title="账户设置" description="管理个人资料与登录密码。" onClose={close}>
      <SegmentedControl label="账户设置内容" value={section} disabled={Boolean(busy)} onChange={setSection}
        options={[{ value: 'profile', label: '个人资料', icon: <UserRound aria-hidden="true" /> }, { value: 'password', label: '修改密码', icon: <KeyRound aria-hidden="true" /> }]} />
      {loading ? <p className="account-settings__status" role="status">正在加载账户资料…</p>
        : loadError ? <div className="account-settings__status"><p className="ui-field__error" role="alert">{loadError}</p><Button variant="secondary" onClick={() => void loadProfile()}>重新加载</Button></div>
          : account && (section === 'profile' ? (
            <div className="account-settings__profile">
              <section aria-label="头像" className="account-settings__avatar-section">
                <div className="account-settings__avatar-row">
                  {draft ? <span className="ui-avatar account-settings__avatar" role="img" aria-label="待保存的头像"><img alt="" src={draft.previewURL} /></span>
                    : <UserAvatar className="account-settings__avatar" url={account.avatarUrl} name={displayName || account.username} label="当前头像" />}
                  <div className="account-settings__avatar-info">
                    <strong>{draft ? '预览新头像' : '个人头像'}</strong>
                    <p className="ui-muted">PNG / JPG，最大 {Math.round(maxAvatarBytes / 1024 / 1024)} MB，自动居中裁剪。</p>
                    <input ref={fileRef} type="file" accept={(capabilities.account.avatarContentTypes ?? ['image/png', 'image/jpeg']).join(',')} hidden aria-label="选择头像图片" disabled={Boolean(busy)} onChange={event => {
                      const file = event.currentTarget.files?.[0];
                      event.currentTarget.value = '';
                      if (file) void chooseAvatar(file);
                    }} />
                    <div className="account-settings__avatar-actions">
                      <Button ref={chooseRef} variant="secondary" leadingIcon={<ImagePlus aria-hidden="true" />} disabled={Boolean(busy)} loading={busy === 'prepare'} loadingLabel="处理图片…" onClick={() => fileRef.current?.click()}>{draft || account.avatarUrl ? '更换图片' : '选择图片'}</Button>
                      {!draft && account.avatarUrl && <Button variant="ghost" leadingIcon={<Trash2 aria-hidden="true" />} disabled={Boolean(busy)} loading={busy === 'remove'} loadingLabel="移除中…" onClick={() => void clearAvatar()}>移除头像</Button>}
                    </div>
                  </div>
                </div>
                {draft && <div className="account-settings__avatar-draft">
                  <p title={draft.name}><strong>尚未保存</strong><span>{draft.name}</span></p>
                  <div className="account-settings__avatar-actions">
                    <Button variant="ghost" disabled={Boolean(busy)} onClick={() => { setDraft(null); setAvatarError(''); focusAfterWrite.current = 'avatar'; }}>取消更换</Button>
                    <Button ref={saveAvatarRef} disabled={Boolean(busy)} loading={busy === 'avatar'} loadingLabel="保存头像…" onClick={() => void saveAvatar()}>保存头像</Button>
                  </div>
                </div>}
                {avatarError && <p className="ui-field__error" role="alert">{avatarError}</p>}
              </section>
              <form className="ui-dialog__form" onSubmit={event => void submitProfile(event)}>
                <p className="ui-muted">登录账号：{account.username}</p>
                <Field label="显示名称" htmlFor="account-display-name" hint={`最多 ${capabilities.account.maxDisplayNameLength} 个字符`} error={nameError}>
                  <Input ref={nameRef} id="account-display-name" autoComplete="nickname" disabled={Boolean(busy)} required value={displayName} onChange={event => { setDisplayName(event.target.value); setNameError(''); }} />
                </Field>
                {profileError && <p className="ui-field__error" role="alert">{profileError}</p>}
                <div className="ui-dialog__actions"><Button type="submit" loading={busy === 'profile'} loadingLabel="保存中…" disabled={Boolean(busy) || displayName.trim() === account.displayName}>保存资料</Button></div>
              </form>
            </div>
          ) : (
            <form className="ui-dialog__form account-settings__password" onSubmit={event => void submitPassword(event)}>
              <input className="sr-only" name="username" autoComplete="username" aria-label="登录账号" tabIndex={-1} value={account.username} readOnly />
              {passwordError && <p className="ui-field__error" role="alert">{passwordError}</p>}
              <Field label="当前密码" htmlFor="account-current-password" error={passwordErrors.currentPassword}>
                <Input ref={currentPasswordRef} id="account-current-password" autoComplete="current-password" type="password" disabled={Boolean(busy)} required value={password.currentPassword} onChange={event => { setPassword(value => ({ ...value, currentPassword: event.target.value })); setPasswordErrors(value => ({ ...value, currentPassword: '' })); }} />
              </Field>
              <Field label="新密码" htmlFor="account-new-password" error={passwordErrors.newPassword} hint={`至少 ${capabilities.account.minPasswordLength} 个字符，最多 ${capabilities.account.maxPasswordBytes} 个 UTF-8 字节`}>
                <Input ref={newPasswordRef} id="account-new-password" autoComplete="new-password" type="password" disabled={Boolean(busy)} required value={password.newPassword} onChange={event => { setPassword(value => ({ ...value, newPassword: event.target.value })); setPasswordErrors(value => ({ ...value, newPassword: '' })); }} />
              </Field>
              <Field label="确认新密码" htmlFor="account-confirm-password" error={passwordErrors.confirmPassword}>
                <Input ref={confirmPasswordRef} id="account-confirm-password" autoComplete="new-password" type="password" disabled={Boolean(busy)} required value={password.confirmPassword} onChange={event => { setPassword(value => ({ ...value, confirmPassword: event.target.value })); setPasswordErrors(value => ({ ...value, confirmPassword: '' })); }} />
              </Field>
              <div className="ui-dialog__actions"><Button type="submit" disabled={Boolean(busy)} loading={busy === 'password'} loadingLabel="修改中…">保存新密码</Button></div>
            </form>
          ))}
      <div className="account-settings__footer"><Button variant="ghost" disabled={Boolean(busy)} onClick={close}>关闭</Button></div>
    </Dialog>
  );
}
