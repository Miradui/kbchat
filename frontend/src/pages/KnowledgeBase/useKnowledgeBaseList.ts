import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { listKnowledgeBases, updateWorkspacePreference } from '../../api/resources';
import { useLocalPreference } from '../../hooks/useLocalPreference';
import type {
  KnowledgeBase,
  KnowledgeBaseScope,
  KnowledgeBaseSort,
  WorkspaceViewMode,
  WorkspaceVisibility,
} from '../../types/api';
import { getErrorMessage } from '../../utils/errors';

export const SCOPES: KnowledgeBaseScope[] = ['all', 'created', 'managed', 'favorite', 'recent'];
export const SORTS: KnowledgeBaseSort[] = ['updatedAt_desc', 'createdAt_desc', 'name_asc'];
export const VISIBILITIES: WorkspaceVisibility[] = ['all', 'private', 'public'];

const DEFAULT_PAGE_SIZE = 20;
const PAGE_SIZES = [10, 20, 50] as const;

function readEnum<T extends string>(raw: string | null, allowed: readonly T[], fallback: T): T {
  return raw !== null && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
}

function readPage(raw: string | null): number {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
}

function readPageSize(raw: string | null): number {
  const parsed = Number(raw);
  return PAGE_SIZES.includes(parsed as (typeof PAGE_SIZES)[number]) ? parsed : DEFAULT_PAGE_SIZE;
}

export type KnowledgeBaseFilters = {
  q: string;
  categoryId: string;
  tagId: string;
  visibility: WorkspaceVisibility;
  scope: KnowledgeBaseScope;
  sort: KnowledgeBaseSort;
  page: number;
  pageSize: number;
};

/**
 * Filters, scope, sort and paging live in the URL so a filtered view is
 * shareable and the back button restores it. View mode is local — it used to be
 * a blocking `PUT` that then disabled the whole page while in flight.
 */
export function useKnowledgeBaseList() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [items, setItems] = useState<KnowledgeBase[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [viewMode, setViewMode] = useLocalPreference<WorkspaceViewMode>('kb.viewMode', 'table');
  const [expandedCategoryIds, setExpandedCategoryIds] = useLocalPreference<string[]>('kb.expandedCategories', []);
  const requestRef = useRef(0);
  const mountedRef = useRef(true);

  const filters = useMemo<KnowledgeBaseFilters>(() => ({
    q: searchParams.get('q') ?? '',
    categoryId: searchParams.get('category') ?? '',
    tagId: searchParams.get('tag') ?? '',
    visibility: readEnum(searchParams.get('visibility'), VISIBILITIES, 'all'),
    scope: readEnum(searchParams.get('scope'), SCOPES, 'all'),
    sort: readEnum(searchParams.get('sort'), SORTS, 'updatedAt_desc'),
    page: readPage(searchParams.get('page')),
    pageSize: readPageSize(searchParams.get('pageSize')),
  }), [searchParams]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestRef.current += 1;
    };
  }, []);

  const load = useCallback(async () => {
    const request = ++requestRef.current;
    setLoading(true);
    try {
      const response = await listKnowledgeBases({
        q: filters.q || undefined,
        categoryId: filters.categoryId || undefined,
        tagIds: filters.tagId ? [filters.tagId] : undefined,
        visibility: filters.visibility,
        scope: filters.scope,
        sort: filters.sort,
        page: filters.page,
        pageSize: filters.pageSize,
      });
      if (mountedRef.current && requestRef.current === request) {
        setItems(response.items);
        setTotal(response.total ?? response.items.length);
        setError('');
      }
    } catch (caught) {
      if (mountedRef.current && requestRef.current === request) {
        setError(getErrorMessage(caught, '知识库加载失败'));
      }
    } finally {
      if (mountedRef.current && requestRef.current === request) setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Cross-device sync only. Never awaited, never blocks a control, and a failure
   * is silent because the local state is already correct.
   */
  const syncPreference = useCallback((next: Partial<{ viewMode: WorkspaceViewMode; expandedCategoryIds: string[] }>) => {
    void updateWorkspacePreference({
      viewMode: next.viewMode ?? viewMode,
      scope: filters.scope,
      sort: filters.sort,
      visibility: filters.visibility,
      expandedCategoryIds: next.expandedCategoryIds ?? expandedCategoryIds,
    }).catch(() => undefined);
  }, [expandedCategoryIds, filters.scope, filters.sort, filters.visibility, viewMode]);

  const setFilter = useCallback((patch: Partial<KnowledgeBaseFilters>) => {
    setSearchParams((current) => {
      const params = new URLSearchParams(current);
      const write = (key: string, value: string, fallback: string) => {
        if (value === fallback || value === '') params.delete(key);
        else params.set(key, value);
      };

      if (patch.q !== undefined) write('q', patch.q, '');
      if (patch.categoryId !== undefined) write('category', patch.categoryId, '');
      if (patch.tagId !== undefined) write('tag', patch.tagId, '');
      if (patch.visibility !== undefined) write('visibility', patch.visibility, 'all');
      if (patch.scope !== undefined) write('scope', patch.scope, 'all');
      if (patch.sort !== undefined) write('sort', patch.sort, 'updatedAt_desc');
      if (patch.pageSize !== undefined) write('pageSize', String(patch.pageSize), String(DEFAULT_PAGE_SIZE));

      // Any filter change resets paging; an explicit page wins.
      const onlyPage = Object.keys(patch).length === 1 && patch.page !== undefined;
      if (patch.page !== undefined) write('page', String(patch.page), '1');
      else if (!onlyPage) params.delete('page');

      return params;
    }, { replace: patch.q !== undefined });
  }, [setSearchParams]);

  const changeViewMode = useCallback((mode: WorkspaceViewMode) => {
    setViewMode(mode);
    syncPreference({ viewMode: mode });
  }, [setViewMode, syncPreference]);

  const toggleCategoryExpanded = useCallback((categoryId: string) => {
    setExpandedCategoryIds((current) => {
      const next = current.includes(categoryId)
        ? current.filter((id) => id !== categoryId)
        : [...current, categoryId];
      syncPreference({ expandedCategoryIds: next });
      return next;
    });
  }, [setExpandedCategoryIds, syncPreference]);

  const activeFilterCount = [
    filters.q,
    filters.categoryId,
    filters.tagId,
    filters.visibility !== 'all' ? filters.visibility : '',
    filters.scope !== 'all' ? filters.scope : '',
  ].filter(Boolean).length;

  return {
    items,
    total,
    loading,
    error,
    filters,
    activeFilterCount,
    viewMode,
    expandedCategoryIds,
    reload: load,
    setFilter,
    changeViewMode,
    toggleCategoryExpanded,
  };
}
