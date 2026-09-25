import { Search } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
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

const keywordStageLabels: Record<KnowledgeBaseSearchDebug['keywordStage']['status'], string> = {
  completed: '已完成',
  disabled: '未启用',
  failed: '已降级',
};

const fusionStageLabels: Record<KnowledgeBaseSearchDebug['fusionStage']['status'], string> = {
  completed: '已融合',
  skipped: '未融合',
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
  const searchingRef = useRef(false);

  useEffect(() => {
    requestRef.current++;
    searchingRef.current = false;
    setQuery('');
    setResults([]);
    setFallback(null);
    setDebug(null);
    setSearching(false);
    setError('');
    setSearched(false);
    return () => { requestRef.current++; };
  }, [knowledgeBase.id]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = query.trim();
    if (!trimmed || searchingRef.current) return;

    const request = ++requestRef.current;
    searchingRef.current = true;
    setSearching(true);
    setResults([]);
    setError('');
    setFallback(null);
    setDebug(null);
    try {
      const response = await searchKnowledgeBase(knowledgeBase.id, {
        query: trimmed,
        vectorTopN: knowledgeBase.retrievalConfig.vectorTopN,
        rerankTopK: knowledgeBase.retrievalConfig.rerankTopK,
        enableRerank: knowledgeBase.retrievalConfig.enableRerank,
        enableKeyword: knowledgeBase.retrievalConfig.enableKeyword,
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
      if (requestRef.current === request) {
        searchingRef.current = false;
        setSearching(false);
      }
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
          <p className={searching ? 'ui-muted' : 'sr-only'} role="status">{searching ? '正在检索相关片段…' : ''}</p>
          {error && <p className="ui-inline-error" role="alert">{error}</p>}
          {debugEnabled && debug && <DebugPanel debug={debug} />}

          {!searching && !error && (results.length === 0 ? (
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
                      相关度 {formatScore(result.vectorScore)}
                      {result.keywordScore != null ? ` · 关键词 ${formatScore(result.keywordScore)}` : ''}
                      {' '}· 精排 {formatNullableScore(result.rerankScore)}
                    </span>
                  </header>
                  <p>{result.content}</p>
                  <small>{result.pageNumber ? `第 ${result.pageNumber} 页` : '无页码'}</small>
                </article>
              ))}
            </div>
          ))}
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
          <h3>关键词召回 ({keywordStageLabels[debug.keywordStage.status]}{debug.keywordStage.status === 'completed' ? ` · ${debug.keywordStage.items.length}` : ''})</h3>
          {debug.keywordStage.status === 'disabled' ? (
            <p className="ui-field__hint">该知识库未启用关键词召回</p>
          ) : debug.keywordStage.status === 'failed' ? (
            <p className="ui-field__hint">关键词召回执行失败，本次已按纯向量召回返回；请检查迁移 024 与关键词索引</p>
          ) : debug.keywordStage.items.length === 0 ? (
            <p className="ui-field__hint">没有片段命中查询词元</p>
          ) : (
            <ol>
              {debug.keywordStage.items.map((item) => (
                <li key={item.chunkId}>
                  <strong>#{item.rank} {item.filename}</strong>
                  <span>关键词分 {formatScore(item.keywordScore)}{item.pageNumber !== null ? ` · 第 ${item.pageNumber} 页` : ''}</span>
                  <p>{item.content}</p>
                </li>
              ))}
            </ol>
          )}
        </section>

        <section>
          <h3>融合 ({fusionStageLabels[debug.fusionStage.status]} · {debug.fusionStage.items.length})</h3>
          {debug.fusionStage.status === 'skipped' ? (
            <p className="ui-field__hint">未启用关键词召回，精排输入即向量召回结果</p>
          ) : debug.fusionStage.items.length === 0 ? (
            <p className="ui-field__hint">无候选片段</p>
          ) : (
            <ol>
              {debug.fusionStage.items.map((item) => (
                <li key={item.chunkId}>
                  <strong>#{item.rank}</strong>
                  <span>
                    融合分 {formatScore(item.fusionScore)}
                    {` · 向量第 ${item.vectorRank ?? '—'} · 关键词第 ${item.keywordRank ?? '—'}`}
                    {item.pageNumber !== null ? ` · 第 ${item.pageNumber} 页` : ''}
                  </span>
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
                    向量 {formatScore(item.vectorScore)}
                    {item.keywordScore != null ? ` · 关键词 ${formatScore(item.keywordScore)}` : ''}
                    {item.fusionScore != null ? ` · 融合 ${formatScore(item.fusionScore)}` : ''}
                    {' '}· 精排 {item.rerankScore === null ? '无' : formatScore(item.rerankScore)}
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
