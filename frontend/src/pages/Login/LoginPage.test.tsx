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

function renderLogin(loginRequest?: typeof login) {
  return renderWithRouter(
    <Routes><Route path="/login" element={<LoginPage loginRequest={loginRequest} />} /><Route path="/home" element={<h1>首页</h1>} /></Routes>,
    ['/login'],
  );
}

beforeEach(() => mockedLogin.mockReset());

describe('LoginPage', () => {
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
});
