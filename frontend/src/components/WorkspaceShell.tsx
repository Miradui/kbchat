import type { ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';

import { logout } from '../api/resources';
import { tokenStore } from '../store/tokenStore';
import type { KnowledgeBaseCategory } from '../types/api';

type WorkspaceShellProps = {
  active: 'home' | 'knowledge-bases' | 'documents' | 'chat' | 'tags' | 'search';
  categories?: KnowledgeBaseCategory[];
  categoryFilter?: string;
  expandedIds?: string[];
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
  active,
  categories = [],
  categoryFilter = '',
  expandedIds = [],
  categoryWorkingId = null,
  onCreateCategory,
  onDeleteCategory,
  onEditCategory,
  onMoveCategory,
  onSelectCategory,
  onToggleExpanded,
  topbar,
  children,
}: WorkspaceShellProps) {
  return (
    <section className="workspace-page">
      <aside className="workspace-sidebar" aria-label="知识库分类">
        <Link className="brand-mark workspace-brand" to="/home" aria-label="智能知识库">
          <span className="brand-icon">▣</span>
          <strong>智能知识库</strong>
        </Link>

        <WorkspaceNav active={active} />

        <div className="category-header">
          <strong>知识库分类</strong>
          <button
            className="icon-button"
            type="button"
            title={onCreateCategory ? '新增根分类' : '当前页面不支持新增分类'}
            aria-label="新增分类"
            onClick={() => onCreateCategory?.()}
            disabled={!onCreateCategory}
          >
            +
          </button>
        </div>

        <div className="category-tree">
          {categories.length === 0 ? (
            <p className="muted-text">暂无分类</p>
          ) : (
            categories.map((category) => (
              <CategoryNode
                category={category}
                categoryFilter={categoryFilter}
                expandedIds={expandedIds}
                key={category.id}
                level={0}
                workingId={categoryWorkingId}
                onCreateCategory={onCreateCategory}
                onDeleteCategory={onDeleteCategory}
                onEditCategory={onEditCategory}
                onMoveCategory={onMoveCategory}
                onSelectCategory={onSelectCategory}
                onToggleExpanded={onToggleExpanded}
              />
            ))
          )}
        </div>

        <Link className="system-link" to="/knowledge-bases">系统设置</Link>
      </aside>

      <main className="workspace-main">
        {topbar ?? <DefaultTopbar />}
        <div className="workspace-content">{children}</div>
      </main>
    </section>
  );
}

function DefaultTopbar() {
  const navigate = useNavigate();

  async function handleLogout() {
    try {
      await logout();
    } catch {
      // Local logout should still happen if the server token is already invalid.
    } finally {
      tokenStore.clearToken();
      navigate('/login', { replace: true });
    }
  }

  return (
    <header className="workspace-topbar">
      <div className="topbar-actions" aria-label="用户工具">
        <button className="secondary-button" type="button" onClick={() => void handleLogout()}>
          退出登录
        </button>
      </div>
    </header>
  );
}

function WorkspaceNav({ active }: { active: WorkspaceShellProps['active'] }) {
  const location = useLocation();
  const homeActive = active === 'home' || location.pathname === '/home' || location.pathname === '/';

  return (
    <nav className="workspace-nav" aria-label="主导航">
      <Link className={homeActive ? 'active strong' : ''} to="/home">首页</Link>
      <Link className={active === 'knowledge-bases' ? 'active strong' : ''} to="/knowledge-bases">知识库</Link>
      <Link className={active === 'documents' ? 'active strong' : ''} to="/documents">文档管理</Link>
      <Link className={active === 'chat' ? 'active strong' : ''} to="/chat">问答管理</Link>
      <Link className={active === 'tags' ? 'active strong' : ''} to="/tags">标签管理</Link>
      <span>权限管理</span>
    </nav>
  );
}

function CategoryNode({
  category,
  categoryFilter,
  expandedIds,
  level,
  workingId,
  onCreateCategory,
  onDeleteCategory,
  onEditCategory,
  onMoveCategory,
  onSelectCategory,
  onToggleExpanded,
}: {
  category: KnowledgeBaseCategory;
  categoryFilter: string;
  expandedIds: string[];
  level: number;
  workingId: string | null;
  onCreateCategory?: (parentId?: string) => void;
  onDeleteCategory?: (category: KnowledgeBaseCategory) => void;
  onEditCategory?: (category: KnowledgeBaseCategory) => void;
  onMoveCategory?: (categoryId: string, direction: 'up' | 'down') => void;
  onSelectCategory?: (categoryId: string) => void;
  onToggleExpanded?: (categoryId: string) => void;
}) {
  const hasChildren = Boolean(category.children?.length);
  const expanded = !hasChildren || expandedIds.includes(category.id);
  const canInteract = Boolean(onSelectCategory && onToggleExpanded);
  const canManage = Boolean(onCreateCategory || onDeleteCategory || onEditCategory || onMoveCategory);

  return (
    <div className="category-node">
      <div className={categoryFilter === category.id ? 'category-row active' : 'category-row'} style={{ paddingLeft: 8 + level * 16 }}>
        <button
          className="tree-toggle"
          type="button"
          onClick={() => {
            if (!canInteract) {
              return;
            }
            if (hasChildren) {
              onToggleExpanded?.(category.id);
            } else {
              onSelectCategory?.(category.id);
            }
          }}
          aria-label={expanded ? '折叠分类' : '展开分类'}
          disabled={!canInteract}
        >
          {hasChildren ? (expanded ? '⌄' : '›') : '•'}
        </button>
        <button
          className="category-name"
          type="button"
          onClick={() => onSelectCategory?.(category.id)}
          disabled={!canInteract}
        >
          {category.name}
        </button>
        {canManage && (
          <div className="category-actions">
            {onCreateCategory && (
              <button type="button" aria-label={`新增 ${category.name} 子分类`} title="新增子分类" onClick={() => onCreateCategory(category.id)}>
                +
              </button>
            )}
            {onEditCategory && (
              <button type="button" aria-label={`编辑 ${category.name}`} title="编辑分类" onClick={() => onEditCategory(category)}>
                edit
              </button>
            )}
            {onMoveCategory && (
              <>
                <button type="button" aria-label={`${category.name} 上移`} title="上移" disabled={workingId === category.id} onClick={() => onMoveCategory(category.id, 'up')}>
                  ↑
                </button>
                <button type="button" aria-label={`${category.name} 下移`} title="下移" disabled={workingId === category.id} onClick={() => onMoveCategory(category.id, 'down')}>
                  ↓
                </button>
              </>
            )}
            {onDeleteCategory && (
              <button type="button" aria-label={`删除 ${category.name}`} title="删除分类" onClick={() => onDeleteCategory(category)}>
                ×
              </button>
            )}
          </div>
        )}
      </div>
      {expanded &&
        category.children?.map((child) => (
          <CategoryNode
            category={child}
            categoryFilter={categoryFilter}
            expandedIds={expandedIds}
            key={child.id}
            level={level + 1}
            workingId={workingId}
            onCreateCategory={onCreateCategory}
            onDeleteCategory={onDeleteCategory}
            onEditCategory={onEditCategory}
            onMoveCategory={onMoveCategory}
            onSelectCategory={onSelectCategory}
            onToggleExpanded={onToggleExpanded}
          />
        ))}
    </div>
  );
}
