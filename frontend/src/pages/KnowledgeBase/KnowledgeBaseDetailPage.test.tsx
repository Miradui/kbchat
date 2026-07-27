import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  addKnowledgeBaseMember,
  createChatSession,
  deleteKnowledgeBase,
  deleteKnowledgeBaseMember,
  getKnowledgeBase,
  getKnowledgeBasePermissions,
  getWorkspacePreference,
  listDocuments,
  listKnowledgeBaseCategories,
  listKnowledgeBaseTags,
  recordKnowledgeBaseView,
  searchKnowledgeBase,
  searchUsers,
  updateKnowledgeBase,
  updateKnowledgeBasePermissions,
} from '../../api/resources';
import { renderWithRouter } from '../../test/render';
import type { DocumentItem, KnowledgeBase } from '../../types/api';
import { KnowledgeBaseDetailPage } from './KnowledgeBaseDetailPage';

vi.mock('../../api/resources', () => ({
  addKnowledgeBaseMember: vi.fn(),
  createChatSession: vi.fn(),
  deleteKnowledgeBase: vi.fn(),
  deleteKnowledgeBaseMember: vi.fn(),
  getKnowledgeBase: vi.fn(),
  getKnowledgeBasePermissions: vi.fn(),
  getWorkspacePreference: vi.fn(),
  listDocuments: vi.fn(),
  listKnowledgeBaseCategories: vi.fn(),
  listKnowledgeBaseTags: vi.fn(),
  logout: vi.fn(),
  recordKnowledgeBaseView: vi.fn(),
  searchKnowledgeBase: vi.fn(),
  searchUsers: vi.fn(),
  updateKnowledgeBase: vi.fn(),
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
  vi.mocked(deleteKnowledgeBase).mockReset().mockResolvedValue(undefined);
  vi.mocked(deleteKnowledgeBaseMember).mockReset().mockResolvedValue(undefined);
  vi.mocked(listKnowledgeBaseTags).mockReset().mockResolvedValue({ items: [] });
  vi.mocked(searchKnowledgeBase).mockReset().mockResolvedValue({ items: [], rerankFallback: null });
  vi.mocked(searchUsers).mockReset().mockResolvedValue({ items: [] });
  vi.mocked(updateKnowledgeBase).mockReset().mockImplementation(async (_, input) => ({
    ...knowledgeBase,
    name: input.name,
    description: input.description,
    categoryId: input.categoryId,
    visibility: input.visibility,
  }));
  vi.mocked(updateKnowledgeBasePermissions).mockReset();
});

describe('KnowledgeBaseDetailPage', () => {
  it('keeps knowledge-base edit and delete actions available across detail tabs', async () => {
    const user = userEvent.setup();
    renderWithRouter(
      <Routes>
        <Route path="/knowledge-bases/:id" element={<KnowledgeBaseDetailPage />} />
      </Routes>,
      ['/knowledge-bases/kb1?tab=settings'],
    );

    const actions = await screen.findByRole('button', { name: '制度库的更多操作' });
    await user.click(actions);

    const menu = screen.getByRole('menu', { name: '制度库的更多操作' });
    expect(within(menu).getByRole('menuitem', { name: '编辑知识库' })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: '删除知识库' })).toBeInTheDocument();
  });

  it('prefills and saves the complete knowledge-base form from detail', async () => {
    const tags = [
      { id: 'tag-a', name: '制度', createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-01T00:00:00Z' },
      { id: 'tag-b', name: '人事', createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-01T00:00:00Z' },
    ];
    const editableKnowledgeBase = {
      ...knowledgeBase,
      categoryId: 'category-a',
      tags: [tags[0]],
    } satisfies KnowledgeBase;
    vi.mocked(getKnowledgeBase).mockResolvedValue(editableKnowledgeBase);
    vi.mocked(listKnowledgeBaseCategories).mockResolvedValue({
      items: [{
        id: 'category-a', parentId: null, name: '制度分类', sortOrder: 1,
        createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-01T00:00:00Z',
      }],
    });
    vi.mocked(listKnowledgeBaseTags).mockResolvedValue({ items: tags });
    vi.mocked(updateKnowledgeBase).mockImplementation(async (_, input) => ({
      ...editableKnowledgeBase,
      name: input.name,
      description: input.description,
      categoryId: input.categoryId,
      visibility: input.visibility,
      tags,
    }));
    const user = userEvent.setup();
    renderWithRouter(
      <Routes>
        <Route path="/knowledge-bases/:id" element={<KnowledgeBaseDetailPage />} />
      </Routes>,
      ['/knowledge-bases/kb1'],
    );

    await user.click(await screen.findByRole('button', { name: '制度库的更多操作' }));
    await user.click(screen.getByRole('menuitem', { name: '编辑知识库' }));
    const drawer = screen.getByRole('dialog', { name: '编辑知识库' });
    const name = within(drawer).getByRole('textbox', { name: '名称' });
    expect(name).toHaveValue('制度库');
    expect(within(drawer).getByRole('textbox', { name: '描述' })).toHaveValue('制度说明');
    expect(within(drawer).getByRole('combobox', { name: '分类' })).toHaveValue('category-a');
    expect(within(drawer).getByRole('checkbox', { name: '制度' })).toBeChecked();
    expect(within(drawer).getByRole('checkbox', { name: '人事' })).not.toBeChecked();
    expect(within(drawer).getByRole('combobox', { name: '访问权限' })).toHaveValue('private');

    await user.clear(name);
    await user.type(name, '员工制度库');
    await user.click(within(drawer).getByRole('checkbox', { name: '人事' }));
    await user.selectOptions(within(drawer).getByRole('combobox', { name: '访问权限' }), 'public');
    await user.click(within(drawer).getByRole('button', { name: '保存修改' }));

    await waitFor(() => expect(updateKnowledgeBase).toHaveBeenCalledWith('kb1', {
      name: '员工制度库',
      description: '制度说明',
      categoryId: 'category-a',
      visibility: 'public',
      retrievalConfig: knowledgeBase.retrievalConfig,
      tagIds: ['tag-a', 'tag-b'],
    }));
    expect(await screen.findByRole('heading', { name: '员工制度库' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: '编辑知识库' })).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('知识库更新成功');
  });

  it('uses the latest loaded tag name when opening the knowledge-base editor', async () => {
    const staleTag = {
      id: 'tag-a', name: '旧标签名', createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-01T00:00:00Z',
    };
    const currentTag = { ...staleTag, name: '制度' };
    vi.mocked(getKnowledgeBase).mockResolvedValue({
      ...knowledgeBase,
      tags: [staleTag],
    });
    vi.mocked(listKnowledgeBaseTags).mockResolvedValue({ items: [currentTag] });
    const user = userEvent.setup();
    renderWithRouter(
      <Routes>
        <Route path="/knowledge-bases/:id" element={<KnowledgeBaseDetailPage />} />
      </Routes>,
      ['/knowledge-bases/kb1'],
    );

    await user.click(await screen.findByRole('button', { name: '制度库的更多操作' }));
    await user.click(screen.getByRole('menuitem', { name: '编辑知识库' }));
    const drawer = screen.getByRole('dialog', { name: '编辑知识库' });

    expect(await within(drawer).findByRole('checkbox', { name: '制度' })).toBeChecked();
    expect(within(drawer).queryByRole('checkbox', { name: '旧标签名' })).not.toBeInTheDocument();
  });

  it('keeps detail edits and the inline error when saving fails', async () => {
    vi.mocked(updateKnowledgeBase).mockRejectedValue(new Error('offline'));
    const user = userEvent.setup();
    renderWithRouter(
      <Routes>
        <Route path="/knowledge-bases/:id" element={<KnowledgeBaseDetailPage />} />
      </Routes>,
      ['/knowledge-bases/kb1'],
    );

    await user.click(await screen.findByRole('button', { name: '制度库的更多操作' }));
    await user.click(screen.getByRole('menuitem', { name: '编辑知识库' }));
    const drawer = screen.getByRole('dialog', { name: '编辑知识库' });
    const name = within(drawer).getByRole('textbox', { name: '名称' });
    await user.type(name, '更新');
    await user.click(within(drawer).getByRole('button', { name: '保存修改' }));

    expect(await within(drawer).findByRole('alert')).toHaveTextContent('知识库保存失败');
    expect(name).toHaveValue('制度库更新');
    expect(screen.getByRole('dialog', { name: '编辑知识库' })).toBeInTheDocument();
  });

  it('keeps loaded permission state in sync after editing visibility', async () => {
    vi.mocked(updateKnowledgeBase).mockImplementation(async (_, input) => ({
      ...knowledgeBase,
      visibility: input.visibility,
    }));
    const user = userEvent.setup();
    renderWithRouter(
      <Routes>
        <Route path="/knowledge-bases/:id" element={<KnowledgeBaseDetailPage />} />
      </Routes>,
      ['/knowledge-bases/kb1?tab=settings'],
    );

    const permissionVisibility = await screen.findByRole('combobox', { name: '可见性' });
    expect(permissionVisibility).toHaveValue('private');
    await user.click(screen.getByRole('button', { name: '制度库的更多操作' }));
    await user.click(screen.getByRole('menuitem', { name: '编辑知识库' }));
    const drawer = screen.getByRole('dialog', { name: '编辑知识库' });
    await user.selectOptions(within(drawer).getByRole('combobox', { name: '访问权限' }), 'public');
    await user.click(within(drawer).getByRole('button', { name: '保存修改' }));

    await waitFor(() => expect(permissionVisibility).toHaveValue('public'));
    expect(screen.getByText('公开', { selector: '.visibility-pill' })).toBeInTheDocument();
  });

  it('does not let an older permission read revert visibility edited from settings', async () => {
    const initialPermissions = deferred<Awaited<ReturnType<typeof getKnowledgeBasePermissions>>>();
    vi.mocked(getKnowledgeBasePermissions)
      .mockReturnValueOnce(initialPermissions.promise)
      .mockResolvedValueOnce({
        knowledgeBaseId: 'kb1',
        visibility: 'public',
        owner: { id: 'u1', username: 'admin', displayName: '管理员' },
        managers: [],
        members: [],
      });
    vi.mocked(updateKnowledgeBase).mockImplementation(async (_, input) => ({
      ...knowledgeBase,
      visibility: input.visibility,
    }));
    const user = userEvent.setup();
    renderWithRouter(
      <Routes>
        <Route path="/knowledge-bases/:id" element={<KnowledgeBaseDetailPage />} />
      </Routes>,
      ['/knowledge-bases/kb1?tab=settings'],
    );

    await user.click(await screen.findByRole('button', { name: '制度库的更多操作' }));
    await user.click(screen.getByRole('menuitem', { name: '编辑知识库' }));
    const drawer = screen.getByRole('dialog', { name: '编辑知识库' });
    await user.selectOptions(within(drawer).getByRole('combobox', { name: '访问权限' }), 'public');
    await user.click(within(drawer).getByRole('button', { name: '保存修改' }));

    await waitFor(() => expect(getKnowledgeBasePermissions).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('combobox', { name: '可见性' })).toHaveValue('public');
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

    expect(screen.getByRole('combobox', { name: '可见性' })).toHaveValue('public');
    expect(screen.getByText('公开', { selector: '.visibility-pill' })).toBeInTheDocument();
  });

  it('keeps current metadata visible and requires recovery when edit options fail to load', async () => {
    const currentTag = {
      id: 'tag-a', name: '制度', createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-01T00:00:00Z',
    };
    vi.mocked(getKnowledgeBase).mockResolvedValue({
      ...knowledgeBase,
      categoryId: 'category-a',
      tags: [currentTag],
    });
    vi.mocked(listKnowledgeBaseCategories)
      .mockResolvedValueOnce({ items: [] })
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({
        items: [{
          id: 'category-a', parentId: null, name: '制度分类', sortOrder: 1,
          createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-01T00:00:00Z',
        }],
      });
    vi.mocked(listKnowledgeBaseTags)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ items: [currentTag] });
    const user = userEvent.setup();
    renderWithRouter(
      <Routes>
        <Route path="/knowledge-bases/:id" element={<KnowledgeBaseDetailPage />} />
      </Routes>,
      ['/knowledge-bases/kb1'],
    );

    await user.click(await screen.findByRole('button', { name: '制度库的更多操作' }));
    await user.click(screen.getByRole('menuitem', { name: '编辑知识库' }));
    const drawer = screen.getByRole('dialog', { name: '编辑知识库' });
    expect(await within(drawer).findByRole('alert')).toHaveTextContent('分类和标签加载失败');
    expect(within(drawer).getByRole('combobox', { name: '分类' })).toHaveValue('category-a');
    expect(within(drawer).getByRole('checkbox', { name: '制度' })).toBeChecked();
    expect(within(drawer).getByRole('button', { name: '保存修改' })).toBeDisabled();

    await user.click(within(drawer).getByRole('button', { name: '重试加载' }));
    await waitFor(() => expect(within(drawer).getByRole('button', { name: '保存修改' })).toBeEnabled());
    expect(within(drawer).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('confirms detail deletion and returns to the knowledge-base list on success', async () => {
    const user = userEvent.setup();
    renderWithRouter(
      <>
        <Routes>
          <Route path="/knowledge-bases/:id" element={<KnowledgeBaseDetailPage />} />
          <Route path="/knowledge-bases" element={<div>知识库列表</div>} />
        </Routes>
        <LocationProbe />
      </>,
      ['/knowledge-bases/kb1'],
    );

    await user.click(await screen.findByRole('button', { name: '制度库的更多操作' }));
    await user.click(screen.getByRole('menuitem', { name: '删除知识库' }));
    const firstConfirmation = screen.getByRole('dialog', { name: '删除知识库' });
    expect(firstConfirmation).toHaveTextContent('回收站');
    await user.click(within(firstConfirmation).getByRole('button', { name: '取消' }));
    expect(deleteKnowledgeBase).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: '制度库的更多操作' }));
    await user.click(screen.getByRole('menuitem', { name: '删除知识库' }));
    await user.click(within(screen.getByRole('dialog', { name: '删除知识库' })).getByRole('button', { name: '删除' }));

    await waitFor(() => expect(deleteKnowledgeBase).toHaveBeenCalledWith('kb1'));
    expect(screen.getByLabelText('当前位置')).toHaveTextContent('/knowledge-bases');
    expect(within(screen.getByRole('region', { name: '通知' })).getByRole('status')).toHaveTextContent(
      '知识库已移入回收站',
    );
  });

  it('keeps a failed detail deletion inside its confirmation', async () => {
    vi.mocked(deleteKnowledgeBase).mockRejectedValue(new Error('offline'));
    const user = userEvent.setup();
    renderWithRouter(
      <>
        <Routes>
          <Route path="/knowledge-bases/:id" element={<KnowledgeBaseDetailPage />} />
        </Routes>
        <LocationProbe />
      </>,
      ['/knowledge-bases/kb1'],
    );

    await user.click(await screen.findByRole('button', { name: '制度库的更多操作' }));
    await user.click(screen.getByRole('menuitem', { name: '删除知识库' }));
    const confirmation = screen.getByRole('dialog', { name: '删除知识库' });
    await user.click(within(confirmation).getByRole('button', { name: '删除' }));

    expect(await within(confirmation).findByRole('alert')).toHaveTextContent('知识库删除失败');
    expect(screen.getByLabelText('当前位置')).toHaveTextContent('/knowledge-bases/kb1');
  });

  it('ignores stale detail mutations after switching knowledge bases', async () => {
    const updateResult = deferred<KnowledgeBase>();
    const secondKnowledgeBase = { ...knowledgeBase, id: 'kb2', name: '产品库' };
    vi.mocked(getKnowledgeBase).mockImplementation((id) => Promise.resolve(
      id === 'kb2' ? secondKnowledgeBase : knowledgeBase,
    ));
    vi.mocked(updateKnowledgeBase).mockReturnValue(updateResult.promise);
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

    await user.click(await screen.findByRole('button', { name: '制度库的更多操作' }));
    await user.click(screen.getByRole('menuitem', { name: '编辑知识库' }));
    await user.click(screen.getByRole('button', { name: '保存修改' }));
    await waitFor(() => expect(updateKnowledgeBase).toHaveBeenCalledWith('kb1', expect.any(Object)));
    act(() => screen.getByText('切换知识库').click());
    expect(await screen.findByRole('heading', { name: '产品库' })).toBeInTheDocument();

    await act(async () => {
      updateResult.resolve({ ...knowledgeBase, name: '旧知识库更新' });
      await Promise.resolve();
    });
    expect(screen.getByRole('heading', { name: '产品库' })).toBeInTheDocument();
    expect(screen.queryByText('知识库更新成功')).not.toBeInTheDocument();
  });

  it('keeps overview focused and loads permissions only after entering settings', async () => {
    const user = userEvent.setup();
    renderWithRouter(
      <Routes>
        <Route path="/knowledge-bases/:id" element={<KnowledgeBaseDetailPage />} />
      </Routes>,
      ['/knowledge-bases/kb1'],
    );

    await screen.findByRole('heading', { name: '制度库' });
    const sectionNav = screen.getByRole('navigation', { name: '知识库功能' });
    expect(within(sectionNav).getByRole('link', { name: '概览' })).toHaveAttribute('aria-current', 'page');
    expect(within(sectionNav).getByRole('link', { name: '文档' })).toHaveAttribute(
      'href',
      '/knowledge-bases/kb1/documents',
    );
    expect(within(sectionNav).getByRole('link', { name: 'AI 问答' })).toHaveAttribute(
      'href',
      '/knowledge-bases/kb1?tab=qa',
    );
    expect(getKnowledgeBasePermissions).not.toHaveBeenCalled();
    expect(screen.queryByRole('heading', { name: '成员权限' })).not.toBeInTheDocument();

    await user.click(within(sectionNav).getByRole('link', { name: '设置' }));

    expect(await screen.findByRole('heading', { name: '成员权限' })).toBeInTheDocument();
    expect(getKnowledgeBasePermissions).toHaveBeenCalledOnce();
    expect(within(sectionNav).getByRole('link', { name: '设置' })).toHaveAttribute('aria-current', 'page');
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

  it('confirms member removal and announces success without reloading permissions', async () => {
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

    await user.click(await screen.findByRole('button', { name: '移除' }));
    const firstDialog = screen.getByRole('dialog', { name: '移除成员' });
    expect(firstDialog).toHaveTextContent('普通成员');
    expect(deleteKnowledgeBaseMember).not.toHaveBeenCalled();
    await user.click(within(firstDialog).getByRole('button', { name: '取消' }));
    expect(deleteKnowledgeBaseMember).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: '移除' }));
    await user.click(within(screen.getByRole('dialog', { name: '移除成员' })).getByRole('button', { name: '移除成员' }));

    await waitFor(() => expect(deleteKnowledgeBaseMember).toHaveBeenCalledWith('kb1', 'u2'));
    expect(await screen.findByRole('status')).toHaveTextContent('成员移除成功');
    expect(screen.queryByText('普通成员')).not.toBeInTheDocument();
    expect(getKnowledgeBasePermissions).toHaveBeenCalledTimes(1);
  });

  it('keeps a failed member removal inside the confirmation dialog', async () => {
    vi.mocked(getKnowledgeBasePermissions).mockResolvedValue({
      knowledgeBaseId: knowledgeBase.id,
      visibility: 'private',
      owner: { id: 'u1', username: 'admin', displayName: '管理员' },
      managers: [],
      members: [{ id: 'u2', username: 'member', displayName: '普通成员', role: 'member' }],
    });
    vi.mocked(deleteKnowledgeBaseMember).mockRejectedValue(new Error('offline'));
    const user = userEvent.setup();
    renderWithRouter(
      <Routes>
        <Route path="/knowledge-bases/:id" element={<KnowledgeBaseDetailPage />} />
      </Routes>,
      ['/knowledge-bases/kb1?tab=settings'],
    );

    await user.click(await screen.findByRole('button', { name: '移除' }));
    const dialog = screen.getByRole('dialog', { name: '移除成员' });
    await user.click(within(dialog).getByRole('button', { name: '移除成员' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('成员移除失败');
    expect(screen.getByRole('dialog', { name: '移除成员' })).toBeInTheDocument();
  });

  it('ignores a stale member-removal result after switching knowledge bases', async () => {
    const removal = deferred<void>();
    const secondKnowledgeBase = { ...knowledgeBase, id: 'kb2', name: '产品库' };
    vi.mocked(getKnowledgeBase).mockImplementation((id) => Promise.resolve(
      id === secondKnowledgeBase.id ? secondKnowledgeBase : knowledgeBase,
    ));
    vi.mocked(getKnowledgeBasePermissions).mockImplementation((id) => Promise.resolve({
      knowledgeBaseId: id,
      visibility: 'private',
      owner: { id: 'u1', username: 'admin', displayName: '管理员' },
      managers: [],
      members: id === secondKnowledgeBase.id
        ? [{ id: 'u3', username: 'product-member', displayName: '产品成员', role: 'member' }]
        : [{ id: 'u2', username: 'member', displayName: '普通成员', role: 'member' }],
    }));
    vi.mocked(deleteKnowledgeBaseMember).mockReturnValue(removal.promise);
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

    await user.click(await screen.findByRole('button', { name: '移除' }));
    await user.click(within(screen.getByRole('dialog', { name: '移除成员' })).getByRole('button', { name: '移除成员' }));
    await waitFor(() => expect(deleteKnowledgeBaseMember).toHaveBeenCalledWith('kb1', 'u2'));
    act(() => screen.getByText('切换知识库').click());

    expect(await screen.findByRole('heading', { name: '产品库' })).toBeInTheDocument();
    expect(await screen.findByText('产品成员')).toBeInTheDocument();
    await act(async () => {
      removal.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText('产品成员')).toBeInTheDocument();
    expect(screen.queryByText('成员移除成功')).not.toBeInTheDocument();
    expect(screen.queryByText('成员移除失败')).not.toBeInTheDocument();
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
        vectorStage: { status: 'completed', items: [{
          chunkId: 'chunk-1', documentId: 'doc-1', filename: '制度.md', content: '制度内容',
          pageNumber: 1, vectorScore: 0.91, rerankScore: 0.82, rank: 1,
        }] },
        rerankStage: {
          status: 'completed',
          input: [{ chunkId: 'chunk-1', pageNumber: 1, rank: 1 }],
          output: [{ chunkId: 'chunk-1', pageNumber: 1, rerankScore: 0.82, rank: 1 }],
        },
        finalStage: { items: [{
          chunkId: 'chunk-1', pageNumber: 1, vectorScore: 0.91, rerankScore: 0.82, rank: 1,
        }] },
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

    const debugPanel = await screen.findByRole('region', { name: '检索调试信息' });
    expect(debugPanel).toHaveTextContent('公司制度');
    expect(debugPanel).toHaveTextContent('已完成');
    expect(debugPanel).toHaveTextContent('向量分');
    expect(debugPanel).toHaveTextContent('精排阶段');
    expect(debugPanel).toHaveTextContent('精排分');
    expect(debugPanel).not.toHaveTextContent('completed');
    expect(debugPanel).not.toHaveTextContent('chunk-1');
  });
});
