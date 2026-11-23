import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithRouter } from '../../test/render';
import type { DocumentItem } from '../../types/api';
import { ImportBatchChat } from './ImportBatchChat';

const doc = (id: string, status: DocumentItem['status'] = 'completed'): DocumentItem => ({ id, knowledgeBaseId: 'kb1', filename: `${id}.md`, fileSize: 10, fileType: 'md', status, errorMessage: null, createdAt: '' });

describe('ImportBatchChat', () => {
  it('requires an explicit subset for a partly available batch and preserves every status', () => {
    const navigate = vi.fn();
    renderWithRouter(<ImportBatchChat batch={{ id: 1, documents: [doc('a'), doc('b', 'embedding'), doc('c', 'failed')] }} onNavigate={navigate} />);
    expect(screen.queryByRole('button', { name: '问本次导入' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '选择本次导入中的资料' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByLabelText('b.md')).toBeDisabled();
    expect(within(dialog).getByLabelText('c.md')).toBeDisabled();
    expect(within(dialog).getByLabelText('a.md')).not.toBeChecked();
    fireEvent.click(within(dialog).getByLabelText('a.md'));
    fireEvent.click(within(dialog).getByRole('button', { name: '问所选资料' }));
    expect(navigate).toHaveBeenCalledWith('/chat?knowledgeBaseId=kb1&documentIds=a');
  });

  it('does not silently truncate batches over 20 documents', () => {
    renderWithRouter(<ImportBatchChat batch={{ id: 1, documents: Array.from({ length: 21 }, (_, i) => doc(String(i))) }} onNavigate={vi.fn()} />);
    expect(screen.queryByRole('button', { name: '问本次导入' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '选择本次导入中的资料' }));
    expect(screen.getAllByRole('checkbox')).toHaveLength(21);
    expect(screen.getAllByRole('checkbox').every((box) => !(box as HTMLInputElement).checked)).toBe(true);
    screen.getAllByRole('checkbox').forEach((box) => fireEvent.click(box));
    fireEvent.click(screen.getByRole('button', { name: '问所选资料' }));
    expect(screen.getByRole('alert')).toHaveTextContent('1–20 份文档');
  });

  it('blocks paused, cancelled and unknown tasks even when a stale snapshot says completed', () => {
    const documents = [doc('paused'), { ...doc('cancelled'), jobStatus: 'cancelled' as const }, doc('unknown', 'future' as DocumentItem['status'])];
    renderWithRouter(<ImportBatchChat batch={{ id: 1, documents, tasks: documents.map((document) => ({ document, paused: document.id === 'paused', error: document.id === 'paused' ? '文档已移动' : '' })) }} onNavigate={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '选择本次导入中的资料' }));
    expect(screen.getAllByRole('checkbox').every((box) => (box as HTMLInputElement).disabled)).toBe(true);
  });
});
