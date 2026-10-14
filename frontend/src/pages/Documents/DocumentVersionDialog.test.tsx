import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { compareDocumentVersions, listDocumentVersions } from '../../api/resources';
import { renderWithRouter } from '../../test/render';
import { DocumentVersionDialog } from './DocumentVersionDialog';
import type { DocumentCompareResponse } from '../../types/api';

vi.mock('../../api/resources', () => ({ compareDocumentVersions: vi.fn(), listDocumentVersions: vi.fn() }));
const versions = ['old', 'new'].map((id) => ({ id, filename: `${id}.md`, createdAt: '2026-10-13T00:00:00Z', status: 'completed', supersededById: id === 'old' ? 'new' : null }));
it('selects the previous revision, shows safe line differences and discards late results after selection changes', async () => {
  vi.mocked(listDocumentVersions).mockResolvedValue({ items: versions });
  const data: DocumentCompareResponse = { base: versions[0], head: versions[1], addedLines: 1, removedLines: 1, lines: [{ kind: 'remove', content: '<img onerror=alert(1)>', baseLine: 1, headLine: null }, { kind: 'add', content: '新条款', baseLine: null, headLine: 1 }] };
  vi.mocked(compareDocumentVersions).mockResolvedValueOnce(data);
  renderWithRouter(<DocumentVersionDialog documentId="new" onClose={vi.fn()} />);
  await waitFor(() => expect(screen.getByLabelText('基准版本')).toHaveValue('old'));
  await userEvent.setup().click(screen.getByRole('button', { name: '比较文本' }));
  await screen.findByText('新增 1 行，删除 1 行');
  expect(screen.getByText('<img onerror=alert(1)>')).toBeInTheDocument(); expect(document.querySelector('img')).toBeNull();
  let done!: (value: DocumentCompareResponse) => void;
  vi.mocked(compareDocumentVersions).mockReturnValueOnce(new Promise((resolve) => { done = resolve; }));
  await userEvent.setup().click(screen.getByRole('button', { name: '比较文本' }));
  fireEvent.change(screen.getByLabelText('基准版本'), { target: { value: 'new' } });
  await act(async () => done(data));
  expect(screen.queryByText('新增 1 行，删除 1 行')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '比较文本' })).toBeDisabled();
});
