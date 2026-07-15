import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

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
});
