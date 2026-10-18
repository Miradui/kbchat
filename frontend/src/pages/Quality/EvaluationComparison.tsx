import { Link } from 'react-router-dom';
import { evaluationScopeLabel } from './evaluationScope';

import { Badge } from '../../components/ui/Badge';
import type { AnswerConfig, RetrievalConfig } from '../../types/api';
import type { EvaluationCase, EvaluationResult, EvaluationRun } from '../../types/evaluation';
import { formatDateTime } from '../../utils/format';
import { ChatMarkdown } from '../Chat/ChatMarkdown';

export const evaluationStatusLabels: Record<EvaluationRun['status'], string> = { queued: '等待执行', running: '评测中', completed: '已完成', failed: '运行中断', cancelled: '已取消' };
export const isEvaluationActive = (run: EvaluationRun) => run.status === 'queued' || run.status === 'running';

function signature(item: EvaluationCase) {
  return JSON.stringify([item.question, item.expectedAnswer, [...item.requiredKeywords].sort(), item.requireCitation]);
}

export function comparisonCases(run: EvaluationRun, baseline?: EvaluationRun | null): EvaluationCase[] {
  const cases = run.cases || [];
  if (!baseline) return cases;
  const base = new Map(baseline.cases?.map((item) => [item.id, signature(item)]));
  return cases.filter((item) => base.get(item.id) === signature(item));
}

const answerLanguageLabels: Record<AnswerConfig['answerLanguage'], string> = { auto: '自动', zh: '中文', en: 'English' };
const PROMPT_PREVIEW_LENGTH = 40;

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function languageLabel(value: AnswerConfig['answerLanguage'] | undefined): string {
  return value ? answerLanguageLabels[value] ?? value : '自动';
}

type ConfigField = { key: string; label: string; read: (run: EvaluationRun) => string };

/**
 * Every field that can change between two runs, rendered as text so the diff
 * list reads the same way the summary lines do. Retrieval fields come first
 * because they are what the run form lets a user change.
 */
const CONFIG_FIELDS: ConfigField[] = [
  { key: 'vectorTopN', label: '召回', read: (run) => String(run.config.vectorTopN) },
  { key: 'rerankTopK', label: '精排保留', read: (run) => String(run.config.rerankTopK) },
  { key: 'scoreThreshold', label: '阈值', read: (run) => String(run.config.scoreThreshold) },
  { key: 'enableRerank', label: '精排', read: (run) => (run.config.enableRerank ? '开' : '关') },
  { key: 'enableKeyword', label: '关键词召回', read: (run) => (run.config.enableKeyword ? '开' : '关') },
  { key: 'answerLanguage', label: '回答语言', read: (run) => languageLabel(run.answerConfig?.answerLanguage) },
  { key: 'allowGeneralKnowledge', label: '补充常识', read: (run) => (run.answerConfig?.allowGeneralKnowledge ? '开' : '关') },
  { key: 'model', label: '模型', read: (run) => run.answerConfig?.model || '全局默认' },
  { key: 'temperature', label: '温度', read: (run) => String(run.answerConfig?.temperature ?? '默认') },
  { key: 'systemPromptAddition', label: '附加提示词', read: (run) => (run.answerConfig?.systemPromptAddition ? truncate(run.answerConfig.systemPromptAddition, PROMPT_PREVIEW_LENGTH) : '无') },
];

/**
 * The raw value decides whether two runs differ; the label only describes the
 * change. Comparing labels would hide a prompt edit past the preview length.
 * Older runs recorded before answer settings were captured have no
 * `answerConfig`, so every answer field is read defensively.
 */
function rawConfigValue(run: EvaluationRun, key: string): unknown {
  if (key in run.config) return run.config[key as keyof RetrievalConfig];
  const answer: AnswerConfig | undefined = run.answerConfig;
  if (!answer) return undefined;
  if (key === 'temperature') return answer.temperature ?? null;
  if (key === 'model') return answer.model || '';
  if (key === 'systemPromptAddition') return answer.systemPromptAddition || '';
  return answer[key as keyof AnswerConfig];
}

export type ConfigDifference = { key: string; label: string; from: string; to: string };

export function configDifferences(baseline: EvaluationRun, run: EvaluationRun): ConfigDifference[] {
  return CONFIG_FIELDS
    .filter((field) => rawConfigValue(baseline, field.key) !== rawConfigValue(run, field.key))
    .map((field) => ({ key: field.key, label: field.label, from: field.read(baseline), to: field.read(run) }));
}

function AnswerConfigLine({ run }: { run: EvaluationRun }) {
  const answer: AnswerConfig | undefined = run.answerConfig;
  if (!answer) return <p>未记录回答配置</p>;
  const prompt = answer.systemPromptAddition?.trim() ?? '';
  return <p className="evaluation-summary__answer">
    回答语言 {languageLabel(answer.answerLanguage)} · 补充常识{answer.allowGeneralKnowledge ? '开' : '关'} · 模型 {answer.model || '全局默认'} · 温度 {answer.temperature ?? '默认'}
    {' · '}
    {prompt ? <span title={prompt}>附加提示词：{truncate(prompt, PROMPT_PREVIEW_LENGTH)}</span> : '无附加提示词'}
  </p>;
}

function Summary({ run, ids, baseline }: { run: EvaluationRun; ids: Set<string>; baseline?: EvaluationRun | null }) {
  const results = (run.results || []).filter((result) => ids.has(result.caseId));
  const scored = results.filter((result) => result.rulePassed !== null && !result.errorCode);
  const passed = scored.filter((result) => result.rulePassed).length;
  const successful = results.filter((result) => !result.errorCode);
  const citationCount = successful.filter((result) => result.citations.length > 0).length;
  const average = successful.length ? successful.reduce((sum, result) => sum + result.durationMs, 0) / successful.length : null;
  const differences = baseline ? configDifferences(baseline, run) : [];
  return <div className="evaluation-summary">
    <h3>{run.name}</h3><p>{formatDateTime(run.createdAt)} · {evaluationStatusLabels[run.status]}</p>
    <p>{evaluationScopeLabel(run.cases?.[0])}</p>
    <dl>
      <div><dt>规则通过</dt><dd>{scored.length ? `${passed} / ${scored.length}` : '暂无可评分结果'}</dd></div>
      <div><dt>含引用的回答</dt><dd>{successful.length ? `${citationCount} / ${successful.length}` : '—'}</dd></div>
      <div><dt>调用失败</dt><dd>{results.filter((result) => result.errorCode).length}</dd></div>
      <div><dt>平均耗时</dt><dd>{average === null ? '—' : `${(average / 1000).toFixed(2)} 秒`}</dd></div>
    </dl>
    <p>召回 {run.config.vectorTopN} · 精排保留 {run.config.rerankTopK} · 阈值 {run.config.scoreThreshold} · 关键词召回{run.config.enableKeyword ? '开' : '关'}</p>
    <AnswerConfigLine run={run} />
    <p>{run.startedAt ? `精排${run.runtime.effectiveRerank ? '已启用' : '未启用'} · 实际模型 ${run.runtime.chatModel || '未记录'}` : '等待记录实际模型配置'}</p>
    {run.config.enableRerank && run.startedAt && !run.runtime.effectiveRerank && <p>本次请求了精排，运行环境未启用精排服务。</p>}
    {differences.length > 0 && <dl aria-label="配置差异" className="evaluation-summary__diff">
      <dt>配置差异（基准 → 本次）</dt>
      {differences.map((diff) => <dd key={diff.key}>{diff.label}：{diff.from} → {diff.to}</dd>)}
    </dl>}
    {run.errorMessage && <p className="ui-inline-error">{run.errorMessage}</p>}
  </div>;
}

export function EvaluationComparison({ run, baseline }: { run: EvaluationRun; baseline?: EvaluationRun | null }) {
  const cases = comparisonCases(run, baseline);
  const ids = new Set(cases.map((item) => item.id));
  const results = new Map(run.results?.map((item) => [item.caseId, item]));
  const baseResults = new Map(baseline?.results?.map((item) => [item.caseId, item]));
  return <section aria-label="评测结果对比" className="evaluation-comparison">
    <p className="ui-muted">{baseline ? `两次运行有 ${cases.length} 道相同问题与规则，以下指标仅统计这些共同样本。` : `本次运行共 ${cases.length} 道题。`} 规则通过表示满足关键词和引用要求，回答内容仍需对照参考答案核查。</p>
    <div className={`evaluation-comparison__grid${baseline ? ' has-baseline' : ''}`}>
      {baseline && <Summary run={baseline} ids={ids} />}<Summary baseline={baseline} run={run} ids={ids} />
    </div>
    {!cases.length && <p>没有可以比较的共同测试问题。请选择使用相同题目与规则的运行。</p>}
    {cases.map((item) => <article className="evaluation-result" key={item.id} aria-label={`评测问题：${item.question}`}>
      <h3>{item.question}</h3>
      {item.expectedAnswer && <p className="evaluation-result__reference"><strong>参考答案：</strong>{item.expectedAnswer}</p>}
      <p className="ui-muted">{item.requireCitation ? '要求引用' : '不要求引用'}{item.requiredKeywords.length > 0 ? ` · 必须包含：${item.requiredKeywords.join('、')}` : ' · 未设置关键词'}</p>
      <div className={`evaluation-comparison__grid${baseline ? ' has-baseline' : ''}`}>
        {baseline && <Result name={baseline.name} result={baseResults.get(item.id)} run={baseline} />}
        <Result name={run.name} result={results.get(item.id)} run={run} />
      </div>
    </article>)}
  </section>;
}

function Result({ name, result, run }: { name: string; result?: EvaluationResult; run: EvaluationRun }) {
  if (!result) return <div className="evaluation-answer"><strong>{name}</strong><p className="ui-muted">{isEvaluationActive(run) ? '等待本题结果' : '本题未执行'}</p></div>;
  const label = result.errorCode ? '调用失败' : result.rulePassed === null ? '待人工核对' : result.rulePassed ? '规则通过' : '规则未通过';
  return <div className="evaluation-answer">
    <div className="evaluation-answer__head"><strong>{name}</strong><Badge tone={result.errorCode ? 'danger' : result.rulePassed === false ? 'warn' : 'neutral'}>{label}</Badge></div>
    {result.errorCode ? <p className="ui-inline-error">{result.errorMessage}</p> : <>
      {result.missingKeywords.length > 0 && <p>未包含：{result.missingKeywords.join('、')}</p>}
      <small>{result.citations.length} 条引用 · {(result.durationMs / 1000).toFixed(2)} 秒{result.rerankFallback?.used ? ' · 精排降级' : ''}</small>
      <details><summary>查看回答和来源</summary>
        <ChatMarkdown content={result.answer} />
        {result.citations.map((citation, index) => <Link key={`${citation.chunkId}-${index}`} className="evaluation-answer__source" to={`/knowledge-bases/${encodeURIComponent(run.knowledgeBaseId)}/documents?documentId=${encodeURIComponent(citation.documentId)}&chunkId=${encodeURIComponent(citation.chunkId)}`}>
          来源 {index + 1}：{citation.filename}{citation.pageNumber ? ` · 第 ${citation.pageNumber} 页` : ''}
        </Link>)}
      </details>
    </>}
  </div>;
}
