import { useEffect, useState } from 'react';
import { Search } from 'lucide-react';
import { listGlobalDocuments } from '../../api/resources';
import { Dialog } from '../../components/ui/Dialog';
import { Button } from '../../components/ui/Button';
import { Checkbox } from '../../components/ui/Field';
import { DebouncedSearchInput } from '../../components/ui/DebouncedSearchInput';
import { Pagination } from '../../components/ui/Pagination';
import { getErrorMessage } from '../../utils/errors';
import type { ChatDocument } from './documentChatScope';

export function ChatDocumentPicker({ onClose, onSelect }: { onClose: () => void; onSelect: (documents: ChatDocument[]) => void }) {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [attempt, setAttempt] = useState(0);
  const [items, setItems] = useState<ChatDocument[]>([]);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<ChatDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    const abort = new AbortController();
    setLoading(true); setError(''); setItems([]);
    void listGlobalDocuments({ q: query, status: 'completed', page, pageSize: 20 }, abort.signal).then((result) => {
      if (!abort.signal.aborted) { setItems(result.items); setTotal(result.total); }
    }).catch((caught) => { if (!abort.signal.aborted) setError(getErrorMessage(caught, '文档加载失败')); })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [query, page, attempt]);
  const tooManyBases = new Set(selected.map((item) => item.knowledgeBaseId)).size > 5;
  return <Dialog open title="选择提问文档" description="最多选择 5 个知识库中的 20 份文档。仅检索所选版本，不自动扩展到其他资料。" onClose={onClose}>
    <DebouncedSearchInput icon={<Search aria-hidden="true" />} aria-label="搜索提问文档" value={query} onCommit={(value) => { setQuery(value); setPage(1); }} placeholder="搜索文件名" />
    <p role="status">{loading ? '正在加载文档…' : `已选择 ${selected.length} 份文档`}</p>
    {error ? <p role="alert">{error}<Button variant="link" onClick={() => setAttempt((value) => value + 1)}>重试</Button></p> : <div className="ui-form">
      {items.map((item) => <label key={item.id} className="ui-checkbox-label"><Checkbox aria-label={`选择 ${item.filename}`} checked={selected.some((value) => value.id === item.id)}
        disabled={selected.length >= 20 && !selected.some((value) => value.id === item.id)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, item] : current.filter((value) => value.id !== item.id))} />{item.filename}</label>)}
      {!loading && !items.length && <p>没有匹配的已处理文档。</p>}
      <Pagination page={page} pageSize={20} total={total} onPageChange={setPage} />
    </div>}
    {selected.length > 0 && <div aria-label="已选文档">{selected.map((item) => <Button key={item.id} variant="ghost" onClick={() => setSelected((current) => current.filter((value) => value.id !== item.id))}>移除 {item.filename}</Button>)}</div>}
    {tooManyBases && <p role="alert">每次最多选择 5 个知识库的文档。</p>}
    <div className="ui-dialog__actions"><Button variant="secondary" onClick={onClose}>取消</Button><Button disabled={!selected.length || tooManyBases} onClick={() => onSelect(selected)}>使用这些文档</Button></div>
  </Dialog>;
}
