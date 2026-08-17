import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Pencil, Plus, Trash2 } from 'lucide-react';

import { IconButton } from '../../components/ui/IconButton';
import type { KnowledgeBaseCategory } from '../../types/api';

type CategoryTreeProps = {
  categories: KnowledgeBaseCategory[];
  expandedIds: string[];
  /** Currently filtered category, or '' for none. */
  selectedId?: string;
  /** Ids with an in-flight reorder. Only those rows are disabled. */
  pendingIds?: ReadonlySet<string>;
  onCreateCategory?: (parentId?: string) => void;
  onDeleteCategory?: (category: KnowledgeBaseCategory) => void;
  onEditCategory?: (category: KnowledgeBaseCategory) => void;
  onMoveCategory?: (categoryId: string, direction: 'up' | 'down') => void;
  onSelectCategory?: (categoryId: string) => void;
  onToggleExpanded?: (categoryId: string) => void;
};

const noPending: ReadonlySet<string> = new Set();

/**
 * Counts come from the category tree endpoint (docs/14-frontend-api-gaps.md G5).
 * They are optional because create/update responses return a single node with no
 * subtree; a node without them renders no badge rather than a misleading zero.
 */
function categoryCountBadge(
  category: KnowledgeBaseCategory,
  rollUp: boolean,
): { countLabel: string | null; countTitle: string | undefined } {
  const total = category.totalCount;
  const direct = category.directCount;
  const value = rollUp ? total ?? direct : direct;
  if (value === undefined) {
    return { countLabel: null, countTitle: undefined };
  }
  const title = rollUp && total !== undefined && total !== direct && direct !== undefined
    ? `含子分类共 ${total} 个知识库，本级 ${direct} 个`
    : `本级 ${value} 个知识库`;
  return { countLabel: String(value), countTitle: title };
}

export function CategoryTree({
  categories,
  expandedIds,
  selectedId = '',
  pendingIds = noPending,
  ...handlers
}: CategoryTreeProps) {
  if (categories.length === 0) {
    return <p className="cat-tree__empty">暂无分类</p>;
  }

  return (
    <ul aria-label="分类层级" className="cat-tree">
      {categories.map((category) => (
        <CategoryNode
          category={category}
          expandedIds={expandedIds}
          key={category.id}
          level={0}
          pendingIds={pendingIds}
          selectedId={selectedId}
          {...handlers}
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
  category,
  expandedIds,
  level,
  selectedId = '',
  pendingIds = noPending,
  onCreateCategory,
  onDeleteCategory,
  onEditCategory,
  onMoveCategory,
  onSelectCategory,
  onToggleExpanded,
}: CategoryNodeProps) {
  const children = category.children ?? [];
  const hasChildren = children.length > 0;
  const expanded = !hasChildren || expandedIds.includes(category.id);
  const selected = selectedId === category.id;
  const pending = pendingIds.has(category.id);
  const hasActions = Boolean(onCreateCategory || onEditCategory || onMoveCategory || onDeleteCategory);
  const { countLabel, countTitle } = categoryCountBadge(category, hasChildren && !expanded);

  return (
    <li className="cat-tree__node">
      <div
        className={selected ? 'cat-tree__row is-selected' : 'cat-tree__row'}
        style={{ paddingLeft: 4 + level * 14 }}
      >
        {hasChildren && onToggleExpanded ? (
          <IconButton
            aria-expanded={expanded}
            className="cat-tree__toggle"
            label={expanded ? `折叠 ${category.name}` : `展开 ${category.name}`}
            onClick={() => onToggleExpanded(category.id)}
          >
            {expanded ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
          </IconButton>
        ) : (
          <span aria-hidden="true" className="cat-tree__spacer" />
        )}

        {onSelectCategory ? (
          <button
            aria-current={selected ? 'true' : undefined}
            className="cat-tree__name"
            onClick={() => onSelectCategory(category.id)}
            type="button"
          >
            {category.name}
          </button>
        ) : (
          <span className="cat-tree__name cat-tree__name--static">{category.name}</span>
        )}

        {/* Collapsed parents stand in for their subtree, so they show the rolled-up
            count; an expanded parent shows only what it holds directly. */}
        {countLabel !== null && (
          <span className="cat-tree__count" title={countTitle}>{countLabel}</span>
        )}

        {hasActions && (
          <div className="cat-tree__actions">
            {onCreateCategory && (
              <IconButton label={`新增 ${category.name} 子分类`} onClick={() => onCreateCategory(category.id)}>
                <Plus aria-hidden="true" />
              </IconButton>
            )}
            {onEditCategory && (
              <IconButton label={`编辑 ${category.name}`} onClick={() => onEditCategory(category)}>
                <Pencil aria-hidden="true" />
              </IconButton>
            )}
            {onMoveCategory && (
              <>
                <IconButton disabled={pending} label={`${category.name} 上移`} onClick={() => onMoveCategory(category.id, 'up')}>
                  <ArrowUp aria-hidden="true" />
                </IconButton>
                <IconButton disabled={pending} label={`${category.name} 下移`} onClick={() => onMoveCategory(category.id, 'down')}>
                  <ArrowDown aria-hidden="true" />
                </IconButton>
              </>
            )}
            {onDeleteCategory && (
              <IconButton label={`删除 ${category.name}`} tone="danger" onClick={() => onDeleteCategory(category)}>
                <Trash2 aria-hidden="true" />
              </IconButton>
            )}
          </div>
        )}
      </div>

      {expanded && hasChildren && (
        <ul className="cat-tree__group">
          {children.map((child) => (
            <CategoryNode
              category={child}
              expandedIds={expandedIds}
              key={child.id}
              level={level + 1}
              onCreateCategory={onCreateCategory}
              onDeleteCategory={onDeleteCategory}
              onEditCategory={onEditCategory}
              onMoveCategory={onMoveCategory}
              onSelectCategory={onSelectCategory}
              onToggleExpanded={onToggleExpanded}
              pendingIds={pendingIds}
              selectedId={selectedId}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
