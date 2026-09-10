import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Pencil, Plus, Trash2 } from 'lucide-react';

import { IconButton } from '../../components/ui/IconButton';
import { OverflowMenu, type OverflowMenuItem } from '../../components/ui/OverflowMenu';
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
  const { countLabel, countTitle } = categoryCountBadge(category, hasChildren && !expanded);
  const actions: OverflowMenuItem[] = [];

  if (onCreateCategory) {
    actions.push({
      label: '新增子分类',
      icon: <Plus aria-hidden="true" />,
      onSelect: () => onCreateCategory(category.id),
    });
  }
  if (onEditCategory) {
    actions.push({
      label: '编辑分类',
      icon: <Pencil aria-hidden="true" />,
      onSelect: () => onEditCategory(category),
    });
  }
  if (onMoveCategory) {
    actions.push(
      {
        label: '上移',
        icon: <ArrowUp aria-hidden="true" />,
        disabled: pending,
        onSelect: () => onMoveCategory(category.id, 'up'),
      },
      {
        label: '下移',
        icon: <ArrowDown aria-hidden="true" />,
        disabled: pending,
        onSelect: () => onMoveCategory(category.id, 'down'),
      },
    );
  }
  if (onDeleteCategory) {
    actions.push({
      label: '删除分类',
      icon: <Trash2 aria-hidden="true" />,
      tone: 'danger',
      onSelect: () => onDeleteCategory(category),
    });
  }

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
            title={category.name}
            type="button"
          >
            <span className="cat-tree__label">{category.name}</span>
          </button>
        ) : (
          <span className="cat-tree__name cat-tree__name--static" title={category.name}>
            <span className="cat-tree__label">{category.name}</span>
          </span>
        )}

        {/* Collapsed parents stand in for their subtree, so they show the rolled-up
            count; an expanded parent shows only what it holds directly. */}
        {countLabel !== null && (
          <span className="cat-tree__count" title={countTitle}>{countLabel}</span>
        )}

        {actions.length > 0 && (
          <div className="cat-tree__actions">
            <OverflowMenu items={actions} label={`${category.name} 的更多操作`} />
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
