import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';

import { getDocumentCounts, listGlobalDocuments } from '../../api/resources';
import { documentCountsKey, documentListKey, queryClient } from '../../store/queryClient';
import { tokenStore } from '../../store/tokenStore';
import type { DocumentSort, DocumentStatusFilter, GlobalDocumentItem, GlobalDocumentListResponse } from '../../types/api';
import { getErrorMessage } from '../../utils/errors';
import { documentStatuses, isTerminalDocumentStatus } from './documentDisplay';

const DEFAULT_PAGE_SIZE = 20;
const POLL_MS = 3000;
const emptyItems: GlobalDocumentItem[] = [];
const emptyCounts: DocumentCounts = {
  total: null, completed: null, processing: null, failed: null,
};

export type DocumentFilters = {
  q: string;
  knowledgeBaseId: string;
  status: DocumentStatusFilter;
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

function readStatus(raw: string | null): DocumentStatusFilter {
  return raw === 'processing' || (raw !== null && (documentStatuses as string[]).includes(raw))
    ? raw as DocumentStatusFilter
    : '';
}

function readPositive(raw: string | null, fallback: number): number {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * One data source for both document routes.
 *
 * Both document routes share the server-side query contract. A scoped view pins
 * knowledgeBaseId while keeping search, processing stages and pagination intact.
 */
export function useDocumentList(scopeKnowledgeBaseId?: string) {
  const [searchParams, setSearchParams] = useSearchParams();
  const revision = useSyncExternalStore(tokenStore.subscribe, tokenStore.getRevision);

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

  const listQueryKey = useMemo(() => [...documentListKey, revision, filters] as const, [revision, filters]);
  const countFilterKey = useMemo(() => ({
    q: filters.q,
    knowledgeBaseId: filters.knowledgeBaseId,
    fileType: filters.fileType,
  }), [filters.fileType, filters.knowledgeBaseId, filters.q]);
  const countsQueryKey = useMemo(() => [...documentCountsKey, revision, countFilterKey] as const, [revision, countFilterKey]);

  const listQuery = useQuery<GlobalDocumentListResponse>({
    queryKey: listQueryKey,
    retry: false,
    placeholderData: (previous, previousQuery) => (
      previousQuery?.queryKey[1] === revision
      && (previousQuery.queryKey[2] as DocumentFilters | undefined)?.knowledgeBaseId === filters.knowledgeBaseId
        ? previous
        : undefined
    ),
    queryFn: async ({ signal }) => {
      const response = await listGlobalDocuments({
        q: filters.q || undefined,
        knowledgeBaseId: filters.knowledgeBaseId || undefined,
        status: filters.status,
        fileType: filters.fileType || undefined,
        sort: filters.sort,
        page: filters.page,
        pageSize: filters.pageSize,
      }, signal);
      if (tokenStore.getRevision() !== revision) throw new Error('账户已切换');
      return response;
    },
  }, queryClient);

  const countsQuery = useQuery({
    queryKey: countsQueryKey,
    retry: false,
    queryFn: async ({ signal }) => {
      const response = await getDocumentCounts({
        q: filters.q || undefined,
        knowledgeBaseId: filters.knowledgeBaseId || undefined,
        fileType: filters.fileType || undefined,
      }, signal);
      if (tokenStore.getRevision() !== revision) throw new Error('账户已切换');
      return response;
    },
  }, queryClient);

  const items = listQuery.data?.items ?? emptyItems;
  const total = listQuery.data?.total ?? 0;
  const counts = countsQuery.isError || !countsQuery.data ? emptyCounts : countsQuery.data;
  const loading = listQuery.isPending || (listQuery.isFetching && listQuery.isPlaceholderData);
  const error = !listQuery.isFetching && listQuery.isError && !listQuery.data
    ? getErrorMessage(listQuery.error, '文档列表加载失败')
    : '';

  const hasProcessing = useMemo(
    () => items.some((item) => !isTerminalDocumentStatus(item.status)),
    [items],
  );

  const { refetch: refetchList } = listQuery;
  const { refetch: refetchCounts } = countsQuery;

  useEffect(() => {
    if (!hasProcessing) return;
    const timer = window.setInterval(() => {
      void refetchList();
      void refetchCounts();
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [hasProcessing, refetchCounts, refetchList]);

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

  const reload = useCallback(async () => {
    await refetchList();
  }, [refetchList]);

  const refresh = useCallback(async () => {
    await Promise.all([refetchList(), refetchCounts()]);
  }, [refetchCounts, refetchList]);

  return {
    items,
    total,
    counts,
    loading,
    error,
    filters,
    activeFilterCount,
    reload,
    refresh,
    setFilter,
  };
}
