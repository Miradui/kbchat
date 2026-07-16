import type { KnowledgeBaseRerankFallback } from '../../types/api';

type RerankFallbackNoticeProps = {
  fallback: KnowledgeBaseRerankFallback | null;
};

export function RerankFallbackNotice({ fallback }: RerankFallbackNoticeProps) {
  if (!fallback?.used) {
    return null;
  }

  return (
    <div className="semantic-fallback-notice" role="status">
      <strong>Rerank 已降级</strong>
      <span>Rerank 服务暂不可用，本次结果按向量相关度返回。</span>
    </div>
  );
}
