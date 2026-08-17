import type { BadgeTone } from '../../components/ui/Badge';
import type { KnowledgeBase } from '../../types/api';

export type KnowledgeBaseReadiness = {
  detail: string;
  label: '存在失败' | '处理中' | '可问答' | '暂无文档';
  tone: BadgeTone;
};

export function getKnowledgeBaseReadiness(item: KnowledgeBase): KnowledgeBaseReadiness {
  const failed = item.failedDocumentCount ?? 0;
  const processing = item.processingDocumentCount ?? 0;
  const completed = item.completedDocumentCount ?? 0;
  const total = item.documentCount ?? failed + processing + completed;

  if (failed > 0) {
    return { detail: `${failed} 个文档处理失败`, label: '存在失败', tone: 'danger' };
  }
  // An older backend without the aggregate counts still reports documentCount,
  // so a non-zero total with no completions is treated conservatively.
  if (processing > 0 || (total > 0 && completed === 0)) {
    return {
      detail: `${Math.max(processing, total - completed)} 个文档处理中`,
      label: '处理中',
      tone: 'warn',
    };
  }
  if (completed > 0) {
    return { detail: `${completed} 个文档可用于问答`, label: '可问答', tone: 'ok' };
  }
  return { detail: '导入文档后即可提问', label: '暂无文档', tone: 'neutral' };
}
