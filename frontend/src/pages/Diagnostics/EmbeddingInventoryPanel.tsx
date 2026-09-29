import type { SystemEmbeddingStatus } from '../../types/api';
import { MetricStrip } from '../../components/ui/MetricStrip';

export function EmbeddingInventoryPanel({ value }: { value: SystemEmbeddingStatus }) {
  return <section aria-label="向量模型来源" className="ui-panel diagnostics-section">
    <h2>向量模型来源</h2>
    <p>当前模型：{value.model}；配置维度：{value.configuredDimension}；数据库维度：{value.columnDimension ?? '未知'}。</p>
    {value.status === 'down' || value.status === 'not_configured' ? <p role="status">暂时无法读取文档向量来源，请稍后刷新。</p> : <>
      <MetricStrip label="向量来源统计" metrics={[
        { key: 'total', label: '有效文档', value: value.totalDocuments },
        { key: 'unknown', label: '来源未知', value: value.unknownDocuments, tone: value.unknownDocuments ? 'warn' : 'default' },
        { key: 'mismatch', label: '模型或维度不一致', value: value.mismatchedDocuments, tone: value.mismatchedDocuments ? 'warn' : 'default' },
      ]} />
      {(value.unknownDocuments > 0 || value.mismatchedDocuments > 0) && <p className="ui-inline-notice">部分文档需要重新处理，以使用当前模型生成向量。</p>}
      <div className="ui-table-wrap"><table className="ui-table"><caption className="ui-visually-hidden">文档向量来源分组</caption>
        <thead><tr><th>模型</th><th>维度</th><th>文档数</th></tr></thead>
        <tbody>{value.groups.map((group) => <tr key={`${group.model ?? 'unknown'}:${group.dimension ?? 'unknown'}`}><td data-label="模型">{group.model || '未知'}</td><td data-label="维度">{group.dimension ?? '未知'}</td><td data-label="文档数">{group.count}</td></tr>)}</tbody>
      </table></div>
    </>}
  </section>;
}
