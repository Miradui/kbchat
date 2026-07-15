import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../api/client';
import {
  createKnowledgeBaseTag,
  deleteKnowledgeBaseTag,
  listKnowledgeBaseTags,
  updateKnowledgeBaseTag,
} from '../../api/resources';
import { renderWithRouter } from '../../test/render';
import type { KnowledgeBaseTag } from '../../types/api';
import { TagsPage } from './TagsPage';

vi.mock('../../api/resources', () => ({
  createKnowledgeBaseTag: vi.fn(),
  deleteKnowledgeBaseTag: vi.fn(),
  listKnowledgeBaseTags: vi.fn(),
  logout: vi.fn(),
  updateKnowledgeBaseTag: vi.fn(),
}));

const existing = {
  id: 't1', name: '制度', createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-01T00:00:00Z',
} satisfies KnowledgeBaseTag;
const created = {
  id: 't2', name: '产品', createdAt: '2026-07-02T00:00:00Z', updatedAt: '2026-07-02T00:00:00Z',
} satisfies KnowledgeBaseTag;

beforeEach(() => {
  vi.mocked(listKnowledgeBaseTags).mockReset().mockResolvedValue({ items: [existing] });
  vi.mocked(createKnowledgeBaseTag).mockReset().mockResolvedValue(created);
  vi.mocked(updateKnowledgeBaseTag).mockReset();
  vi.mocked(deleteKnowledgeBaseTag).mockReset();
});

describe('TagsPage', () => {
  it('creates locally without refetching', async () => {
    const user = userEvent.setup();
    renderWithRouter(<TagsPage />);
    expect(await screen.findByText('制度')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '新建标签' }));
    await user.type(screen.getByLabelText('标签名称'), '产品');
    await user.click(screen.getByRole('button', { name: '保存标签' }));

    expect(await screen.findByText('产品')).toBeInTheDocument();
    expect(screen.getByText('制度')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('标签创建成功');
    expect(listKnowledgeBaseTags).toHaveBeenCalledOnce();
  });

  it('updates locally without refetching', async () => {
    vi.mocked(updateKnowledgeBaseTag).mockResolvedValue({ ...existing, name: '规章制度', updatedAt: '2026-07-03T00:00:00Z' });
    const user = userEvent.setup();
    renderWithRouter(<TagsPage />);
    expect(await screen.findByText('制度')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '编辑 制度' }));
    const input = screen.getByLabelText('标签名称');
    await user.clear(input);
    await user.type(input, '规章制度');
    await user.click(screen.getByRole('button', { name: '保存标签' }));

    expect(await screen.findByText('规章制度')).toBeInTheDocument();
    expect(screen.queryByText('制度')).not.toBeInTheDocument();
    expect(updateKnowledgeBaseTag).toHaveBeenCalledWith('t1', { name: '规章制度' });
    expect(listKnowledgeBaseTags).toHaveBeenCalledOnce();
  });

  it('deletes locally without refetching', async () => {
    vi.mocked(deleteKnowledgeBaseTag).mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderWithRouter(<TagsPage />);
    expect(await screen.findByText('制度')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '删除 制度' }));
    await user.click(within(screen.getByRole('dialog', { name: '删除标签' })).getByRole('button', { name: '删除' }));

    await waitFor(() => expect(screen.queryByText('制度')).not.toBeInTheDocument());
    expect(screen.getByRole('status')).toHaveTextContent('标签删除成功');
    expect(listKnowledgeBaseTags).toHaveBeenCalledOnce();
  });

  it('keeps the row and confirmation after a failed delete', async () => {
    vi.mocked(deleteKnowledgeBaseTag).mockImplementation(() => Promise.reject(
      new ApiError(409, { code: 'TAG_NOT_EMPTY', message: '标签仍被知识库引用' }),
    ));
    const user = userEvent.setup();
    renderWithRouter(<TagsPage />);
    expect(await screen.findByText('制度')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '删除 制度' }));

    const dialog = screen.getByRole('dialog', { name: '删除标签' });
    await user.click(within(dialog).getByRole('button', { name: '删除' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('标签仍被知识库引用');
    expect(screen.getByText('制度')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: '删除标签' })).toBeInTheDocument();
    expect(listKnowledgeBaseTags).toHaveBeenCalledOnce();
  });
});
