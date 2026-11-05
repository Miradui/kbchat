import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ToastProvider } from '../../components/feedback/ToastProvider';
import type { KnowledgeBase } from '../../types/api';
import { AnswerConfigForm } from './AnswerConfigForm';
import { RetrievalConfigForm } from './RetrievalConfigForm';

function renderWithRouter(ui: ReactElement) {
  const router = createMemoryRouter([{ path: '/', element: ui }]);
  return render(<ToastProvider><RouterProvider router={router} /></ToastProvider>);
}

const resources = vi.hoisted(() => ({ updateKnowledgeBase: vi.fn(), searchKnowledgeBase: vi.fn() }));
vi.mock('../../api/resources', () => resources);
const capabilities = vi.hoisted(() => ({
  rerankEnabled: true,
  keywordSearchEnabled: true,
  retrieval: { maxVectorTopN: 100, maxRerankTopK: 20 },
  chatModels: ['gpt-4.1-mini', 'gpt-4.1'] as string[],
}));
vi.mock('../../hooks/useSystemCapabilities', () => ({ useSystemCapabilities: () => capabilities }));

const knowledgeBase: KnowledgeBase = {
  id: 'kb1', name: '回答配置', description: '', visibility: 'private', effectiveRole: 'owner',
  retrievalConfig: { vectorTopN: 30, rerankTopK: 5, scoreThreshold: 0.3, enableRerank: true, enableKeyword: true },
  answerConfig: { systemPromptAddition: '用要点作答', answerLanguage: 'zh', allowGeneralKnowledge: true, model: 'gpt-4.1', temperature: 0.2 },
  createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
};

beforeEach(() => {
  vi.resetAllMocks();
  capabilities.chatModels = ['gpt-4.1-mini', 'gpt-4.1'];
  resources.updateKnowledgeBase.mockImplementation(async (_id: string, body: Partial<KnowledgeBase>) => ({ ...knowledgeBase, ...body }));
});

describe('AnswerConfigForm', () => {
  it('submits the answer config while carrying the stored retrieval config', async () => {
    const user = userEvent.setup();
    const onUpdated = vi.fn();
    renderWithRouter(<AnswerConfigForm knowledgeBase={knowledgeBase} onUpdated={onUpdated} />);
    await user.selectOptions(screen.getByRole('combobox', { name: '回答语言' }), 'en');
    await user.click(screen.getByRole('button', { name: '保存配置' }));
    await waitFor(() => expect(resources.updateKnowledgeBase).toHaveBeenCalledOnce());
    const body = resources.updateKnowledgeBase.mock.calls[0][1];
    expect(body.answerConfig).toEqual({ ...knowledgeBase.answerConfig, answerLanguage: 'en' });
    expect(body.retrievalConfig).toEqual(knowledgeBase.retrievalConfig);
    expect(onUpdated).toHaveBeenCalled();
  });

  it('offers only whitelisted models and disables the override when no whitelist is configured', () => {
    const { unmount } = renderWithRouter(<AnswerConfigForm knowledgeBase={knowledgeBase} onUpdated={vi.fn()} />);
    const select = screen.getByRole('combobox', { name: '回答模型' });
    expect(select).toBeEnabled();
    expect(Array.from((select as HTMLSelectElement).options).map((option) => option.value)).toEqual(['', 'gpt-4.1-mini', 'gpt-4.1']);
    unmount();

    capabilities.chatModels = [];
    renderWithRouter(<AnswerConfigForm knowledgeBase={{ ...knowledgeBase, answerConfig: { ...knowledgeBase.answerConfig!, model: '' } }} onUpdated={vi.fn()} />);
    expect(screen.getByRole('combobox', { name: '回答模型' })).toBeDisabled();
    expect(screen.getByText(/未配置 CHAT_ALLOWED_MODELS/)).toBeInTheDocument();
  });

  it('is read-only for members without write access', () => {
    renderWithRouter(<AnswerConfigForm knowledgeBase={{ ...knowledgeBase, effectiveRole: 'editor', capabilities: ['chat.use', 'document.read'] }} onUpdated={vi.fn()} />);
    expect(screen.getByRole('combobox', { name: '回答语言' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: '保存配置' })).not.toBeInTheDocument();
  });
});

describe('RetrievalConfigForm', () => {
  it('sends the stored answer config alongside the retrieval config so saving one form does not reset the other', async () => {
    renderWithRouter(<RetrievalConfigForm knowledgeBase={knowledgeBase} onUpdated={vi.fn()} />);
    const input = screen.getByRole('spinbutton', { name: '向量召回数量' });
    fireEvent.change(input, { target: { value: '31' } });
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => expect(resources.updateKnowledgeBase).toHaveBeenCalledOnce());
    const body = resources.updateKnowledgeBase.mock.calls[0][1];
    expect(body.retrievalConfig.vectorTopN).toBe(31);
    expect(body.answerConfig).toEqual(knowledgeBase.answerConfig);
  });
});
