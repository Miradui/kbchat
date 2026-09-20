import { act, fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Route, Routes } from 'react-router-dom';

import { ApiError } from '../../api/client';
import { login } from '../../api/resources';
import { renderWithRouter } from '../../test/render';
import type { LoginResponse } from '../../types/api';
import { LoginPage } from './LoginPage';

vi.mock('../../api/resources', () => ({ login: vi.fn() }));
const mockedLogin = vi.mocked(login);

function renderLogin(loginRequest?: typeof login, from?: string) {
  return renderWithRouter(
    <Routes>
      <Route path="/login" element={<LoginPage loginRequest={loginRequest} />} />
      <Route path="/home" element={<h1>首页</h1>} />
      <Route path="/knowledge-bases/:id/documents" element={<h1>文档来源</h1>} />
    </Routes>,
    [{ pathname: '/login', state: from ? { from } : undefined }],
  );
}

beforeEach(() => mockedLogin.mockReset());

describe('LoginPage', () => {
  it('rejects whitespace-only credentials and focuses the first invalid field', async () => {
    const user = userEvent.setup();
    renderLogin();
    const username = screen.getByLabelText('用户名');

    await user.type(username, '   ');
    await user.type(screen.getByLabelText('密码'), '   ');
    await user.click(screen.getByRole('button', { name: '登录' }));

    expect(mockedLogin).not.toHaveBeenCalled();
    expect(username).toHaveFocus();
    expect(username).toHaveAttribute('aria-invalid', 'true');
    expect(username).toHaveAccessibleDescription('请输入用户名');
  });

  it('toggles password visibility without hiding its label', async () => {
    const user = userEvent.setup();
    renderLogin();
    const password = screen.getByLabelText('密码');
    expect(password).toHaveAttribute('type', 'password');
    await user.click(screen.getByRole('button', { name: '显示密码' }));
    expect(password).toHaveAttribute('type', 'text');
    await user.click(screen.getByRole('button', { name: '隐藏密码' }));
    expect(password).toHaveAttribute('type', 'password');
  });

  it('prevents repeat submit and navigates home after success', async () => {
    let resolveLogin!: (value: LoginResponse) => void;
    mockedLogin.mockReturnValue(new Promise((resolve) => { resolveLogin = resolve; }));
    const user = userEvent.setup();
    renderLogin();
    await user.type(screen.getByLabelText('用户名'), 'admin');
    await user.type(screen.getByLabelText('密码'), 'secret');
    const form = screen.getByRole('button', { name: '登录' }).closest('form');
    expect(form).not.toBeNull();
    fireEvent.submit(form!);
    fireEvent.submit(form!);

    expect(mockedLogin).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: '登录中' })).toBeDisabled();
    await act(async () => resolveLogin({ token: 'token-value', user: { id: 'u1', username: 'admin', displayName: '管理员' } }));
    expect(await screen.findByRole('heading', { name: '首页' })).toBeInTheDocument();
  });

  it('shows the backend error and moves focus to the summary', async () => {
    const user = userEvent.setup();
    renderLogin(() => Promise.reject(new ApiError(401, { code: 'INVALID_CREDENTIALS', message: '用户名或密码错误' })));
    await user.type(screen.getByLabelText('用户名'), 'admin');
    await user.type(screen.getByLabelText('密码'), 'bad');
    await user.click(screen.getByRole('button', { name: '登录' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('用户名或密码错误');
    expect(alert).toHaveFocus();
  });

  it('shows a rate limit retry delay inside the login form', async () => {
    const user = userEvent.setup();
    renderLogin(() => Promise.reject(new ApiError(429, {
      code: 'RATE_LIMITED',
      message: '请求过于频繁，请稍后重试',
      details: { retryAfter: 23 },
    })));
    await user.type(screen.getByLabelText('用户名'), 'admin');
    await user.type(screen.getByLabelText('密码'), 'bad');
    await user.click(screen.getByRole('button', { name: '登录' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('请求过于频繁，请 23 秒后再试');
    expect(alert).toHaveFocus();
    expect(alert.closest('form')).not.toBeNull();
  });

  it('rejects a password over the bcrypt UTF-8 byte limit before login', async () => {
    const user = userEvent.setup();
    renderLogin();
    const password = screen.getByLabelText('密码');

    await user.type(screen.getByLabelText('用户名'), 'admin');
    await user.type(password, '界'.repeat(25));
    await user.click(screen.getByRole('button', { name: '登录' }));

    expect(mockedLogin).not.toHaveBeenCalled();
    expect(password).toHaveFocus();
    expect(screen.getByRole('alert')).toHaveTextContent('密码不能超过 72 个 UTF-8 字节');
    expect(password).toHaveAccessibleDescription('密码不能超过 72 个 UTF-8 字节');
  });

  it('shows the custom required error on the password input', async () => {
    const user = userEvent.setup();
    renderLogin();
    const password = screen.getByLabelText('密码');

    await user.type(screen.getByLabelText('用户名'), 'admin');
    await user.click(screen.getByRole('button', { name: '登录' }));

    expect(mockedLogin).not.toHaveBeenCalled();
    expect(password).toHaveFocus();
    expect(password).toHaveAccessibleDescription('请输入密码');
  });

  it('submits a non-empty whitespace password without trimming it', async () => {
    mockedLogin.mockResolvedValue({
      token: 'token-value',
      user: { id: 'u1', username: 'admin', displayName: '管理员' },
    });
    const user = userEvent.setup();
    renderLogin();

    await user.type(screen.getByLabelText('用户名'), 'admin');
    await user.type(screen.getByLabelText('密码'), '        ');
    await user.click(screen.getByRole('button', { name: '登录' }));

    expect(mockedLogin).toHaveBeenCalledWith('admin', '        ');
  });

  it('returns to the protected location after login', async () => {
    mockedLogin.mockResolvedValue({
      token: 'token-value',
      user: { id: 'u1', username: 'admin', displayName: '管理员' },
    });
    const user = userEvent.setup();
    renderLogin(undefined, '/knowledge-bases/kb1/documents?documentId=doc1&chunkId=chunk1');

    await user.type(screen.getByLabelText('用户名'), 'admin');
    await user.type(screen.getByLabelText('密码'), 'secret');
    await user.click(screen.getByRole('button', { name: '登录' }));

    expect(await screen.findByRole('heading', { name: '文档来源' })).toBeInTheDocument();
  });

  it('ignores an external login return target', async () => {
    mockedLogin.mockResolvedValue({
      token: 'token-value',
      user: { id: 'u1', username: 'admin', displayName: '管理员' },
    });
    const user = userEvent.setup();
    renderLogin(undefined, '//evil.example/steal');

    await user.type(screen.getByLabelText('用户名'), 'admin');
    await user.type(screen.getByLabelText('密码'), 'secret');
    await user.click(screen.getByRole('button', { name: '登录' }));

    expect(await screen.findByRole('heading', { name: '首页' })).toBeInTheDocument();
  });

  it('ignores a backslash network-path login return target', async () => {
    mockedLogin.mockResolvedValue({
      token: 'token-value',
      user: { id: 'u1', username: 'admin', displayName: '管理员' },
    });
    const user = userEvent.setup();
    renderLogin(undefined, '/\\evil.example/steal');

    await user.type(screen.getByLabelText('用户名'), 'admin');
    await user.type(screen.getByLabelText('密码'), 'secret');
    await user.click(screen.getByRole('button', { name: '登录' }));

    expect(await screen.findByRole('heading', { name: '首页' })).toBeInTheDocument();
  });
});
