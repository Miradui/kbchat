import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getDocumentVersionStatus } from '../../api/resources';
import { Button } from '../../components/ui/Button';
import { DocumentVersionDialog } from '../Documents/DocumentVersionDialog';
import { documentChatUrl } from './documentChatScope';
import type { ChatDocument } from './documentChatScope';
import type { DocumentVersionStatus } from '../../types/api';

export function CitationVersionNotice({ documentId, relatedDocumentIds, question }: { documentId: string; relatedDocumentIds?: string[]; question?: string }) {
  const [states, setStates] = useState<DocumentVersionStatus[]>([]);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [compare, setCompare] = useState(false);
  const ids = [...new Set([documentId, ...(relatedDocumentIds ?? [])])].sort().join(',');
  useEffect(() => {
    const abort = new AbortController(); setStates([]); setError(false); setCompare(false);
    void getDocumentVersionStatus(ids.split(','), abort.signal).then((result) => { if (!abort.signal.aborted) setStates(result.items); })
      .catch(() => { if (!abort.signal.aborted) setError(true); });
    return () => abort.abort();
  }, [ids, attempt]);
  const item = states.find((state) => state.documentId === documentId);
  const current = states.map((state) => state.current).filter((document): document is ChatDocument => Boolean(document));
  const latest = [...new Map(current.map((document) => [document.id, document])).values()];
  const canAsk = Boolean(question) && ids.split(',').every((id) => states.some((state) => state.documentId === id && state.current)) && new Set(latest.map((document) => document.knowledgeBaseId)).size <= 5;
  if (error) return <p className="ui-muted">暂时无法确认来源版本。<Button variant="link" onClick={() => setAttempt((value) => value + 1)}>重试</Button></p>;
  if (!item) return null;
  return <div className="ui-inline-notice">
    <span>{item.state === 'newer_available' ? '这份回答依据已有可用新版。' : item.state === 'current' ? '当前仍使用这个已发布版本。' : '此来源目前没有可检索的已发布内容。'}{item.newerPending ? '另有更新版本尚未发布可检索内容。' : ''}</span>
    {item.state === 'newer_available' && item.current && <>
      <Button variant="link" onClick={() => setCompare(true)}>查看差异</Button>
      {canAsk && <Link className="ui-button ui-button--ghost" to={documentChatUrl(latest, question)}>按当前有效资料提问</Link>}
      {compare && <DocumentVersionDialog documentId={item.current.id} initialBaseId={documentId} onClose={() => setCompare(false)} />}
    </>}
  </div>;
}
