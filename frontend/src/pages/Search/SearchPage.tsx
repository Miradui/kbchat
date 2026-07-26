import { Search } from 'lucide-react';
import { useEffect, useState } from 'react';
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
const DEFAULT_PAGE_SIZE = 20;
const typeOptions: Array<{ value: SearchType; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'knowledgeBase', label: '知识库' },
  { value: 'document', label: '文档' },
  { value: 'chunk', label: '内容片段' },
];

function readType(value: string | null): SearchType {
  return typeOptions.some((option) => option.value === value) ? value as SearchType : 'all';
}

function readPositiveInteger(value: string | null, fallback: number, maximum?: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  return maximum ? Math.min(parsed, maximum) : parsed;
}

export function SearchPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const rawQuery = searchParams.get('q') ?? '';
  const submittedQuery = rawQuery.trim();
  const selectedType = readType(searchParams.get('type'));
  const selectedPage = readPositiveInteger(searchParams.get('page'), 1);
  const selectedPageSize = readPositiveInteger(searchParams.get('pageSize'), DEFAULT_PAGE_SIZE, 100);
  const [draft, setDraft] = useState(submittedQuery);
  const [items, setItems] = useState<GlobalSearchResult[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => setDraft(submittedQuery), [submittedQuery]);

  useEffect(() => {
    const normalizedType = selectedType === 'all' ? null : selectedType;
    const normalizedPage = selectedPage === 1 ? null : String(selectedPage);
    const normalizedPageSize = selectedPageSize === DEFAULT_PAGE_SIZE ? null : String(selectedPageSize);
    if (
      (!searchParams.has('q') || rawQuery === submittedQuery)
      && searchParams.get('type') === normalizedType
      && searchParams.get('page') === normalizedPage
      && searchParams.get('pageSize') === normalizedPageSize
    ) {
      return;
    }
    setSearchParams((current) => (
      updateParams(current, submittedQuery, selectedType, selectedPage, selectedPageSize)
    ), { replace: true });
  }, [rawQuery, searchParams, selectedPage, selectedPageSize, selectedType, setSearchParams, submittedQuery]);

  useEffect(() => {
    const query = draft.trim();
    if (query === submittedQuery) {
      return;
    }

    const timer = window.setTimeout(() => {
      setSearchParams((current) => (
        updateParams(current, query, selectedType, 1, selectedPageSize)
      ), { replace: true });
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [draft, selectedPageSize, selectedType, setSearchParams, submittedQuery]);

  useEffect(() => {
    if (!submittedQuery) {
      setItems([]);
      setTotal(0);
      setError('');
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    setError('');
    void globalSearch({
      query: submittedQuery,
      type: selectedType,
      page: selectedPage,
      pageSize: selectedPageSize,
    }, controller.signal)
      .then((response) => {
        if (!controller.signal.aborted) {
          setItems(response.items);
          setTotal(response.total);
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
  }, [reloadKey, selectedPage, selectedPageSize, selectedType, submittedQuery]);

  const totalPages = Math.max(1, Math.ceil(total / selectedPageSize));
  const resultStatus = loading
    ? '正在搜索'
    : error || !submittedQuery
      ? ''
      : items.length === 0
        ? '没有匹配结果'
        : `找到 ${total} 条结果`;

  function writeParams(query: string, type: SearchType, page = 1) {
    setSearchParams((current) => updateParams(current, query, type, page, selectedPageSize));
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    writeParams(draft.trim(), selectedType, 1);
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
              onClick={() => writeParams(submittedQuery, option.value, 1)}
              type="button"
            >
              {option.label}
            </button>
          ))}
        </div>

        <section aria-busy={loading} className="search-results" aria-labelledby="search-results-title">
          <header>
            <h2 id="search-results-title">搜索结果</h2>
            <span>{submittedQuery ? `关键词：${submittedQuery}` : '等待输入关键词'}</span>
          </header>
          <p
            aria-atomic="true"
            aria-label={loading ? '正在加载' : '搜索状态'}
            className="sr-only"
            role="status"
          >
            {resultStatus}
          </p>
          {loading ? (
            <LoadingSkeleton rows={5} columns={3} />
          ) : error ? (
            <ErrorState title="搜索失败" description={error} onRetry={() => setReloadKey((value) => value + 1)} />
          ) : !submittedQuery ? (
            <EmptyState title="输入关键词开始搜索" description="可搜索知识库名称、文件名与内容片段。" />
          ) : items.length === 0 ? (
            <EmptyState title="没有匹配结果" description="尝试更短的关键词或切换结果类型。" />
          ) : (
            <div className="search-result-list">
              {items.map((item) => <SearchResult item={item} key={`${item.type}-${item.id}`} />)}
            </div>
          )}
          {!loading && !error && submittedQuery && total > 0 && (
            <nav aria-label="搜索结果分页" className="workspace-pagination">
              <Button
                variant="secondary"
                disabled={selectedPage <= 1}
                onClick={() => writeParams(submittedQuery, selectedType, selectedPage - 1)}
              >
                上一页
              </Button>
              <span>第 {selectedPage} / {totalPages} 页 · 共 {total} 条</span>
              <Button
                variant="secondary"
                disabled={selectedPage >= totalPages}
                onClick={() => writeParams(submittedQuery, selectedType, selectedPage + 1)}
              >
                下一页
              </Button>
            </nav>
          )}
        </section>
      </div>
    </WorkspaceShell>
  );
}

function updateParams(
  current: URLSearchParams,
  query: string,
  type: SearchType,
  page = 1,
  pageSize = DEFAULT_PAGE_SIZE,
) {
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
  if (page <= 1) {
    next.delete('page');
  } else {
    next.set('page', String(page));
  }
  if (pageSize === DEFAULT_PAGE_SIZE) {
    next.delete('pageSize');
  } else {
    next.set('pageSize', String(pageSize));
  }
  return next;
}

function SearchResult({ item }: { item: GlobalSearchResult }) {
  const href = searchResultHref(item);
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

function searchResultHref(item: GlobalSearchResult): string {
  if (item.type === 'knowledgeBase') {
    return `/knowledge-bases/${item.knowledgeBaseId}`;
  }

  const params = new URLSearchParams();
  const documentId = item.documentId ?? (item.type === 'document' ? item.id : '');
  if (documentId) {
    params.set('documentId', documentId);
  }
  if (item.type === 'chunk') {
    params.set('chunkId', item.id);
  }

  const query = params.toString();
  const documentsPath = `/knowledge-bases/${item.knowledgeBaseId}/documents`;
  return query ? `${documentsPath}?${query}` : documentsPath;
}
