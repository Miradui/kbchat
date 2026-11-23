import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
import { getChatQualityIssue, getChatSession, getKnowledgeBase, saveChatQualityIssue } from '../../api/resources';
import { createEvaluationRun, getEvaluationRun, listEvaluationCases } from '../../api/evaluations';
import type { KnowledgeBase } from '../../types/api';
import type { EvaluationCase, EvaluationRun } from '../../types/evaluation';
import { QualityIssueDialog } from './QualityIssueDialog';

vi.mock('../../api/resources', () => ({ getChatQualityIssue: vi.fn(), getChatSession: vi.fn(), getKnowledgeBase: vi.fn(), listKnowledgeBases: vi.fn(), saveChatQualityIssue: vi.fn() }));
vi.mock('../../api/evaluations', () => ({ createEvaluationRun: vi.fn(), getEvaluationRun: vi.fn(), listEvaluationCases: vi.fn() }));
vi.mock('../../hooks/useKnowledgeBaseOptions', () => ({ useKnowledgeBaseOptions: () => ({ items: [], loading: false, error: '', reload: vi.fn() }) }));
const capabilities: KnowledgeBase['capabilities'] = ['content.write', 'quality.read', 'chat.use'];
const kb = { id: 'kb', name: '资料库', capabilities, retrievalConfig: { vectorTopN: 30, rerankTopK: 5, scoreThreshold: 0.3, enableRerank: true } } as KnowledgeBase;
const target = { sessionId: 'session', knowledgeBaseId: 'kb', question: '原问题' };
const issue = { question: '原问题', status: 'open' as const, note: '', documentIds: [], evaluationCaseId: '', evaluationRunId: '', updatedAt: null };
beforeEach(() => { vi.resetAllMocks(); vi.mocked(getChatSession).mockResolvedValue({ id: 'session', knowledgeBaseId: 'kb', scopeMode: 'manual' } as Awaited<ReturnType<typeof getChatSession>>); vi.mocked(getKnowledgeBase).mockResolvedValue(kb); vi.mocked(getChatQualityIssue).mockResolvedValue(issue); vi.mocked(listEvaluationCases).mockResolvedValue({ items: [] }); vi.mocked(saveChatQualityIssue).mockImplementation(async (_, value) => ({ ...value, updatedAt: null })); });
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
 vi.mocked(getKnowledgeBase).mockResolvedValue({ id: 'kb', name: '资料库', capabilities, retrievalConfig: { vectorTopN: 30, rerankTopK: 5, scoreThreshold: 0.3, enableRerank: true } } as KnowledgeBase);
 const run = { id: 'run', status: 'completed', results: [] } as unknown as EvaluationRun;
 vi.mocked(createEvaluationRun).mockRejectedValueOnce(new Error('未知')).mockResolvedValueOnce(run); vi.mocked(getEvaluationRun).mockResolvedValue(run);
 render(<MemoryRouter><QualityIssueDialog target={target} onClose={vi.fn()} onCreateCase={vi.fn()} /></MemoryRouter>);
 fireEvent.click(await screen.findByRole('button', { name: '按原范围复测' })); await screen.findByRole('alert');
 const first = vi.mocked(createEvaluationRun).mock.calls[0][1];
 fireEvent.click(screen.getByRole('button', { name: '按原范围复测' })); await waitFor(() => expect(saveChatQualityIssue).toHaveBeenCalled());
 expect(vi.mocked(createEvaluationRun).mock.calls[1][1]).toEqual(first); expect(getKnowledgeBase).toHaveBeenCalledTimes(2);
 expect(screen.getByLabelText('处理状态')).toHaveValue('retest');
 for (const status of ['resolved', 'open']) {
  fireEvent.change(screen.getByLabelText('处理状态'), { target: { value: status } }); fireEvent.click(screen.getByRole('button', { name: '保存处理记录' }));
  await waitFor(() => expect(saveChatQualityIssue).toHaveBeenLastCalledWith('session', expect.objectContaining({ status, evaluationRunId: 'run' })));
  await waitFor(() => expect(screen.getByRole('button', { name: '保存处理记录' })).toBeDisabled());
 }
});

it('starts a fresh retest after manually saving a previously unconfirmed run association', async () => {
 vi.mocked(getChatQualityIssue).mockResolvedValue({ ...issue, evaluationCaseId: 'case' });
 vi.mocked(getKnowledgeBase).mockResolvedValue({ id: 'kb', name: '资料库', capabilities, retrievalConfig: { vectorTopN: 30, rerankTopK: 5, scoreThreshold: 0.3, enableRerank: true } } as KnowledgeBase);
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

it('requires an explicit upload target for auto scope and links the exact answer', async () => {
 vi.mocked(getChatSession).mockResolvedValue({ id: 'session', knowledgeBaseId: 'kb', scopeMode: 'auto' } as Awaited<ReturnType<typeof getChatSession>>);
 render(<MemoryRouter><QualityIssueDialog target={{ ...target, messageId: 'answer/1' }} onClose={vi.fn()} onCreateCase={vi.fn()} /></MemoryRouter>);
 expect(await screen.findByLabelText('补资料目标库')).toHaveValue('');
 expect(screen.getByRole('button', { name: '去补充资料' })).toBeDisabled();
 expect(screen.getByRole('link', { name: '查看这条回答' })).toHaveAttribute('href', '/chat/session?messageId=answer%2F1');
 expect(screen.getByText(/同会话相同问题共用处理记录/)).toBeInTheDocument();
 expect(screen.getByText(/原范围：自动跨库检索/)).toBeInTheDocument();
});
it('allows viewer notes while hiding upload and evaluation actions', async () => {
 vi.mocked(getKnowledgeBase).mockResolvedValue({ ...kb, capabilities: ['chat.use'] });
 render(<MemoryRouter><QualityIssueDialog target={target} onClose={vi.fn()} onCreateCase={vi.fn()} /></MemoryRouter>);
 fireEvent.change(await screen.findByLabelText('处理备注'), { target: { value: '需要保险适用条件' } });
 expect(screen.queryByRole('button', { name: '去补充资料' })).not.toBeInTheDocument();
 expect(screen.queryByRole('button', { name: '保存为测试问题' })).not.toBeInTheDocument();
 fireEvent.click(screen.getByRole('button', { name: '保存处理记录' }));
 await waitFor(() => expect(saveChatQualityIssue).toHaveBeenCalledWith('session', expect.objectContaining({ note: '需要保险适用条件', status: 'open' })));
 expect(listEvaluationCases).not.toHaveBeenCalled();
});
it('excludes single-library tests from automatic session retesting', async () => {
 vi.mocked(getChatSession).mockResolvedValue({ id: 'session', knowledgeBaseId: 'kb', scopeMode: 'auto' } as Awaited<ReturnType<typeof getChatSession>>);
 vi.mocked(listEvaluationCases).mockResolvedValue({ items: [{ id: 'shared', question: target.question }, { id: 'private', question: target.question, sourceSessionId: 'session' }] as EvaluationCase[] });
 render(<MemoryRouter><QualityIssueDialog target={target} onClose={vi.fn()} onCreateCase={vi.fn()} /></MemoryRouter>);
 await screen.findByRole('option', { name: '原问题 · 来源会话范围' });
 expect(screen.queryByRole('option', { name: '原问题 · 单库范围' })).not.toBeInTheDocument();
});

it('keeps notes and the original scope when saving before upload fails', async () => {
 vi.mocked(getChatSession).mockResolvedValue({ id: 'session', knowledgeBaseId: 'kb', scopeMode: 'auto' } as Awaited<ReturnType<typeof getChatSession>>);
 vi.mocked(saveChatQualityIssue).mockRejectedValue(new Error('备注尚未保存'));
 const close = vi.fn();
 render(<MemoryRouter><QualityIssueDialog target={target} onClose={close} onCreateCase={vi.fn()} /></MemoryRouter>);
 fireEvent.change(await screen.findByLabelText('补资料目标库'), { target: { value: 'kb' } });
 fireEvent.change(screen.getByLabelText('处理备注'), { target: { value: '需要适用条件' } });
 fireEvent.click(screen.getByRole('button', { name: '去补充资料' }));
 await screen.findByText('处理记录保存失败');
 expect(close).not.toHaveBeenCalled();
 expect(screen.getByLabelText('处理备注')).toHaveValue('需要适用条件');
 expect(screen.getByText(/原范围：自动跨库检索/)).toBeInTheDocument();
 expect(getKnowledgeBase).toHaveBeenLastCalledWith('kb');
 expect(saveChatQualityIssue).toHaveBeenCalledWith('session', expect.objectContaining({ question: '原问题', note: '需要适用条件' }));
});
it('ignores a late save after switching to another answer', async () => {
 let finish: (value: typeof issue) => void = () => undefined;
 vi.mocked(saveChatQualityIssue).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
 const create = vi.fn();
 const view = render(<MemoryRouter><QualityIssueDialog target={{ ...target, messageId: 'first' }} onClose={vi.fn()} onCreateCase={create} /></MemoryRouter>);
 fireEvent.change(await screen.findByLabelText('处理备注'), { target: { value: '旧回答备注' } });
 fireEvent.click(screen.getByRole('button', { name: '保存为测试问题' }));
 view.rerender(<MemoryRouter><QualityIssueDialog target={{ ...target, messageId: 'second' }} onClose={vi.fn()} onCreateCase={create} /></MemoryRouter>);
 await screen.findByLabelText('处理备注');
 await act(async () => finish({ ...issue, note: '旧回答备注' }));
 expect(create).not.toHaveBeenCalled();
 expect(screen.getByLabelText('处理备注')).toHaveValue('');
 expect(screen.getByRole('link', { name: '查看这条回答' })).toHaveAttribute('href', '/chat/session?messageId=second');
});
