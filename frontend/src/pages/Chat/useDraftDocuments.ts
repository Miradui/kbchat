import { useEffect, useState, useSyncExternalStore } from 'react';
import { getDocument } from '../../api/resources';
import { tokenStore } from '../../store/tokenStore';
import type { DocumentItem } from '../../types/api';
import { getErrorMessage } from '../../utils/errors';

class DocumentScopeError extends Error {}

/** Confirm the entire requested scope; an unavailable item never widens it. */
export function useDraftDocuments(documentIds: string[], knowledgeBaseIds: string[], enabled: boolean) {
  const revision = useSyncExternalStore(tokenStore.subscribe, tokenStore.getRevision, tokenStore.getRevision);
  const [attempt, setAttempt] = useState(0);
  const key = JSON.stringify([enabled, revision, documentIds, knowledgeBaseIds, attempt]);
  const [result, setResult] = useState<{ key: string; documents: DocumentItem[]; error: string } | null>(null);
  useEffect(() => {
    const [active, , ids, bases] = JSON.parse(key) as [boolean, number, string[], string[], number];
    if (!active || !ids.length) return;
    const abort = new AbortController();
    async function load() {
      try {
        if (ids.length > 20 || ids.some((id) => !id) || new Set(ids).size !== ids.length || !bases.length || bases.length > 5) {
          throw new DocumentScopeError('请选择最多 5 个知识库中的 1–20 份不同文档。');
        }
        const documents = await Promise.all(ids.map((id) => getDocument(id, abort.signal)));
        if (documents.some((document, index) => document.id !== ids[index] || !bases.includes(document.knowledgeBaseId))) {
          throw new DocumentScopeError('所选文档已移动或不属于当前范围，请重新选择资料。');
        }
        if (documents.some((document) => document.status !== 'completed' || document.jobStatus === 'cancelled')) {
          throw new DocumentScopeError('所选文档尚未全部处理完成，请等待处理完成或重新选择资料。');
        }
        if (!abort.signal.aborted) setResult({ key, documents, error: '' });
      } catch (caught) {
        if (!abort.signal.aborted) setResult({ key, documents: [], error: caught instanceof DocumentScopeError ? caught.message : getErrorMessage(caught, '无法确认所选资料，请重试或重新选择。') });
      }
    }
    void load();
    return () => abort.abort();
  }, [key]);
  const required = enabled && documentIds.length > 0;
  return {
    documents: required && result?.key === key ? result.documents : [],
    loading: required && result?.key !== key,
    error: required && result?.key === key ? result.error : '',
    retry: () => setAttempt((value) => value + 1),
  };
}
