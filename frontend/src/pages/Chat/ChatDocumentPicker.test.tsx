import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { listGlobalDocuments } from '../../api/resources';
import type { GlobalDocumentItem } from '../../types/api';
import { ChatDocumentPicker } from './ChatDocumentPicker';

vi.mock('../../api/resources', () => ({ listGlobalDocuments: vi.fn() }));
const makeDocument = (index: number, base = 'kb1'): GlobalDocumentItem => ({
  id: `doc${index}`, knowledgeBaseId: base, knowledgeBaseName: base, filename: `资料${index}.pdf`,
  fileType: 'pdf', fileSize: 100, status: 'completed', errorMessage: null, createdAt: '2026-11-23T00:00:00Z',
});
const response = (items: GlobalDocumentItem[]) => ({ items, total: items.length, page: 1, pageSize: 20 });
beforeEach(() => vi.resetAllMocks());

describe('ChatDocumentPicker', () => {
  it('keeps the default 1–20 selection contract and completed-document query', async () => {
    const user = userEvent.setup(), onSelect = vi.fn();
    const items = Array.from({ length: 20 }, (_, index) => makeDocument(index));
    vi.mocked(listGlobalDocuments).mockResolvedValue(response(items));
    render(<ChatDocumentPicker onClose={vi.fn()} onSelect={onSelect} />);
    expect(screen.getByRole('button', { name: '使用这些文档' })).toBeDisabled();
    const checks = await screen.findAllByRole('checkbox');
    await user.click(checks[0]);
    expect(screen.getByRole('button', { name: '使用这些文档' })).toBeEnabled();
    for (const checkbox of checks.slice(1)) await user.click(checkbox);
    await user.click(screen.getByRole('button', { name: '使用这些文档' }));
    expect(onSelect.mock.calls[0][0]).toHaveLength(20);
    expect(listGlobalDocuments).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed', page: 1, pageSize: 20 }), expect.any(AbortSignal));
  });

  it('prevents a 21st document while letting the user remove an existing choice', async () => {
    const user = userEvent.setup(), initial = Array.from({ length: 20 }, (_, index) => makeDocument(index));
    vi.mocked(listGlobalDocuments).mockResolvedValue(response([initial[0], makeDocument(21)]));
    render(<ChatDocumentPicker initialSelection={initial} onClose={vi.fn()} onSelect={vi.fn()} />);
    const next = await screen.findByRole('checkbox', { name: '选择 资料21.pdf（kb1）' });
    expect(next).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: '选择 资料0.pdf（kb1）' }));
    expect(next).toBeEnabled();
    await user.click(next);
    expect(screen.getByRole('status')).toHaveTextContent('已选择 20 份文档');
  });

  it('requires the configured count and keeps initial selection isolated until confirmation', async () => {
    const user = userEvent.setup(), onSelect = vi.fn(), onClose = vi.fn(), original = [makeDocument(1)];
    vi.mocked(listGlobalDocuments).mockResolvedValue(response([original[0], makeDocument(2), makeDocument(3)]));
    render(<ChatDocumentPicker title="挑选两份资料" description="限定两份" minSelection={2} maxSelection={2} initialSelection={original} onClose={onClose} onSelect={onSelect} />);
    expect(screen.getByRole('dialog', { name: '挑选两份资料' })).toHaveAccessibleDescription('限定两份');
    expect(await screen.findByRole('checkbox', { name: '选择 资料1.pdf（kb1）' })).toBeChecked();
    expect(screen.getByRole('button', { name: '使用这些文档' })).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: '选择 资料2.pdf（kb1）' }));
    expect(screen.getByRole('checkbox', { name: '选择 资料3.pdf（kb1）' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '取消' }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onSelect).not.toHaveBeenCalled();
    expect(original).toHaveLength(1);
  });

  it('rejects selections spanning six libraries and recovers after removal', async () => {
    const user = userEvent.setup(), onSelect = vi.fn();
    const items = Array.from({ length: 6 }, (_, index) => makeDocument(index, `kb${index}`));
    vi.mocked(listGlobalDocuments).mockResolvedValue(response(items));
    render(<ChatDocumentPicker initialSelection={items} onClose={vi.fn()} onSelect={onSelect} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('每次最多选择 5 个知识库');
    expect(screen.getByRole('button', { name: '使用这些文档' })).toBeDisabled();
    await user.click(await screen.findByRole('checkbox', { name: '选择 资料5.pdf（kb5）' }));
    await user.click(screen.getByRole('button', { name: '使用这些文档' }));
    expect(onSelect.mock.calls[0][0]).toHaveLength(5);
  });

  it('shows an error with retry and preserves initial selection after recovery', async () => {
    const user = userEvent.setup();
    vi.mocked(listGlobalDocuments).mockRejectedValueOnce(new Error('读取失败')).mockResolvedValueOnce(response([makeDocument(1)]));
    render(<ChatDocumentPicker initialSelection={[makeDocument(1)]} onClose={vi.fn()} onSelect={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('文档加载失败');
    await user.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByRole('checkbox', { name: '选择 资料1.pdf（kb1）' })).toBeChecked();
  });
});
