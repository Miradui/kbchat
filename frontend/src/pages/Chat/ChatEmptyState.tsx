import { ArrowUpRight, BookOpen, Check, FileText, Files, Search, Sparkles } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { EmptyState } from '../../components/feedback/EmptyState';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';
import { Button } from '../../components/ui/Button';
import type { ChatTaskKind } from './ChatTaskDialog';

const FILTER_THRESHOLD = 12;

type ChatEmptyStateProps = {
  documentCount?: number;
  knowledgeBases: Array<{ id: string; name: string; description: string }>;
  loading: boolean;
  error: string;
  onRetry: () => void;
  selectedIds: string[];
  disabled: boolean;
  onSelect: (id: string) => void;
  composer: ReactNode;
  onSuggest: (kind: ChatTaskKind) => void;
};

/**
 * Draft-state body. Absorbs what used to be a separate `/chat` landing page.
 */
export function ChatEmptyState({
  documentCount = 0,
  knowledgeBases,
  loading,
  error,
  onRetry,
  selectedIds,
  disabled,
  onSelect,
  composer,
  onSuggest,
}: ChatEmptyStateProps) {
  const [filterText, setFilterText] = useState('');
  const showFilter = knowledgeBases.length > FILTER_THRESHOLD;
  const normalizedFilter = filterText.trim().toLowerCase();
  const visibleKnowledgeBases = showFilter && normalizedFilter
    ? knowledgeBases.filter((knowledgeBase) => (
      knowledgeBase.name.toLowerCase().includes(normalizedFilter)
      || (knowledgeBase.description ?? '').toLowerCase().includes(normalizedFilter)
    ))
    : knowledgeBases;

  return (
    <div className="chat-launcher">
      <span className="chat-launcher__mark"><Sparkles aria-hidden="true" />你的知识，随时可用</span>
      <h1>{documentCount ? '针对指定文档提问' : selectedIds.length ? '在指定知识库中提问' : '今天，想从资料中了解什么？'}</h1>
      <p>{documentCount ? '本会话只检索选定的 ' + documentCount + ' 份文档版本，回答会标注资料来源。' : selectedIds.length ? '本会话仅检索所选知识库，回答会标注资料来源。' : '把问题交给知汇，每一个答案都能找到出处。'}</p>
      {composer}
      <div aria-label="提问建议" className="chat-launcher__suggestions">
        <Button disabled={disabled} leadingIcon={<FileText aria-hidden="true" />} onClick={() => onSuggest('summary')} variant="secondary">总结一份资料</Button>
        <Button disabled={disabled} leadingIcon={<Files aria-hidden="true" />} onClick={() => onSuggest('comparison')} variant="secondary">对比文档差异</Button>
        <Button disabled={disabled} leadingIcon={<Search aria-hidden="true" />} onClick={() => onSuggest('policy')} variant="secondary">查找制度规定</Button>
      </div>
      <div className="chat-launcher__scope-heading"><span>继续探索你的知识库</span><Link to="/knowledge-bases">查看全部<ArrowUpRight aria-hidden="true" /></Link></div>
      {loading ? <LoadingSkeleton announce columns={3} rows={1} /> : error && knowledgeBases.length === 0 ? <EmptyState
        action={<Button onClick={onRetry} variant="secondary">重试知识库</Button>}
        description={error}
        title="知识库暂不可用"
      /> : knowledgeBases.length === 0 ? <EmptyState
        action={<Link className="ui-button ui-button--primary" to="/knowledge-bases?intent=create"><span>新建知识库</span></Link>}
        description="AI 问答基于知识库中的文档作答。先创建一个知识库并导入文档。"
        title="还没有可提问的知识库"
      /> : <>
        {showFilter && (
          <div className="chat-launcher__filter">
            <input
              aria-label="筛选知识库"
              className="ui-input"
              onChange={(event) => setFilterText(event.target.value)}
              placeholder="筛选知识库…"
              type="search"
              value={filterText}
            />
          </div>
        )}
        {visibleKnowledgeBases.length === 0 ? (
          <p className="chat-launcher__hint">没有匹配「{filterText.trim()}」的知识库。</p>
        ) : (
          <div aria-label="可提问的知识库" className="chat-launcher__list">
            {visibleKnowledgeBases.map((knowledgeBase) => (
              <button
                aria-pressed={selectedIds.includes(knowledgeBase.id)}
                className={selectedIds.includes(knowledgeBase.id) ? 'chat-launcher__item is-selected' : 'chat-launcher__item'}
                disabled={disabled || (selectedIds.length >= 5 && !selectedIds.includes(knowledgeBase.id))}
                key={knowledgeBase.id}
                onClick={() => onSelect(knowledgeBase.id)}
                type="button"
              >
                <span className="chat-launcher__book"><BookOpen aria-hidden="true" /></span>
                <span className="ui-cell-stack"><strong>{knowledgeBase.name}</strong><small>{knowledgeBase.description || '点击限定提问范围'}</small></span>
                {selectedIds.includes(knowledgeBase.id) && <Check aria-hidden="true" className="chat-launcher__selected" />}
              </button>
            ))}
          </div>
        )}
        <p className="chat-launcher__hint">{selectedIds.length > 0 && !documentCount ? '已指定 ' + selectedIds.length + ' 个知识库，本会话仅在所选范围内检索。' : '点击卡片限定提问范围，最多选择 5 个知识库。'}</p>
      </>}
    </div>
  );
}
