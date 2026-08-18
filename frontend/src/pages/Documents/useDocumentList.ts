import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { listGlobalDocuments } from '../../api/resources';
import type { DocumentSort, DocumentStatus, GlobalDocumentItem } from '../../types/api';
import { getErrorMessage } from '../../utils/errors';
import { documentStatuses, isTerminalDocumentStatus } from './documentDisplay';

const DEFAULT_PAGE_SIZE = 20;
const POLL_MS = 3000;

export type DocumentFilters = {
  q: string;
  knowledgeBaseId: string;
  status: DocumentStatus | '';
  fileType: string;
  sort: DocumentSort;
  page: number;
  pageSize: number;
};

export type DocumentCounts = {
  total: number | null;
  completed: number | null;
  processing: number | null;
  failed: number | null;
};

const sorts: DocumentSort[] = ['updatedAt_desc', 'createdAt_desc', 'filename_asc'];

function readStatus(raw: string | null): DocumentStatus | '' {
  return raw !== null && (documentStatuses as string[]).includes(raw) ? (raw as DocumentStatus) : '';
}

function readPositive(raw: string | null, fallback: number): number {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * One data source for both document routes.
 *
 * `GET /documents` is used even when scoped to a single knowledge base, because
 * `GET /knowledge-bases/:id/documents` accepts no query parameters — the scoped
 * page previously had to fetch every document and filter in the browser.
 */
export function useDocumentList(scopeKnowledgeBaseId?: string) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [items, setItems] = useState<GlobalDocumentItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [counts, setCounts] = useState<DocumentCounts>({
    total: null, completed: null, processing: null, failed: null,
  });
  const requestRef = useRef(0);
  const countRequestRef = useRef(0);
  const mountedRef = useRef(true);
  const listAbortRef = useRef<AbortController | null>(null);
  const countAbortRef = useRef<AbortController | null>(null);

  const filters = useMemo<DocumentFilters>(() => ({
    q: searchParams.get('q') ?? '',
    knowledgeBaseId: scopeKnowledgeBaseId ?? searchParams.get('knowledgeBaseId') ?? '',
    status: readStatus(searchParams.get('status')),
    fileType: searchParams.get('fileType') ?? '',
    sort: (sorts as string[]).includes(searchParams.get('sort') ?? '')
      ? (searchParams.get('sort') as DocumentSort)
      : 'updatedAt_desc',
    page: readPositive(searchParams.get('page'), 1),
    pageSize: readPositive(searchParams.get('pageSize'), DEFAULT_PAGE_SIZE),
  }), [scopeKnowledgeBaseId, searchParams]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestRef.current += 1;
      countRequestRef.current += 1;
      listAbortRef.current?.abort();
      countAbortRef.current?.abort();
    };
  }, []);

  const load = useCallback(async (options: { quiet?: boolean } = {}) => {
    const request = ++requestRef.current;
    listAbortRef.current?.abort();
    const controller = new AbortController();
    listAbortRef.current = controller;
    if (!options.quiet) setLoading(true);
    try {
      const response = await listGlobalDocuments({
        q: filters.q || undefined,
        knowledgeBaseId: filters.knowledgeBaseId || undefined,
        status: filters.status,
        fileType: filters.fileType || undefined,
        sort: filters.sort,
        page: filters.page,
        pageSize: filters.pageSize,
      }, controller.signal);
      if (mountedRef.current && requestRef.current === request) {
        setItems(response.items);
        setTotal(response.total);
        setError('');
      }
    } catch (caught) {
      // A background poll must not wipe out an error the user is still reading,
      // nor replace the list with an error banner.
      if (mountedRef.current && requestRef.current === request && !options.quiet) {
        setError(getErrorMessage(caught, '文档列表加载失败'));
      }
    } finally {
      if (mountedRef.current && requestRef.current === request && !options.quiet) setLoading(false);
    }
  }, [filters]);

  /**
   * Real totals for the status strip. Computed from three `total`-only queries
   * rather than counting the current page, which would under-report on page 2.
   */
  const loadCounts = useCallback(async () => {
    const request = ++countRequestRef.current;
    countAbortRef.current?.abort();
    const controller = new AbortController();
    countAbortRef.current = controller;
    const base = {
      q: filters.q || undefined,
      knowledgeBaseId: filters.knowledgeBaseId || undefined,
      fileType: filters.fileType || undefined,
      page: 1,
      pageSize: 1,
    };
    try {
      const [all, completed, failed] = await Promise.all([
        listGlobalDocuments(base, controller.signal),
        listGlobalDocuments({ ...base, status: 'completed' }, controller.signal),
        listGlobalDocuments({ ...base, status: 'failed' }, controller.signal),
      ]);
      if (!mountedRef.current || countRequestRef.current !== request) return;
      setCounts({
        total: all.total,
        completed: completed.total,
        failed: failed.total,
        processing: Math.max(0, all.total - completed.total - failed.total),
      });
    } catch {
      if (mountedRef.current && countRequestRef.current === request) {
        setCounts({ total: null, completed: null, processing: null, failed: null });
      }
    }
  }, [filters.fileType, filters.knowledgeBaseId, filters.q]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void loadCounts();
  }, [loadCounts]);

  const hasProcessing = useMemo(
    () => items.some((item) => !isTerminalDocumentStatus(item.status)),
    [items],
  );

  useEffect(() => {
    if (!hasProcessing) return;
    const timer = window.setInterval(() => {
      void load({ quiet: true });
      void loadCounts();
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [hasProcessing, load, loadCounts]);

  const setFilter = useCallback((patch: Partial<DocumentFilters>) => {
    setSearchParams((current) => {
      const params = new URLSearchParams(current);
      const write = (key: string, value: string, fallback: string) => {
        if (value === fallback || value === '') params.delete(key);
        else params.set(key, value);
      };

      if (patch.q !== undefined) write('q', patch.q, '');
      if (patch.knowledgeBaseId !== undefined) write('knowledgeBaseId', patch.knowledgeBaseId, '');
      if (patch.status !== undefined) write('status', patch.status, '');
      if (patch.fileType !== undefined) write('fileType', patch.fileType, '');
      if (patch.sort !== undefined) write('sort', patch.sort, 'updatedAt_desc');
      if (patch.pageSize !== undefined) write('pageSize', String(patch.pageSize), String(DEFAULT_PAGE_SIZE));

      const onlyPage = Object.keys(patch).length === 1 && patch.page !== undefined;
      if (patch.page !== undefined) write('page', String(patch.page), '1');
      else if (!onlyPage) params.delete('page');

      return params;
    }, { replace: patch.q !== undefined });
  }, [setSearchParams]);

  const activeFilterCount = [
    filters.q,
    scopeKnowledgeBaseId ? '' : filters.knowledgeBaseId,
    filters.status,
    filters.fileType,
  ].filter(Boolean).length;

  return {
    items,
    total,
    counts,
    loading,
    error,
    filters,
    activeFilterCount,
    reload: () => load(),
    refresh: async () => {
      await load();
      await loadCounts();
    },
    setFilter,
  };
}
