import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';

import { tokenStore } from '../store/tokenStore';
import { ProtectedRoute } from './ProtectedRoute';

afterEach(() => tokenStore.clearToken());

function LoginProbe() {
  const location = useLocation();
  return <output aria-label="登录来源">{location.state?.from ?? ''}</output>;
}

function renderRoute(entry = '/home') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/login" element={<><h1>登录</h1><LoginProbe /></>} />
        <Route element={<ProtectedRoute />}>
          <Route path="/home" element={<h1>首页</h1>} />
          <Route path="/knowledge-bases/:id/documents" element={<h1>文档</h1>} />
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

  it('preserves the full protected location for login', () => {
    tokenStore.clearToken();
    renderRoute('/knowledge-bases/kb1/documents?documentId=doc1&chunkId=chunk1');

    expect(screen.getByRole('status', { name: '登录来源' })).toHaveTextContent(
      '/knowledge-bases/kb1/documents?documentId=doc1&chunkId=chunk1',
    );
  });

  it('renders the protected outlet for authenticated users', () => {
    tokenStore.setToken('token');
    renderRoute();
    expect(screen.getByRole('heading', { name: '首页' })).toBeInTheDocument();
  });
});
