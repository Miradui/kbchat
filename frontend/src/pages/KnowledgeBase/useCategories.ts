import { useCallback, useEffect, useRef, useState } from 'react';

import {
  createKnowledgeBaseCategory,
  deleteKnowledgeBaseCategory,
  listKnowledgeBaseCategories,
  reorderKnowledgeBaseCategories,
  updateKnowledgeBaseCategory,
} from '../../api/resources';
import type { KnowledgeBaseCategory, KnowledgeBaseCategoryInput } from '../../types/api';
import { getErrorMessage } from '../../utils/errors';
import { categoryReorderItemsAfterMove } from './categoryTreeUtils';

/**
 * Owns the category tree and its writes. Category mutations no longer block the
 * knowledge-base list: only the row being reordered is disabled.
 */
export function useCategories() {
  const [categories, setCategories] = useState<KnowledgeBaseCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(() => new Set());
  const requestRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestRef.current += 1;
    };
  }, []);

  const reload = useCallback(async () => {
    const request = ++requestRef.current;
    setLoading(true);
    try {
      const response = await listKnowledgeBaseCategories();
      if (mountedRef.current && requestRef.current === request) {
        setCategories(response.items);
        setError('');
      }
    } catch (caught) {
      if (mountedRef.current && requestRef.current === request) {
        setError(getErrorMessage(caught, '分类加载失败'));
      }
    } finally {
      if (mountedRef.current && requestRef.current === request) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const markPending = useCallback((id: string, pending: boolean) => {
    setPendingIds((current) => {
      const next = new Set(current);
      if (pending) next.add(id); else next.delete(id);
      return next;
    });
  }, []);

  const save = useCallback(async (input: KnowledgeBaseCategoryInput, id?: string) => {
    if (id) {
      await updateKnowledgeBaseCategory(id, input);
    } else {
      await createKnowledgeBaseCategory(input);
    }
    await reload();
  }, [reload]);

  const remove = useCallback(async (id: string) => {
    await deleteKnowledgeBaseCategory(id);
    await reload();
  }, [reload]);

  const move = useCallback(async (id: string, direction: 'up' | 'down') => {
    const items = categoryReorderItemsAfterMove(categories, id, direction);
    if (!items) return;

    markPending(id, true);
    // Reflect the new order immediately; the reload below is the source of truth.
    try {
      await reorderKnowledgeBaseCategories(items);
      await reload();
    } finally {
      if (mountedRef.current) markPending(id, false);
    }
  }, [categories, markPending, reload]);

  return { categories, loading, error, pendingIds, reload, save, remove, move };
}
