import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderWithRouter } from '../../test/render';
import type { AnswerConfig } from '../../types/api';
import type { EvaluationCase, EvaluationRun } from '../../types/evaluation';
import { configDifferences, EvaluationComparison } from './EvaluationComparison';

vi.mock('../../api/resources', () => ({ getCurrentUser: vi.fn().mockResolvedValue({ id: 'owner', username: 'owner' }) }));

const item: EvaluationCase = { id: 'case-1', knowledgeBaseId: 'kb1', question: '几天内可退货？', expectedAnswer: '7 天内', requiredKeywords: ['7'], requireCitation: true, createdAt: '', updatedAt: '' };

const baseAnswer: AnswerConfig = { systemPromptAddition: '', answerLanguage: 'auto', allowGeneralKnowledge: false, model: '', temperature: null };

function makeRun(id: string, name: string, overrides: Partial<EvaluationRun> = {}): EvaluationRun {
  return {
    id, knowledgeBaseId: 'kb1', clientRequestId: `request-${id}`, name, status: 'completed',
    config: { vectorTopN: 30, rerankTopK: 5, scoreThreshold: 0.3, enableRerank: true, enableKeyword: false },
    answerConfig: baseAnswer,
    cases: [item],
    results: [{ caseId: item.id, answer: '7 天内可退货。', answerStatus: 'answered', citations: [], rerankFallback: null, durationMs: 1100, rulePassed: true, missingKeywords: [], errorCode: '', errorMessage: '' }],
    runtime: { chatModel: 'gpt-4o-mini', effectiveRerank: true },
    total: 1, completedCount: 1, errorMessage: '', createdAt: '2026-09-10T00:00:00Z', startedAt: '2026-09-10T00:00:01Z', finishedAt: '2026-09-10T00:00:02Z',
    ...overrides,
  };
}

describe('EvaluationComparison', () => {
  it('shows the answer configuration of a run and the model that actually answered', () => {
    const longPrompt = '请务必用礼貌的语气回答，并且在回答末尾附上相关的政策链接，避免任何猜测性的内容，遇到无法确认的问题时请明确说明。';
    expect(longPrompt.length).toBeGreaterThan(40);
    const run = makeRun('run-2', '第二次运行', {
      answerConfig: { systemPromptAddition: longPrompt, answerLanguage: 'zh', allowGeneralKnowledge: true, model: 'gpt-4o', temperature: 0.2 },
    });
    renderWithRouter(<EvaluationComparison run={run} />);

    const summary = screen.getByRole('heading', { name: '第二次运行' }).closest('.evaluation-summary') as HTMLElement;
    expect(within(summary).getByText(/回答语言 中文 · 补充常识开 · 模型 gpt-4o · 温度 0.2/)).toBeInTheDocument();
    const preview = within(summary).getByText(/附加提示词：/);
    expect(preview).toHaveTextContent(`附加提示词：${longPrompt.slice(0, 40)}…`);
    expect(preview).toHaveAttribute('title', longPrompt);
    expect(within(summary).getByText(/实际模型 gpt-4o-mini/)).toBeInTheDocument();
    // Without a baseline there is nothing to diff against.
    expect(within(summary).queryByRole('list', { name: '配置差异' })).not.toBeInTheDocument();
    expect(screen.queryByText('配置差异（基准 → 本次）')).not.toBeInTheDocument();
  });

  it('falls back to the global default labels when the run has no overrides', () => {
    renderWithRouter(<EvaluationComparison run={makeRun('run-1', '首次运行')} />);
    expect(screen.getByText(/回答语言 自动 · 补充常识关 · 模型 全局默认 · 温度 默认 · 无附加提示词/)).toBeInTheDocument();
  });

  it('lists every answer and retrieval field that differs from the baseline', () => {
    const baseline = makeRun('run-1', '首次运行');
    const run = makeRun('run-2', '第二次运行', {
      config: { vectorTopN: 50, rerankTopK: 5, scoreThreshold: 0.3, enableRerank: false, enableKeyword: false },
      answerConfig: { systemPromptAddition: '只用中文回答', answerLanguage: 'zh', allowGeneralKnowledge: true, model: 'gpt-4o', temperature: 0.5 },
    });
    renderWithRouter(<EvaluationComparison run={run} baseline={baseline} />);

    // The diff belongs to the run being compared, not the baseline card.
    const runSummary = screen.getByRole('heading', { name: '第二次运行' }).closest('.evaluation-summary') as HTMLElement;
    const diff = within(runSummary).getByText('配置差异（基准 → 本次）').closest('dl') as HTMLElement;
    const lines = within(diff).getAllByRole('definition').map((node) => node.textContent);
    expect(lines).toEqual([
      '召回：30 → 50',
      '精排：开 → 关',
      '回答语言：自动 → 中文',
      '补充常识：关 → 开',
      '模型：全局默认 → gpt-4o',
      '温度：默认 → 0.5',
      '附加提示词：无 → 只用中文回答',
    ]);
    const baselineSummary = screen.getByRole('heading', { name: '首次运行' }).closest('.evaluation-summary') as HTMLElement;
    expect(within(baselineSummary).queryByText('配置差异（基准 → 本次）')).not.toBeInTheDocument();
  });

  it('renders no diff list when the baseline shares the same configuration', () => {
    const baseline = makeRun('run-1', '首次运行');
    const run = makeRun('run-2', '第二次运行');
    renderWithRouter(<EvaluationComparison run={run} baseline={baseline} />);
    expect(screen.queryByText('配置差异（基准 → 本次）')).not.toBeInTheDocument();
    expect(configDifferences(baseline, run)).toEqual([]);
  });

  it('treats a missing answerConfig on an older run as a difference only where values really differ', () => {
    const legacy = makeRun('run-0', '旧运行', { answerConfig: undefined as unknown as AnswerConfig });
    const run = makeRun('run-2', '第二次运行', { answerConfig: { ...baseAnswer, model: 'gpt-4o' } });
    const keys = configDifferences(legacy, run).map((diff) => diff.key);
    expect(keys).toContain('model');
    renderWithRouter(<EvaluationComparison run={legacy} />);
    expect(screen.getByText('未记录回答配置')).toBeInTheDocument();
  });
});
