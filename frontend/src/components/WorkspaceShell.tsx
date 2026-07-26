import type { ReactNode } from 'react';

import { AppShell } from '../layouts/AppShell';
import type { AppSection } from '../layouts/AppShell';
import type { KnowledgeBaseCategory } from '../types/api';
import { CategoryTree } from '../pages/KnowledgeBase/CategoryTree';

type WorkspaceShellProps = {
  active: AppSection;
  categories?: KnowledgeBaseCategory[];
  categoryFilter?: string;
  expandedIds?: string[];
  categoryBusy?: boolean;
  onManageCategories?: () => void;
  onSelectCategory?: (categoryId: string) => void;
  onToggleExpanded?: (categoryId: string) => void;
  topbar?: ReactNode;
  children: ReactNode;
};

export function WorkspaceShell({
  active, categories = [], categoryFilter = '', expandedIds = [], categoryBusy = false,
  onManageCategories, onSelectCategory, onToggleExpanded,
  topbar: _legacyTopbar, children,
}: WorkspaceShellProps) {
  const hasCategoryWorkspace = active === 'knowledge-bases' && Boolean(
    onManageCategories || onSelectCategory || onToggleExpanded,
  );
  const context = hasCategoryWorkspace ? (
    <section aria-busy={categoryBusy} className="category-context" aria-label="知识库分类">
      <div className="category-context__header">
        <strong>知识库分类</strong>
        {onManageCategories && <button className="link-button" data-app-drawer-dismiss="true" disabled={categoryBusy} onClick={onManageCategories} type="button">管理分类</button>}
      </div>
      <CategoryTree busy={categoryBusy} categories={categories} categoryFilter={categoryFilter} dismissOnSelect expandedIds={expandedIds} onSelectCategory={onSelectCategory} onToggleExpanded={onToggleExpanded} />
    </section>
  ) : undefined;
  return <AppShell active={active} contextSidebar={context}>{children}</AppShell>;
}
