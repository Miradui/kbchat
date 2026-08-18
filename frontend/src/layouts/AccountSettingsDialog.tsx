import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';

import { ApiError } from '../api/client';
import { changePassword, getCurrentUser, updateProfile } from '../api/resources';
import { useToast } from '../components/feedback/ToastProvider';
import { Button } from '../components/ui/Button';
import { Dialog } from '../components/ui/Dialog';
import { Field, Input } from '../components/ui/Field';
import { useSystemCapabilities } from '../hooks/useSystemCapabilities';
import { currentUserStore } from '../store/currentUserStore';
import { getErrorMessage } from '../utils/errors';
import { validatePasswordLength } from '../utils/password';
import { countUnicodeCodePoints } from '../utils/text';
import type { User } from '../types/api';

type AccountSettingsDialogProps = {
  open: boolean;
  onClose: () => void;
  /** Lets the shell refresh the identity it shows in the rail. */
  onProfileSaved?: (user: User) => void;
};

type ProfileForm = { displayName: string; avatarUrl: string };
type ProfileFieldErrors = { displayName: string; avatarUrl: string };
type PasswordForm = { currentPassword: string; newPassword: string; confirmPassword: string };
type PasswordFieldErrors = PasswordForm;

const emptyPassword: PasswordForm = { currentPassword: '', newPassword: '', confirmPassword: '' };
const emptyPasswordErrors: PasswordFieldErrors = { currentPassword: '', newPassword: '', confirmPassword: '' };
const emptyProfileErrors: ProfileFieldErrors = { displayName: '', avatarUrl: '' };

/**
 * Account settings for the rail's user menu. See docs/14-frontend-api-gaps.md G11.
 *
 * Field limits come from GET /system/capabilities rather than local constants, so
 * this form validates against the same numbers PUT /auth/me enforces.
 */
export function AccountSettingsDialog({ open, onClose, onProfileSaved }: AccountSettingsDialogProps) {
  const toast = useToast();
  const capabilities = useSystemCapabilities();
  const [profile, setProfile] = useState<ProfileForm>({ displayName: '', avatarUrl: '' });
  const [profileError, setProfileError] = useState('');
  const [profileFieldErrors, setProfileFieldErrors] = useState<ProfileFieldErrors>(emptyProfileErrors);
  const [profileSaving, setProfileSaving] = useState(false);
  const [password, setPassword] = useState<PasswordForm>(emptyPassword);
  const [passwordFieldErrors, setPasswordFieldErrors] = useState<PasswordFieldErrors>(emptyPasswordErrors);
  const [passwordFormError, setPasswordFormError] = useState('');
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [loadError, setLoadError] = useState('');
  const currentPasswordRef = useRef<HTMLInputElement>(null);
  const newPasswordRef = useRef<HTMLInputElement>(null);
  const confirmPasswordRef = useRef<HTMLInputElement>(null);

  // Read the profile fresh on open: the rail only keeps the display name.
  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoadError('');
    setProfileError('');
    setProfileFieldErrors(emptyProfileErrors);
    setPasswordFieldErrors(emptyPasswordErrors);
    setPasswordFormError('');
    setPassword(emptyPassword);
    void currentUserStore
      .load(getCurrentUser)
      .then((user) => {
        if (!active) return;
        setProfile({ displayName: user.displayName ?? '', avatarUrl: user.avatarUrl ?? '' });
      })
      .catch((error: unknown) => {
        if (active) setLoadError(getErrorMessage(error, '账户信息加载失败'));
      });
    return () => {
      active = false;
    };
  }, [open]);

  const submitProfile = async (event: FormEvent) => {
    event.preventDefault();
    if (profileSaving) return;
    setProfileError('');
    const nextProfile = {
      displayName: profile.displayName.trim(),
      avatarUrl: profile.avatarUrl.trim(),
    };
    const fieldErrors: ProfileFieldErrors = {
      displayName: !nextProfile.displayName
        ? '显示名称不能为空'
        : countUnicodeCodePoints(nextProfile.displayName) > capabilities.account.maxDisplayNameLength
          ? `显示名称不能超过 ${capabilities.account.maxDisplayNameLength} 个字符`
          : '',
      avatarUrl: countUnicodeCodePoints(nextProfile.avatarUrl) > capabilities.account.maxAvatarUrlLength
        ? `头像地址不能超过 ${capabilities.account.maxAvatarUrlLength} 个字符`
        : '',
    };
    setProfileFieldErrors(fieldErrors);
    if (fieldErrors.displayName || fieldErrors.avatarUrl) return;
    setProfileSaving(true);
    try {
      const updated = await updateProfile(nextProfile);
      // The cached user is now stale; the next read refetches it.
      currentUserStore.clear();
      onProfileSaved?.(updated);
      toast.success('账户资料已更新');
    } catch (error) {
      setProfileError(getErrorMessage(error, '账户资料更新失败'));
    } finally {
      setProfileSaving(false);
    }
  };

  const submitPassword = async (event: FormEvent) => {
    event.preventDefault();
    if (passwordSaving) return;
    setPasswordFieldErrors(emptyPasswordErrors);
    setPasswordFormError('');
    if (password.newPassword !== password.confirmPassword) {
      setPasswordFieldErrors({ ...emptyPasswordErrors, confirmPassword: '两次输入的新密码不一致' });
      confirmPasswordRef.current?.focus();
      return;
    }
    const lengthError = validatePasswordLength(
      password.newPassword,
      capabilities.account.minPasswordLength,
      capabilities.account.maxPasswordBytes,
    );
    if (lengthError === 'tooShort') {
      setPasswordFieldErrors({
        ...emptyPasswordErrors,
        newPassword: `新密码至少需要 ${capabilities.account.minPasswordLength} 个字符`,
      });
      newPasswordRef.current?.focus();
      return;
    }
    if (lengthError === 'tooLong') {
      setPasswordFieldErrors({
        ...emptyPasswordErrors,
        newPassword: `新密码不能超过 ${capabilities.account.maxPasswordBytes} 个 UTF-8 字节`,
      });
      newPasswordRef.current?.focus();
      return;
    }
    setPasswordSaving(true);
    try {
      await changePassword({
        currentPassword: password.currentPassword,
        newPassword: password.newPassword,
      });
      setPassword(emptyPassword);
      setPasswordFieldErrors(emptyPasswordErrors);
      toast.success('密码已修改');
    } catch (error) {
      if (error instanceof ApiError && error.code === 'INVALID_CURRENT_PASSWORD') {
        setPasswordFieldErrors({
          ...emptyPasswordErrors,
          currentPassword: getErrorMessage(error, '当前密码不正确'),
        });
        currentPasswordRef.current?.focus();
      } else {
        setPasswordFormError(getErrorMessage(error, '密码修改失败'));
      }
    } finally {
      setPasswordSaving(false);
    }
  };

  return (
    <Dialog
      description="修改显示名称、头像和登录密码。"
      onClose={onClose}
      open={open}
      title="账户设置"
    >
      {loadError && <p className="ui-field__error" role="alert">{loadError}</p>}

      <form className="ui-dialog__form" onSubmit={(event) => void submitProfile(event)}>
        {profileError && <p className="ui-field__error" role="alert">{profileError}</p>}
        <Field
          error={profileFieldErrors.displayName}
          htmlFor="account-display-name"
          hint={`最多 ${capabilities.account.maxDisplayNameLength} 个字符`}
          label="显示名称"
        >
          <Input
            id="account-display-name"
            onChange={(event) => {
              setProfile((current) => ({ ...current, displayName: event.target.value }));
              setProfileFieldErrors((current) => ({ ...current, displayName: '' }));
            }}
            required
            value={profile.displayName}
          />
        </Field>
        <Field
          error={profileFieldErrors.avatarUrl}
          htmlFor="account-avatar-url"
          hint={`支持 http/https 地址或站内相对路径（以 / 开头），最多 ${capabilities.account.maxAvatarUrlLength} 个字符`}
          label="头像地址"
        >
          <Input
            id="account-avatar-url"
            onChange={(event) => {
              setProfile((current) => ({ ...current, avatarUrl: event.target.value }));
              setProfileFieldErrors((current) => ({ ...current, avatarUrl: '' }));
            }}
            placeholder="https://example.com/avatar.png"
            value={profile.avatarUrl}
          />
        </Field>
        <div className="ui-dialog__actions">
          <Button disabled={profileSaving} type="submit">
            {profileSaving ? '保存中…' : '保存资料'}
          </Button>
        </div>
      </form>

      <div className="ui-menu-sep" />

      <form className="ui-dialog__form" onSubmit={(event) => void submitPassword(event)}>
        {passwordFormError && <p className="ui-field__error" role="alert">{passwordFormError}</p>}
        <Field error={passwordFieldErrors.currentPassword} htmlFor="account-current-password" label="当前密码">
          <Input
            autoComplete="current-password"
            id="account-current-password"
            onChange={(event) => {
              setPassword((current) => ({ ...current, currentPassword: event.target.value }));
              setPasswordFieldErrors((current) => ({ ...current, currentPassword: '' }));
            }}
            ref={currentPasswordRef}
            required
            type="password"
            value={password.currentPassword}
          />
        </Field>
        <Field
          error={passwordFieldErrors.newPassword}
          htmlFor="account-new-password"
          hint={`至少 ${capabilities.account.minPasswordLength} 个字符，最多 ${capabilities.account.maxPasswordBytes} 个 UTF-8 字节`}
          label="新密码"
        >
          <Input
            autoComplete="new-password"
            id="account-new-password"
            onChange={(event) => {
              setPassword((current) => ({ ...current, newPassword: event.target.value }));
              setPasswordFieldErrors((current) => ({ ...current, newPassword: '' }));
            }}
            ref={newPasswordRef}
            required
            type="password"
            value={password.newPassword}
          />
        </Field>
        <Field error={passwordFieldErrors.confirmPassword} htmlFor="account-confirm-password" label="确认新密码">
          <Input
            autoComplete="new-password"
            id="account-confirm-password"
            onChange={(event) => {
              setPassword((current) => ({ ...current, confirmPassword: event.target.value }));
              setPasswordFieldErrors((current) => ({ ...current, confirmPassword: '' }));
            }}
            ref={confirmPasswordRef}
            required
            type="password"
            value={password.confirmPassword}
          />
        </Field>
        <div className="ui-dialog__actions">
          <Button disabled={passwordSaving} type="submit" variant="secondary">
            {passwordSaving ? '修改中…' : '修改密码'}
          </Button>
          <Button onClick={onClose} type="button" variant="ghost">关闭</Button>
        </div>
      </form>
    </Dialog>
  );
}
