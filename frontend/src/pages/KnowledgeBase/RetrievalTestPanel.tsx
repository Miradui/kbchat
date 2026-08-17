import { Search } from 'lucide-react';
import { useRef, useState } from 'react';
import type { FormEvent } from 'react';

import { searchKnowledgeBase } from '../../api/resources';
import { EmptyState } from '../../components/feedback/EmptyState';
import { RerankFallbackNotice } from '../../components/feedback/RerankFallbackNotice';
import { Button } from '../../components/ui/Button';
import { Checkbox, SearchInput } from '../../components/ui/Field';
import type {
  KnowledgeBase,
  KnowledgeBaseRerankFallback,
  KnowledgeBaseSearchDebug,
  KnowledgeBaseSearchResult,
} from '../../types/api';
import { formatNullableScore, formatScore } from '../../utils/format';
import { getErrorMessage } from '../../utils/errors';

const stageLabels: Record<KnowledgeBaseSearchDebug['rerankStage']['status'], string> = {
  completed: '已完成',
  disabled: '未启用',
  fallback: '已降级',
};

/** Runs a real retrieval against this knowledge base so config changes can be verified. */
export function RetrievalTestPanel({ knowledgeBase }: { knowledgeBase: KnowledgeBase }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<KnowledgeBaseSearchResult[]>([]);
  const [fallback, setFallback] = useState<KnowledgeBaseRerankFallback | null>(null);
  const [debugEnabled, setDebugEnabled] = useState(false);
  const [debug, setDebug] = useState<KnowledgeBaseSearchDebug | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');
  const [searched, setSearched] = useState(false);
  const requestRef = useRef(0);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = query.trim();
    if (!trimmed) return;

    const request = ++requestRef.current;
    setSearching(true);
    setError('');
    setFallback(null);
    setDebug(null);
    try {
      const response = await searchKnowledgeBase(knowledgeBase.id, {
        query: trimmed,
        vectorTopN: knowledgeBase.retrievalConfig.vectorTopN,
        rerankTopK: knowledgeBase.retrievalConfig.rerankTopK,
        enableRerank: knowledgeBase.retrievalConfig.enableRerank,
        debug: debugEnabled,
      });
      // A slower earlier request must not overwrite a newer one.
      if (requestRef.current !== request) return;
      setResults(response.items);
      setFallback(response.rerankFallback?.used ? response.rerankFallback : null);
      setDebug(response.debug ?? null);
      setSearched(true);
    } catch (caught) {
      if (requestRef.current !== request) return;
      setResults([]);
      setError(getErrorMessage(caught, '知识库内检索失败'));
    } finally {
      if (requestRef.current === request) setSearching(false);
    }
  }

  return (
    <section className="ui-panel">
      <div className="ui-panel__head">
        <h2>检索测试</h2>
        <span className="ui-panel__head-note">验证当前配置能否找到相关内容</span>
      </div>
      <div className="ui-panel__body">
        <div className="retrieval-test">
          <form className="retrieval-test__form" onSubmit={(event) => void submit(event)} role="search">
            <SearchInput
              aria-label="知识库内检索问题"
              icon={<Search aria-hidden="true" />}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="输入问题，测试召回的片段"
              value={query}
            />
            <Button disabled={!query.trim()} loading={searching} loadingLabel="检索中" type="submit">检索</Button>
            <label className="ui-switch-row">
              <Checkbox checked={debugEnabled} onChange={(event) => setDebugEnabled(event.target.checked)} />
              <span>显示调试信息</span>
            </label>
          </form>

          <RerankFallbackNotice fallback={fallback} />
          {error && <p className="ui-inline-error" role="alert">{error}</p>}
          {debugEnabled && debug && <DebugPanel debug={debug} />}

          {results.length === 0 ? (
            <EmptyState
              description={searched
                ? '当前配置下没有召回片段。可以降低最低相关度，或确认文档已完成处理。'
                : '输入一个真实问题，看看知识库会返回哪些片段。'}
              title={searched ? '没有召回结果' : '还没有检索'}
            />
          ) : (
            <div style={{ display: 'grid', gap: 'var(--s-2)' }}>
              {results.map((result) => (
                <article className="retrieval-result" key={result.chunkId}>
                  <header>
                    <strong>{result.filename}</strong>
                    <span>
                      相关度 {formatScore(result.vectorScore)} · 精排 {formatNullableScore(result.rerankScore)}
                    </span>
                  </header>
                  <p>{result.content}</p>
                  <small>{result.pageNumber ? `第 ${result.pageNumber} 页` : '无页码'}</small>
                </article>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

/** Renders the backend's debug payload verbatim; nothing here is inferred client side. */
function DebugPanel({ debug }: { debug: KnowledgeBaseSearchDebug }) {
  return (
    <section aria-label="检索调试信息" className="retrieval-debug">
      <div className="retrieval-debug__head">
        <div className="ui-cell-stack">
          <strong>检索调试</strong>
          <small>查询：{debug.rewrittenQuery || debug.query}</small>
        </div>
        <span className="ui-badge ui-badge--neutral">{stageLabels[debug.rerankStage.status]}</span>
      </div>

      <div className="retrieval-debug__grid">
        <section>
          <h3>向量召回 ({debug.vectorStage.items.length})</h3>
          {debug.vectorStage.items.length === 0 ? (
            <p className="ui-field__hint">无候选片段</p>
          ) : (
            <ol>
              {debug.vectorStage.items.map((item) => (
                <li key={item.chunkId}>
                  <strong>#{item.rank} {item.filename}</strong>
                  <span>向量分 {formatScore(item.vectorScore)}{item.pageNumber !== null ? ` · 第 ${item.pageNumber} 页` : ''}</span>
                  <p>{item.content}</p>
                </li>
              ))}
            </ol>
          )}
        </section>

        <section>
          <h3>精排 ({stageLabels[debug.rerankStage.status]})</h3>
          <p className="ui-field__hint">输入 {debug.rerankStage.input.length} 条</p>
          {debug.rerankStage.output.length > 0 && (
            <ol>
              {debug.rerankStage.output.map((item) => (
                <li key={item.chunkId}>
                  <strong>#{item.rank}</strong>
                  <span>
                    精排分 {item.rerankScore === null ? '无' : formatScore(item.rerankScore)}
                    {item.pageNumber !== null ? ` · 第 ${item.pageNumber} 页` : ''}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </section>

        <section>
          <h3>最终结果 ({debug.finalStage.items.length})</h3>
          {debug.finalStage.items.length === 0 ? (
            <p className="ui-field__hint">阈值过滤后没有可用片段</p>
          ) : (
            <ol>
              {debug.finalStage.items.map((item) => (
                <li key={item.chunkId}>
                  <strong>#{item.rank}</strong>
                  <span>
                    向量 {formatScore(item.vectorScore)} · 精排 {item.rerankScore === null ? '无' : formatScore(item.rerankScore)}
                    {item.pageNumber !== null ? ` · 第 ${item.pageNumber} 页` : ''}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </section>
  );
}
