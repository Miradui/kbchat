import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../api/client';
import { ToastProvider } from '../components/feedback/ToastProvider';
import { currentUserStore } from '../store/currentUserStore';
import { AccountSettingsDialog } from './AccountSettingsDialog';

const resourceMocks = vi.hoisted(() => ({
  changePassword: vi.fn(),
  getCurrentUser: vi.fn(),
  updateProfile: vi.fn(),
}));

vi.mock('../api/resources', () => resourceMocks);
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
    },
  }),
}));

function renderDialog(onProfileSaved = vi.fn()) {
  return render(
    <ToastProvider>
      <AccountSettingsDialog onClose={vi.fn()} onProfileSaved={onProfileSaved} open />
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

describe('AccountSettingsDialog password limits', () => {
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
  });

  it('submits a 72-byte multibyte password', async () => {
    const user = userEvent.setup();
    renderDialog();
    await screen.findByDisplayValue('Owner');
    const inputs = passwordInputs();

    await user.type(inputs.current, 'current-secret');
    await user.type(inputs.next, '界'.repeat(24));
    await user.type(inputs.confirm, '界'.repeat(24));
    await user.click(screen.getByRole('button', { name: '修改密码' }));

    expect(resourceMocks.changePassword).toHaveBeenCalledWith({
      currentPassword: 'current-secret',
      newPassword: '界'.repeat(24),
    });
  });

  it('rejects a password over 72 UTF-8 bytes before calling the API', async () => {
    const user = userEvent.setup();
    renderDialog();
    await screen.findByDisplayValue('Owner');
    const inputs = passwordInputs();

    await user.type(inputs.current, 'current-secret');
    await user.type(inputs.next, '界'.repeat(25));
    await user.type(inputs.confirm, '界'.repeat(25));
    await user.click(screen.getByRole('button', { name: '修改密码' }));

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
    const inputs = passwordInputs();

    await user.type(inputs.current, 'incorrect-current-password');
    await user.type(inputs.next, 'new-password');
    await user.type(inputs.confirm, 'new-password');
    await user.click(screen.getByRole('button', { name: '修改密码' }));

    expect(await screen.findByText('当前密码不正确')).toBeInTheDocument();
    expect(inputs.current).toHaveFocus();
    expect(inputs.current).toHaveAttribute('aria-invalid', 'true');
    expect(inputs.next).not.toHaveAttribute('aria-invalid', 'true');
  });

  it('counts display names and avatar URLs by Unicode code points instead of UTF-16 units', async () => {
    const user = userEvent.setup();
    const updatedUser = {
      id: 'user-1', username: 'owner', displayName: '😀'.repeat(128), avatarUrl: '', role: 'user',
    };
    const onProfileSaved = vi.fn();
    resourceMocks.updateProfile.mockResolvedValue(updatedUser);
    renderDialog(onProfileSaved);
    const displayName = await screen.findByLabelText('显示名称');
    const avatarUrl = screen.getByLabelText('头像地址');
    const unicodeName = '😀'.repeat(128);
    const prefix = 'https://example.com/';
    const unicodeAvatar = prefix + '😀'.repeat(512 - Array.from(prefix).length);

    expect(displayName).not.toHaveAttribute('maxlength');
    expect(avatarUrl).not.toHaveAttribute('maxlength');
    fireEvent.change(displayName, { target: { value: unicodeName } });
    fireEvent.change(avatarUrl, { target: { value: unicodeAvatar } });
    await user.click(screen.getByRole('button', { name: '保存资料' }));

    expect(resourceMocks.updateProfile).toHaveBeenCalledWith({
      displayName: unicodeName,
      avatarUrl: unicodeAvatar,
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
});
