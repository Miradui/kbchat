import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createEvaluationRun, getEvaluationRun, listEvaluationCases, listEvaluationRuns, saveEvaluationCase } from '../../api/evaluations';
import { currentUserStore } from '../../store/currentUserStore';
import { renderWithRouter } from '../../test/render';
import type { KnowledgeBase } from '../../types/api';
import type { EvaluationCase, EvaluationRun } from '../../types/evaluation';
import { EvaluationCaseDialog } from './EvaluationCaseDialog';
import { EvaluationComparison } from './EvaluationComparison';
import { EvaluationPanel } from './EvaluationPanel';

vi.mock('../../api/evaluations', () => ({ createEvaluationRun: vi.fn(), getEvaluationRun: vi.fn(), listEvaluationCases: vi.fn(), listEvaluationRuns: vi.fn(), saveEvaluationCase: vi.fn(), deleteEvaluationCase: vi.fn(), cancelEvaluationRun: vi.fn() }));
vi.mock('../../api/resources', () => ({ getCurrentUser: vi.fn().mockResolvedValue({ id: 'owner', username: 'owner' }) }));
vi.mock('../../hooks/useSystemCapabilities', () => ({ useSystemCapabilities: () => ({ retrieval: { maxVectorTopN: 100, maxRerankTopK: 20 }, rerankEnabled: true }) }));

const kb: KnowledgeBase = {answerConfig: { systemPromptAddition: '', answerLanguage: 'auto' as const, allowGeneralKnowledge: false, model: '' },  id: 'kb1', name: '制度库', description: '', retrievalConfig: {enableKeyword: true,  vectorTopN: 30, rerankTopK: 5, scoreThreshold: .3, enableRerank: true }, createdAt: '', updatedAt: '' };
const item: EvaluationCase = { id: 'case-1', knowledgeBaseId: 'kb1', question: '几天内可退货？', expectedAnswer: '7 天内', requiredKeywords: ['7'], requireCitation: true, createdAt: '', updatedAt: '' };
const completed: EvaluationRun = { id: 'run-1', knowledgeBaseId: 'kb1', clientRequestId: 'request-1', name: '首次运行', status: 'completed', config: kb.retrievalConfig, cases: [item], results: [{ caseId: item.id, answer: '7 天内可退货。', answerStatus: 'answered', citations: [], rerankFallback: null, durationMs: 1100, rulePassed: false, missingKeywords: [], errorCode: '', errorMessage: '' }], answerConfig: { systemPromptAddition: '', answerLanguage: 'auto', allowGeneralKnowledge: false, model: '', temperature: null }, runtime: { chatModel: 'test-model', effectiveRerank: true }, total: 1, completedCount: 1, errorMessage: '', createdAt: '2026-09-10T00:00:00Z', startedAt: '2026-09-10T00:00:01Z', finishedAt: '2026-09-10T00:00:02Z' };

beforeEach(() => {
  vi.clearAllMocks(); currentUserStore.clear(); sessionStorage.clear();
  vi.mocked(listEvaluationCases).mockResolvedValue({ items: [item] });
  vi.mocked(listEvaluationRuns).mockResolvedValue({ items: [] });
  vi.mocked(getEvaluationRun).mockResolvedValue(completed);
});

describe('evaluation workflow', () => {
  it('keeps a saved case when the original case list arrives late', async () => {
    let resolveOriginal!: (value: { items: EvaluationCase[] }) => void;
    vi.mocked(listEvaluationCases).mockReturnValueOnce(new Promise((resolve) => { resolveOriginal = resolve; })).mockResolvedValue({ items: [item] });
    vi.mocked(saveEvaluationCase).mockResolvedValueOnce(item);
    renderWithRouter(<EvaluationPanel knowledgeBase={kb} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: '新增测试问题' }));
    await user.type(screen.getByRole('textbox', { name: '测试问题' }), item.question);
    await user.click(screen.getByRole('button', { name: '保存测试问题' }));
    await screen.findByRole('checkbox', { name: `选择测试问题：${item.question}` });
    await act(async () => resolveOriginal({ items: [] }));
    expect(screen.getByRole('checkbox', { name: `选择测试问题：${item.question}` })).toBeChecked();
  });

  it('keeps a newly created run when an older list request returns without it', async () => {
    let resolveList!: (value: { items: EvaluationRun[] }) => void;
    vi.mocked(listEvaluationRuns).mockReturnValueOnce(new Promise((resolve) => { resolveList = resolve; }));
    vi.mocked(createEvaluationRun).mockResolvedValueOnce(completed);
    renderWithRouter(<EvaluationPanel knowledgeBase={kb} />);
    const start = await screen.findByRole('button', { name: '批量重测（1 题）' });
    await waitFor(() => expect(start).toBeEnabled());
    await userEvent.setup().click(start);
    expect(await screen.findByRole('heading', { name: completed.name })).toBeInTheDocument();
    await act(async () => resolveList({ items: [] }));
    expect(screen.getByRole('heading', { name: completed.name })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: '查看评测运行' })).toHaveValue(completed.id);
  });

  it('preserves an unknown run request across a remount and retries with the same configuration and id', async () => {
    const user = userEvent.setup();
    vi.mocked(createEvaluationRun).mockRejectedValueOnce(new Error('connection lost')).mockImplementationOnce(async (_kb, input) => ({ ...completed, clientRequestId: input.clientRequestId }));
    const first = renderWithRouter(<EvaluationPanel knowledgeBase={kb} />);
    const runButton = await screen.findByRole('button', { name: '批量重测（1 题）' });
    await waitFor(() => expect(runButton).toBeEnabled());
    await user.clear(screen.getByRole('spinbutton', { name: '评测最低相关度' }));
    await user.type(screen.getByRole('spinbutton', { name: '评测最低相关度' }), '0');
    await user.click(runButton);
    await screen.findByRole('button', { name: '继续确认本次评测' });
    await waitFor(() => expect(createEvaluationRun).toHaveBeenCalledTimes(1));
    const original = vi.mocked(createEvaluationRun).mock.calls[0][1];
    expect(original.config.scoreThreshold).toBe(0);
    expect(sessionStorage.getItem('rag.evaluation.pending:owner:kb1')).toContain(original.clientRequestId);
    first.unmount();
    renderWithRouter(<EvaluationPanel knowledgeBase={kb} />);
    const retry = await screen.findByRole('button', { name: '继续确认本次评测' });
    expect(screen.getByRole('spinbutton', { name: '评测最低相关度' })).toBeDisabled();
    await user.click(retry);
    await waitFor(() => expect(createEvaluationRun).toHaveBeenCalledTimes(2));
    expect(vi.mocked(createEvaluationRun).mock.calls[1][1]).toEqual(original);
    await waitFor(() => expect(sessionStorage.getItem('rag.evaluation.pending:owner:kb1')).toBeNull());
  });

  it('does not overwrite a newly selected run with a late response from the previous run', async () => {
    let resolveOld!: (value: EvaluationRun) => void;
    const old = new Promise<EvaluationRun>((resolve) => { resolveOld = resolve; });
    const newer = { ...completed, id: 'run-2', name: '新的运行' };
    vi.mocked(listEvaluationRuns).mockResolvedValue({ items: [completed, newer] });
    vi.mocked(getEvaluationRun).mockImplementation((_kb, id) => id === completed.id ? old : Promise.resolve(newer));
    renderWithRouter(<EvaluationPanel knowledgeBase={kb} />);
    await userEvent.setup().selectOptions(await screen.findByRole('combobox', { name: '查看评测运行' }), newer.id);
    const results = await screen.findByRole('region', { name: '评测结果对比' });
    expect(within(results).getByRole('heading', { name: newer.name })).toBeInTheDocument();
    await act(async () => resolveOld(completed));
    expect(within(results).queryByRole('heading', { name: completed.name })).not.toBeInTheDocument();
  });

  it('keeps case edits when saving fails and submits explicit reference and keyword rules', async () => {
    const user = userEvent.setup();
    vi.mocked(saveEvaluationCase).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(item);
    const onSaved = vi.fn(), onClose = vi.fn();
    renderWithRouter(<EvaluationCaseDialog knowledgeBaseId="kb1" initial={{ question: item.question }} onSaved={onSaved} onClose={onClose} />);
    await user.type(screen.getByRole('textbox', { name: '参考答案' }), '7 天内');
    await user.type(screen.getByRole('textbox', { name: '必须包含的关键词' }), '7\n订单号');
    await user.click(screen.getByRole('button', { name: '保存测试问题' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '参考答案' })).toHaveValue('7 天内');
    expect(onClose).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '保存测试问题' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(item));
    expect(saveEvaluationCase).toHaveBeenLastCalledWith('kb1', { question: item.question, expectedAnswer: '7 天内', requiredKeywords: ['7', '订单号'], requireCitation: true }, undefined);
  });

  it('compares only identical question snapshots and keeps call failures out of rule pass counts', () => {
    const changed = { ...item, id: 'changed', question: '运费多少？' };
    const run: EvaluationRun = { ...completed, cases: [item, changed], total: 2, results: [{ ...completed.results![0], errorCode: 'EMBEDDING_FAILED', errorMessage: '检索不可用', rulePassed: null }] };
    const baseline: EvaluationRun = { ...completed, id: 'baseline', name: '基准', cases: [item, { ...changed, requiredKeywords: ['免费'] }] };
    renderWithRouter(<EvaluationComparison run={run} baseline={baseline} />);
    expect(screen.getByText(/两次运行有 1 道相同问题与规则/)).toBeInTheDocument();
    expect(screen.queryByRole('article', { name: `评测问题：${changed.question}` })).not.toBeInTheDocument();
    expect(screen.getByText('暂无可评分结果')).toBeInTheDocument();
    expect(screen.getByText('检索不可用')).toBeInTheDocument();
    expect(screen.getByText('规则未通过')).toBeInTheDocument();
  });
});
