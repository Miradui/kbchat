import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';

import { tokenStore } from '../store/tokenStore';
import { ProtectedRoute } from './ProtectedRoute';

afterEach(() => tokenStore.clearToken());

function renderRoute() {
  return render(
    <MemoryRouter initialEntries={['/home']}>
      <Routes>
        <Route path="/login" element={<h1>登录</h1>} />
        <Route element={<ProtectedRoute />}>
          <Route path="/home" element={<h1>首页</h1>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('ProtectedRoute', () => {
  it('redirects anonymous users to login', () => {
    tokenStore.clearToken();
    renderRoute();
    expect(screen.getByRole('heading', { name: '登录' })).toBeInTheDocument();
  });

  it('renders the protected outlet for authenticated users', () => {
    tokenStore.setToken('token');
    renderRoute();
    expect(screen.getByRole('heading', { name: '首页' })).toBeInTheDocument();
  });
});
