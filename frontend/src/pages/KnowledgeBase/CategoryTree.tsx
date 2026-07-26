import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Pencil, Plus, Trash2 } from 'lucide-react';

import { IconButton } from '../../components/ui/IconButton';
import type { KnowledgeBaseCategory } from '../../types/api';

type CategoryTreeProps = {
  busy: boolean;
  categories: KnowledgeBaseCategory[];
  categoryFilter?: string;
  expandedIds: string[];
  workingId?: string | null;
  dismissOnSelect?: boolean;
  onCreateCategory?: (parentId?: string) => void;
  onDeleteCategory?: (category: KnowledgeBaseCategory) => void;
  onEditCategory?: (category: KnowledgeBaseCategory) => void;
  onMoveCategory?: (categoryId: string, direction: 'up' | 'down') => void;
  onSelectCategory?: (categoryId: string) => void;
  onToggleExpanded?: (categoryId: string) => void;
};

export function CategoryTree({
  busy,
  categories,
  categoryFilter = '',
  expandedIds,
  workingId = null,
  dismissOnSelect = false,
  onCreateCategory,
  onDeleteCategory,
  onEditCategory,
  onMoveCategory,
  onSelectCategory,
  onToggleExpanded,
}: CategoryTreeProps) {
  if (categories.length === 0) {
    return <p className="muted-text">暂无分类</p>;
  }

  return (
    <ul aria-label="分类层级" className="category-tree">
      {categories.map((category) => (
        <CategoryNode
          busy={busy}
          category={category}
          categoryFilter={categoryFilter}
          dismissOnSelect={dismissOnSelect}
          expandedIds={expandedIds}
          key={category.id}
          level={0}
          onCreateCategory={onCreateCategory}
          onDeleteCategory={onDeleteCategory}
          onEditCategory={onEditCategory}
          onMoveCategory={onMoveCategory}
          onSelectCategory={onSelectCategory}
          onToggleExpanded={onToggleExpanded}
          workingId={workingId}
        />
      ))}
    </ul>
  );
}

type CategoryNodeProps = Omit<CategoryTreeProps, 'categories'> & {
  category: KnowledgeBaseCategory;
  level: number;
};

function CategoryNode({
  busy,
  category,
  categoryFilter = '',
  dismissOnSelect = false,
  expandedIds,
  level,
  workingId,
  onCreateCategory,
  onDeleteCategory,
  onEditCategory,
  onMoveCategory,
  onSelectCategory,
  onToggleExpanded,
}: CategoryNodeProps) {
  const hasChildren = Boolean(category.children?.length);
  const expanded = !hasChildren || expandedIds.includes(category.id);
  return (
    <li className="category-node">
      <div className={categoryFilter === category.id ? 'category-row active' : 'category-row'} style={{ paddingLeft: 8 + level * 16 }}>
        {hasChildren && onToggleExpanded ? (
          <IconButton
            aria-expanded={expanded}
            className="category-tree__toggle"
            disabled={busy}
            label={expanded ? `折叠 ${category.name}` : `展开 ${category.name}`}
            onClick={() => onToggleExpanded(category.id)}
          >
            {expanded ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
          </IconButton>
        ) : <span className="category-tree__spacer" aria-hidden="true" />}
        {onSelectCategory ? (
          <button
            aria-current={categoryFilter === category.id ? 'true' : undefined}
            className="category-name"
            data-app-drawer-dismiss={dismissOnSelect ? 'true' : undefined}
            disabled={busy}
            onClick={() => onSelectCategory(category.id)}
            type="button"
          >
            {category.name}
          </button>
        ) : <span className="category-name category-name--label">{category.name}</span>}
        {(onCreateCategory || onEditCategory || onMoveCategory || onDeleteCategory) && (
          <div className="category-actions">
            {onCreateCategory && <IconButton disabled={busy} label={`新增 ${category.name} 子分类`} onClick={() => onCreateCategory(category.id)}><Plus aria-hidden="true" /></IconButton>}
            {onEditCategory && <IconButton disabled={busy} label={`编辑 ${category.name}`} onClick={() => onEditCategory(category)}><Pencil aria-hidden="true" /></IconButton>}
            {onMoveCategory && <><IconButton disabled={busy || workingId === category.id} label={`${category.name} 上移`} onClick={() => onMoveCategory(category.id, 'up')}><ArrowUp aria-hidden="true" /></IconButton><IconButton disabled={busy || workingId === category.id} label={`${category.name} 下移`} onClick={() => onMoveCategory(category.id, 'down')}><ArrowDown aria-hidden="true" /></IconButton></>}
            {onDeleteCategory && <IconButton disabled={busy} label={`删除 ${category.name}`} tone="danger" onClick={() => onDeleteCategory(category)}><Trash2 aria-hidden="true" /></IconButton>}
          </div>
        )}
      </div>
      {expanded && Boolean(category.children?.length) && (
        <ul className="category-tree__group">
          {category.children?.map((child) => (
            <CategoryNode
              busy={busy}
              category={child}
              categoryFilter={categoryFilter}
              dismissOnSelect={dismissOnSelect}
              expandedIds={expandedIds}
              key={child.id}
              level={level + 1}
              onCreateCategory={onCreateCategory}
              onDeleteCategory={onDeleteCategory}
              onEditCategory={onEditCategory}
              onMoveCategory={onMoveCategory}
              onSelectCategory={onSelectCategory}
              onToggleExpanded={onToggleExpanded}
              workingId={workingId}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
