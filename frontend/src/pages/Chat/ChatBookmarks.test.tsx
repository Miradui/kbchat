import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { deleteChatBookmark, listChatBookmarks, saveChatBookmark } from '../../api/resources';
import { renderWithRouter } from '../../test/render';
import { ChatBookmarkDialog, ChatBookmarksDialog } from './ChatBookmarks';

vi.mock('../../api/resources', () => ({ deleteChatBookmark: vi.fn(), listChatBookmarks: vi.fn(), saveChatBookmark: vi.fn() }));
const bookmark = { messageId: 'old-version', note: '采购备注', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' };
const item = { messageId: bookmark.messageId, sessionId: 's1', sessionTitle: '采购', archivedAt: null, role: 'assistant' as const, createdAt: bookmark.createdAt, excerpt: { before: 'old answer', match: '', after: '' }, bookmark };
beforeEach(() => { vi.resetAllMocks(); vi.mocked(listChatBookmarks).mockResolvedValue({ items: [item], total: 1, page: 1, pageSize: 20 }); });

it('loads notes and navigates to the exact bookmarked answer, including empty search', async () => {
  const select = vi.fn();
  renderWithRouter(<ChatBookmarksDialog onClose={vi.fn()} onSelect={select} onUpdated={vi.fn()} />);
  await screen.findByText('采购备注');
  expect(listChatBookmarks).toHaveBeenCalledWith({ q: '', page: 1, pageSize: 20 }, expect.any(AbortSignal));
  await userEvent.setup().click(screen.getByRole('button', { name: /查看原回答/ }));
  expect(select).toHaveBeenCalledWith(item);
});

it('retains failed note edits, guards duplicate submits and persists the selected version', async () => {
  const close = vi.fn(); const updated = vi.fn();
  vi.mocked(saveChatBookmark).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ ...bookmark, note: '新笔记' });
  renderWithRouter(<ChatBookmarkDialog target={item} onClose={close} onUpdated={updated} />);
  fireEvent.change(screen.getByLabelText('个人备注'), { target: { value: '新笔记' } });
  await userEvent.setup().click(screen.getByRole('button', { name: '保存收藏' }));
  await screen.findByRole('alert');
  expect(screen.getByLabelText('个人备注')).toHaveValue('新笔记'); expect(close).not.toHaveBeenCalled();
  await userEvent.setup().click(screen.getByRole('button', { name: '保存收藏' }));
  await waitFor(() => expect(updated).toHaveBeenCalledWith('old-version', expect.objectContaining({ note: '新笔记' })));
  expect(saveChatBookmark).toHaveBeenLastCalledWith('old-version', '新笔记'); expect(close).toHaveBeenCalledOnce();
});

it('removes a bookmark and protects an unsaved note on cancel', async () => {
  const close = vi.fn(); const updated = vi.fn(); vi.mocked(deleteChatBookmark).mockResolvedValue();
  renderWithRouter(<ChatBookmarkDialog target={item} onClose={close} onUpdated={updated} />);
  fireEvent.change(screen.getByLabelText('个人备注'), { target: { value: '尚未保存' } });
  await userEvent.setup().click(screen.getByRole('button', { name: '取消' }));
  expect(screen.getByRole('dialog', { name: '放弃备注修改？' })).toBeInTheDocument(); expect(close).not.toHaveBeenCalled();
  await userEvent.setup().click(within(screen.getByRole('dialog', { name: '放弃备注修改？' })).getByRole('button', { name: '取消' }));
  await userEvent.setup().click(screen.getByRole('button', { name: '取消收藏' }));
  await waitFor(() => expect(updated).toHaveBeenCalledWith('old-version', null));
  expect(deleteChatBookmark).toHaveBeenCalledWith('old-version');
});

it('switches to an inline note editor inside ChatBookmarksDialog without stacking dialogs', async () => {
  vi.mocked(saveChatBookmark).mockResolvedValue({ ...bookmark, note: '更新备注' });
  const updated = vi.fn();
  const user = userEvent.setup();
  renderWithRouter(<ChatBookmarksDialog onClose={vi.fn()} onSelect={vi.fn()} onUpdated={updated} />);
  await screen.findByText('采购备注');

  await user.click(screen.getByRole('button', { name: '编辑备注 / 取消收藏' }));

  expect(screen.getAllByRole('dialog')).toHaveLength(1);
  expect(screen.getByRole('dialog', { name: '编辑收藏备注' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '返回收藏列表' })).toBeInTheDocument();

  fireEvent.change(screen.getByLabelText('个人备注'), { target: { value: '更新备注' } });
  await user.click(screen.getByRole('button', { name: '保存收藏' }));

  await waitFor(() => expect(updated).toHaveBeenCalledWith('old-version', expect.objectContaining({ note: '更新备注' })));
  expect(screen.getByRole('dialog', { name: '收藏与笔记' })).toBeInTheDocument();
});
