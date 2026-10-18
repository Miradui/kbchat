import type { EvaluationCase } from '../../types/evaluation';

export function evaluationScopeKey(item?: EvaluationCase) { return JSON.stringify(item?.scope ?? null); }
export function evaluationScopeLabel(item?: EvaluationCase) {
  const scope = item?.scope;
  if (!scope) return '共享单库范围';
  if (scope.documents?.length) return `我的指定文档 · ${scope.documents.length} 份`;
  if (scope.scopeMode === 'auto') return '我的自动跨库范围';
  return scope.knowledgeBaseIds.length > 1 ? `我的固定多库 · ${scope.knowledgeBaseIds.length} 个库` : '我的单库会话范围';
}
export function firstScopeCases(items: EvaluationCase[], anchor = items[0]) {
  return items.filter((item) => evaluationScopeKey(item) === evaluationScopeKey(anchor)).slice(0, 20).map((item) => item.id);
}
