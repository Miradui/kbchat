import { Download, FileText, Library, TextQuote } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';

import { exportGlobalSearch, globalSearch } from '../../api/resources';
import { EmptyState } from '../../components/feedback/EmptyState';
import { ErrorState } from '../../components/feedback/ErrorState';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';
import { Button } from '../../components/ui/Button';
import { Pagination } from '../../components/ui/Pagination';
import { AppShell } from '../../layouts/AppShell';
import { SearchCombobox, suggestionHref } from './SearchCombobox';
import type { GlobalSearchResult, GlobalSearchResultType, SearchHighlight } from '../../types/api';
import { downloadBlob } from '../../utils/download';
import { getErrorMessage } from '../../utils/errors';

type SearchType = 'all' | GlobalSearchResultType;

const DEBOUNCE_MS = 300;
const DEFAULT_PAGE_SIZE = 20;

const typeOptions: Array<{ value: SearchType; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'knowledgeBase', label: '知识库' },
  { value: 'document', label: '文档' },
  { value: 'chunk', label: '内容片段' },
];

const typeLabels: Record<GlobalSearchResultType, string> = {
  knowledgeBase: '知识库',
  document: '文档',
  chunk: '内容片段',
};

function readType(value: string | null): SearchType {
  return typeOptions.some((option) => option.value === value) ? (value as SearchType) : 'all';
}

function readPositive(value: string | null, fallback: number, max?: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return max ? Math.min(parsed, max) : parsed;
}

export function SearchPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const rawQuery = searchParams.get('q') ?? '';
  const submittedQuery = rawQuery.trim();
  const selectedType = readType(searchParams.get('type'));
  const selectedPage = readPositive(searchParams.get('page'), 1);
  const selectedPageSize = readPositive(searchParams.get('pageSize'), DEFAULT_PAGE_SIZE, 100);
  const [draft, setDraft] = useState(submittedQuery);
  const [items, setItems] = useState<GlobalSearchResult[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [exportError, setExportError] = useState('');
  const [exporting, setExporting] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => setDraft(submittedQuery), [submittedQuery]);

  useEffect(() => setExportError(''), [selectedType, submittedQuery]);

  // Normalise the URL so defaults never linger as explicit parameters.
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
    setSearchParams(
      (current) => updateParams(current, submittedQuery, selectedType, selectedPage, selectedPageSize),
      { replace: true },
    );
  }, [rawQuery, searchParams, selectedPage, selectedPageSize, selectedType, setSearchParams, submittedQuery]);

  useEffect(() => {
    const query = draft.trim();
    if (query === submittedQuery) return;
    const timer = window.setTimeout(() => {
      setSearchParams(
        (current) => updateParams(current, query, selectedType, 1, selectedPageSize),
        { replace: true },
      );
    }, DEBOUNCE_MS);
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

    // Aborting stops a slower earlier query from overwriting newer results.
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
        if (!aborted) setError(getErrorMessage(caught, '全局搜索失败'));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [reloadKey, selectedPage, selectedPageSize, selectedType, submittedQuery]);

  // In `all` mode the backend interleaves types, so group them for scanning.
  const groups = useMemo(() => {
    if (selectedType !== 'all') return [{ type: null, items }];
    return (['knowledgeBase', 'document', 'chunk'] as GlobalSearchResultType[])
      .map((type) => ({ type, items: items.filter((item) => item.type === type) }))
      .filter((group) => group.items.length > 0);
  }, [items, selectedType]);

  const status = loading
    ? '正在搜索'
    : error || !submittedQuery
      ? ''
      : items.length === 0 ? '没有匹配结果' : `找到 ${total} 条结果`;

  function writeParams(query: string, type: SearchType, page = 1) {
    setSearchParams((current) => updateParams(current, query, type, page, selectedPageSize));
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    writeParams(draft.trim(), selectedType, 1);
  }

  async function handleExport() {
    if (!submittedQuery || exporting) return;
    setExportError('');
    setExporting(true);
    try {
      const blob = await exportGlobalSearch({ query: submittedQuery, type: selectedType });
      downloadBlob(blob, '搜索结果.csv');
    } catch (caught) {
      setExportError(getErrorMessage(caught, '搜索结果导出失败'));
    } finally {
      setExporting(false);
    }
  }

  return (
    <AppShell active="search" breadcrumbs={[{ label: '搜索' }]}>
      <div className="search-page">
        <form className="search-page__form" onSubmit={handleSubmit} role="search">
          <SearchCombobox
            onChange={setDraft}
            onPick={(item) => navigate(suggestionHref(item))}
            onSubmit={() => writeParams(draft.trim(), selectedType, 1)}
            value={draft}
          />
          <Button type="submit">搜索</Button>
          <Button
            disabled={!submittedQuery || loading}
            leadingIcon={<Download aria-hidden="true" />}
            loading={exporting}
            loadingLabel="正在导出"
            onClick={() => void handleExport()}
            variant="secondary"
          >
            导出 CSV
          </Button>
        </form>

        {exportError && <p className="ui-inline-error" role="alert">{exportError}</p>}

        <div className="ui-segmented search-page__types" role="group" aria-label="结果类型">
          {typeOptions.map((option) => (
            <button
              aria-pressed={selectedType === option.value}
              key={option.value}
              onClick={() => writeParams(submittedQuery, option.value, 1)}
              type="button"
            >
              <span>{option.label}</span>
            </button>
          ))}
        </div>

        <p
          aria-atomic="true"
          aria-label={loading ? '正在加载' : '搜索状态'}
          className="sr-only"
          role="status"
        >
          {status}
        </p>

        <section aria-busy={loading} aria-label="搜索结果" className="search-page__results">
          {loading ? (
            <LoadingSkeleton columns={3} rows={5} />
          ) : error ? (
            <ErrorState description={error} onRetry={() => setReloadKey((value) => value + 1)} title="搜索失败" />
          ) : !submittedQuery ? (
            <EmptyState description="可搜索知识库名称、文件名与内容片段。" title="输入关键词开始搜索" />
          ) : items.length === 0 ? (
            <EmptyState description="尝试更短的关键词，或切换结果类型。" title="没有匹配结果" />
          ) : (
            groups.map((group) => (
              <div className="search-group" key={group.type ?? 'flat'}>
                {group.type && <p className="search-group__label">{typeLabels[group.type]}</p>}
                {group.items.map((item) => (
                  <SearchResultRow item={item} key={`${item.type}-${item.id}`} />
                ))}
              </div>
            ))
          )}
        </section>

        {!loading && !error && submittedQuery && (
          <Pagination
            onPageChange={(page) => writeParams(submittedQuery, selectedType, page)}
            page={selectedPage}
            pageSize={selectedPageSize}
            total={total}
          />
        )}
      </div>
    </AppShell>
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
  if (query) next.set('q', query); else next.delete('q');
  if (type === 'all') next.delete('type'); else next.set('type', type);
  if (page <= 1) next.delete('page'); else next.set('page', String(page));
  if (pageSize === DEFAULT_PAGE_SIZE) next.delete('pageSize'); else next.set('pageSize', String(pageSize));
  return next;
}

function SearchResultRow({ item }: { item: GlobalSearchResult }) {
  const Icon = item.type === 'knowledgeBase' ? Library : item.type === 'document' ? FileText : TextQuote;
  return (
    <Link className="search-result" to={resultHref(item)}>
      <span className="search-result__icon" aria-hidden="true"><Icon /></span>
      <span className="search-result__body">
        <strong>{highlight(item.title, item.highlights, 'title')}</strong>
        <small>{item.knowledgeBaseName}{item.filename ? ` · ${item.filename}` : ''}</small>
        <p>{item.snippet ? highlight(item.snippet, item.highlights, 'snippet') : '暂无摘要'}</p>
      </span>
    </Link>
  );
}

/**
 * Renders the server's match positions. `start`/`end` are UTF-16 code units,
 * which is exactly what `String.prototype.slice` takes, so they are used as-is —
 * no re-matching on the client, which used to miss whatever the server matched
 * under a different tokenisation or case-folding rule.
 * See docs/14-frontend-api-gaps.md G9.
 */
function highlight(text: string, highlights: SearchHighlight[] | undefined, field: string): ReactNode {
  const ranges = (highlights ?? [])
    .filter((range) => range.field === field && range.start < range.end && range.start >= 0)
    .sort((a, b) => a.start - b.start);
  if (ranges.length === 0) return text;

  const parts: ReactNode[] = [];
  let cursor = 0;
  ranges.forEach((range, index) => {
    // Defensive against overlapping or stale ranges: never walk backwards.
    const start = Math.max(cursor, Math.min(range.start, text.length));
    const end = Math.max(start, Math.min(range.end, text.length));
    if (start >= end) return;
    if (start > cursor) parts.push(text.slice(cursor, start));
    parts.push(<mark className="hl" key={`${field}-${index}`}>{text.slice(start, end)}</mark>);
    cursor = end;
  });

  if (parts.length === 0) return text;
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

function resultHref(item: GlobalSearchResult): string {
  if (item.type === 'knowledgeBase') return `/knowledge-bases/${item.knowledgeBaseId}`;

  const params = new URLSearchParams();
  const documentId = item.documentId ?? (item.type === 'document' ? item.id : '');
  if (documentId) params.set('documentId', documentId);
  if (item.type === 'chunk') params.set('chunkId', item.id);

  const query = params.toString();
  const base = `/knowledge-bases/${item.knowledgeBaseId}/documents`;
  return query ? `${base}?${query}` : base;
}
