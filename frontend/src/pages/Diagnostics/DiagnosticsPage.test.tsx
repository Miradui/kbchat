import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithRouter } from '../../test/render';
import type { SystemDiagnostics } from '../../types/api';
import { DiagnosticsPage } from './DiagnosticsPage';
import { getCurrentUser } from '../../api/resources';
import { currentUserStore } from '../../store/currentUserStore';
import { tokenStore } from '../../store/tokenStore';

vi.mock('../../api/resources', () => ({
  getCurrentUser: vi.fn(),
  getSystemDiagnostics: vi.fn(),
  logout: vi.fn().mockResolvedValue(undefined),
  listChatSessions: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 50 }),
  listKnowledgeBases: vi.fn().mockResolvedValue({ items: [] }),
}));

beforeEach(() => {
  currentUserStore.clear();
  vi.mocked(getCurrentUser).mockReset().mockResolvedValue({ id: 'user-1', username: 'admin', displayName: '管理员', role: 'admin' });
});

function diagnostics(overrides: Partial<SystemDiagnostics> = {}): SystemDiagnostics {
  return {
    status: 'ok',
    checkedAt: new Date().toISOString(),
    env: 'production',
    dependencies: [
      { name: 'database', status: 'ok', latencyMs: 3 },
      { name: 'redis', status: 'ok', latencyMs: 1 },
      { name: 'storage', status: 'ok', latencyMs: 12 },
    ],
    queues: {
      documents: {
        pending: 2, running: 1, failed: 4, completed: 30, cancelled: 0,
        oldestPendingSeconds: 125, oldestRunningSeconds: 8,
        failureWindowHours: 24, finishedInWindow: 10, failedInWindow: 2, recentFailureRate: 0.2,
      },
      cleanup: { backlog: 3, retrying: 1, locked: 0, oldestPendingSeconds: 3600 },
    },
    providers: [
      { name: 'chat', configured: true, model: 'gpt-test', status: 'ok', lastSuccessAt: new Date().toISOString(), lastFailureAt: null, successCount: 12, failureCount: 0, recentFailures: 0 },
      { name: 'embedding', configured: true, model: 'embed-test', status: 'ok', lastSuccessAt: null, lastFailureAt: null, successCount: 0, failureCount: 0, recentFailures: 0 },
      { name: 'rerank', configured: false, status: 'not_configured', lastSuccessAt: null, lastFailureAt: null, successCount: 0, failureCount: 0, recentFailures: 0 },
    ],
    latency: [
      { metric: 'retrieval', count: 40, sampleCount: 40, p50Ms: 120, p95Ms: 300, maxMs: 800 },
      { metric: 'chat_first_token', count: 40, sampleCount: 40, p50Ms: 420, p95Ms: 900, maxMs: 1500 },
    ],
    rerankFallbacks: {},
    rateLimitTriggers: { login: 3, chat: 7 },
    embeddingCache: { hits: 8, misses: 2, errors: 1, hitRate: 0.8 },
    vectorSearch: { pgvectorVersion: '0.5.1', iterativeScan: false, exactFallbacks: 4 },
    metricsSinceRestart: true,
    ...overrides,
  };
}

async function renderPage(payload: SystemDiagnostics) {
  const loadDiagnostics = vi.fn().mockResolvedValue(payload);
  renderWithRouter(<DiagnosticsPage sources={{ loadDiagnostics }} />);
  await waitFor(() => { expect(loadDiagnostics).toHaveBeenCalled(); });
  return loadDiagnostics;
}

describe('DiagnosticsPage', () => {
  it('does not request diagnostics for an ordinary user opening the URL directly', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue({ id: 'ordinary', username: 'reader', displayName: '普通用户', role: 'user' });
    const loadDiagnostics = vi.fn();
    renderWithRouter(<DiagnosticsPage sources={{ loadDiagnostics }} />);
    expect(await screen.findByRole('heading', { name: '需要系统管理员权限' })).toBeInTheDocument();
    expect(loadDiagnostics).not.toHaveBeenCalled();
    expect(screen.queryByRole('link', { name: '系统诊断' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: '返回首页' })).toHaveAttribute('href', '/home');
  });

  it('does not expose diagnostics when the current account cannot be checked', async () => {
    vi.mocked(getCurrentUser).mockRejectedValue(new Error('account unavailable'));
    const loadDiagnostics = vi.fn();
    renderWithRouter(<DiagnosticsPage sources={{ loadDiagnostics }} />);
    expect(await screen.findByRole('heading', { name: '无法确认访问权限' })).toBeInTheDocument();
    expect(loadDiagnostics).not.toHaveBeenCalled();
  });

  it('clears diagnostics after the backend reports an administrator revocation', async () => {
    const loadDiagnostics = await renderPage(diagnostics());
    vi.mocked(getCurrentUser).mockResolvedValue({ id: 'user-1', username: 'admin', displayName: '原管理员', role: 'user' });
    loadDiagnostics.mockRejectedValueOnce({ code: 'SYSTEM_ADMIN_REQUIRED', message: '此操作需要系统管理员权限' });
    await userEvent.click(screen.getByRole('button', { name: '刷新诊断数据' }));
    expect(await screen.findByRole('heading', { name: '需要系统管理员权限' })).toBeInTheDocument();
    expect(screen.queryByLabelText('依赖状态')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '系统诊断' })).not.toBeInTheDocument();
  });

  it('hides the previous administrator data when another account signs in', async () => {
    await renderPage(diagnostics());
    vi.mocked(getCurrentUser).mockResolvedValue({ id: 'user-2', username: 'reader', displayName: '普通用户', role: 'user' });
    act(() => tokenStore.setToken('ordinary-account-token'));
    expect(screen.queryByLabelText('依赖状态')).not.toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: '需要系统管理员权限' })).toBeInTheDocument();
  });

  it('renders dependency, queue, provider and latency state', async () => {
    await renderPage(diagnostics());

    const dependencies = await screen.findByLabelText('依赖状态');
    expect(within(dependencies).getByText('数据库')).toBeInTheDocument();
    expect(within(dependencies).getByText('对象存储')).toBeInTheDocument();
    expect(within(dependencies).getAllByText('正常')).toHaveLength(3);
    expect(within(dependencies).getByText('12 ms')).toBeInTheDocument();

    const queues = screen.getByLabelText('任务队列');
    expect(within(queues).getByText('排队中')).toBeInTheDocument();
    expect(within(queues).getByText('最老排队时间')).toBeInTheDocument();
    expect(within(queues).getByText('2 分钟')).toBeInTheDocument();
    expect(within(queues).getByText('近 24 小时失败率')).toBeInTheDocument();
    expect(within(queues).getByText('20%')).toBeInTheDocument();
    expect(within(queues).getByText(/对象清理队列：待处理 3/)).toBeInTheDocument();

    const runtime = screen.getByLabelText('当前进程指标');
    const rateLimits = within(runtime).getByLabelText('限流触发次数');
    expect(within(rateLimits).getByText('登录限流')).toBeInTheDocument();
    expect(within(rateLimits).getByText('聊天限流')).toBeInTheDocument();
    expect(within(rateLimits).getByText('3')).toBeInTheDocument();
    expect(within(rateLimits).getByText('7')).toBeInTheDocument();
    const cache = within(runtime).getByLabelText('查询向量缓存指标');
    expect(within(cache).getByText('缓存命中')).toBeInTheDocument();
    expect(within(cache).getByText('缓存未命中')).toBeInTheDocument();
    expect(within(cache).getByText('缓存错误')).toBeInTheDocument();
    expect(within(cache).getByText('80%')).toBeInTheDocument();
    const vector = within(runtime).getByLabelText('向量检索');
    expect(within(vector).getByText('0.5.1')).toBeInTheDocument();
    expect(within(vector).getByText('不支持')).toBeInTheDocument();
    expect(within(vector).getByText('4')).toBeInTheDocument();
    expect(within(runtime).getByText(/pgvector 低于 0\.8\.0/)).toBeInTheDocument();

    const providers = screen.getByLabelText('模型 Provider');
    expect(within(providers).getByText('对话模型')).toBeInTheDocument();
    expect(within(providers).getByText('gpt-test')).toBeInTheDocument();
    expect(within(providers).getByText('未配置')).toBeInTheDocument();

    const latency = screen.getByLabelText('调用耗时');
    expect(within(latency).getByText('检索总耗时')).toBeInTheDocument();
    expect(within(latency).getByText('模型首 token 延迟')).toBeInTheDocument();
    expect(within(latency).getByText('420 ms')).toBeInTheDocument();
    // The volatility of these numbers is stated, not implied.
    expect(within(latency).getByText(/服务重启后归零/)).toBeInTheDocument();
  });

  it('labels a failing dependency in Chinese without printing the raw code', async () => {
    await renderPage(diagnostics({
      status: 'down',
      dependencies: [
        { name: 'database', status: 'ok', latencyMs: 2 },
        { name: 'redis', status: 'ok', latencyMs: 1 },
        { name: 'storage', status: 'down', reason: 'unreachable', latencyMs: 2001 },
      ],
    }));

    const dependencies = await screen.findByLabelText('依赖状态');
    expect(within(dependencies).getByText('不可用')).toBeInTheDocument();
    expect(within(dependencies).getByText('无法连接')).toBeInTheDocument();
    expect(within(dependencies).queryByText('unreachable')).not.toBeInTheDocument();
    expect(screen.getByText(/整体状态：不可用/)).toBeInTheDocument();
  });

  it('falls back to neutral copy for an unknown reason code', async () => {
    await renderPage(diagnostics({
      status: 'down',
      dependencies: [{ name: 'database', status: 'down', reason: 'quota_exhausted_on_shard_7', latencyMs: 5 }],
    }));

    const dependencies = await screen.findByLabelText('依赖状态');
    // A future server code must not be echoed verbatim: that is the path by
    // which raw provider text could reach the page.
    expect(within(dependencies).queryByText(/quota_exhausted_on_shard_7/)).not.toBeInTheDocument();
    expect(within(dependencies).getByText('异常（详情见服务端日志）')).toBeInTheDocument();
  });

  it('renders an unconfigured Redis as 未配置 with no failure notice', async () => {
    await renderPage(diagnostics({
      dependencies: [
        { name: 'database', status: 'ok', latencyMs: 2 },
        { name: 'redis', status: 'not_configured', reason: 'not_configured', latencyMs: null },
      ],
    }));

    const dependencies = await screen.findByLabelText('依赖状态');
    const redis = within(dependencies).getByText('缓存 Redis').closest('li');
    expect(redis).not.toBeNull();
    expect(within(redis as HTMLElement).getByText('未配置')).toBeInTheDocument();
    expect(within(redis as HTMLElement).getByText('—')).toBeInTheDocument();
    // not_configured is a deployment choice, not a fault, so it gets no warning.
    expect(within(redis as HTMLElement).queryByText('未配置（详情见服务端日志）')).not.toBeInTheDocument();
  });

  it('shows an empty state instead of NaN when no latency samples exist', async () => {
    await renderPage(diagnostics({ latency: [], queues: {
      documents: {
        pending: 0, running: 0, failed: 0, completed: 0, cancelled: 0,
        oldestPendingSeconds: null, oldestRunningSeconds: null,
        failureWindowHours: 24, finishedInWindow: 0, failedInWindow: 0, recentFailureRate: null,
      },
      cleanup: { backlog: 0, retrying: 0, locked: 0, oldestPendingSeconds: null },
    } }));

    const latency = await screen.findByLabelText('调用耗时');
    expect(within(latency).getByText('暂无耗时样本')).toBeInTheDocument();
    expect(within(latency).queryByText(/NaN/)).not.toBeInTheDocument();

    const queues = screen.getByLabelText('任务队列');
    // An idle window has no failure rate; 0% would claim a clean record that was
    // never measured.
    expect(within(queues).getByText('暂无数据')).toBeInTheDocument();
    expect(within(queues).queryByText(/NaN/)).not.toBeInTheDocument();
  });

  it('reports rerank fallbacks with a mapped label', async () => {
    await renderPage(diagnostics({ rerankFallbacks: { provider_unavailable: 4 } }));

    const latency = await screen.findByLabelText('调用耗时');
    expect(within(latency).getByText(/重排服务不可用 4 次/)).toBeInTheDocument();
    expect(within(latency).queryByText(/provider_unavailable/)).not.toBeInTheDocument();
  });

  it('shows 暂无数据 when no embedding cache hit rate has been observed', async () => {
    await renderPage(diagnostics({
      rateLimitTriggers: {},
      embeddingCache: { hits: 0, misses: 0, errors: 2, hitRate: null },
    }));

    const runtime = await screen.findByLabelText('当前进程指标');
    const rateLimits = within(runtime).getByLabelText('限流触发次数');
    expect(within(rateLimits).getAllByText('0')).toHaveLength(2);
    const cache = within(runtime).getByLabelText('查询向量缓存指标');
    expect(within(cache).getByText('暂无数据')).toBeInTheDocument();
    expect(within(cache).queryByText(/NaN/)).not.toBeInTheDocument();
  });

  it('re-requests diagnostics on refresh', async () => {
    const loadDiagnostics = await renderPage(diagnostics());
    expect(loadDiagnostics).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole('button', { name: '刷新诊断数据' }));

    await waitFor(() => { expect(loadDiagnostics).toHaveBeenCalledTimes(2); });
  });

  it('surfaces a load failure with a retry', async () => {
    const loadDiagnostics = vi.fn().mockRejectedValue(new Error('boom'));
    renderWithRouter(<DiagnosticsPage sources={{ loadDiagnostics }} />);

    expect(await screen.findByText('诊断数据加载失败')).toBeInTheDocument();

    loadDiagnostics.mockResolvedValue(diagnostics());
    await userEvent.click(screen.getByRole('button', { name: '重试' }));

    expect(await screen.findByLabelText('依赖状态')).toBeInTheDocument();
  });

  it('keeps the existing data visible while refreshing and prevents repeated clicks', async () => {
    const user = userEvent.setup();
    const loadDiagnostics = await renderPage(diagnostics());
    await screen.findByLabelText('依赖状态');
    let reject!: (reason: Error) => void;
    loadDiagnostics.mockReturnValueOnce(new Promise((_resolve, fail) => { reject = fail; }));
    const refresh = screen.getByRole('button', { name: '刷新诊断数据' });
    await user.click(refresh);
    expect(refresh).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('正在刷新诊断数据');
    expect(screen.getByLabelText('依赖状态')).toBeInTheDocument();
    await user.click(refresh);
    expect(loadDiagnostics).toHaveBeenCalledTimes(2);
    await act(async () => reject(new Error('unavailable')));
    expect(await screen.findByText('诊断数据加载失败')).toBeInTheDocument();
    expect(refresh).toBeEnabled();
    await user.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByLabelText('依赖状态')).toBeInTheDocument();
    expect(screen.queryByText('诊断数据加载失败')).not.toBeInTheDocument();
  });
});
