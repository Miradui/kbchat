import { Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { globalSearch } from '../../api/resources';
import { EmptyState } from '../../components/feedback/EmptyState';
import { ErrorState } from '../../components/feedback/ErrorState';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';
import { WorkspaceShell } from '../../components/WorkspaceShell';
import { Button } from '../../components/ui/Button';
import type { GlobalSearchResult, GlobalSearchResultType } from '../../types/api';
import { getErrorMessage } from '../../utils/errors';

type SearchType = 'all' | GlobalSearchResultType;

const SEARCH_DEBOUNCE_MS = 300;
const typeOptions: Array<{ value: SearchType; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'knowledgeBase', label: '知识库' },
  { value: 'document', label: '文档' },
  { value: 'chunk', label: '内容片段' },
];

function readType(value: string | null): SearchType {
  return typeOptions.some((option) => option.value === value) ? value as SearchType : 'all';
}

export function SearchPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const rawQuery = searchParams.get('q') ?? '';
  const submittedQuery = rawQuery.trim();
  const selectedType = readType(searchParams.get('type'));
  const [draft, setDraft] = useState(submittedQuery);
  const [items, setItems] = useState<GlobalSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => setDraft(submittedQuery), [submittedQuery]);

  useEffect(() => {
    if (!searchParams.has('q') || rawQuery === submittedQuery) {
      return;
    }
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      if (submittedQuery) {
        next.set('q', submittedQuery);
      } else {
        next.delete('q');
      }
      return next;
    }, { replace: true });
  }, [rawQuery, searchParams, setSearchParams, submittedQuery]);

  useEffect(() => {
    const query = draft.trim();
    if (query === submittedQuery) {
      return;
    }

    const timer = window.setTimeout(() => {
      setSearchParams((current) => updateParams(current, query, selectedType), { replace: true });
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [draft, selectedType, setSearchParams, submittedQuery]);

  useEffect(() => {
    if (!submittedQuery) {
      setItems([]);
      setError('');
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    setError('');
    void globalSearch(submittedQuery, controller.signal)
      .then((response) => {
        if (!controller.signal.aborted) {
          setItems(response.items);
        }
      })
      .catch((caught: unknown) => {
        const aborted = controller.signal.aborted
          || (caught instanceof DOMException && caught.name === 'AbortError');
        if (!aborted) {
          setError(getErrorMessage(caught, '全局搜索失败'));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      });

    return () => controller.abort();
  }, [reloadKey, submittedQuery]);

  const counts = useMemo(() => items.reduce<Record<SearchType, number>>((result, item) => {
    result.all += 1;
    result[item.type] += 1;
    return result;
  }, { all: 0, knowledgeBase: 0, document: 0, chunk: 0 }), [items]);
  const visibleItems = selectedType === 'all'
    ? items
    : items.filter((item) => item.type === selectedType);

  function writeParams(query: string, type: SearchType) {
    setSearchParams((current) => updateParams(current, query, type));
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    writeParams(draft.trim(), selectedType);
  }

  return (
    <WorkspaceShell active="search">
      <div className="search-page">
        <header className="page-header workspace-heading">
          <div>
            <h1>全局搜索</h1>
            <p className="page-description">搜索当前用户可访问的知识库、文档和内容片段。</p>
          </div>
        </header>

        <form className="search-command" onSubmit={handleSubmit}>
          <Search aria-hidden="true" />
          <label className="sr-only" htmlFor="global-search-query">搜索关键词</label>
          <input
            id="global-search-query"
            placeholder="输入知识库、文件名或内容关键词"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <Button type="submit">搜索</Button>
        </form>

        <div className="search-type-tabs" aria-label="结果类型" role="group">
          {typeOptions.map((option) => (
            <button
              aria-pressed={selectedType === option.value}
              className={selectedType === option.value ? 'is-active' : ''}
              key={option.value}
              onClick={() => writeParams(submittedQuery, option.value)}
              type="button"
            >
              {option.label} {counts[option.value]}
            </button>
          ))}
        </div>

        <section className="search-results" aria-labelledby="search-results-title">
          <header>
            <h2 id="search-results-title">搜索结果</h2>
            <span>{submittedQuery ? `关键词：${submittedQuery}` : '等待输入关键词'}</span>
          </header>
          {loading ? (
            <LoadingSkeleton announce rows={5} columns={3} />
          ) : error ? (
            <ErrorState title="搜索失败" description={error} onRetry={() => setReloadKey((value) => value + 1)} />
          ) : !submittedQuery ? (
            <EmptyState title="输入关键词开始搜索" description="可搜索知识库名称、文件名与内容片段。" />
          ) : visibleItems.length === 0 ? (
            <EmptyState title="没有匹配结果" description="尝试更短的关键词或切换结果类型。" />
          ) : (
            <div className="search-result-list">
              {visibleItems.map((item) => <SearchResult item={item} key={`${item.type}-${item.id}`} />)}
            </div>
          )}
        </section>
      </div>
    </WorkspaceShell>
  );
}

function updateParams(current: URLSearchParams, query: string, type: SearchType) {
  const next = new URLSearchParams(current);
  if (query) {
    next.set('q', query);
  } else {
    next.delete('q');
  }
  if (type === 'all') {
    next.delete('type');
  } else {
    next.set('type', type);
  }
  return next;
}

function SearchResult({ item }: { item: GlobalSearchResult }) {
  const href = item.type === 'knowledgeBase'
    ? `/knowledge-bases/${item.knowledgeBaseId}`
    : `/knowledge-bases/${item.knowledgeBaseId}/documents`;
  const label = item.type === 'knowledgeBase' ? '知识库' : item.type === 'document' ? '文档' : '内容片段';
  return (
    <Link className="search-result-row" to={href}>
      <span className="search-result-type">{label}</span>
      <span>
        <strong>{item.title}</strong>
        <small>{item.knowledgeBaseName}{item.filename ? ` · ${item.filename}` : ''}</small>
      </span>
      <p>{item.snippet || '暂无摘要'}</p>
    </Link>
  );
}
