import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';

import { getKnowledgeBase, recordKnowledgeBaseView } from '../../api/resources';
import type { KnowledgeBase } from '../../types/api';
import { getErrorMessage } from '../../utils/errors';

/**
 * Loads one knowledge base and ignores responses for a base the user has already
 * navigated away from.
 */
export function useKnowledgeBase() {
  const { id } = useParams();
  const [knowledgeBase, setKnowledgeBase] = useState<KnowledgeBase | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const activeIdRef = useRef(id);
  const requestRef = useRef(0);
  activeIdRef.current = id;

  const load = useCallback(async () => {
    if (!id) return;
    const requestedId = id;
    const request = ++requestRef.current;
    setLoading(true);
    try {
      const response = await getKnowledgeBase(requestedId);
      if (activeIdRef.current === requestedId && requestRef.current === request) {
        setKnowledgeBase(response);
        setError('');
        // Views are recorded explicitly by the API contract, never implicitly on GET.
        void recordKnowledgeBaseView(requestedId).catch(() => undefined);
      }
    } catch (caught) {
      if (activeIdRef.current === requestedId && requestRef.current === request) {
        setKnowledgeBase(null);
        setError(getErrorMessage(caught, '知识库详情加载失败'));
      }
    } finally {
      if (activeIdRef.current === requestedId && requestRef.current === request) setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
    return () => {
      requestRef.current += 1;
    };
  }, [load]);

  return { id, knowledgeBase, setKnowledgeBase, loading, error, reload: load };
}
