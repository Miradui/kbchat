import { TriangleAlert } from 'lucide-react';

import type { KnowledgeBaseRerankFallback } from '../../types/api';

type RerankFallbackNoticeProps = {
  fallback: KnowledgeBaseRerankFallback | null;
};

/** Surfaces a real backend fallback. Never inferred client side. */
export function RerankFallbackNotice({ fallback }: RerankFallbackNoticeProps) {
  if (!fallback?.used) return null;

  return (
    <div className="ui-inline-notice" role="status">
      <TriangleAlert aria-hidden="true" size={14} />
      <span>精排服务暂不可用，本次结果按向量相关度排序。</span>
    </div>
  );
}
