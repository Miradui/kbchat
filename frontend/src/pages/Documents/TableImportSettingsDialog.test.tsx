import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { TableImportPreview } from '../../types/api';
import { TableImportSettingsDialog } from './TableImportSettingsDialog';

const preview: TableImportPreview = { sheets: [
  { name: '销售', columnCount: 3, lastRow: 8, suggestedHeaderRow: 1, truncated: false, rows: [{ rowStart: 1, rowEnd: 1, values: ['报表说明'] }, { rowStart: 3, rowEnd: 3, values: ['名称', '内部备注', '金额'] }, { rowStart: 8, rowEnd: 8, values: ['设备', '内部信息', '8'] }] },
  { name: '库存', columnCount: 2, lastRow: 2, suggestedHeaderRow: 1, truncated: false, rows: [{ rowStart: 1, rowEnd: 1, values: ['产品', '数量'] }] },
] };
const file = new File(['fixture'], 'data.xlsx');

describe('TableImportSettingsDialog', () => {
  it('applies selected sheets, physical header and original column indices', async () => {
    const user = userEvent.setup(); const onApply = vi.fn();
    render(<TableImportSettingsDialog file={file} knowledgeBaseId="kb" inspect={vi.fn().mockResolvedValue(preview)} onApply={onApply} onClose={vi.fn()} />);
    await user.click(await screen.findByRole('checkbox', { name: '导入工作表 库存' }));
    fireEvent.change(screen.getByLabelText('表头所在行'), { target: { value: '3' } });
    expect(screen.getByText('B · 内部备注')).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: '导入列 B' }));
    await user.click(screen.getByRole('button', { name: '应用设置' }));
    expect(onApply).toHaveBeenCalledWith({ sheets: [{ name: '销售', headerRow: 3, columns: [1, 3] }] });
  });
  it('requires a sheet and a column and supports restoring defaults', async () => {
    const user = userEvent.setup(); const onApply = vi.fn();
    render(<TableImportSettingsDialog file={file} knowledgeBaseId="kb" initial={{ sheets: [{ name: '销售', headerRow: 3, columns: [1] }] }} inspect={vi.fn().mockResolvedValue(preview)} onApply={onApply} onClose={vi.fn()} />);
    await user.click(await screen.findByRole('checkbox', { name: '导入列 A' }));
    expect(screen.getByRole('button', { name: '应用设置' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '全选列' }));
    expect(screen.getByRole('button', { name: '应用设置' })).toBeEnabled();
    await user.click(screen.getByRole('checkbox', { name: '导入工作表 销售' }));
    expect(screen.getByRole('button', { name: '应用设置' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '恢复自动设置' }));
    expect(onApply).toHaveBeenCalledWith(undefined);
  });
  it('retries preview failures and aborts a dismissed inspection', async () => {
    const user = userEvent.setup(); const inspect = vi.fn().mockRejectedValueOnce(new Error('failed')).mockResolvedValueOnce(preview);
    const { unmount } = render(<TableImportSettingsDialog file={file} knowledgeBaseId="kb" inspect={inspect} onApply={vi.fn()} onClose={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: '重试预览' }));
    await waitFor(() => expect(screen.getByLabelText('查看工作表')).toBeInTheDocument());
    const signal = inspect.mock.calls[1][2] as AbortSignal;
    act(() => unmount());
    expect(signal.aborted).toBe(true);
  });
});
