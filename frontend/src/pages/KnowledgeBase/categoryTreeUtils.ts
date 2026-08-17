import type { KnowledgeBaseCategory, KnowledgeBaseCategoryReorderItem } from '../../types/api';

export type CategoryOption = { id: string; label: string };

/** Flattens the tree into `<select>` options, indenting by depth. */
export function flattenCategories(categories: KnowledgeBaseCategory[], level = 0): CategoryOption[] {
  return categories.flatMap((category) => [
    { id: category.id, label: `${'　'.repeat(level)}${category.name}` },
    ...flattenCategories(category.children ?? [], level + 1),
  ]);
}

/** Keeps a category the user cannot see (e.g. removed by a filter) selectable. */
export function withCurrentCategory(options: CategoryOption[], currentId: string): CategoryOption[] {
  if (!currentId || options.some((option) => option.id === currentId)) return options;
  return [{ id: currentId, label: '当前分类' }, ...options];
}

export function findCategoryById(
  categories: KnowledgeBaseCategory[],
  categoryId: string,
): KnowledgeBaseCategory | null {
  for (const category of categories) {
    if (category.id === categoryId) return category;
    const found = findCategoryById(category.children ?? [], categoryId);
    if (found) return found;
  }
  return null;
}

export function findCategoryName(categories: KnowledgeBaseCategory[], categoryId: string): string | null {
  return findCategoryById(categories, categoryId)?.name ?? null;
}

function flattenCategoryIds(categories: KnowledgeBaseCategory[]): string[] {
  return categories.flatMap((category) => [category.id, ...flattenCategoryIds(category.children ?? [])]);
}

/** Ids that must not be offered as a parent, to avoid creating a cycle. */
export function descendantCategoryIds(categories: KnowledgeBaseCategory[], categoryId: string): string[] {
  const category = findCategoryById(categories, categoryId);
  return category ? flattenCategoryIds(category.children ?? []) : [];
}

function findCategorySiblings(
  categories: KnowledgeBaseCategory[],
  parentId: string | null,
): KnowledgeBaseCategory[] {
  if (parentId === null) return categories;
  return findCategoryById(categories, parentId)?.children ?? [];
}

export function nextCategorySortOrder(
  categories: KnowledgeBaseCategory[],
  parentId: string | null,
): number {
  const siblings = findCategorySiblings(categories, parentId);
  return siblings.reduce((max, category) => Math.max(max, category.sortOrder), 0) + 10;
}

function findCategorySiblingGroup(
  categories: KnowledgeBaseCategory[],
  categoryId: string,
): { parentId: string | null; siblings: KnowledgeBaseCategory[] } | null {
  if (categories.some((category) => category.id === categoryId)) {
    return { parentId: null, siblings: categories };
  }
  for (const category of categories) {
    const children = category.children ?? [];
    if (children.some((child) => child.id === categoryId)) {
      return { parentId: category.id, siblings: children };
    }
    const found = findCategorySiblingGroup(children, categoryId);
    if (found) return found;
  }
  return null;
}

function sortCategories(categories: KnowledgeBaseCategory[]): KnowledgeBaseCategory[] {
  return [...categories].sort((left, right) => (
    left.sortOrder - right.sortOrder
    || left.name.localeCompare(right.name, 'zh-CN')
    || left.id.localeCompare(right.id)
  ));
}

function flattenReorderItems(
  categories: KnowledgeBaseCategory[],
  sortOrderById: Map<string, number>,
  parentId: string | null = null,
): KnowledgeBaseCategoryReorderItem[] {
  return categories.flatMap((category) => {
    const itemParentId = category.parentId ?? parentId;
    return [
      {
        id: category.id,
        parentId: itemParentId,
        sortOrder: sortOrderById.get(category.id) ?? category.sortOrder,
      },
      ...flattenReorderItems(category.children ?? [], sortOrderById, category.id),
    ];
  });
}

/**
 * The reorder API requires the caller's complete tree, so a single move still
 * submits every node. Returns null when the move is not possible.
 */
export function categoryReorderItemsAfterMove(
  categories: KnowledgeBaseCategory[],
  categoryId: string,
  direction: 'up' | 'down',
): KnowledgeBaseCategoryReorderItem[] | null {
  const group = findCategorySiblingGroup(categories, categoryId);
  if (!group) return null;

  const siblings = sortCategories(group.siblings);
  const currentIndex = siblings.findIndex((category) => category.id === categoryId);
  const nextIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
  if (currentIndex < 0 || nextIndex < 0 || nextIndex >= siblings.length) return null;

  const reordered = [...siblings];
  [reordered[currentIndex], reordered[nextIndex]] = [reordered[nextIndex], reordered[currentIndex]];

  const sortOrderById = new Map<string, number>();
  reordered.forEach((category, index) => sortOrderById.set(category.id, (index + 1) * 10));

  return flattenReorderItems(categories, sortOrderById);
}
