import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { searchChatMessages } from '../../api/resources';
import { renderWithRouter } from '../../test/render';
import type { ChatMessageSearchItem, ChatMessageSearchResponse } from '../../types/api';
import { ChatSearchDialog } from './ChatSearchDialog';

vi.mock('../../api/resources', () => ({ searchChatMessages: vi.fn() }));
const item: ChatMessageSearchItem = { messageId: 'm1', sessionId: 's1', sessionTitle: '采购流程', role: 'assistant', archivedAt: '2026-10-01T00:00:00Z',
  createdAt: '2026-10-01T00:00:00Z', excerpt: { before: '制度要求 ', match: 'A+B', after: ' <img src=x onerror=alert(1)>' } };
const response = { items: [item], total: 21, page: 1, pageSize: 20 };
beforeEach(() => vi.mocked(searchChatMessages).mockReset().mockResolvedValue(response));

it('searches all sessions, renders a safe highlighted excerpt and pages before selecting a hit', async () => {
  const user = userEvent.setup();
  const select = vi.fn();
  renderWithRouter(<ChatSearchDialog onClose={vi.fn()} onSelect={select} />);
  const dialog = screen.getByRole('dialog', { name: '搜索会话内容' });
  const input = within(dialog).getByRole('searchbox');
  expect(input).toHaveFocus();
  expect(searchChatMessages).not.toHaveBeenCalled();
  await user.type(input, 'a+b');
  await screen.findByText('找到 21 条匹配消息');
  expect(searchChatMessages).toHaveBeenLastCalledWith({ q: 'a+b', sessionId: undefined, page: 1, pageSize: 20 }, expect.any(AbortSignal));
  expect(screen.getByText('A+B').tagName).toBe('MARK');
  expect(dialog.querySelector('img')).toBeNull();
  expect(screen.getByText('已归档')).toBeInTheDocument();
  vi.mocked(searchChatMessages).mockResolvedValueOnce({ ...response, items: [{ ...item, messageId: 'm21', sessionTitle: '第 21 条' }], page: 2 });
  await user.click(screen.getByRole('button', { name: '下一页' }));
  await user.click(await screen.findByRole('button', { name: /第 21 条/ }));
  expect(select).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'm21' }));
  expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled();
});

it('hides obsolete results during typing and ignores late responses, with retry on failure', async () => {
  let resolve!: (value: ChatMessageSearchResponse) => void;
  vi.mocked(searchChatMessages).mockReturnValueOnce(new Promise((done) => { resolve = done; }));
  renderWithRouter(<ChatSearchDialog onClose={vi.fn()} onSelect={vi.fn()} />);
  const input = screen.getByRole('searchbox');
  fireEvent.change(input, { target: { value: 'old' } });
  await waitFor(() => expect(searchChatMessages).toHaveBeenCalledTimes(1));
  const signal = vi.mocked(searchChatMessages).mock.calls[0][1];
  fireEvent.change(input, { target: { value: 'new' } });
  expect(signal?.aborted).toBe(true);
  await act(async () => resolve(response));
  expect(screen.queryByText('采购流程')).not.toBeInTheDocument();
  vi.mocked(searchChatMessages).mockRejectedValueOnce(new Error('offline'));
  await screen.findByRole('alert');
  vi.mocked(searchChatMessages).mockResolvedValueOnce({ ...response, items: [], total: 0 });
  await userEvent.setup().click(screen.getByRole('button', { name: '重试搜索' }));
  await screen.findByText('没有匹配消息，试试其他关键词。');
  expect(searchChatMessages).toHaveBeenLastCalledWith(expect.objectContaining({ q: 'new', page: 1 }), expect.any(AbortSignal));
});

it('waits for IME composition to finish and aborts reads when closing', async () => {
  const { unmount } = renderWithRouter(<ChatSearchDialog onClose={vi.fn()} onSelect={vi.fn()} />);
  const input = screen.getByRole('searchbox');
  fireEvent.compositionStart(input);
  fireEvent.change(input, { target: { value: '采购' } });
  await act(async () => { await new Promise((done) => setTimeout(done, 300)); });
  expect(searchChatMessages).not.toHaveBeenCalled();
  fireEvent.compositionEnd(input);
  await waitFor(() => expect(searchChatMessages).toHaveBeenCalledOnce());
  const signal = vi.mocked(searchChatMessages).mock.calls[0][1];
  unmount();
  expect(signal?.aborted).toBe(true);
});
