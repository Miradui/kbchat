import { fireEvent, render, screen } from '@testing-library/react';
import { lazy, Suspense } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { RenderBoundary } from './RenderBoundary';

afterEach(() => vi.restoreAllMocks());

it('isolates a broken preview and retries without removing surrounding content', () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  let broken = true;
  function Preview() { if (broken) throw new Error('private stack'); return <p>预览恢复</p>; }
  render(<><input aria-label="问题" defaultValue="保留草稿" /><RenderBoundary local><Preview /></RenderBoundary></>);
  expect(screen.getByRole('alert')).toHaveTextContent('这部分内容暂时无法显示');
  expect(screen.queryByText('private stack')).toBeNull();
  broken = false;
  fireEvent.click(screen.getByRole('button', { name: '重试显示' }));
  expect(screen.getByText('预览恢复')).toBeInTheDocument();
  expect(screen.getByLabelText('问题')).toHaveValue('保留草稿');
});

it('handles a rejected lazy import and resets for another route', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const Page = lazy(() => Promise.reject(new Error('chunk offline')));
  const view = render(<RenderBoundary resetKey="a"><Suspense fallback="加载中"><Page /></Suspense></RenderBoundary>);
  expect(await screen.findByRole('button', { name: '刷新页面' })).toBeInTheDocument();
  view.rerender(<RenderBoundary resetKey="b"><h1>正常页面</h1></RenderBoundary>);
  expect(screen.getByRole('heading', { name: '正常页面' })).toBeInTheDocument();
});
