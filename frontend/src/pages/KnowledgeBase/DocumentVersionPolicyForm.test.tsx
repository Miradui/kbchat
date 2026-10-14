import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { updateKnowledgeBase } from '../../api/resources';
import { ToastProvider } from '../../components/feedback/ToastProvider';
import type { KnowledgeBase } from '../../types/api';
import { DocumentVersionPolicyForm } from './DocumentVersionPolicyForm';

vi.mock('../../api/resources', () => ({ updateKnowledgeBase: vi.fn() }));
const kb = { id: 'kb', name: '资料', description: '说明', capabilities: ['kb.write'], documentVersionPolicy: 'all', visibility: 'private' } as KnowledgeBase;

describe('DocumentVersionPolicyForm', () => {
  it('saves the policy without submitting model or retrieval parameters', async () => {
    const user = userEvent.setup(); const onUpdated = vi.fn();
    vi.mocked(updateKnowledgeBase).mockResolvedValue({ ...kb, documentVersionPolicy: 'current' });
    render(<ToastProvider><DocumentVersionPolicyForm knowledgeBase={kb} onUpdated={onUpdated} /></ToastProvider>);
    await user.selectOptions(screen.getByLabelText('参与新问答的版本'), 'current');
    await user.click(screen.getByRole('button', { name: '保存版本范围' }));
    await waitFor(() => expect(onUpdated).toHaveBeenCalledWith(expect.objectContaining({ documentVersionPolicy: 'current' })));
    expect(updateKnowledgeBase).toHaveBeenCalledWith('kb', { name: '资料', description: '说明', visibility: 'private', categoryId: null, documentVersionPolicy: 'current' });
  });
  it('keeps failed settings editable for retry and prevents read-only changes', async () => {
    const user = userEvent.setup(); vi.mocked(updateKnowledgeBase).mockRejectedValue(new Error('保存失败'));
    const { rerender } = render(<ToastProvider><DocumentVersionPolicyForm knowledgeBase={kb} onUpdated={vi.fn()} /></ToastProvider>);
    await user.selectOptions(screen.getByLabelText('参与新问答的版本'), 'current'); await user.click(screen.getByRole('button', { name: '保存版本范围' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('保存失败');
    expect(screen.getByLabelText('参与新问答的版本')).toHaveValue('current');
    rerender(<ToastProvider><DocumentVersionPolicyForm knowledgeBase={{ ...kb, capabilities: [] }} onUpdated={vi.fn()} /></ToastProvider>);
    expect(screen.getByLabelText('参与新问答的版本')).toBeDisabled(); expect(screen.queryByRole('button', { name: '保存版本范围' })).not.toBeInTheDocument();
  });
});
