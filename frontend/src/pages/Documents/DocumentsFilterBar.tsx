import { RotateCw, Search, Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { useLocation } from 'react-router-dom';

import { Button } from '../../components/ui/Button';
import { DebouncedSearchInput } from '../../components/ui/DebouncedSearchInput';
import { Select } from '../../components/ui/Field';
import { MetricStrip } from '../../components/ui/MetricStrip';
import { OverflowMenu } from '../../components/ui/OverflowMenu';
import type { DocumentSort, DocumentStatus, KnowledgeBase } from '../../types/api';
import { documentStatuses, documentStatusLabel, isTerminalDocumentStatus } from './documentDisplay';
import type { DocumentCounts, DocumentFilters } from './useDocumentList';

type DocumentsFilterBarProps = {
  knowledgeBaseError: string;
  onReloadKnowledgeBases: () => void;
  filters: DocumentFilters;
  setFilter: (patch: Partial<DocumentFilters>) => void;
  scopeKnowledgeBaseId?: string;
  knowledgeBases: KnowledgeBase[];
  fileTypes: string[];
  importButton: ReactNode;
  onRefresh: () => void;
  onOpenRecycle: () => void;
  counts: DocumentCounts;
  activeFilterCount: number;
};

export function DocumentsFilterBar({
  knowledgeBaseError,
  onReloadKnowledgeBases,
  filters,
  setFilter,
  scopeKnowledgeBaseId,
  knowledgeBases,
  fileTypes,
  importButton,
  onRefresh,
  onOpenRecycle,
  counts,
  activeFilterCount,
}: DocumentsFilterBarProps) {
  const location = useLocation();

  return (
    <div className="doc-toolbar">
      {knowledgeBaseError && (
        <p className="ui-inline-error" role="alert">
          {knowledgeBaseError}
          <Button variant="link" onClick={onReloadKnowledgeBases}>重试知识库列表</Button>
        </p>
      )}
      <div className="ui-toolbar">
        <DebouncedSearchInput
          aria-label="按文件名搜索"
          icon={<Search aria-hidden="true" />}
          onCommit={(q) => setFilter({ q })}
          placeholder="搜索文件名"
          value={filters.q}
          resetKey={location.key}
        />

        {!scopeKnowledgeBaseId && (
          <Select
            aria-label="知识库筛选"
            onChange={(event) => setFilter({ knowledgeBaseId: event.target.value })}
            value={filters.knowledgeBaseId}
          >
            <option value="">全部知识库</option>
            {knowledgeBases.map((item) => (
              <option key={item.id} value={item.id}>{item.name}</option>
            ))}
          </Select>
        )}

        <Select
          aria-label="类型筛选"
          onChange={(event) => setFilter({ fileType: event.target.value })}
          value={filters.fileType}
        >
          <option value="">全部类型</option>
          {fileTypes.map((type) => <option key={type} value={type}>{type}</option>)}
        </Select>

        <Select
          aria-label="排序"
          onChange={(event) => setFilter({ sort: event.target.value as DocumentSort })}
          value={filters.sort}
        >
          <option value="updatedAt_desc">最新更新</option>
          <option value="createdAt_desc">最新创建</option>
          <option value="filename_asc">文件名升序</option>
        </Select>

        <span className="ui-toolbar__spacer" />

        {scopeKnowledgeBaseId && importButton}

        <OverflowMenu
          label="更多文档操作"
          items={[
            { label: '刷新列表', icon: <RotateCw aria-hidden="true" />, onSelect: onRefresh },
            { label: '文档回收站', icon: <Trash2 aria-hidden="true" />, onSelect: onOpenRecycle },
          ]}
        />
      </div>

      {/* Status counts double as filters, so a failure count is one click from the list. */}
      <MetricStrip
        label="文档处理概况"
        metrics={[
          {
            key: 'all',
            label: '个文档',
            value: counts.total,
            active: filters.status === '',
            onToggle: () => setFilter({ status: '' }),
          },
          {
            key: 'completed',
            label: '可用于问答',
            value: counts.completed,
            active: filters.status === 'completed',
            onToggle: () => setFilter({ status: filters.status === 'completed' ? '' : 'completed' }),
          },
          {
            key: 'processing',
            label: '处理中',
            tone: 'warn',
            value: counts.processing,
            active: filters.status !== '' && filters.status !== 'completed' && filters.status !== 'failed',
            onToggle: () => setFilter({ status: filters.status === 'processing' ? '' : 'processing' }),
          },
          {
            key: 'failed',
            label: '失败',
            tone: 'danger',
            value: counts.failed,
            active: filters.status === 'failed',
            onToggle: () => setFilter({ status: filters.status === 'failed' ? '' : 'failed' }),
          },
        ]}
        trailing={activeFilterCount > 0 ? (
          <Button
            variant="link"
            onClick={() => setFilter({ q: '', status: '', fileType: '', knowledgeBaseId: scopeKnowledgeBaseId ? filters.knowledgeBaseId : '' })}
          >
            清除筛选
          </Button>
        ) : undefined}
      />

      {filters.status !== '' && filters.status !== 'completed' && filters.status !== 'failed' && (
        <div className="ui-inline-notice">
          <span>正在按“{filters.status === 'processing' ? '全部处理中' : documentStatusLabel(filters.status)}”筛选。</span>
          <Select
            aria-label="处理阶段"
            onChange={(event) => setFilter({ status: event.target.value as DocumentStatus | 'processing' })}
            value={filters.status}
          >
            <option value="processing">全部处理中</option>
            {documentStatuses
              .filter((status) => !isTerminalDocumentStatus(status))
              .map((status) => (
                <option key={status} value={status}>{documentStatusLabel(status)}</option>
              ))}
          </Select>
        </div>
      )}
    </div>
  );
}
