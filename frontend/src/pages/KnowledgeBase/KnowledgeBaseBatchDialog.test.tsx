import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { renderWithRouter } from '../../test/render';
import { KnowledgeBaseBatchDialog } from './KnowledgeBaseBatchDialog';

function props() {
  return {
    kind: 'move' as const, count: 2, busy: false, error: '', categories: [{ id: 'cat-1', label: '产品资料', depth: 0 }],
    tags: [{ id: 'tag-1', name: '指南' }, { id: 'tag-2', name: '制度' }], optionsLoading: false, optionsError: '',
    onRetryOptions: vi.fn(), onClose: vi.fn(), onSubmit: vi.fn(),
  };
}

describe('KnowledgeBaseBatchDialog', () => {
  it('requires an explicit category and submits the selected destination', async () => {
    const p = props();
    const user = userEvent.setup();
    renderWithRouter(<KnowledgeBaseBatchDialog {...p} />);
    expect(screen.getByText('此操作仅应用于已选择的 2 个知识库。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '确认移动' })).toBeDisabled();
    await user.selectOptions(screen.getByLabelText('目标分类'), 'cat-1');
    await user.click(screen.getByRole('button', { name: '确认移动' }));
    expect(p.onSubmit).toHaveBeenCalledWith({ kind: 'move', categoryId: 'cat-1' });
  });

  it('supports intentionally moving back to uncategorized', async () => {
    const p = props();
    const user = userEvent.setup();
    renderWithRouter(<KnowledgeBaseBatchDialog {...p} />);
    await user.selectOptions(screen.getByLabelText('目标分类'), '__none__');
    await user.click(screen.getByRole('button', { name: '确认移动' }));
    expect(p.onSubmit).toHaveBeenCalledWith({ kind: 'move', categoryId: null });
  });

  it('accepts multiple tags and explains destructive replacement before applying it', async () => {
    const p = props();
    const user = userEvent.setup();
    renderWithRouter(<KnowledgeBaseBatchDialog {...p} kind="tags" />);
    expect(screen.getByRole('button', { name: '应用标签' })).toBeDisabled();
    await user.click(screen.getByLabelText('指南'));
    await user.click(screen.getByLabelText('制度'));
    await user.selectOptions(screen.getByLabelText('操作方式'), 'replace');
    expect(screen.getByText('替换后仅保留所选标签，原有其他标签会被移除。')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '应用标签' }));
    expect(p.onSubmit).toHaveBeenCalledWith({ kind: 'tags', tagIds: ['tag-1', 'tag-2'], mode: 'replace' });
  });

  it('keeps failed selections available for retry', async () => {
    const p = props();
    const user = userEvent.setup();
    const view = render(<KnowledgeBaseBatchDialog {...p} kind="tags" />);
    await user.click(screen.getByLabelText('指南'));
    view.rerender(<KnowledgeBaseBatchDialog {...p} kind="tags" error="暂时无法保存，请重试" />);
    expect(screen.getByRole('alert')).toHaveTextContent('暂时无法保存，请重试');
    expect(screen.getByLabelText('指南')).toBeChecked();
    await user.click(screen.getByRole('button', { name: '应用标签' }));
    expect(p.onSubmit).toHaveBeenCalledWith({ kind: 'tags', tagIds: ['tag-1'], mode: 'add' });
  });

  it('does not dismiss or resubmit while saving', () => {
    const p = props();
    renderWithRouter(<KnowledgeBaseBatchDialog {...p} busy />);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    fireEvent.mouseDown(screen.getByTestId('dialog-backdrop'));
    expect(p.onClose).not.toHaveBeenCalled();
    expect(p.onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '取消' })).toBeDisabled();
  });

  it('shows failed option reads separately from an empty tag list', async () => {
    const p = props();
    const user = userEvent.setup();
    renderWithRouter(<KnowledgeBaseBatchDialog {...p} kind="tags" tags={[]} optionsError="标签加载失败" />);
    expect(screen.queryByText('还没有标签，请先到“标签”页面创建。')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '应用标签' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '重新加载' }));
    expect(p.onRetryOptions).toHaveBeenCalledOnce();
  });
});
