import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Pencil, Plus, Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';

import { AppShell } from '../layouts/AppShell';
import type { AppSection } from '../layouts/AppShell';
import type { KnowledgeBaseCategory } from '../types/api';
import { IconButton } from './ui/IconButton';

type WorkspaceShellProps = {
  active: AppSection;
  categories?: KnowledgeBaseCategory[];
  categoryFilter?: string;
  expandedIds?: string[];
  categoryBusy?: boolean;
  categoryWorkingId?: string | null;
  onCreateCategory?: (parentId?: string) => void;
  onDeleteCategory?: (category: KnowledgeBaseCategory) => void;
  onEditCategory?: (category: KnowledgeBaseCategory) => void;
  onMoveCategory?: (categoryId: string, direction: 'up' | 'down') => void;
  onSelectCategory?: (categoryId: string) => void;
  onToggleExpanded?: (categoryId: string) => void;
  topbar?: ReactNode;
  children: ReactNode;
};

export function WorkspaceShell({
  active, categories = [], categoryFilter = '', expandedIds = [], categoryBusy = false, categoryWorkingId = null,
  onCreateCategory, onDeleteCategory, onEditCategory, onMoveCategory, onSelectCategory, onToggleExpanded,
  topbar: _legacyTopbar, children,
}: WorkspaceShellProps) {
  const hasCategoryWorkspace = active === 'knowledge-bases' && Boolean(
    onCreateCategory || onDeleteCategory || onEditCategory || onMoveCategory || onSelectCategory || onToggleExpanded,
  );
  const context = hasCategoryWorkspace ? (
    <section aria-busy={categoryBusy} className="category-context" aria-label="知识库分类">
      <div className="category-context__header"><strong>知识库分类</strong>{onCreateCategory && <IconButton data-app-drawer-dismiss="true" disabled={categoryBusy} label="新增根分类" onClick={() => onCreateCategory()}><Plus aria-hidden="true" /></IconButton>}</div>
      <div className="category-tree">
        {categories.length === 0 ? <p className="muted-text">暂无分类</p> : categories.map((category) => (
          <CategoryNode busy={categoryBusy} category={category} categoryFilter={categoryFilter} expandedIds={expandedIds} key={category.id} level={0} workingId={categoryWorkingId}
            onCreateCategory={onCreateCategory} onDeleteCategory={onDeleteCategory} onEditCategory={onEditCategory} onMoveCategory={onMoveCategory}
            onSelectCategory={onSelectCategory} onToggleExpanded={onToggleExpanded} />
        ))}
      </div>
    </section>
  ) : undefined;
  return <AppShell active={active} contextSidebar={context}>{children}</AppShell>;
}

type CategoryNodeProps = {
  busy: boolean; category: KnowledgeBaseCategory; categoryFilter: string; expandedIds: string[]; level: number; workingId: string | null;
  onCreateCategory?: (parentId?: string) => void; onDeleteCategory?: (category: KnowledgeBaseCategory) => void;
  onEditCategory?: (category: KnowledgeBaseCategory) => void; onMoveCategory?: (categoryId: string, direction: 'up' | 'down') => void;
  onSelectCategory?: (categoryId: string) => void; onToggleExpanded?: (categoryId: string) => void;
};

function CategoryNode({ busy, category, categoryFilter, expandedIds, level, workingId, onCreateCategory, onDeleteCategory, onEditCategory, onMoveCategory, onSelectCategory, onToggleExpanded }: CategoryNodeProps) {
  const hasChildren = Boolean(category.children?.length);
  const expanded = !hasChildren || expandedIds.includes(category.id);
  return (
    <div className="category-node">
      <div className={categoryFilter === category.id ? 'category-row active' : 'category-row'} style={{ paddingLeft: 8 + level * 16 }}>
        {hasChildren && onToggleExpanded ? <IconButton aria-expanded={expanded} className="category-tree__toggle" disabled={busy} label={expanded ? `折叠 ${category.name}` : `展开 ${category.name}`} onClick={() => onToggleExpanded(category.id)}>{expanded ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}</IconButton> : <span className="category-tree__spacer" aria-hidden="true" />}
        <button aria-current={categoryFilter === category.id ? 'true' : undefined} className="category-name" data-app-drawer-dismiss="true" disabled={busy || !onSelectCategory} onClick={() => onSelectCategory?.(category.id)} type="button">{category.name}</button>
        <div className="category-actions">
          {onCreateCategory && <IconButton data-app-drawer-dismiss="true" disabled={busy} label={`新增 ${category.name} 子分类`} onClick={() => onCreateCategory(category.id)}><Plus aria-hidden="true" /></IconButton>}
          {onEditCategory && <IconButton data-app-drawer-dismiss="true" disabled={busy} label={`编辑 ${category.name}`} onClick={() => onEditCategory(category)}><Pencil aria-hidden="true" /></IconButton>}
          {onMoveCategory && <><IconButton disabled={busy || workingId === category.id} label={`${category.name} 上移`} onClick={() => onMoveCategory(category.id, 'up')}><ArrowUp aria-hidden="true" /></IconButton><IconButton disabled={busy || workingId === category.id} label={`${category.name} 下移`} onClick={() => onMoveCategory(category.id, 'down')}><ArrowDown aria-hidden="true" /></IconButton></>}
          {onDeleteCategory && <IconButton data-app-drawer-dismiss="true" disabled={busy} label={`删除 ${category.name}`} tone="danger" onClick={() => onDeleteCategory(category)}><Trash2 aria-hidden="true" /></IconButton>}
        </div>
      </div>
      {expanded && category.children?.map((child) => <CategoryNode busy={busy} category={child} categoryFilter={categoryFilter} expandedIds={expandedIds} key={child.id} level={level + 1} workingId={workingId} onCreateCategory={onCreateCategory} onDeleteCategory={onDeleteCategory} onEditCategory={onEditCategory} onMoveCategory={onMoveCategory} onSelectCategory={onSelectCategory} onToggleExpanded={onToggleExpanded} />)}
    </div>
  );
}
