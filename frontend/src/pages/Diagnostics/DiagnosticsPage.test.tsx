import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { renderWithRouter } from '../../test/render';
import type { SystemDiagnostics } from '../../types/api';
import { DiagnosticsPage } from './DiagnosticsPage';

vi.mock('../../api/resources', () => ({
  getCurrentUser: vi.fn().mockResolvedValue({ id: 'user-1', username: 'admin', displayName: '管理员' }),
  getSystemDiagnostics: vi.fn(),
  logout: vi.fn().mockResolvedValue(undefined),
}));

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
      { name: 'title', configured: true, model: 'gpt-title', status: 'ok', lastSuccessAt: null, lastFailureAt: null, successCount: 3, failureCount: 0, recentFailures: 0 },
    ],
    latency: [
      { metric: 'retrieval', count: 40, sampleCount: 40, p50Ms: 120, p95Ms: 300, maxMs: 800 },
      { metric: 'chat_first_token', count: 40, sampleCount: 40, p50Ms: 420, p95Ms: 900, maxMs: 1500 },
    ],
    rerankFallbacks: {},
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

    const providers = screen.getByLabelText('模型 Provider');
    expect(within(providers).getByText('对话模型')).toBeInTheDocument();
    expect(within(providers).getByText('gpt-test')).toBeInTheDocument();
    expect(within(providers).getByText('未配置')).toBeInTheDocument();

    const latency = screen.getByLabelText('调用耗时');
    expect(within(latency).getByText('检索总耗时')).toBeInTheDocument();
    expect(within(latency).getByText('首 token 延迟')).toBeInTheDocument();
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
});
