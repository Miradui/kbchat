import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
import { getChatQualityIssue, getKnowledgeBase, saveChatQualityIssue } from '../../api/resources';
import { createEvaluationRun, getEvaluationRun, listEvaluationCases } from '../../api/evaluations';
import type { KnowledgeBase } from '../../types/api';
import type { EvaluationCase, EvaluationRun } from '../../types/evaluation';
import { QualityIssueDialog } from './QualityIssueDialog';

vi.mock('../../api/resources', () => ({ getChatQualityIssue: vi.fn(), getKnowledgeBase: vi.fn(), saveChatQualityIssue: vi.fn() }));
vi.mock('../../api/evaluations', () => ({ createEvaluationRun: vi.fn(), getEvaluationRun: vi.fn(), listEvaluationCases: vi.fn() }));
const target = { sessionId: 'session', knowledgeBaseId: 'kb', question: '原问题' };
const issue = { question: '原问题', status: 'open' as const, note: '', documentIds: [], evaluationCaseId: '', evaluationRunId: '', updatedAt: null };
beforeEach(() => { vi.resetAllMocks(); vi.mocked(getChatQualityIssue).mockResolvedValue(issue); vi.mocked(listEvaluationCases).mockResolvedValue({ items: [] }); vi.mocked(saveChatQualityIssue).mockImplementation(async (_, value) => ({ ...value, updatedAt: null })); });
it('saves notes before switching to a test question and stays when saving fails', async () => {
 const create = vi.fn(); vi.mocked(saveChatQualityIssue).mockRejectedValueOnce(new Error('保存失败')).mockResolvedValueOnce(issue);
 render(<MemoryRouter><QualityIssueDialog target={target} onClose={vi.fn()} onCreateCase={create} /></MemoryRouter>);
 fireEvent.change(await screen.findByLabelText('处理备注'), { target: { value: '补充了资料' } });
 fireEvent.click(screen.getByRole('button', { name: '保存为测试问题' })); await screen.findByRole('alert'); expect(create).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button', { name: '保存为测试问题' })); await waitFor(() => expect(create).toHaveBeenCalledOnce());
 expect(saveChatQualityIssue).toHaveBeenLastCalledWith('session', expect.objectContaining({ note: '补充了资料' }));
});
it('retries the same run config and requires manual resolution before reopening', async () => {
 vi.mocked(getChatQualityIssue).mockResolvedValue({ ...issue, evaluationCaseId: 'case' });
 vi.mocked(listEvaluationCases).mockResolvedValue({ items: [{ id: 'case', question: '原问题', sourceSessionId: 'session' } as EvaluationCase] });
 vi.mocked(getKnowledgeBase).mockResolvedValue({ retrievalConfig: { vectorTopN: 30, rerankTopK: 5, scoreThreshold: 0.3, enableRerank: true } } as KnowledgeBase);
 const run = { id: 'run', status: 'completed', results: [] } as unknown as EvaluationRun;
 vi.mocked(createEvaluationRun).mockRejectedValueOnce(new Error('未知')).mockResolvedValueOnce(run); vi.mocked(getEvaluationRun).mockResolvedValue(run);
 render(<MemoryRouter><QualityIssueDialog target={target} onClose={vi.fn()} onCreateCase={vi.fn()} /></MemoryRouter>);
 fireEvent.click(await screen.findByRole('button', { name: '按原范围复测' })); await screen.findByRole('alert');
 const first = vi.mocked(createEvaluationRun).mock.calls[0][1];
 fireEvent.click(screen.getByRole('button', { name: '按原范围复测' })); await waitFor(() => expect(saveChatQualityIssue).toHaveBeenCalled());
 expect(vi.mocked(createEvaluationRun).mock.calls[1][1]).toEqual(first); expect(getKnowledgeBase).toHaveBeenCalledOnce();
 expect(screen.getByLabelText('处理状态')).toHaveValue('retest');
 for (const status of ['resolved', 'open']) {
  fireEvent.change(screen.getByLabelText('处理状态'), { target: { value: status } }); fireEvent.click(screen.getByRole('button', { name: '保存处理记录' }));
  await waitFor(() => expect(saveChatQualityIssue).toHaveBeenLastCalledWith('session', expect.objectContaining({ status, evaluationRunId: 'run' })));
  await waitFor(() => expect(screen.getByRole('button', { name: '保存处理记录' })).toBeDisabled());
 }
});

it('starts a fresh retest after manually saving a previously unconfirmed run association', async () => {
 vi.mocked(getChatQualityIssue).mockResolvedValue({ ...issue, evaluationCaseId: 'case' });
 vi.mocked(getKnowledgeBase).mockResolvedValue({ retrievalConfig: { vectorTopN: 30, rerankTopK: 5, scoreThreshold: 0.3, enableRerank: true } } as KnowledgeBase);
 const run = { id: 'run', status: 'completed', results: [] } as unknown as EvaluationRun;
 vi.mocked(createEvaluationRun).mockResolvedValue(run); vi.mocked(getEvaluationRun).mockResolvedValue(run);
 vi.mocked(saveChatQualityIssue).mockRejectedValueOnce(new Error('关联未确认'));
 render(<MemoryRouter><QualityIssueDialog target={target} onClose={vi.fn()} onCreateCase={vi.fn()} /></MemoryRouter>);
 fireEvent.click(await screen.findByRole('button', { name: '按原范围复测' })); await screen.findByRole('alert');
 const first = vi.mocked(createEvaluationRun).mock.calls[0][1].clientRequestId;
 fireEvent.click(screen.getByRole('button', { name: '保存处理记录' }));
 await waitFor(() => expect(screen.getByRole('button', { name: '保存处理记录' })).toBeDisabled());
 fireEvent.click(screen.getByRole('button', { name: '按原范围复测' }));
 await waitFor(() => expect(createEvaluationRun).toHaveBeenCalledTimes(2));
 expect(vi.mocked(createEvaluationRun).mock.calls[1][1].clientRequestId).not.toBe(first);
});
