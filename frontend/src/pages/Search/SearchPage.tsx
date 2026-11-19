import { FileText, Library, TextQuote } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';

import { globalSearch } from '../../api/resources';
import { EmptyState } from '../../components/feedback/EmptyState';
import { ErrorState } from '../../components/feedback/ErrorState';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';
import { Button } from '../../components/ui/Button';
import { Pagination } from '../../components/ui/Pagination';
import { PageHeading } from '../../components/ui/PageHeading';
import { AppShell } from '../../layouts/AppShell';
import { SearchCombobox, suggestionHref } from './SearchCombobox';
import { searchGuidance } from './searchGuidance';
import type { SearchGuidance } from './searchGuidance';
import type { GlobalSearchResult, GlobalSearchResultType, SearchHighlight } from '../../types/api';
import { getErrorMessage } from '../../utils/errors';
import { documentStatuses, documentStatusLabel } from '../Documents/documentDisplay';

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
  const [hasOtherTypes, setHasOtherTypes] = useState(false);
  // What the last completed search was for. Needed because "no results" and "not
  // searched yet" look identical in `items`/`loading`.
  const [settled, setSettled] = useState<{ query: string; type: SearchType; total: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => setDraft(submittedQuery), [submittedQuery]);

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
      setSettled(null);
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
          setSettled({ query: submittedQuery, type: selectedType, total: response.total });
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

  // Only asked when a filtered search came back empty: the guidance may claim other
  // types have results, and that claim needs evidence. `pageSize: 1` because the
  // count is the whole answer -- the rows are thrown away.
  //
  // Gated on `settled` rather than on `!loading && items.length === 0`, because those
  // two are also the state before the first search has run: `loading` is still false
  // in the commit that starts it, so the looser condition fires a probe on mount for
  // a query that has not been searched yet.
  useEffect(() => {
    setHasOtherTypes(false);
    if (!settled || settled.query !== submittedQuery || settled.type !== selectedType) return;
    if (settled.total > 0 || selectedType === 'all') return;

    const controller = new AbortController();
    void globalSearch({ query: submittedQuery, type: 'all', page: 1, pageSize: 1 }, controller.signal)
      .then((response) => {
        if (!controller.signal.aborted) setHasOtherTypes(response.total > 0);
      })
      // A failed probe just means the guidance stays generic, which is the honest
      // fallback: it cannot claim results exist elsewhere without having seen them.
      .catch(() => undefined);

    return () => controller.abort();
  }, [selectedType, settled, submittedQuery]);

  const guidance = useMemo(
    () => searchGuidance(submittedQuery, selectedType, hasOtherTypes),
    [hasOtherTypes, selectedType, submittedQuery],
  );

  function guidanceAction(current: SearchGuidance): ReactNode {
    if (!current.action) return null;
    if (current.action.kind === 'clearType') {
      return (
        <Button onClick={() => writeParams(submittedQuery, 'all', 1)} variant="secondary">
          查看全部类型
        </Button>
      );
    }
    const { query } = current.action;
    return (
      <Button
        onClick={() => {
          // The effect above syncs `draft` from the URL, so this is not what puts the
          // new query in the box -- it closes the one render where `draft` still holds
          // the old query while the URL holds the new one, which is a window the
          // debounce effect below could use to write the old query straight back.
          setDraft(query);
          writeParams(query, selectedType, 1);
        }}
        variant="secondary"
      >
        改搜「{query}」
      </Button>
    );
  }

  // In `all` mode the backend interleaves types, so group them for scanning.
  const groups = useMemo(() => {
    if (selectedType !== 'all') return [{ type: null, items }];
    return (['knowledgeBase', 'document', 'chunk'] as GlobalSearchResultType[])
      .map((type) => ({ type, items: items.filter((item) => item.type === type) }))
      .filter((group) => group.items.length > 0);
  }, [items, selectedType]);

  // The empty case announces the guidance title rather than a generic "没有匹配结果",
  // so what a screen reader hears is what the page shows. It also means the reason
  // reaches someone who never sees the button below it.
  const status = loading
    ? '正在搜索'
    : error || !submittedQuery
      ? ''
      : items.length === 0 ? guidance.title : `找到 ${total} 条结果`;

  function writeParams(query: string, type: SearchType, page = 1) {
    setSearchParams((current) => updateParams(current, query, type, page, selectedPageSize));
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    writeParams(draft.trim(), selectedType, 1);
  }

  return (
    <AppShell active="search" breadcrumbs={[{ label: '搜索' }]}>
      <div className="search-page">
        <PageHeading className="search-page__heading" title="搜索你的知识" description="搜索名称与原文关键词，查找知识库、文档和内容片段。" />
        <form className="search-page__form" onSubmit={handleSubmit} role="search">
          <SearchCombobox
            onChange={setDraft}
            onPick={(item) => navigate(suggestionHref(item))}
            onSubmit={() => writeParams(draft.trim(), selectedType, 1)}
            value={draft}
          />
          <Button type="submit">搜索</Button>
        </form>

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
            <EmptyState
              action={guidanceAction(guidance)}
              description={guidance.description}
              title={guidance.title}
            />
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
  const documentStatus = item.type === 'document'
    ? documentStatuses.find((status) => status === item.snippet)
    : undefined;
  const snippet = documentStatus
    ? documentStatusLabel(documentStatus)
    : item.snippet ? highlight(item.snippet, item.highlights, 'snippet') : '暂无摘要';
  return (
    <Link className="search-result" to={resultHref(item)}>
      <span className="search-result__icon" aria-hidden="true"><Icon /></span>
      <span className="search-result__body">
        <strong>{highlight(item.title, item.highlights, 'title')}</strong>
        <small>{item.knowledgeBaseName}{item.filename ? ` · ${item.filename}` : ''}</small>
        <p>{snippet}</p>
      </span>
    </Link>
  );
}

/**
 * Renders the server's match positions. `start`/`end` are UTF-16 code units,
 * which is exactly what `String.prototype.slice` takes, so they are used as-is —
 * no re-matching on the client, which used to miss whatever the server matched
 * under a different tokenisation or case-folding rule.
 * See docs/04-api-design.md (GET /search).
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
