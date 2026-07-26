import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderWithRouter } from '../test/render';
import type { KnowledgeBaseCategory } from '../types/api';
import { WorkspaceShell } from './WorkspaceShell';

const category = {
  id: 'c1', parentId: null, name: '制度', sortOrder: 1,
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
} satisfies KnowledgeBaseCategory;

describe('WorkspaceShell', () => {
  it('shows category context only for an interactive knowledge-base workspace', () => {
    const { unmount } = renderWithRouter(
      <WorkspaceShell active="home" categories={[category]}><p>首页</p></WorkspaceShell>,
    );
    expect(screen.queryByRole('region', { name: '知识库分类' })).not.toBeInTheDocument();

    unmount();
    renderWithRouter(
      <WorkspaceShell active="knowledge-bases" categories={[category]} onSelectCategory={() => undefined}>
        <p>知识库</p>
      </WorkspaceShell>,
    );
    expect(screen.getByRole('region', { name: '知识库分类' })).toBeInTheDocument();
  });

  it('ignores the legacy topbar instead of duplicating global controls', () => {
    renderWithRouter(
      <WorkspaceShell active="knowledge-bases" topbar={<button type="button">旧退出</button>}>
        <p>知识库</p>
      </WorkspaceShell>,
    );
    expect(screen.queryByRole('button', { name: '旧退出' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('textbox', { name: '全局搜索' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: '退出登录' })).toHaveLength(1);
  });

  it('locks category navigation and exposes the selected category while busy', () => {
    const onSelectCategory = vi.fn();
    const onToggleExpanded = vi.fn();
    const parent = {
      ...category,
      children: [{ ...category, id: 'c2', parentId: category.id, name: '子分类' }],
    } satisfies KnowledgeBaseCategory;
    renderWithRouter(
      <WorkspaceShell
        active="knowledge-bases"
        categories={[parent]}
        categoryBusy
        categoryFilter={category.id}
        onSelectCategory={onSelectCategory}
        onToggleExpanded={onToggleExpanded}
      >
        <p>知识库</p>
      </WorkspaceShell>,
    );

    const region = screen.getByRole('region', { name: '知识库分类' });
    const categoryButton = screen.getByRole('button', { name: '制度' });
    const expandButton = screen.getByRole('button', { name: '展开 制度' });
    expect(region).toHaveAttribute('aria-busy', 'true');
    expect(categoryButton).toBeDisabled();
    expect(categoryButton).toHaveAttribute('aria-current', 'true');
    expect(expandButton).toBeDisabled();

    categoryButton.click();
    expandButton.click();
    expect(onSelectCategory).not.toHaveBeenCalled();
    expect(onToggleExpanded).not.toHaveBeenCalled();
  });

  it('marks only category actions that should dismiss the mobile drawer', () => {
    const parent = {
      ...category,
      children: [{ ...category, id: 'c2', parentId: category.id, name: '子分类' }],
    } satisfies KnowledgeBaseCategory;
    renderWithRouter(
      <WorkspaceShell
        active="knowledge-bases"
        categories={[parent]}
        onCreateCategory={vi.fn()}
        onDeleteCategory={vi.fn()}
        onEditCategory={vi.fn()}
        onMoveCategory={vi.fn()}
        onSelectCategory={vi.fn()}
        onToggleExpanded={vi.fn()}
      >
        <p>知识库</p>
      </WorkspaceShell>,
    );

    expect(screen.getByRole('button', { name: '制度' })).toHaveAttribute('data-app-drawer-dismiss', 'true');
    expect(screen.getByRole('button', { name: '编辑 制度' })).toHaveAttribute('data-app-drawer-dismiss', 'true');
    expect(screen.getByRole('button', { name: '新增根分类' })).toHaveAttribute('data-app-drawer-dismiss', 'true');
    expect(screen.getByRole('button', { name: '展开 制度' })).not.toHaveAttribute('data-app-drawer-dismiss');
    expect(screen.getByRole('button', { name: '制度 上移' })).not.toHaveAttribute('data-app-drawer-dismiss');
  });
});
