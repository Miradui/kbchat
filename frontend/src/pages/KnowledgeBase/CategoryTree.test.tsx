import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { KnowledgeBaseCategory } from '../../types/api';
import { CategoryTree } from './CategoryTree';

const child: KnowledgeBaseCategory = {
  id: 'child',
  parentId: 'parent',
  name: '接口设计与联调说明',
  sortOrder: 0,
  directCount: 12,
  totalCount: 12,
  createdAt: '',
  updatedAt: '',
};
const parent: KnowledgeBaseCategory = {
  ...child,
  id: 'parent',
  parentId: null,
  name: '产品资料',
  directCount: 3,
  totalCount: 15,
  children: [child],
};

function managementHandlers() {
  return {
    onCreateCategory: vi.fn(),
    onEditCategory: vi.fn(),
    onMoveCategory: vi.fn(),
    onDeleteCategory: vi.fn(),
    onSelectCategory: vi.fn(),
  };
}

describe('CategoryTree', () => {
  it.each([
    { label: '新增子分类', handler: 'onCreateCategory', args: [child.id] },
    { label: '编辑分类', handler: 'onEditCategory', args: [child] },
    { label: '上移', handler: 'onMoveCategory', args: [child.id, 'up'] },
    { label: '下移', handler: 'onMoveCategory', args: [child.id, 'down'] },
    { label: '删除分类', handler: 'onDeleteCategory', args: [child] },
  ] as const)('invokes $label for the category whose menu is open', async ({ label, handler, args }) => {
    const user = userEvent.setup();
    const handlers = managementHandlers();
    render(<CategoryTree categories={[parent]} expandedIds={[parent.id]} {...handlers} />);

    expect(screen.queryByRole('menuitem')).not.toBeInTheDocument();
    const trigger = screen.getByRole('button', { name: `${child.name} 的更多操作` });
    await user.click(trigger);
    const menu = screen.getByRole('menu', { name: `${child.name} 的更多操作` });
    await user.click(within(menu).getByRole('menuitem', { name: label }));

    expect(handlers[handler]).toHaveBeenCalledExactlyOnceWith(...args);
    expect(handlers.onSelectCategory).not.toHaveBeenCalled();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('keeps counts, full names and selection independent of the management menu', async () => {
    const user = userEvent.setup();
    const onSelectCategory = vi.fn();
    function Tree() {
      const [expandedIds, setExpandedIds] = useState<string[]>([]);
      return (
        <CategoryTree
          categories={[parent]}
          expandedIds={expandedIds}
          onEditCategory={vi.fn()}
          onSelectCategory={onSelectCategory}
          onToggleExpanded={(id) => setExpandedIds((current) => current.includes(id) ? [] : [id])}
          selectedId={child.id}
        />
      );
    }
    render(<Tree />);

    expect(screen.getByTitle('含子分类共 15 个知识库，本级 3 个')).toHaveTextContent('15');
    expect(screen.queryByRole('button', { name: child.name, exact: true })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: `展开 ${parent.name}` }));
    expect(screen.getByTitle('本级 3 个知识库')).toHaveTextContent('3');
    expect(screen.getByTitle('本级 12 个知识库')).toHaveTextContent('12');

    const name = screen.getByRole('button', { name: child.name, exact: true });
    expect(name).toHaveAttribute('title', child.name);
    expect(name).toHaveAttribute('aria-current', 'true');
    await user.click(name);
    expect(onSelectCategory).toHaveBeenCalledExactlyOnceWith(child.id);

    await user.click(screen.getByRole('button', { name: `${child.name} 的更多操作` }));
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: `折叠 ${parent.name}` }));
    expect(screen.getByTitle('含子分类共 15 个知识库，本级 3 个')).toHaveTextContent('15');
    expect(onSelectCategory).toHaveBeenCalledOnce();
  });

  it('disables only the pending category reorder commands and skips them with the keyboard', async () => {
    const user = userEvent.setup();
    const handlers = managementHandlers();
    render(
      <CategoryTree
        categories={[parent]}
        expandedIds={[parent.id]}
        pendingIds={new Set([parent.id])}
        {...handlers}
      />,
    );

    const trigger = screen.getByRole('button', { name: `${parent.name} 的更多操作` });
    await user.click(trigger);
    expect(screen.getByRole('menuitem', { name: '新增子分类' })).toHaveFocus();
    expect(screen.getByRole('menuitem', { name: '上移' })).toBeDisabled();
    expect(screen.getByRole('menuitem', { name: '下移' })).toBeDisabled();
    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: '删除分类' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(trigger).toHaveFocus();
    expect(handlers.onMoveCategory).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: `${child.name} 的更多操作` }));
    expect(screen.getByRole('menuitem', { name: '上移' })).toBeEnabled();
    await user.click(screen.getByRole('menuitem', { name: '下移' }));
    expect(handlers.onMoveCategory).toHaveBeenCalledExactlyOnceWith(child.id, 'down');
  });

  it('removes an open management menu when management mode ends without changing selection', async () => {
    const user = userEvent.setup();
    const handlers = managementHandlers();
    const { rerender } = render(
      <CategoryTree categories={[parent]} expandedIds={[]} selectedId={parent.id} {...handlers} />,
    );
    await user.click(screen.getByRole('button', { name: `${parent.name} 的更多操作` }));
    expect(screen.getByRole('menu')).toBeInTheDocument();

    rerender(
      <CategoryTree
        categories={[parent]}
        expandedIds={[]}
        selectedId={parent.id}
        onSelectCategory={handlers.onSelectCategory}
      />,
    );
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /的更多操作/u })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: parent.name, exact: true }));
    expect(handlers.onSelectCategory).toHaveBeenCalledExactlyOnceWith(parent.id);
  });
});
