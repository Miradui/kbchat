import type { DocumentStatus } from '../../types/api';

import { isTerminalDocumentStatus } from './documentDisplay';

/**
 * What to tell the user once the documents they just imported stop processing.
 *
 * Kept out of the page component because the interesting part is the timing
 * rules, and those are worth testing without a router and a list around them.
 */
export type ImportGuidance = {
  completed: number;
  failed: number;
  /** True when at least one document finished, so asking questions can work. */
  canAsk: boolean;
};

export type GuidanceDocument = {
  id: string;
  status: DocumentStatus;
};

/**
 * Guidance for a batch, or null while it is still running.
 *
 * Returns null until every watched document reaches a terminal status: a partly
 * finished batch would prompt the user to start asking while chunks for the rest
 * are still being written, and the first answer would silently miss them.
 *
 * Documents that have dropped out of the list entirely (filtered away, deleted,
 * or on another page) are treated as still pending rather than as finished. The
 * alternative is claiming a batch completed when the page simply cannot see it.
 */
export function importGuidance(
  watchedIds: readonly string[],
  documents: readonly GuidanceDocument[],
): ImportGuidance | null {
  if (watchedIds.length === 0) return null;

  const byId = new Map(documents.map((document) => [document.id, document.status]));
  let completed = 0;
  let failed = 0;
  for (const id of watchedIds) {
    const status = byId.get(id);
    if (status === undefined || !isTerminalDocumentStatus(status)) return null;
    if (status === 'completed') completed += 1;
    else failed += 1;
  }

  return { canAsk: completed > 0, completed, failed };
}

/**
 * The banner copy. Failures are named rather than folded into a count, because
 * "3 个已完成" next to a silent failure reads as though everything worked.
 */
export function importGuidanceMessage(guidance: ImportGuidance): string {
  if (guidance.completed === 0) {
    return guidance.failed === 1
      ? '文档处理失败，暂时还不能基于它提问。'
      : `${guidance.failed} 个文档处理失败，暂时还不能基于它们提问。`;
  }
  const done = `${guidance.completed} 个文档已处理完成，可以开始提问了。`;
  return guidance.failed > 0 ? `${done}另有 ${guidance.failed} 个处理失败，可在列表中查看原因。` : done;
}
