import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Route, Routes, useNavigate } from 'react-router-dom';

import { renderWithRouter } from '../../test/render';
import { KnowledgeBaseDetailPage } from './KnowledgeBaseDetailPage';

const api = vi.hoisted(() => ({
  addKnowledgeBaseMember: vi.fn(),
  createChatSession: vi.fn(),
  deleteKnowledgeBaseMember: vi.fn(),
  getCurrentUser: vi.fn(),
  getKnowledgeBase: vi.fn(),
  getKnowledgeBasePermissions: vi.fn(),
  getWorkspacePreference: vi.fn(),
  listDocuments: vi.fn(),
  listKnowledgeBaseCategories: vi.fn(),
  recordKnowledgeBaseView: vi.fn(),
  searchKnowledgeBase: vi.fn(),
  searchUsers: vi.fn(),
  updateKnowledgeBaseMember: vi.fn(),
  updateKnowledgeBasePermissions: vi.fn(),
  logout: vi.fn(),
}));

vi.mock('../../api/resources', () => api);

beforeEach(() => {
  Object.values(api).forEach((mock) => mock.mockReset());
  api.getCurrentUser.mockResolvedValue({ id: 'user-1', username: 'admin', displayName: '管理员' });
  api.getKnowledgeBase.mockResolvedValue({
    id: 'kb-1', name: '员工制度', description: '制度文档', visibility: 'private',
    retrievalConfig: { vectorTopN: 30, rerankTopK: 5, scoreThreshold: 0.3, enableRerank: true },
    createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-01T00:00:00Z',
  });
  api.listDocuments.mockResolvedValue({ items: [] });
  api.listKnowledgeBaseCategories.mockResolvedValue({ items: [] });
  api.getKnowledgeBasePermissions.mockResolvedValue({ owner: null, managers: [], members: [], visibility: 'private' });
  api.getWorkspacePreference.mockResolvedValue({
    viewMode: 'table', scope: 'all', sort: 'updatedAt_desc', visibility: 'all', expandedCategoryIds: [],
  });
  api.recordKnowledgeBaseView.mockResolvedValue(undefined);
});

describe('KnowledgeBaseDetailPage retrieval debug', () => {
  it('requests and progressively displays vector, rerank, and final stages', async () => {
    api.searchKnowledgeBase.mockResolvedValue({
      items: [],
      rerankFallback: { used: true, reason: 'provider_unavailable' },
      debug: {
        query: '报销',
        vectorStage: { status: 'completed', items: [{ chunkId: 'c1', documentId: 'd1', filename: 'policy.pdf', content: '向量内容', pageNumber: 3, vectorScore: 0.8, rank: 1 }] },
        rerankStage: { status: 'fallback', input: [{ chunkId: 'c1', pageNumber: 4, rank: 1 }], output: [{ chunkId: 'c1', pageNumber: 5, rerankScore: null, rank: 1 }] },
        finalStage: { items: [{ chunkId: 'c1', pageNumber: 8, vectorScore: 0.8, rerankScore: null, rank: 1 }] },
        rerankFallback: { used: true, reason: 'provider_unavailable' },
      },
    });
    const user = userEvent.setup();
    renderWithRouter(
      <Routes><Route element={<KnowledgeBaseDetailPage />} path="/knowledge-bases/:id" /></Routes>,
      ['/knowledge-bases/kb-1'],
    );

    await screen.findByRole('heading', { name: '员工制度' });
    await user.type(screen.getByLabelText('知识库内检索问题'), '报销');
    await user.click(screen.getByLabelText('显示检索调试信息'));
    await user.click(screen.getByRole('button', { name: '检索' }));

    expect(api.searchKnowledgeBase).toHaveBeenCalledWith('kb-1', expect.objectContaining({ debug: true }));
    expect(await screen.findByText('向量召回')).toBeInTheDocument();
    expect(screen.getByText('Rerank 阶段')).toBeInTheDocument();
    expect(screen.getByText('最终结果')).toBeInTheDocument();
    expect(screen.getByText('第 3 页')).toBeInTheDocument();
    expect(screen.getByText('第 4 页')).toBeInTheDocument();
    expect(screen.getByText('第 5 页')).toBeInTheDocument();
    expect(screen.getByText('第 8 页')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Rerank 服务暂不可用');
    expect(screen.queryByText('provider_unavailable')).not.toBeInTheDocument();
  });

  it('ignores an older semantic-search response that resolves last', async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    api.searchKnowledgeBase.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const user = userEvent.setup();
    renderWithRouter(
      <Routes><Route element={<KnowledgeBaseDetailPage />} path="/knowledge-bases/:id" /></Routes>,
      ['/knowledge-bases/kb-1'],
    );

    await screen.findByRole('heading', { name: '员工制度' });
    const input = screen.getByLabelText('知识库内检索问题');
    const form = input.closest('form');
    if (!form) throw new Error('semantic search form not found');

    await user.type(input, '旧问题');
    fireEvent.submit(form);
    await user.clear(input);
    await user.type(input, '新问题');
    fireEvent.submit(form);

    await act(async () => second.resolve(searchResponse('新结果')));
    expect(await screen.findByText('新结果')).toBeInTheDocument();
    await act(async () => first.resolve(searchResponse('旧结果')));

    expect(screen.getByText('新结果')).toBeInTheDocument();
    expect(screen.queryByText('旧结果')).not.toBeInTheDocument();
  });
});

describe('KnowledgeBaseDetailPage loading', () => {
  it('ignores a previous knowledge base response that resolves after navigation', async () => {
    const staleKnowledgeBase = deferred<ReturnType<typeof knowledgeBaseFixture>>();
    api.getKnowledgeBase.mockImplementation((id: string) => (
      id === 'kb-a' ? staleKnowledgeBase.promise : Promise.resolve(knowledgeBaseFixture('kb-b', '知识库 B'))
    ));
    api.listDocuments.mockImplementation((id: string) => Promise.resolve({
      items: [documentFixture(id, id === 'kb-a' ? 'A 文档.md' : 'B 文档.md')],
    }));
    api.getKnowledgeBasePermissions.mockImplementation((id: string) => Promise.resolve(permissionFixture(
      id,
      id === 'kb-a' ? 'A Owner' : 'B Owner',
    )));
    const user = userEvent.setup();

    renderWithRouter(
      <>
        <KnowledgeBaseNavigation />
        <Routes><Route element={<KnowledgeBaseDetailPage />} path="/knowledge-bases/:id" /></Routes>
      </>,
      ['/knowledge-bases/kb-a'],
    );

    await user.click(screen.getByRole('button', { name: '切换到知识库 B' }));
    expect(await screen.findByRole('heading', { name: '知识库 B' })).toBeInTheDocument();
    expect(screen.getByText('B 文档.md')).toBeInTheDocument();
    expect(screen.getByText('B Owner')).toBeInTheDocument();

    await act(async () => staleKnowledgeBase.resolve(knowledgeBaseFixture('kb-a', '知识库 A')));

    await waitFor(() => expect(screen.getByRole('heading', { name: '知识库 B' })).toBeInTheDocument());
    expect(screen.queryByRole('heading', { name: '知识库 A' })).not.toBeInTheDocument();
    expect(screen.getByText('B 文档.md')).toBeInTheDocument();
    expect(screen.queryByText('A 文档.md')).not.toBeInTheDocument();
    expect(screen.getByText('B Owner')).toBeInTheDocument();
    expect(screen.queryByText('A Owner')).not.toBeInTheDocument();
    expect(api.recordKnowledgeBaseView).toHaveBeenCalledTimes(1);
    expect(api.recordKnowledgeBaseView).toHaveBeenCalledWith('kb-b');
  });

  it('ignores a visibility update for the previous knowledge base after navigation', async () => {
    const stalePermissions = deferred<ReturnType<typeof permissionFixture>>();
    api.getKnowledgeBase.mockImplementation((id: string) => Promise.resolve(knowledgeBaseFixture(
      id,
      id === 'kb-a' ? '知识库 A' : '知识库 B',
    )));
    api.getKnowledgeBasePermissions.mockImplementation((id: string) => Promise.resolve(permissionFixture(
      id,
      id === 'kb-a' ? 'A Owner' : 'B Owner',
    )));
    api.updateKnowledgeBasePermissions.mockReturnValue(stalePermissions.promise);
    const user = userEvent.setup();

    renderWithRouter(
      <>
        <KnowledgeBaseNavigation />
        <Routes><Route element={<KnowledgeBaseDetailPage />} path="/knowledge-bases/:id" /></Routes>
      </>,
      ['/knowledge-bases/kb-a'],
    );

    expect(await screen.findByRole('heading', { name: '知识库 A' })).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('可见性'), 'public');
    expect(api.updateKnowledgeBasePermissions).toHaveBeenCalledWith('kb-a', 'public');

    await user.click(screen.getByRole('button', { name: '切换到知识库 B' }));
    expect(await screen.findByRole('heading', { name: '知识库 B' })).toBeInTheDocument();

    await act(async () => stalePermissions.resolve(permissionFixture('kb-a', 'A Owner', 'public')));

    expect(screen.getByRole('heading', { name: '知识库 B' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '知识库 A' })).not.toBeInTheDocument();
    expect(screen.getByText('B Owner')).toBeInTheDocument();
  });

  it('ignores a member update for the previous knowledge base after navigation', async () => {
    const staleMemberAdd = deferred<void>();
    api.getKnowledgeBase.mockImplementation((id: string) => Promise.resolve(knowledgeBaseFixture(
      id,
      id === 'kb-a' ? '知识库 A' : '知识库 B',
    )));
    api.getKnowledgeBasePermissions.mockImplementation((id: string) => Promise.resolve(permissionFixture(
      id,
      id === 'kb-a' ? 'A Owner' : 'B Owner',
    )));
    api.searchUsers.mockResolvedValue({
      items: [{ id: 'user-2', username: 'member', displayName: '待添加成员' }],
    });
    api.addKnowledgeBaseMember.mockReturnValue(staleMemberAdd.promise);
    const user = userEvent.setup();

    renderWithRouter(
      <>
        <KnowledgeBaseNavigation />
        <Routes><Route element={<KnowledgeBaseDetailPage />} path="/knowledge-bases/:id" /></Routes>
      </>,
      ['/knowledge-bases/kb-a'],
    );

    expect(await screen.findByRole('heading', { name: '知识库 A' })).toBeInTheDocument();
    await user.type(screen.getByLabelText('搜索用户'), 'member');
    await user.click(screen.getByRole('button', { name: '搜索' }));
    await user.click(await screen.findByRole('button', { name: '设为 member' }));
    expect(api.addKnowledgeBaseMember).toHaveBeenCalledWith('kb-a', 'user-2', 'member');

    await user.click(screen.getByRole('button', { name: '切换到知识库 B' }));
    expect(await screen.findByRole('heading', { name: '知识库 B' })).toBeInTheDocument();
    expect(screen.queryByText('待添加成员')).not.toBeInTheDocument();

    await act(async () => staleMemberAdd.resolve());

    expect(screen.getByRole('heading', { name: '知识库 B' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '知识库 A' })).not.toBeInTheDocument();
    expect(screen.getByText('B Owner')).toBeInTheDocument();
  });

  it('ignores a visibility update from an earlier visit after returning to the same knowledge base', async () => {
    const stalePermissions = deferred<ReturnType<typeof permissionFixture>>();
    api.getKnowledgeBase.mockImplementation((id: string) => Promise.resolve(knowledgeBaseFixture(
      id,
      id === 'kb-a' ? '知识库 A' : '知识库 B',
    )));
    api.getKnowledgeBasePermissions.mockImplementation((id: string) => Promise.resolve(permissionFixture(
      id,
      id === 'kb-a' ? 'A Owner' : 'B Owner',
    )));
    api.updateKnowledgeBasePermissions.mockReturnValue(stalePermissions.promise);
    const user = userEvent.setup();

    renderWithRouter(
      <>
        <KnowledgeBaseRoundTripNavigation />
        <Routes><Route element={<KnowledgeBaseDetailPage />} path="/knowledge-bases/:id" /></Routes>
      </>,
      ['/knowledge-bases/kb-a'],
    );

    expect(await screen.findByRole('heading', { name: '知识库 A' })).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('可见性'), 'public');
    await user.click(screen.getByRole('button', { name: '切换到知识库 B' }));
    expect(await screen.findByRole('heading', { name: '知识库 B' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '返回知识库 A' }));
    expect(await screen.findByRole('heading', { name: '知识库 A' })).toBeInTheDocument();
    expect(screen.getByLabelText('可见性')).toHaveValue('private');

    await act(async () => stalePermissions.resolve(permissionFixture('kb-a', 'A Owner', 'public')));

    expect(screen.getByLabelText('可见性')).toHaveValue('private');
  });

  it('disables all permission mutation controls while a member update is pending', async () => {
    api.getKnowledgeBasePermissions.mockResolvedValue(permissionWithMembersFixture());
    api.updateKnowledgeBaseMember.mockReturnValue(new Promise(() => undefined));
    const user = userEvent.setup();

    renderWithRouter(
      <Routes><Route element={<KnowledgeBaseDetailPage />} path="/knowledge-bases/:id" /></Routes>,
      ['/knowledge-bases/kb-1'],
    );

    expect(await screen.findByRole('heading', { name: '员工制度' })).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('修改 成员一 的角色'), 'manager');

    expect(api.updateKnowledgeBaseMember).toHaveBeenCalledWith('kb-1', 'member-1', 'manager');
    expect(screen.getByLabelText('修改 成员一 的角色')).toBeDisabled();
    expect(screen.getByLabelText('修改 成员二 的角色')).toBeDisabled();
    expect(screen.getByLabelText('可见性')).toBeDisabled();
  });

  it('ignores a member update from an earlier visit after returning to the same knowledge base', async () => {
    const staleMemberAdd = deferred<void>();
    let knowledgeBaseAPermissionLoads = 0;
    api.getKnowledgeBase.mockImplementation((id: string) => Promise.resolve(knowledgeBaseFixture(
      id,
      id === 'kb-a' ? '知识库 A' : '知识库 B',
    )));
    api.getKnowledgeBasePermissions.mockImplementation((id: string) => {
      if (id === 'kb-b') {
        return Promise.resolve(permissionFixture(id, 'B Owner'));
      }
      knowledgeBaseAPermissionLoads += 1;
      const ownerName = knowledgeBaseAPermissionLoads === 1
        ? 'A Initial Owner'
        : knowledgeBaseAPermissionLoads === 2
          ? 'A Current Owner'
          : 'A Stale Owner';
      return Promise.resolve(permissionFixture(id, ownerName));
    });
    api.searchUsers.mockResolvedValue({
      items: [{ id: 'user-2', username: 'member', displayName: '待添加成员' }],
    });
    api.addKnowledgeBaseMember.mockReturnValue(staleMemberAdd.promise);
    const user = userEvent.setup();

    renderWithRouter(
      <>
        <KnowledgeBaseRoundTripNavigation />
        <Routes><Route element={<KnowledgeBaseDetailPage />} path="/knowledge-bases/:id" /></Routes>
      </>,
      ['/knowledge-bases/kb-a'],
    );

    expect(await screen.findByText('A Initial Owner')).toBeInTheDocument();
    await user.type(screen.getByLabelText('搜索用户'), 'member');
    await user.click(screen.getByRole('button', { name: '搜索' }));
    await user.click(await screen.findByRole('button', { name: '设为 member' }));
    await user.click(screen.getByRole('button', { name: '切换到知识库 B' }));
    expect(await screen.findByText('B Owner')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '返回知识库 A' }));
    expect(await screen.findByText('A Current Owner')).toBeInTheDocument();

    await act(async () => staleMemberAdd.resolve());

    expect(screen.getByText('A Current Owner')).toBeInTheDocument();
    expect(screen.queryByText('A Stale Owner')).not.toBeInTheDocument();
    expect(knowledgeBaseAPermissionLoads).toBe(2);
  });

  it('does not navigate to a chat created for the previous knowledge base', async () => {
    const staleChat = deferred<{ id: string }>();
    api.getKnowledgeBase.mockImplementation((id: string) => Promise.resolve(knowledgeBaseFixture(
      id,
      id === 'kb-a' ? '知识库 A' : '知识库 B',
    )));
    api.getKnowledgeBasePermissions.mockImplementation((id: string) => Promise.resolve(permissionFixture(
      id,
      id === 'kb-a' ? 'A Owner' : 'B Owner',
    )));
    api.createChatSession.mockReturnValue(staleChat.promise);
    const user = userEvent.setup();

    renderWithRouter(
      <>
        <KnowledgeBaseNavigation />
        <Routes><Route element={<KnowledgeBaseDetailPage />} path="/knowledge-bases/:id" /></Routes>
      </>,
      ['/knowledge-bases/kb-a'],
    );

    expect(await screen.findByRole('heading', { name: '知识库 A' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '开始问答' }));
    expect(api.createChatSession).toHaveBeenCalledWith('kb-a', '知识库 A 问答');

    await user.click(screen.getByRole('button', { name: '切换到知识库 B' }));
    expect(await screen.findByRole('heading', { name: '知识库 B' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '开始问答' })).toBeEnabled();

    await act(async () => staleChat.resolve({ id: 'chat-for-kb-a' }));

    expect(screen.getByRole('heading', { name: '知识库 B' })).toBeInTheDocument();
  });

  it('ignores user search results from the previous knowledge base', async () => {
    const staleUserSearch = deferred<{ items: Array<{ id: string; username: string; displayName: string }> }>();
    api.getKnowledgeBase.mockImplementation((id: string) => Promise.resolve(knowledgeBaseFixture(
      id,
      id === 'kb-a' ? '知识库 A' : '知识库 B',
    )));
    api.getKnowledgeBasePermissions.mockImplementation((id: string) => Promise.resolve(permissionFixture(
      id,
      id === 'kb-a' ? 'A Owner' : 'B Owner',
    )));
    api.searchUsers.mockReturnValue(staleUserSearch.promise);
    const user = userEvent.setup();

    renderWithRouter(
      <>
        <KnowledgeBaseNavigation />
        <Routes><Route element={<KnowledgeBaseDetailPage />} path="/knowledge-bases/:id" /></Routes>
      </>,
      ['/knowledge-bases/kb-a'],
    );

    expect(await screen.findByRole('heading', { name: '知识库 A' })).toBeInTheDocument();
    await user.type(screen.getByLabelText('搜索用户'), 'stale-member');
    await user.click(screen.getByRole('button', { name: '搜索' }));

    await user.click(screen.getByRole('button', { name: '切换到知识库 B' }));
    expect(await screen.findByRole('heading', { name: '知识库 B' })).toBeInTheDocument();

    await act(async () => staleUserSearch.resolve({
      items: [{ id: 'stale-user', username: 'stale-member', displayName: 'A 的搜索结果' }],
    }));

    expect(screen.queryByText('A 的搜索结果')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '知识库 B' })).toBeInTheDocument();
  });

  it('does not navigate after the detail page unmounts during chat creation', async () => {
    const staleChat = deferred<{ id: string }>();
    api.createChatSession.mockReturnValue(staleChat.promise);
    const user = userEvent.setup();

    renderWithRouter(
      <>
        <DetailExitNavigation />
        <Routes>
          <Route element={<KnowledgeBaseDetailPage />} path="/knowledge-bases/:id" />
          <Route element={<div>知识库列表页</div>} path="/knowledge-bases" />
        </Routes>
      </>,
      ['/knowledge-bases/kb-1'],
    );

    expect(await screen.findByRole('heading', { name: '员工制度' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '开始问答' }));
    await user.click(screen.getByRole('button', { name: '离开详情' }));
    expect(screen.getByText('知识库列表页')).toBeInTheDocument();

    await act(async () => staleChat.resolve({ id: 'chat-after-unmount' }));

    expect(screen.getByText('知识库列表页')).toBeInTheDocument();
  });

  it('does not accept a previous chat request after returning to the same knowledge base', async () => {
    const staleChat = deferred<{ id: string }>();
    api.getKnowledgeBase.mockImplementation((id: string) => Promise.resolve(knowledgeBaseFixture(
      id,
      id === 'kb-a' ? '知识库 A' : '知识库 B',
    )));
    api.getKnowledgeBasePermissions.mockImplementation((id: string) => Promise.resolve(permissionFixture(
      id,
      id === 'kb-a' ? 'A Owner' : 'B Owner',
    )));
    api.createChatSession.mockReturnValue(staleChat.promise);
    const user = userEvent.setup();

    renderWithRouter(
      <>
        <KnowledgeBaseRoundTripNavigation />
        <Routes><Route element={<KnowledgeBaseDetailPage />} path="/knowledge-bases/:id" /></Routes>
      </>,
      ['/knowledge-bases/kb-a'],
    );

    expect(await screen.findByRole('heading', { name: '知识库 A' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '开始问答' }));
    await user.click(screen.getByRole('button', { name: '切换到知识库 B' }));
    expect(await screen.findByRole('heading', { name: '知识库 B' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '返回知识库 A' }));
    expect(await screen.findByRole('heading', { name: '知识库 A' })).toBeInTheDocument();

    await act(async () => staleChat.resolve({ id: 'chat-for-old-a' }));

    expect(screen.getByRole('heading', { name: '知识库 A' })).toBeInTheDocument();
  });
});

function KnowledgeBaseNavigation() {
  const navigate = useNavigate();
  return <button onClick={() => navigate('/knowledge-bases/kb-b')} type="button">切换到知识库 B</button>;
}

function KnowledgeBaseRoundTripNavigation() {
  const navigate = useNavigate();
  return (
    <>
      <button onClick={() => navigate('/knowledge-bases/kb-b')} type="button">切换到知识库 B</button>
      <button onClick={() => navigate('/knowledge-bases/kb-a')} type="button">返回知识库 A</button>
    </>
  );
}

function DetailExitNavigation() {
  const navigate = useNavigate();
  return <button onClick={() => navigate('/knowledge-bases')} type="button">离开详情</button>;
}

function knowledgeBaseFixture(id = 'kb-1', name = '员工制度') {
  return {
    id,
    name,
    description: `${name}描述`,
    visibility: 'private' as const,
    retrievalConfig: { vectorTopN: 30, rerankTopK: 5, scoreThreshold: 0.3, enableRerank: true },
    createdAt: '2026-07-01T00:00:00Z',
    updatedAt: '2026-07-01T00:00:00Z',
  };
}

function documentFixture(knowledgeBaseId: string, filename: string) {
  return {
    id: `document-${knowledgeBaseId}`,
    knowledgeBaseId,
    filename,
    fileType: 'md',
    fileSize: 128,
    status: 'completed' as const,
    errorMessage: null,
    createdAt: '2026-07-01T00:00:00Z',
  };
}

function permissionFixture(
  knowledgeBaseId: string,
  ownerName: string,
  visibility: 'private' | 'public' = 'private',
) {
  return {
    knowledgeBaseId,
    visibility,
    owner: { id: `owner-${knowledgeBaseId}`, username: ownerName, displayName: ownerName },
    managers: [],
    members: [],
  };
}

function permissionWithMembersFixture() {
  return {
    knowledgeBaseId: 'kb-1',
    visibility: 'private' as const,
    owner: { id: 'owner-kb-1', username: 'owner', displayName: 'Owner' },
    managers: [],
    members: [
      { id: 'member-1', username: 'member-1', displayName: '成员一', role: 'member' as const },
      { id: 'member-2', username: 'member-2', displayName: '成员二', role: 'member' as const },
    ],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function searchResponse(content: string) {
  return {
    items: [{
      chunkId: content,
      documentId: 'd1',
      filename: 'policy.md',
      content,
      pageNumber: null,
      vectorScore: 0.8,
      rerankScore: 0.9,
    }],
    rerankFallback: null,
  };
}
