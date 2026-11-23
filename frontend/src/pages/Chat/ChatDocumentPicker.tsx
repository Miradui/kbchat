import { useEffect, useMemo, useState } from 'react';
import { Search, X } from 'lucide-react';
import { listGlobalDocuments } from '../../api/resources';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';
import { Dialog } from '../../components/ui/Dialog';
import { Button } from '../../components/ui/Button';
import { Checkbox, Select } from '../../components/ui/Field';
import { DebouncedSearchInput } from '../../components/ui/DebouncedSearchInput';
import { Pagination } from '../../components/ui/Pagination';
import type { GlobalDocumentItem } from '../../types/api';
import { getErrorMessage } from '../../utils/errors';
import type { ChatDocument } from './documentChatScope';

type KnowledgeBaseOption = { id: string; name: string };

export function ChatDocumentPicker({
  knowledgeBases,
  onClose,
  onSelect,
  title = '选择提问文档',
  description = '最多选择 5 个知识库中的 20 份文档。仅检索所选版本，不自动扩展到其他资料。',
  minSelection = 1,
  maxSelection = 20,
  initialSelection = [],
}: {
  knowledgeBases?: KnowledgeBaseOption[];
  onClose: () => void;
  onSelect: (documents: ChatDocument[]) => void;
  title?: string;
  description?: string;
  minSelection?: number;
  maxSelection?: number;
  initialSelection?: ChatDocument[];
}) {
  const [query, setQuery] = useState('');
  const [knowledgeBaseId, setKnowledgeBaseId] = useState('');
  const [page, setPage] = useState(1);
  const [attempt, setAttempt] = useState(0);
  const [items, setItems] = useState<GlobalDocumentItem[]>([]);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<ChatDocument[]>(() => Array.from(new Map(initialSelection.map((item) => [item.id, item])).values()));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    setError('');
    setItems([]);
    void listGlobalDocuments(
      { q: query, knowledgeBaseId: knowledgeBaseId || undefined, status: 'completed', page, pageSize: 20 },
      abort.signal,
    ).then((result) => {
      if (!abort.signal.aborted) {
        setItems(result.items);
        setTotal(result.total);
      }
    }).catch((caught) => {
      if (!abort.signal.aborted) setError(getErrorMessage(caught, '文档加载失败'));
    }).finally(() => {
      if (!abort.signal.aborted) setLoading(false);
    });
    return () => abort.abort();
  }, [query, knowledgeBaseId, page, attempt]);

  const kbFilterOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const kb of knowledgeBases ?? []) {
      seen.set(kb.id, kb.name);
    }
    for (const item of items) {
      if (item.knowledgeBaseId && !seen.has(item.knowledgeBaseId)) {
        seen.set(item.knowledgeBaseId, item.knowledgeBaseName || item.knowledgeBaseId);
      }
    }
    return Array.from(seen, ([id, name]) => ({ id, name }));
  }, [items, knowledgeBases]);

  const tooManyBases = new Set(selected.map((item) => item.knowledgeBaseId)).size > 5;
  const selectionLimit = Math.min(20, Math.max(1, maxSelection));
  const selectionMinimum = Math.min(selectionLimit, Math.max(1, minSelection));
  const invalidSelection = selected.length < selectionMinimum || selected.length > selectionLimit || tooManyBases;
  const baseName = (item: ChatDocument) => kbFilterOptions.find((kb) => kb.id === item.knowledgeBaseId)?.name || item.knowledgeBaseId;

  return (
    <Dialog
      className="chat-doc-picker"
      description={description}
      onClose={onClose}
      open
      title={title}
    >
      <div className="ui-toolbar">
        <DebouncedSearchInput
          aria-label="搜索提问文档"
          icon={<Search aria-hidden="true" />}
          onCommit={(value) => { setQuery(value); setPage(1); }}
          placeholder="搜索文件名"
          value={query}
        />
        <Select
          aria-label="按知识库筛选"
          onChange={(event) => { setKnowledgeBaseId(event.target.value); setPage(1); }}
          value={knowledgeBaseId}
        >
          <option value="">全部知识库</option>
          {kbFilterOptions.map((kb) => (
            <option key={kb.id} value={kb.id}>{kb.name}</option>
          ))}
        </Select>
      </div>

      <p className="ui-muted" role="status">
        {loading ? '正在加载文档…' : `已选择 ${selected.length} 份文档`}
      </p>

      {selected.length > 0 && (
        <div aria-label="已选文档" className="chat-doc-picker__chips">
          {selected.map((item) => (
            <span className="ui-tag chat-doc-picker__chip" key={item.id}>
              <span title={`${item.filename}（${baseName(item)}）`}>{item.filename}（{baseName(item)}）</span>
              <button
                aria-label={`移除 ${item.filename}（${baseName(item)}）`}
                className="chat-doc-picker__chip-remove"
                onClick={() => setSelected((current) => current.filter((value) => value.id !== item.id))}
                type="button"
                title={`移除 ${item.filename}`}
              >
                <X aria-hidden="true" size={12} />
              </button>
            </span>
          ))}
        </div>
      )}

      {error ? (
        <p className="ui-inline-error" role="alert">
          {error}
          <Button onClick={() => setAttempt((value) => value + 1)} variant="link">重试</Button>
        </p>
      ) : loading ? (
        <LoadingSkeleton compact columns={2} rows={4} />
      ) : (
        <>
          <div className="chat-doc-picker__list">
            {items.map((item) => {
              const checked = selected.some((value) => value.id === item.id);
              const disabled = selected.length >= selectionLimit && !checked;
              return (
                <label className="chat-doc-picker__row" key={item.id}>
                  <Checkbox
                    aria-label={`选择 ${item.filename}（${baseName(item)}）`}
                    checked={checked}
                    disabled={disabled}
                    onChange={(event) => setSelected((current) => (
                      event.target.checked
                        ? current.length >= selectionLimit || current.some((value) => value.id === item.id) ? current : [...current, item]
                        : current.filter((value) => value.id !== item.id)
                    ))}
                  />
                  <span className="ui-cell-stack">
                    <strong>{item.filename}</strong>
                    {item.knowledgeBaseName && <small>{item.knowledgeBaseName}</small>}
                  </span>
                </label>
              );
            })}
            {items.length === 0 && <p className="ui-muted">没有匹配的已处理文档。</p>}
          </div>
          <Pagination compact onPageChange={setPage} page={page} pageSize={20} total={total} />
        </>
      )}

      {tooManyBases && <p className="ui-inline-error" role="alert">每次最多选择 5 个知识库的文档。</p>}
      {selected.length > selectionLimit && <p className="ui-inline-error" role="alert">最多选择 {selectionLimit} 份文档，请移除多余选择。</p>}
      <div className="ui-dialog__actions">
        <Button onClick={onClose} variant="secondary">取消</Button>
        <Button disabled={invalidSelection} onClick={() => { if (!invalidSelection) onSelect(selected); }}>使用这些文档</Button>
      </div>
    </Dialog>
  );
}
