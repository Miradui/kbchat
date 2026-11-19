import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithRouter } from '../../test/render';
import type { KnowledgeBase } from '../../types/api';
import { MembersPanel } from './MembersPanel';

const resources = vi.hoisted(() => ({
  addKnowledgeBaseMember: vi.fn(),
  deleteKnowledgeBaseMember: vi.fn(),
  getKnowledgeBasePermissions: vi.fn(),
  searchUsers: vi.fn(),
  updateKnowledgeBaseMember: vi.fn(),
}));
vi.mock('../../api/resources', () => resources);
vi.mock('../../components/UserAvatar', () => ({ UserAvatar: () => <span /> }));

const owner = { id: 'owner', username: 'admin', displayName: '管理员' };
const knowledgeBase: KnowledgeBase = {answerConfig: { systemPromptAddition: '', answerLanguage: 'auto' as const, allowGeneralKnowledge: false, model: '' },
  id: 'kb1', name: '成员验收', description: '', visibility: 'private',
  effectiveRole: 'owner', capabilities: ['members.read', 'members.write'],
  retrievalConfig: {enableKeyword: true,  vectorTopN: 30, rerankTopK: 5, scoreThreshold: 0.3, enableRerank: true },
  createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
};

beforeEach(() => {
  vi.resetAllMocks();
  resources.getKnowledgeBasePermissions.mockResolvedValue({ owner, visibility: 'private', managers: [], members: [] });
});

describe('MembersPanel search', () => {
  it('labels visibility and distinguishes a finished empty search from idle', async () => {
    const user = userEvent.setup();
    resources.searchUsers.mockResolvedValue({ items: [] });
    renderWithRouter(<MembersPanel knowledgeBase={knowledgeBase} onVisibilityChange={vi.fn()} />);
    expect(await screen.findByRole('combobox', { name: '可见性' })).toHaveValue('private');
    expect(screen.queryByText('没有找到匹配的用户，请调整关键词。')).not.toBeInTheDocument();
    await user.type(screen.getByRole('searchbox', { name: '搜索用户' }), '不存在');
    await user.click(screen.getByRole('button', { name: '搜索' }));
    expect(await screen.findByRole('status')).toHaveTextContent('没有找到匹配的用户');
  });

  it('invalidates pending results when the query changes so the wrong user cannot be added', async () => {
    const user = userEvent.setup();
    let resolve!: (value: { items: typeof owner[] }) => void;
    resources.searchUsers.mockReturnValue(new Promise((done) => { resolve = done; }));
    renderWithRouter(<MembersPanel knowledgeBase={knowledgeBase} onVisibilityChange={vi.fn()} />);
    const search = await screen.findByRole('searchbox', { name: '搜索用户' });
    await user.type(search, 'old');
    await user.click(screen.getByRole('button', { name: '搜索' }));
    expect(screen.getByRole('status')).toHaveTextContent('正在搜索用户');
    await user.clear(search);
    await user.type(search, 'new');
    await act(async () => resolve({ items: [{ id: 'old-user', username: 'old', displayName: '过期用户' }] }));
    expect(screen.queryByText('过期用户')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
    expect(screen.getByRole('button', { name: '搜索' })).toBeEnabled();
  });

  it('retains a failed query and clears the error after a successful retry', async () => {
    const user = userEvent.setup();
    resources.searchUsers.mockRejectedValueOnce(new Error('unavailable')).mockResolvedValue({ items: [owner] });
    renderWithRouter(<MembersPanel knowledgeBase={knowledgeBase} onVisibilityChange={vi.fn()} />);
    await user.type(await screen.findByRole('searchbox', { name: '搜索用户' }), 'admin');
    await user.click(screen.getByRole('button', { name: '搜索' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('用户搜索失败，请重试');
    expect(screen.getByRole('searchbox')).toHaveValue('admin');
    await user.click(screen.getByRole('button', { name: '搜索' }));
    expect(await screen.findByRole('status')).toHaveTextContent('找到 1 位用户');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '设为只读成员' })).toBeDisabled();
  });
});

describe('MembersPanel write and refresh failures', () => {
  const member = { id: 'member1', username: 'editor', displayName: '编辑者' };

  it('reports a failed refresh as a stale list, not as a failed add', async () => {
    const user = userEvent.setup();
    resources.getKnowledgeBasePermissions
      .mockResolvedValueOnce({ owner, visibility: 'private', managers: [], members: [] })
      .mockRejectedValueOnce(new Error('offline'));
    resources.searchUsers.mockResolvedValue({ items: [member] });
    resources.addKnowledgeBaseMember.mockResolvedValue(undefined);
    renderWithRouter(<MembersPanel knowledgeBase={knowledgeBase} onVisibilityChange={vi.fn()} />);

    await user.type(await screen.findByRole('searchbox', { name: '搜索用户' }), 'editor');
    await user.click(screen.getByRole('button', { name: '搜索' }));
    await user.click(await screen.findByRole('button', { name: '设为只读成员' }));

    // The add itself succeeded; claiming it failed would invite a retry that then
    // fails as a duplicate.
    expect(await screen.findByText('成员列表刷新失败，请重试。')).toBeInTheDocument();
    expect(screen.queryByText('成员添加失败')).not.toBeInTheDocument();
  });

  it('closes the removal dialog after a successful removal even when the refresh fails', async () => {
    const user = userEvent.setup();
    resources.getKnowledgeBasePermissions
      .mockResolvedValueOnce({ owner, visibility: 'private', managers: [], members: [{ ...member, role: 'editor' }] })
      .mockRejectedValueOnce(new Error('offline'));
    resources.deleteKnowledgeBaseMember.mockResolvedValue(undefined);
    renderWithRouter(<MembersPanel knowledgeBase={knowledgeBase} onVisibilityChange={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: '移除' }));
    await user.click(await screen.findByRole('button', { name: '移除成员' }));

    expect(await screen.findByText('成员移除成功')).toBeInTheDocument();
    expect(await screen.findByText('成员列表刷新失败，请重试。')).toBeInTheDocument();
    // The removal error belongs to the dialog; a refresh failure must not land in it
    // after it closed.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
