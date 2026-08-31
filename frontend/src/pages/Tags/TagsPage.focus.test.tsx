import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { deleteKnowledgeBaseTag, listKnowledgeBaseTags } from '../../api/resources';
import { renderWithRouter } from '../../test/render';
import type { KnowledgeBaseTag } from '../../types/api';
import { TagsPage } from './TagsPage';

/**
 * Focus after a row delete. The dialog is opened from a button inside the row being
 * deleted, so by the time it closes there is nothing to return to and focus falls to a
 * page-level fallback -- or, before that fallback existed, to `body`. These lock in that
 * it lands on the same control in the neighbouring row, and that the page-level fallback
 * still covers the case where there is no neighbour left.
 */
vi.mock('../../api/resources', () => ({
  createKnowledgeBaseTag: vi.fn(),
  deleteKnowledgeBaseTag: vi.fn(),
  getCurrentUser: vi.fn().mockResolvedValue({ id: 'user-1', username: 'admin', displayName: '管理员' }),
  listKnowledgeBaseTags: vi.fn(),
  logout: vi.fn(),
  updateKnowledgeBaseTag: vi.fn(),
}));

/* Descending `updatedAt`, because the page sorts by it: newest first. Naming them in the
   order they appear on screen keeps the neighbour assertions readable. */
const first = {
  id: 't1', name: '制度', createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-03T00:00:00Z',
} satisfies KnowledgeBaseTag;
const middle = {
  id: 't2', name: '产品', createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-02T00:00:00Z',
} satisfies KnowledgeBaseTag;
const last = {
  id: 't3', name: '流程', createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-01T00:00:00Z',
} satisfies KnowledgeBaseTag;

async function deleteTag(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole('button', { name: `删除 ${name}` }));
  await user.click(
    within(screen.getByRole('dialog', { name: '删除标签' })).getByRole('button', { name: '删除' }),
  );
  await waitFor(() => expect(screen.queryByText(name)).not.toBeInTheDocument());
}

beforeEach(() => {
  vi.mocked(listKnowledgeBaseTags).mockReset().mockResolvedValue({ items: [first, middle, last] });
  vi.mocked(deleteKnowledgeBaseTag).mockReset().mockResolvedValue(undefined);
});

describe('TagsPage focus after delete', () => {
  it('moves focus to the next row', async () => {
    const user = userEvent.setup();
    renderWithRouter(<TagsPage />);
    expect(await screen.findByText('产品')).toBeInTheDocument();

    await deleteTag(user, '产品');

    expect(screen.getByRole('button', { name: '删除 流程' })).toHaveFocus();
  });

  it('moves focus to the previous row when the last one is deleted', async () => {
    const user = userEvent.setup();
    renderWithRouter(<TagsPage />);
    expect(await screen.findByText('流程')).toBeInTheDocument();

    await deleteTag(user, '流程');

    // There is no next row, so staying in the list means going backwards.
    expect(screen.getByRole('button', { name: '删除 产品' })).toHaveFocus();
  });

  it('picks the right neighbour on a second delete', async () => {
    const user = userEvent.setup();
    renderWithRouter(<TagsPage />);
    expect(await screen.findByText('制度')).toBeInTheDocument();

    // Middle first, then the row above it: that order is what makes the registry
    // observable. A deleted row has to leave it, not just leave the screen -- an entry
    // that stays behind sits between 制度 and 流程, so the second delete picks a
    // detached node as the neighbour, focuses nothing, and drops out of the list.
    await deleteTag(user, '产品');
    expect(screen.getByRole('button', { name: '删除 流程' })).toHaveFocus();
    await deleteTag(user, '制度');

    expect(screen.getByRole('button', { name: '删除 流程' })).toHaveFocus();
  });

  it('falls back to a page control when the only row is deleted', async () => {
    vi.mocked(listKnowledgeBaseTags).mockResolvedValue({ items: [first] });
    const user = userEvent.setup();
    renderWithRouter(<TagsPage />);
    expect(await screen.findByText('制度')).toBeInTheDocument();

    await deleteTag(user, '制度');

    // No list left to stay inside. What matters is that focus is somewhere reachable
    // rather than on `body`, where a keyboard user has to tab from the top of the page.
    expect(document.activeElement).toHaveAttribute('data-modal-focus-fallback');
  });

  it('keeps focus on the row control when the delete fails', async () => {
    vi.mocked(deleteKnowledgeBaseTag).mockRejectedValue(new Error('nope'));
    const user = userEvent.setup();
    renderWithRouter(<TagsPage />);
    expect(await screen.findByText('产品')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '删除 产品' }));
    const dialog = screen.getByRole('dialog', { name: '删除标签' });
    await user.click(within(dialog).getByRole('button', { name: '删除' }));
    await within(dialog).findByRole('alert');
    await user.click(within(dialog).getByRole('button', { name: '取消' }));

    // The row is still there, so the remembered neighbour must not be used: normal
    // restore-to-trigger applies.
    expect(screen.getByRole('button', { name: '删除 产品' })).toHaveFocus();
  });

  it('does not move focus when a row is removed by filtering', async () => {
    const user = userEvent.setup();
    renderWithRouter(<TagsPage />);
    expect(await screen.findByText('产品')).toBeInTheDocument();

    const search = screen.getByLabelText('搜索标签');
    await user.type(search, '产品');

    await waitFor(() => expect(screen.queryByText('制度')).not.toBeInTheDocument());
    // Rows disappearing is not a deletion. Pulling focus out of the search box while
    // someone is still typing in it would be worse than doing nothing.
    expect(search).toHaveFocus();
  });
});
