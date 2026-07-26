import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  addKnowledgeBaseMember,
  createChatSession,
  getKnowledgeBase,
  getKnowledgeBasePermissions,
  getWorkspacePreference,
  listDocuments,
  listKnowledgeBaseCategories,
  recordKnowledgeBaseView,
  searchKnowledgeBase,
  searchUsers,
  updateKnowledgeBasePermissions,
} from '../../api/resources';
import { renderWithRouter } from '../../test/render';
import type { DocumentItem, KnowledgeBase } from '../../types/api';
import { KnowledgeBaseDetailPage } from './KnowledgeBaseDetailPage';

vi.mock('../../api/resources', () => ({
  addKnowledgeBaseMember: vi.fn(),
  createChatSession: vi.fn(),
  deleteKnowledgeBaseMember: vi.fn(),
  getKnowledgeBase: vi.fn(),
  getKnowledgeBasePermissions: vi.fn(),
  getWorkspacePreference: vi.fn(),
  listDocuments: vi.fn(),
  listKnowledgeBaseCategories: vi.fn(),
  logout: vi.fn(),
  recordKnowledgeBaseView: vi.fn(),
  searchKnowledgeBase: vi.fn(),
  searchUsers: vi.fn(),
  updateKnowledgeBaseMember: vi.fn(),
  updateKnowledgeBasePermissions: vi.fn(),
}));

const knowledgeBase = {
  id: 'kb1',
  name: '制度库',
  description: '制度说明',
  visibility: 'private',
  retrievalConfig: { vectorTopN: 30, rerankTopK: 5, scoreThreshold: 0.3, enableRerank: true },
  createdAt: '2026-07-01T00:00:00Z',
  updatedAt: '2026-07-01T00:00:00Z',
} satisfies KnowledgeBase;

const completedDocument = {
  id: 'doc1',
  knowledgeBaseId: knowledgeBase.id,
  filename: 'handbook.pdf',
  fileType: 'pdf',
  fileSize: 1024,
  status: 'completed',
  errorMessage: null,
  createdAt: '2026-07-01T00:00:00Z',
  updatedAt: '2026-07-01T00:00:00Z',
} satisfies DocumentItem;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function LocationProbe() {
  const location = useLocation();
  return <output aria-label="当前位置">{location.pathname}{location.search}</output>;
}

function RouteControl({ target = '/knowledge-bases/kb2' }: { target?: string }) {
  const navigate = useNavigate();
  return <button type="button" onClick={() => navigate(target)}>切换知识库</button>;
}

function LeaveDetailButton() {
  const navigate = useNavigate();
  return <button type="button" onClick={() => navigate('/away')}>离开详情</button>;
}

beforeEach(() => {
  vi.mocked(getKnowledgeBase).mockReset().mockResolvedValue(knowledgeBase);
  vi.mocked(listDocuments).mockReset().mockResolvedValue({ items: [] });
  vi.mocked(listKnowledgeBaseCategories).mockReset().mockResolvedValue({ items: [] });
  vi.mocked(getKnowledgeBasePermissions).mockReset().mockResolvedValue({
    knowledgeBaseId: knowledgeBase.id,
    visibility: 'private',
    owner: { id: 'u1', username: 'admin', displayName: '管理员' },
    managers: [],
    members: [],
  });
  vi.mocked(getWorkspacePreference).mockReset().mockResolvedValue({
    viewMode: 'table', scope: 'all', sort: 'updatedAt_desc', visibility: 'all', expandedCategoryIds: [],
  });
  vi.mocked(recordKnowledgeBaseView).mockReset().mockResolvedValue(undefined);
  vi.mocked(addKnowledgeBaseMember).mockReset().mockResolvedValue(undefined);
  vi.mocked(createChatSession).mockReset();
  vi.mocked(searchKnowledgeBase).mockReset().mockResolvedValue({ items: [], rerankFallback: null });
  vi.mocked(searchUsers).mockReset().mockResolvedValue({ items: [] });
  vi.mocked(updateKnowledgeBasePermissions).mockReset();
});

describe('KnowledgeBaseDetailPage', () => {
  it('keeps overview focused and loads permissions only after entering settings', async () => {
    const user = userEvent.setup();
    renderWithRouter(
      <Routes>
        <Route path="/knowledge-bases/:id" element={<KnowledgeBaseDetailPage />} />
      </Routes>,
      ['/knowledge-bases/kb1'],
    );

    await screen.findByRole('heading', { name: '制度库' });
    expect(screen.getByRole('link', { name: '概览' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: '文档' })).toHaveAttribute(
      'href',
      '/knowledge-bases/kb1/documents',
    );
    expect(screen.getByRole('link', { name: 'AI 问答' })).toHaveAttribute(
      'href',
      '/knowledge-bases/kb1?tab=qa',
    );
    expect(getKnowledgeBasePermissions).not.toHaveBeenCalled();
    expect(screen.queryByRole('heading', { name: '成员权限' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('link', { name: '设置' }));

    expect(await screen.findByRole('heading', { name: '成员权限' })).toBeInTheDocument();
    expect(getKnowledgeBasePermissions).toHaveBeenCalledOnce();
    expect(screen.getByRole('link', { name: '设置' })).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByText('文档总数')).not.toBeInTheDocument();
  });

  it('shows a single primary action in the AI question section', async () => {
    vi.mocked(listDocuments).mockResolvedValue({ items: [completedDocument] });
    renderWithRouter(
      <Routes>
        <Route path="/knowledge-bases/:id" element={<KnowledgeBaseDetailPage />} />
      </Routes>,
      ['/knowledge-bases/kb1?tab=qa'],
    );

    expect(await screen.findByRole('heading', { name: 'AI 问答' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: '基于此知识库提问' })).toHaveLength(1);
  });

  it('opens a draft chat without creating an empty session', async () => {
    vi.mocked(listDocuments).mockResolvedValue({ items: [completedDocument] });
    const user = userEvent.setup();
    renderWithRouter(
      <>
        <Routes>
          <Route path="/knowledge-bases/:id" element={<KnowledgeBaseDetailPage />} />
          <Route path="/chat/:sessionId" element={<div>问答页</div>} />
        </Routes>
        <LocationProbe />
      </>,
      ['/knowledge-bases/kb1'],
    );

    await user.click(await screen.findByRole('button', { name: '基于此知识库提问' }));

    expect(createChatSession).not.toHaveBeenCalled();
    expect(screen.getByRole('status', { name: '当前位置' })).toHaveTextContent('/chat/new?knowledgeBaseId=kb1');
  });

  it('guides users to upload instead of opening chat before any document is ready', async () => {
    renderWithRouter(
      <Routes>
        <Route path="/knowledge-bases/:id" element={<KnowledgeBaseDetailPage />} />
      </Routes>,
      ['/knowledge-bases/kb1'],
    );

    expect(await screen.findByRole('link', { name: '上传文档' })).toHaveAttribute(
      'href',
      '/knowledge-bases/kb1/documents?intent=upload',
    );
    expect(screen.queryByRole('button', { name: '基于此知识库提问' })).not.toBeInTheDocument();
  });

  it('shows optional detail counters as unknown when the API omits them', async () => {
    renderWithRouter(
      <Routes>
        <Route path="/knowledge-bases/:id" element={<KnowledgeBaseDetailPage />} />
      </Routes>,
      ['/knowledge-bases/kb1'],
    );

    await screen.findByRole('heading', { name: '制度库' });
    expect(within(screen.getByText('浏览量').parentElement!).getByText('--')).toBeInTheDocument();
    expect(within(screen.getByText('问答数').parentElement!).getByText('--')).toBeInTheDocument();
  });

  it('does not present upload as the primary action when document summary loading fails', async () => {
    vi.mocked(listDocuments).mockRejectedValue(new Error('offline'));

    renderWithRouter(
      <Routes>
        <Route path="/knowledge-bases/:id" element={<KnowledgeBaseDetailPage />} />
      </Routes>,
      ['/knowledge-bases/kb1'],
    );

    expect(await screen.findByRole('alert')).toHaveTextContent('文档摘要加载失败');
    expect(screen.queryByRole('link', { name: '上传文档' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重试文档摘要' })).toBeInTheDocument();
    expect(within(screen.getByText('文档总数').parentElement!).getByText('--')).toBeInTheDocument();
  });

  it('offers recovery actions when the main knowledge-base detail fails', async () => {
    vi.mocked(getKnowledgeBase)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(knowledgeBase);
    const user = userEvent.setup();
    renderWithRouter(
      <Routes>
        <Route path="/knowledge-bases/:id" element={<KnowledgeBaseDetailPage />} />
      </Routes>,
      ['/knowledge-bases/kb1'],
    );

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('知识库详情加载失败');
    expect(within(alert).getByRole('link', { name: '返回知识库列表' })).toHaveAttribute('href', '/knowledge-bases');
    await user.click(within(alert).getByRole('button', { name: '重试详情' }));

    expect(await screen.findByRole('heading', { name: '制度库' })).toBeInTheDocument();
    expect(getKnowledgeBase).toHaveBeenCalledTimes(2);
  });

  it('keeps core detail and documents usable when optional metadata fails', async () => {
    vi.mocked(listDocuments).mockResolvedValue({ items: [completedDocument] });
    vi.mocked(getKnowledgeBasePermissions).mockRejectedValue(new Error('permissions unavailable'));
    vi.mocked(listKnowledgeBaseCategories).mockRejectedValue(new Error('categories unavailable'));

    const user = userEvent.setup();
    renderWithRouter(
      <Routes>
        <Route path="/knowledge-bases/:id" element={<KnowledgeBaseDetailPage />} />
      </Routes>,
      ['/knowledge-bases/kb1'],
    );

    expect(await screen.findByRole('heading', { name: '制度库' })).toBeInTheDocument();
    expect(screen.getByText('handbook.pdf')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '基于此知识库提问' })).toBeEnabled();
    expect(getKnowledgeBasePermissions).not.toHaveBeenCalled();

    await user.click(screen.getByRole('link', { name: '设置' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('成员权限加载失败');
  });

  it('does not let a slow previous route overwrite the current knowledge base', async () => {
    const firstKnowledgeBase = deferred<KnowledgeBase>();
    const secondKnowledgeBase = { ...knowledgeBase, id: 'kb2', name: '产品库' };
    vi.mocked(getKnowledgeBase).mockImplementation((id) => (
      id === 'kb1' ? firstKnowledgeBase.promise : Promise.resolve(secondKnowledgeBase)
    ));
    vi.mocked(listDocuments).mockResolvedValue({ items: [] });
    vi.mocked(getKnowledgeBasePermissions).mockImplementation((id) => Promise.resolve({
      knowledgeBaseId: id,
      visibility: 'private',
      owner: { id: 'u1', username: 'admin', displayName: '管理员' },
      managers: [],
      members: [],
    }));
    const user = userEvent.setup();

    renderWithRouter(
      <>
        <Routes>
          <Route path="/knowledge-bases/:id" element={<KnowledgeBaseDetailPage />} />
        </Routes>
        <RouteControl />
      </>,
      ['/knowledge-bases/kb1'],
    );

    await user.click(screen.getByRole('button', { name: '切换知识库' }));
    expect(await screen.findByRole('heading', { name: '产品库' })).toBeInTheDocument();

    await act(async () => {
      firstKnowledgeBase.resolve(knowledgeBase);
      await Promise.resolve();
    });

    expect(screen.getByRole('heading', { name: '产品库' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '制度库' })).not.toBeInTheDocument();
  });

  it('does not record a view when the detail request resolves after unmount', async () => {
    const detailResult = deferred<KnowledgeBase>();
    vi.mocked(getKnowledgeBase).mockReturnValue(detailResult.promise);
    const user = userEvent.setup();
    renderWithRouter(
      <>
        <Routes>
          <Route path="/knowledge-bases/:id" element={<KnowledgeBaseDetailPage />} />
          <Route path="/away" element={<div>已离开详情</div>} />
        </Routes>
        <LeaveDetailButton />
      </>,
      ['/knowledge-bases/kb1'],
    );

    await user.click(screen.getByRole('button', { name: '离开详情' }));
    expect(await screen.findByText('已离开详情')).toBeInTheDocument();
    await act(async () => {
      detailResult.resolve(knowledgeBase);
      await Promise.resolve();
    });

    expect(recordKnowledgeBaseView).not.toHaveBeenCalled();
  });

  it('does not let a visibility save from the previous route overwrite the current knowledge base', async () => {
    const visibilitySave = deferred<Awaited<ReturnType<typeof updateKnowledgeBasePermissions>>>();
    const secondKnowledgeBase = { ...knowledgeBase, id: 'kb2', name: '产品库' };
    vi.mocked(getKnowledgeBase).mockImplementation((id) => Promise.resolve(
      id === 'kb2' ? secondKnowledgeBase : knowledgeBase,
    ));
    vi.mocked(getKnowledgeBasePermissions).mockImplementation((id) => Promise.resolve({
      knowledgeBaseId: id,
      visibility: 'private',
      owner: { id: 'u1', username: 'admin', displayName: '管理员' },
      managers: [],
      members: [],
    }));
    vi.mocked(updateKnowledgeBasePermissions).mockReturnValue(visibilitySave.promise);
    const user = userEvent.setup();

    renderWithRouter(
      <>
        <Routes>
          <Route path="/knowledge-bases/:id" element={<KnowledgeBaseDetailPage />} />
        </Routes>
        <RouteControl target="/knowledge-bases/kb2?tab=settings" />
      </>,
      ['/knowledge-bases/kb1?tab=settings'],
    );

    await user.selectOptions(await screen.findByRole('combobox', { name: '可见性' }), 'public');
    expect(updateKnowledgeBasePermissions).toHaveBeenCalledWith('kb1', 'public');
    await user.click(screen.getByRole('button', { name: '切换知识库' }));
    expect(await screen.findByRole('heading', { name: '产品库' })).toBeInTheDocument();

    await act(async () => {
      visibilitySave.resolve({
        knowledgeBaseId: 'kb1',
        visibility: 'public',
        owner: { id: 'u1', username: 'admin', displayName: '管理员' },
        managers: [],
        members: [],
      });
      await Promise.resolve();
    });

    expect(screen.getByRole('heading', { name: '产品库' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: '可见性' })).toHaveValue('private');
    expect(screen.queryByRole('heading', { name: '制度库' })).not.toBeInTheDocument();
  });

  it('does not expose permission controls before the initial permission read completes', async () => {
    const initialPermissions = deferred<Awaited<ReturnType<typeof getKnowledgeBasePermissions>>>();
    vi.mocked(getKnowledgeBasePermissions).mockReturnValue(initialPermissions.promise);
    vi.mocked(updateKnowledgeBasePermissions).mockResolvedValue({
      knowledgeBaseId: 'kb1',
      visibility: 'public',
      owner: { id: 'u1', username: 'admin', displayName: '管理员' },
      managers: [],
      members: [],
    });
    const user = userEvent.setup();
    renderWithRouter(
      <Routes>
        <Route path="/knowledge-bases/:id" element={<KnowledgeBaseDetailPage />} />
      </Routes>,
      ['/knowledge-bases/kb1?tab=settings'],
    );

    await screen.findByRole('heading', { name: '成员权限' });
    expect(screen.queryByRole('combobox', { name: '可见性' })).not.toBeInTheDocument();
    expect(updateKnowledgeBasePermissions).not.toHaveBeenCalled();

    await act(async () => {
      initialPermissions.resolve({
        knowledgeBaseId: 'kb1',
        visibility: 'private',
        owner: { id: 'u1', username: 'admin', displayName: '管理员' },
        managers: [],
        members: [],
      });
      await Promise.resolve();
    });

    const visibility = await screen.findByRole('combobox', { name: '可见性' });
    expect(visibility).toHaveValue('private');
    await user.selectOptions(visibility, 'public');
    await waitFor(() => expect(updateKnowledgeBasePermissions).toHaveBeenCalledWith('kb1', 'public'));
    expect(visibility).toHaveValue('public');
  });

  it('does not let a late member failure pollute or unlock a newer knowledge-base mutation', async () => {
    const firstAdd = deferred<void>();
    const secondAdd = deferred<void>();
    const secondKnowledgeBase = { ...knowledgeBase, id: 'kb2', name: '产品库' };
    vi.mocked(getKnowledgeBase).mockImplementation((knowledgeBaseId) => Promise.resolve(
      knowledgeBaseId === secondKnowledgeBase.id ? secondKnowledgeBase : knowledgeBase,
    ));
    vi.mocked(getKnowledgeBasePermissions).mockImplementation((knowledgeBaseId) => Promise.resolve({
      knowledgeBaseId,
      visibility: 'private',
      owner: { id: 'u1', username: 'admin', displayName: '管理员' },
      managers: [],
      members: [],
    }));
    vi.mocked(searchUsers)
      .mockResolvedValueOnce({ items: [{ id: 'user-a', username: 'user-a', displayName: '用户 A' }] })
      .mockResolvedValueOnce({ items: [{ id: 'user-b', username: 'user-b', displayName: '用户 B' }] });
    vi.mocked(addKnowledgeBaseMember).mockImplementation((knowledgeBaseId) => (
      knowledgeBaseId === secondKnowledgeBase.id ? secondAdd.promise : firstAdd.promise
    ));
    const user = userEvent.setup();
    renderWithRouter(
      <>
        <Routes>
          <Route path="/knowledge-bases/:id" element={<KnowledgeBaseDetailPage />} />
        </Routes>
        <RouteControl target="/knowledge-bases/kb2?tab=settings" />
      </>,
      ['/knowledge-bases/kb1?tab=settings'],
    );

    const searchInput = await screen.findByRole('textbox', { name: '搜索用户' });
    await user.type(searchInput, '用户 A');
    await user.click(screen.getByRole('button', { name: '搜索' }));
    await user.click(await screen.findByRole('button', { name: '设为成员' }));
    await user.click(screen.getByRole('button', { name: '切换知识库' }));
    await screen.findByRole('heading', { name: '产品库' });
    const nextSearchInput = await screen.findByRole('textbox', { name: '搜索用户' });
    await user.clear(nextSearchInput);
    await user.type(nextSearchInput, '用户 B');
    await user.click(screen.getByRole('button', { name: '搜索' }));
    await user.click(await screen.findByRole('button', { name: '设为成员' }));

    await act(async () => {
      firstAdd.reject(new Error('offline'));
      await Promise.resolve();
    });
    expect(screen.queryByText('成员添加失败')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '添加中...' })).toBeDisabled();

    await act(async () => {
      secondAdd.resolve();
      await Promise.resolve();
    });
  });

  it('disables visibility changes while a member mutation is pending', async () => {
    const addResult = deferred<void>();
    vi.mocked(addKnowledgeBaseMember).mockReturnValue(addResult.promise);
    vi.mocked(searchUsers).mockResolvedValue({
      items: [{ id: 'user-a', username: 'user-a', displayName: '用户 A' }],
    });
    const user = userEvent.setup();
    renderWithRouter(
      <Routes>
        <Route path="/knowledge-bases/:id" element={<KnowledgeBaseDetailPage />} />
      </Routes>,
      ['/knowledge-bases/kb1?tab=settings'],
    );

    const searchInput = await screen.findByRole('textbox', { name: '搜索用户' });
    await user.type(searchInput, '用户 A');
    await user.click(screen.getByRole('button', { name: '搜索' }));
    await user.click(await screen.findByRole('button', { name: '设为成员' }));

    expect(screen.getByRole('combobox', { name: '可见性' })).toBeDisabled();
    addResult.resolve();
    await waitFor(() => expect(screen.getByRole('combobox', { name: '可见性' })).toBeEnabled());
  });

  it('disables member mutations while visibility is being saved', async () => {
    const visibilityResult = deferred<Awaited<ReturnType<typeof updateKnowledgeBasePermissions>>>();
    vi.mocked(updateKnowledgeBasePermissions).mockReturnValue(visibilityResult.promise);
    vi.mocked(getKnowledgeBasePermissions).mockResolvedValue({
      knowledgeBaseId: knowledgeBase.id,
      visibility: 'private',
      owner: { id: 'u1', username: 'admin', displayName: '管理员' },
      managers: [],
      members: [{ id: 'u2', username: 'member', displayName: '普通成员', role: 'member' }],
    });
    const user = userEvent.setup();
    renderWithRouter(
      <Routes>
        <Route path="/knowledge-bases/:id" element={<KnowledgeBaseDetailPage />} />
      </Routes>,
      ['/knowledge-bases/kb1?tab=settings'],
    );

    const visibility = await screen.findByRole('combobox', { name: '可见性' });
    await screen.findByText('普通成员');
    await user.selectOptions(visibility, 'public');

    expect(screen.getByRole('textbox', { name: '搜索用户' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: '修改 普通成员 的角色' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '移除' })).toBeDisabled();

    visibilityResult.resolve({
      knowledgeBaseId: knowledgeBase.id,
      visibility: 'public',
      owner: { id: 'u1', username: 'admin', displayName: '管理员' },
      managers: [],
      members: [{ id: 'u2', username: 'member', displayName: '普通成员', role: 'member' }],
    });
    await waitFor(() => expect(screen.getByRole('textbox', { name: '搜索用户' })).toBeEnabled());
  });

  it('keeps only the latest member search results', async () => {
    const first = deferred<{ items: Array<{ id: string; username: string; displayName: string }> }>();
    const second = deferred<{ items: Array<{ id: string; username: string; displayName: string }> }>();
    vi.mocked(searchUsers)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const user = userEvent.setup();

    renderWithRouter(
      <Routes>
        <Route path="/knowledge-bases/:id" element={<KnowledgeBaseDetailPage />} />
      </Routes>,
      ['/knowledge-bases/kb1?tab=settings'],
    );

    const input = await screen.findByRole('textbox', { name: '搜索用户' });
    const form = input.closest('form')!;
    await user.type(input, '旧用户');
    await user.click(within(form).getByRole('button', { name: '搜索' }));
    await user.clear(input);
    await user.type(input, '新用户');
    await user.click(within(form).getByRole('button', { name: '搜索' }));

    await act(async () => {
      second.resolve({ items: [{ id: 'new', username: 'new', displayName: '新用户结果' }] });
      await Promise.resolve();
    });
    expect(await screen.findByText('新用户结果')).toBeInTheDocument();

    await act(async () => {
      first.resolve({ items: [{ id: 'old', username: 'old', displayName: '旧用户结果' }] });
      await Promise.resolve();
    });
    expect(screen.getByText('新用户结果')).toBeInTheDocument();
    expect(screen.queryByText('旧用户结果')).not.toBeInTheDocument();
  });

  it('keeps only the latest semantic search results and loading state', async () => {
    const first = deferred<Awaited<ReturnType<typeof searchKnowledgeBase>>>();
    const second = deferred<Awaited<ReturnType<typeof searchKnowledgeBase>>>();
    vi.mocked(searchKnowledgeBase)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const user = userEvent.setup();

    renderWithRouter(
      <Routes>
        <Route path="/knowledge-bases/:id" element={<KnowledgeBaseDetailPage />} />
      </Routes>,
      ['/knowledge-bases/kb1?tab=settings'],
    );

    const input = await screen.findByRole('textbox', { name: '知识库内检索问题' });
    const form = input.closest('form')!;
    await user.type(input, '旧问题');
    await user.click(within(form).getByRole('button', { name: '检索' }));
    await user.clear(input);
    await user.type(input, '新问题');
    await user.click(within(form).getByRole('button', { name: '检索' }));

    await act(async () => {
      second.resolve({
        items: [{
          chunkId: 'new', documentId: 'doc1', filename: 'new.md', content: '新结果',
          pageNumber: 1, vectorScore: 0.9, rerankScore: 0.8,
        }],
        rerankFallback: null,
      });
      await Promise.resolve();
    });
    expect(await screen.findByText('新结果')).toBeInTheDocument();

    await act(async () => {
      first.resolve({
        items: [{
          chunkId: 'old', documentId: 'doc1', filename: 'old.md', content: '旧结果',
          pageNumber: 1, vectorScore: 0.5, rerankScore: 0.4,
        }],
        rerankFallback: null,
      });
      await Promise.resolve();
    });
    expect(screen.getByText('新结果')).toBeInTheDocument();
    expect(screen.queryByText('旧结果')).not.toBeInTheDocument();
    await waitFor(() => expect(within(form).getByRole('button', { name: '检索' })).toBeEnabled());
  });

  it('renders retrieval debug data returned by the settings diagnostic', async () => {
    vi.mocked(searchKnowledgeBase).mockResolvedValue({
      items: [],
      rerankFallback: null,
      debug: {
        query: '制度',
        rewrittenQuery: '公司制度',
        vectorStage: { status: 'completed', items: [] },
        rerankStage: { status: 'completed', input: [], output: [] },
        finalStage: { items: [] },
        rerankFallback: null,
      },
    });
    const user = userEvent.setup();
    renderWithRouter(
      <Routes>
        <Route path="/knowledge-bases/:id" element={<KnowledgeBaseDetailPage />} />
      </Routes>,
      ['/knowledge-bases/kb1?tab=settings'],
    );

    await user.click(await screen.findByRole('checkbox', { name: '显示检索调试信息' }));
    await user.type(screen.getByRole('textbox', { name: '知识库内检索问题' }), '制度');
    await user.click(screen.getByRole('button', { name: '检索' }));

    expect(await screen.findByRole('region', { name: '检索调试信息' })).toHaveTextContent('公司制度');
  });
});
