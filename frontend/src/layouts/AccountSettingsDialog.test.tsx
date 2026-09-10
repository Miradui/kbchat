import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../api/client';
import { ToastProvider } from '../components/feedback/ToastProvider';
import { currentUserStore } from '../store/currentUserStore';
import type { User } from '../types/api';
import { AccountSettingsDialog } from './AccountSettingsDialog';

const resourceMocks = vi.hoisted(() => ({
  changePassword: vi.fn(),
  getCurrentUser: vi.fn(),
  updateProfile: vi.fn(),
  uploadAvatar: vi.fn(),
  removeAvatar: vi.fn(),
}));
const avatarMocks = vi.hoisted(() => ({ prepare: vi.fn(), createURL: vi.fn(), revokeURL: vi.fn() }));

vi.mock('../api/resources', () => resourceMocks);
vi.mock('../utils/avatar', async importOriginal => ({
  ...await importOriginal<typeof import('../utils/avatar')>(),
  prepareAvatarUpload: avatarMocks.prepare,
}));
vi.mock('../hooks/useSystemCapabilities', () => ({
  useSystemCapabilities: () => ({
    rerankEnabled: false,
    upload: { maxFileBytes: 1, allowedExtensions: ['txt'] },
    retrieval: { maxVectorTopN: 100, maxRerankTopK: 20 },
    account: {
      minPasswordLength: 8,
      maxPasswordBytes: 72,
      maxDisplayNameLength: 128,
      maxAvatarUrlLength: 512,
      maxAvatarBytes: 2097152,
      avatarSize: 256,
    },
  }),
}));

function renderDialog(onProfileSaved = vi.fn(), onClose = vi.fn()) {
  return render(
    <ToastProvider>
      <AccountSettingsDialog onClose={onClose} onProfileSaved={onProfileSaved} open />
    </ToastProvider>,
  );
}

function passwordInputs() {
  const dialog = screen.getByRole('dialog');
  const current = dialog.querySelector<HTMLInputElement>('input[autocomplete="current-password"]');
  const newPasswords = dialog.querySelectorAll<HTMLInputElement>('input[autocomplete="new-password"]');
  if (!current || newPasswords.length !== 2) throw new Error('password inputs not found');
  return { current, next: newPasswords[0], confirm: newPasswords[1] };
}

const savedUser: User = { id: 'user-1', username: 'owner', displayName: 'Owner', avatarUrl: '', role: 'user' };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

async function pickAvatar(user: ReturnType<typeof userEvent.setup>) {
  await user.upload(screen.getByLabelText('选择头像图片'), new File(['image'], 'portrait.jpg', { type: 'image/jpeg' }));
  await screen.findByRole('img', { name: '待保存的头像' });
}

describe('AccountSettingsDialog', () => {
  beforeEach(() => {
    currentUserStore.clear();
    resourceMocks.changePassword.mockReset().mockResolvedValue(undefined);
    resourceMocks.getCurrentUser.mockReset().mockResolvedValue({
      id: 'user-1',
      username: 'owner',
      displayName: 'Owner',
      avatarUrl: '',
      role: 'user',
    });
    resourceMocks.updateProfile.mockReset();
    resourceMocks.uploadAvatar.mockReset();
    resourceMocks.removeAvatar.mockReset();
    avatarMocks.prepare.mockReset().mockResolvedValue(new File(['normalized'], 'avatar.png', { type: 'image/png' }));
    avatarMocks.createURL.mockReset().mockReturnValue('blob:preview');
    avatarMocks.revokeURL.mockReset();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: avatarMocks.createURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: avatarMocks.revokeURL });
  });

  it('submits a 72-byte multibyte password', async () => {
    const user = userEvent.setup();
    renderDialog();
    await screen.findByDisplayValue('Owner');
    await user.click(screen.getByRole('button', { name: '修改密码', exact: true }));
    const inputs = passwordInputs();

    await user.type(inputs.current, 'current-secret');
    await user.type(inputs.next, '界'.repeat(24));
    await user.type(inputs.confirm, '界'.repeat(24));
    await user.click(screen.getByRole('button', { name: '保存新密码' }));

    expect(resourceMocks.changePassword).toHaveBeenCalledWith({
      currentPassword: 'current-secret',
      newPassword: '界'.repeat(24),
    });
  });

  it('rejects a password over 72 UTF-8 bytes before calling the API', async () => {
    const user = userEvent.setup();
    renderDialog();
    await screen.findByDisplayValue('Owner');
    await user.click(screen.getByRole('button', { name: '修改密码', exact: true }));
    const inputs = passwordInputs();

    await user.type(inputs.current, 'current-secret');
    await user.type(inputs.next, '界'.repeat(25));
    await user.type(inputs.confirm, '界'.repeat(25));
    await user.click(screen.getByRole('button', { name: '保存新密码' }));

    expect(resourceMocks.changePassword).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('新密码不能超过 72 个 UTF-8 字节');
  });

  it('binds an invalid current password error to the current password field', async () => {
    const user = userEvent.setup();
    resourceMocks.changePassword.mockRejectedValue(new ApiError(400, {
      code: 'INVALID_CURRENT_PASSWORD',
      message: '当前密码不正确',
    }));
    renderDialog();
    await screen.findByDisplayValue('Owner');
    await user.click(screen.getByRole('button', { name: '修改密码', exact: true }));
    const inputs = passwordInputs();

    await user.type(inputs.current, 'incorrect-current-password');
    await user.type(inputs.next, 'new-password');
    await user.type(inputs.confirm, 'new-password');
    await user.click(screen.getByRole('button', { name: '保存新密码' }));

    expect(await screen.findByText('当前密码不正确')).toBeInTheDocument();
    expect(inputs.current).toHaveFocus();
    expect(inputs.current).toHaveAttribute('aria-invalid', 'true');
    expect(inputs.next).not.toHaveAttribute('aria-invalid', 'true');
  });

  it('counts display names by Unicode code points and omits avatarUrl from name saves', async () => {
    const user = userEvent.setup();
    const updatedUser = {
      id: 'user-1', username: 'owner', displayName: '😀'.repeat(128), avatarUrl: '', role: 'user',
    };
    const onProfileSaved = vi.fn();
    resourceMocks.updateProfile.mockResolvedValue(updatedUser);
    renderDialog(onProfileSaved);
    const displayName = await screen.findByLabelText('显示名称');
    const unicodeName = '😀'.repeat(128);

    expect(displayName).not.toHaveAttribute('maxlength');
    fireEvent.change(displayName, { target: { value: unicodeName } });
    await user.click(screen.getByRole('button', { name: '保存资料' }));

    expect(resourceMocks.updateProfile).toHaveBeenCalledWith({
      displayName: unicodeName,
    });
    expect(onProfileSaved).toHaveBeenCalledWith(updatedUser);
  });

  it('rejects profile fields beyond the Unicode code-point limits', async () => {
    const user = userEvent.setup();
    renderDialog();
    const displayName = await screen.findByLabelText('显示名称');
    fireEvent.change(displayName, { target: { value: '😀'.repeat(129) } });
    await user.click(screen.getByRole('button', { name: '保存资料' }));

    expect(resourceMocks.updateProfile).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('显示名称不能超过 128 个字符');
  });

  it('keeps editing unavailable until profile loading succeeds and allows retry', async () => {
    const user = userEvent.setup();
    resourceMocks.getCurrentUser.mockRejectedValueOnce(new ApiError(503, { code: 'UNAVAILABLE', message: '暂时无法读取账户' }));
    renderDialog();
    expect(screen.queryByLabelText('显示名称')).not.toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent('暂时无法读取账户');
    await user.click(screen.getByRole('button', { name: '重新加载' }));
    expect(await screen.findByDisplayValue('Owner')).toBeEnabled();
  });

  it('preserves drafts between views and releases the preview when cancelling', async () => {
    const user = userEvent.setup();
    renderDialog();
    await screen.findByDisplayValue('Owner');
    await pickAvatar(user);
    fireEvent.change(screen.getByLabelText('显示名称'), { target: { value: '未保存的名称' } });
    await user.click(screen.getByRole('button', { name: '修改密码', exact: true }));
    await user.type(screen.getByLabelText('当前密码'), 'unfinished');
    await user.click(screen.getByRole('button', { name: '个人资料' }));
    expect(screen.getByDisplayValue('未保存的名称')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: '待保存的头像' })).toBeInTheDocument();
    expect(resourceMocks.uploadAvatar).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '取消更换' }));
    expect(avatarMocks.revokeURL).toHaveBeenCalledWith('blob:preview');
    expect(screen.getByRole('button', { name: '选择图片' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: '修改密码', exact: true }));
    expect(screen.getByLabelText('当前密码')).toHaveValue('unfinished');
  });

  it('keeps the preview after upload failure and preserves the name draft on retry success', async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    resourceMocks.uploadAvatar.mockRejectedValueOnce(new Error('保存失败，请重试')).mockResolvedValue({ ...savedUser, avatarUrl: '/static/saved.png' });
    renderDialog(onSaved);
    await screen.findByDisplayValue('Owner');
    fireEvent.change(screen.getByLabelText('显示名称'), { target: { value: '名称草稿' } });
    await pickAvatar(user);
    await user.click(screen.getByRole('button', { name: '保存头像' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('保存失败，请重试');
    expect(screen.getByRole('img', { name: '待保存的头像' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '保存头像' }));
    await waitFor(() => expect(screen.queryByRole('img', { name: '待保存的头像' })).not.toBeInTheDocument());
    expect(onSaved).toHaveBeenCalledWith({ ...savedUser, avatarUrl: '/static/saved.png' });
    expect(screen.getByLabelText('显示名称')).toHaveValue('名称草稿');
    expect(screen.getByRole('button', { name: '更换图片' })).toHaveFocus();
    expect(avatarMocks.revokeURL).toHaveBeenCalledWith('blob:preview');
  });

  it('blocks duplicate writes and closing while saving', async () => {
    const user = userEvent.setup();
    const response = deferred<User>();
    const onClose = vi.fn();
    resourceMocks.uploadAvatar.mockReturnValue(response.promise);
    renderDialog(vi.fn(), onClose);
    await screen.findByDisplayValue('Owner');
    await pickAvatar(user);
    const save = screen.getByRole('button', { name: '保存头像' });
    fireEvent.click(save);
    fireEvent.click(save);
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.mouseDown(screen.getByTestId('dialog-backdrop'));
    expect(resourceMocks.uploadAvatar).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '关闭' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '修改密码', exact: true })).toBeDisabled();
    await act(async () => response.resolve(savedUser));
    expect(screen.getByRole('button', { name: '关闭' })).toBeEnabled();
  });

  it('ignores a late save from an earlier opening', async () => {
    const user = userEvent.setup();
    const response = deferred<User>();
    const onSaved = vi.fn();
    const onClose = vi.fn();
    resourceMocks.uploadAvatar.mockReturnValue(response.promise);
    const view = renderDialog(onSaved, onClose);
    await screen.findByDisplayValue('Owner');
    await pickAvatar(user);
    await user.click(screen.getByRole('button', { name: '保存头像' }));
    view.rerender(<ToastProvider><AccountSettingsDialog open={false} onClose={onClose} onProfileSaved={onSaved} /></ToastProvider>);
    resourceMocks.getCurrentUser.mockResolvedValue({ ...savedUser, displayName: 'Fresh profile' });
    view.rerender(<ToastProvider><AccountSettingsDialog open onClose={onClose} onProfileSaved={onSaved} /></ToastProvider>);
    await screen.findByDisplayValue('Fresh profile');
    await act(async () => response.resolve(savedUser));
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.getByLabelText('显示名称')).toHaveValue('Fresh profile');
    expect(avatarMocks.revokeURL).toHaveBeenCalledWith('blob:preview');
  });

  it('retains the saved avatar on removal failure and restores the initial after success', async () => {
    const user = userEvent.setup();
    resourceMocks.getCurrentUser.mockResolvedValue({ ...savedUser, avatarUrl: '/static/saved.png' });
    resourceMocks.removeAvatar.mockRejectedValueOnce(new Error('移除失败')).mockResolvedValue(savedUser);
    renderDialog();
    await screen.findByDisplayValue('Owner');
    await user.click(screen.getByRole('button', { name: '移除头像' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('移除失败');
    expect(screen.getByRole('img', { name: '当前头像' }).querySelector('img')).toHaveAttribute('src', '/static/saved.png');
    await user.click(screen.getByRole('button', { name: '移除头像' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: '移除头像' })).not.toBeInTheDocument());
    expect(screen.getByRole('img', { name: '当前头像' }).querySelector('img')).toBeNull();
    expect(screen.getByRole('button', { name: '选择图片' })).toHaveFocus();
  });
});
