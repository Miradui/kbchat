import { FolderInput, Lock, Pencil, Star, Trash2, Globe } from 'lucide-react';
import { Link } from 'react-router-dom';

import { Badge } from '../../components/ui/Badge';
import { Checkbox } from '../../components/ui/Field';
import { IconButton } from '../../components/ui/IconButton';
import { OverflowMenu } from '../../components/ui/OverflowMenu';
import type { OverflowMenuItem } from '../../components/ui/OverflowMenu';
import type { KnowledgeBase } from '../../types/api';
import { canUnlessUnknown } from '../../utils/access';
import { formatCount, formatRelativeTime } from '../../utils/format';
import { getKnowledgeBaseReadiness } from './knowledgeBaseReadiness';

export type RowHandlers = {
  isPending: (id: string) => boolean;
  onDelete: (item: KnowledgeBase) => void;
  onEdit: (item: KnowledgeBase) => void;
  onFavorite: (item: KnowledgeBase) => void;
  onMove: (item: KnowledgeBase) => void;
  onOpen: (item: KnowledgeBase) => void;
  onToggleSelected: (id: string) => void;
};

export function KnowledgeBaseGlyph({ visibility, large = false }: { visibility?: string; large?: boolean }) {
  const isPublic = visibility === 'public';
  return (
    <span
      aria-hidden="true"
      className={[
        'ui-kb-glyph',
        isPublic && 'ui-kb-glyph--public',
        large && 'ui-kb-glyph--lg',
      ].filter(Boolean).join(' ')}
    >
      {isPublic ? <Globe /> : <Lock />}
    </span>
  );
}

/** Star plus an overflow menu. Only this row's controls are disabled while it mutates. */
function RowActions({ item, handlers }: { item: KnowledgeBase; handlers: RowHandlers }) {
  const pending = handlers.isPending(item.id);
  // Favouriting is deliberately never gated: it writes the caller's own bookmark,
  // not the knowledge base, so a viewer keeps it.
  const items: OverflowMenuItem[] = [];
  if (canUnlessUnknown(item, 'kb.write')) {
    items.push({ label: '编辑', icon: <Pencil aria-hidden="true" />, onSelect: () => handlers.onEdit(item) });
    items.push({ label: '移动到分类', icon: <FolderInput aria-hidden="true" />, onSelect: () => handlers.onMove(item) });
  }
  if (canUnlessUnknown(item, 'kb.delete')) {
    items.push({ label: '删除', icon: <Trash2 aria-hidden="true" />, tone: 'danger', onSelect: () => handlers.onDelete(item) });
  }
  return (
    <div className="kb-row-actions">
      <IconButton
        className={item.isFavorite ? 'is-on' : undefined}
        disabled={pending}
        label={item.isFavorite ? `取消收藏 ${item.name}` : `收藏 ${item.name}`}
        onClick={() => handlers.onFavorite(item)}
      >
        <Star aria-hidden="true" fill={item.isFavorite ? 'currentColor' : 'none'} />
      </IconButton>
      {items.length > 0 && (
        <OverflowMenu disabled={pending} items={items} label={`${item.name} 的更多操作`} />
      )}
    </div>
  );
}

type ListProps = {
  items: KnowledgeBase[];
  selected: ReadonlySet<string>;
  handlers: RowHandlers;
};

export function KnowledgeBaseTable({
  items,
  selected,
  handlers,
  allSelected,
  onToggleAll,
}: ListProps & { allSelected: boolean; onToggleAll: () => void }) {
  return (
    <div className="ui-table-wrap">
      <table className="ui-table kb-table">
        <thead>
          <tr>
            <th className="ui-table__select">
              <Checkbox
                aria-label="选择当前页全部知识库"
                checked={allSelected}
                onChange={onToggleAll}
              />
            </th>
            <th>名称</th>
            <th>状态</th>
            <th>文档</th>
            <th>更新</th>
            <th className="ui-table__actions">操作</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const readiness = getKnowledgeBaseReadiness(item);
            const updatedBy = item.updatedBy?.displayName || item.updatedBy?.username;
            return (
              <tr data-busy={handlers.isPending(item.id) || undefined} data-selected={selected.has(item.id) || undefined} key={item.id}>
                <td className="ui-table__select" data-label="选择">
                  <Checkbox
                    aria-label={`选择 ${item.name}`}
                    checked={selected.has(item.id)}
                    onChange={() => handlers.onToggleSelected(item.id)}
                  />
                </td>
                <td data-label="名称">
                  <Link
                    className="kb-name"
                    onClick={() => handlers.onOpen(item)}
                    title={item.visibility === 'public' ? '公开知识库' : '私有知识库'}
                    to={`/knowledge-bases/${item.id}`}
                  >
                    <KnowledgeBaseGlyph visibility={item.visibility} />
                    <span className="ui-cell-stack">
                      <strong>{item.name}</strong>
                      <small>{item.description || '未填写描述'}</small>
                    </span>
                  </Link>
                  {(item.tags?.length ?? 0) > 0 && (
                    <span className="kb-name__tags">
                      {item.tags?.slice(0, 3).map((tag) => <span className="ui-tag" key={tag.id}>{tag.name}</span>)}
                    </span>
                  )}
                </td>
                <td data-label="状态">
                  <Badge aria-label={readiness.detail} title={readiness.detail} tone={readiness.tone}>
                    {readiness.label}
                  </Badge>
                </td>
                <td className="ui-table__num" data-label="文档">{formatCount(item.documentCount)}</td>
                <td data-label="更新" title={updatedBy ? `最后更新人：${updatedBy}` : undefined}>
                  {formatRelativeTime(item.updatedAt || item.createdAt)}
                </td>
                <td className="ui-table__actions" data-label="操作">
                  <RowActions handlers={handlers} item={item} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function KnowledgeBaseCards({ items, selected, handlers }: ListProps) {
  return (
    <div className="kb-cards">
      {items.map((item) => {
        const readiness = getKnowledgeBaseReadiness(item);
        return (
          <article
            className={handlers.isPending(item.id) ? 'kb-card is-busy' : 'kb-card'}
            key={item.id}
          >
            <header className="kb-card__head">
              <Checkbox
                aria-label={`选择 ${item.name}`}
                checked={selected.has(item.id)}
                onChange={() => handlers.onToggleSelected(item.id)}
              />
              <KnowledgeBaseGlyph visibility={item.visibility} />
              <RowActions handlers={handlers} item={item} />
            </header>

            <Link className="kb-card__body" onClick={() => handlers.onOpen(item)} to={`/knowledge-bases/${item.id}`}>
              <strong>{item.name}</strong>
              <p>{item.description || '未填写描述'}</p>
            </Link>

            <div className="kb-card__meta">
              <Badge aria-label={readiness.detail} title={readiness.detail} tone={readiness.tone}>
                {readiness.label}
              </Badge>
              <span className="ui-muted">{formatCount(item.documentCount)} 文档</span>
              <span className="ui-muted">{formatRelativeTime(item.updatedAt || item.createdAt)}</span>
            </div>

            {(item.tags?.length ?? 0) > 0 && (
              <div className="kb-card__tags">
                {item.tags?.slice(0, 4).map((tag) => <span className="ui-tag" key={tag.id}>{tag.name}</span>)}
              </div>
            )}
          </article>
        );
      })}
    </div>
  );
}
