import { LayoutGrid, List, Search, Tags, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';

import { SearchInput, Select } from '../../components/ui/Field';
import { OverflowMenu } from '../../components/ui/OverflowMenu';
import { SegmentedControl } from '../../components/ui/SegmentedControl';
import type {
  KnowledgeBaseScope,
  KnowledgeBaseSort,
  KnowledgeBaseTag,
  WorkspaceViewMode,
  WorkspaceVisibility,
} from '../../types/api';
import type { KnowledgeBaseFilters } from './useKnowledgeBaseList';

const scopeTabs: Array<{ value: KnowledgeBaseScope; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'created', label: '我创建的' },
  { value: 'managed', label: '我管理的' },
  { value: 'favorite', label: '收藏' },
  { value: 'recent', label: '最近浏览' },
];

type ToolbarProps = {
  filters: KnowledgeBaseFilters;
  tags: KnowledgeBaseTag[];
  viewMode: WorkspaceViewMode;
  recycleCount: number | null;
  onFilter: (patch: Partial<KnowledgeBaseFilters>) => void;
  onViewMode: (mode: WorkspaceViewMode) => void;
  onOpenRecycleBin: () => void;
};

/**
 * Filters are never disabled. Under the old page any in-flight write — even
 * favouriting a single row — greyed out this entire bar.
 */
export function KnowledgeBaseToolbar({
  filters,
  tags,
  viewMode,
  recycleCount,
  onFilter,
  onViewMode,
  onOpenRecycleBin,
}: ToolbarProps) {
  const navigate = useNavigate();
  const [draft, setDraft] = useState(filters.q);

  useEffect(() => setDraft(filters.q), [filters.q]);

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onFilter({ q: draft.trim() });
  }

  return (
    <div className="kb-toolbar">
      <div className="ui-segmented kb-toolbar__scopes" role="group" aria-label="知识库范围">
        {scopeTabs.map((tab) => (
          <button
            aria-pressed={filters.scope === tab.value}
            key={tab.value}
            onClick={() => onFilter({ scope: tab.value })}
            type="button"
          >
            <span>{tab.label}</span>
          </button>
        ))}
      </div>

      <div className="ui-toolbar kb-toolbar__controls">
        <form className="kb-toolbar__search" onSubmit={submitSearch} role="search">
          <SearchInput
            aria-label="搜索知识库名称或描述"
            icon={<Search aria-hidden="true" />}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="搜索知识库"
            value={draft}
          />
        </form>

        <Select
          aria-label="标签筛选"
          onChange={(event) => onFilter({ tagId: event.target.value })}
          value={filters.tagId}
        >
          <option value="">全部标签</option>
          {tags.map((tag) => <option key={tag.id} value={tag.id}>{tag.name}</option>)}
        </Select>

        <Select
          aria-label="可见性筛选"
          onChange={(event) => onFilter({ visibility: event.target.value as WorkspaceVisibility })}
          value={filters.visibility}
        >
          <option value="all">全部可见性</option>
          <option value="public">公开</option>
          <option value="private">私有</option>
        </Select>

        <Select
          aria-label="排序"
          onChange={(event) => onFilter({ sort: event.target.value as KnowledgeBaseSort })}
          value={filters.sort}
        >
          <option value="updatedAt_desc">最新更新</option>
          <option value="createdAt_desc">最新创建</option>
          <option value="name_asc">名称升序</option>
        </Select>

        <span className="ui-toolbar__spacer" />

        <SegmentedControl
          label="视图模式"
          onChange={onViewMode}
          options={[
            { value: 'table', label: '列表视图', icon: <List aria-hidden="true" />, iconOnly: true },
            { value: 'card', label: '卡片视图', icon: <LayoutGrid aria-hidden="true" />, iconOnly: true },
          ]}
          value={viewMode}
        />

        <OverflowMenu
          label="更多工作台操作"
          items={[
            {
              label: recycleCount === null ? '回收站' : `回收站（${recycleCount}）`,
              icon: <Trash2 aria-hidden="true" />,
              onSelect: onOpenRecycleBin,
            },
            {
              label: '管理标签',
              icon: <Tags aria-hidden="true" />,
              onSelect: () => navigate('/tags'),
            },
          ]}
        />

      </div>
    </div>
  );
}
