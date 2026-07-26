import { Plus, X } from 'lucide-react';

import { Button } from '../../components/ui/Button';
import { IconButton } from '../../components/ui/IconButton';
import { useModalFocus } from '../../components/ui/useModalFocus';
import type { KnowledgeBaseCategory } from '../../types/api';
import { CategoryTree } from './CategoryTree';

type CategoryManagerDrawerProps = {
  busy: boolean;
  categories: KnowledgeBaseCategory[];
  expandedIds: string[];
  workingId: string | null;
  onClose: () => void;
  onCreateCategory: (parentId?: string) => void;
  onDeleteCategory: (category: KnowledgeBaseCategory) => void;
  onEditCategory: (category: KnowledgeBaseCategory) => void;
  onMoveCategory: (categoryId: string, direction: 'up' | 'down') => void;
  onToggleExpanded: (categoryId: string) => void;
};

export function CategoryManagerDrawer({
  busy,
  categories,
  expandedIds,
  workingId,
  onClose,
  onCreateCategory,
  onDeleteCategory,
  onEditCategory,
  onMoveCategory,
  onToggleExpanded,
}: CategoryManagerDrawerProps) {
  const requestClose = () => {
    if (!busy) onClose();
  };
  const panelRef = useModalFocus<HTMLElement>(true, requestClose);

  return (
    <aside className="drawer-backdrop" role="presentation">
      <section
        aria-busy={busy}
        aria-labelledby="category-manager-title"
        aria-modal="true"
        className="drawer-panel category-manager-drawer"
        ref={panelRef}
        role="dialog"
        tabIndex={-1}
      >
        <header>
          <div>
            <h2 id="category-manager-title">管理分类</h2>
            <p className="muted-text">维护分类层级和展示顺序。</p>
          </div>
          <IconButton disabled={busy} label="关闭分类管理" onClick={requestClose}><X aria-hidden="true" /></IconButton>
        </header>
        <div className="category-manager-drawer__toolbar">
          <Button disabled={busy} leadingIcon={<Plus aria-hidden="true" />} onClick={() => onCreateCategory()}>
            新建根分类
          </Button>
        </div>
        <div className="category-manager-drawer__tree">
          <CategoryTree
            busy={busy}
            categories={categories}
            expandedIds={expandedIds}
            onCreateCategory={onCreateCategory}
            onDeleteCategory={onDeleteCategory}
            onEditCategory={onEditCategory}
            onMoveCategory={onMoveCategory}
            onToggleExpanded={onToggleExpanded}
            workingId={workingId}
          />
        </div>
      </section>
    </aside>
  );
}
