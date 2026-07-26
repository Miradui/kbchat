import { useCallback, type FormEvent } from 'react';
import { X } from 'lucide-react';

import { IconButton } from '../../components/ui/IconButton';
import { useModalFocus } from '../../components/ui/useModalFocus';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';
import type { KnowledgeBaseTag, RecycleBinItem } from '../../types/api';

export type KnowledgeBaseFormState = {
  id?: string;
  name: string;
  description: string;
  categoryId: string;
  visibility: 'private' | 'public';
  tagIds: string[];
};

type KnowledgeBaseFormDrawerProps = {
  busy: boolean;
  categories: { id: string; label: string }[];
  error: string;
  form: KnowledgeBaseFormState;
  tags: KnowledgeBaseTag[];
  onChange: (form: KnowledgeBaseFormState) => void;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
};

export function KnowledgeBaseFormDrawer({
  busy,
  categories,
  error,
  form,
  tags,
  onChange,
  onClose,
  onSubmit,
}: KnowledgeBaseFormDrawerProps) {
  const requestClose = useCallback(() => {
    if (!busy) {
      onClose();
    }
  }, [busy, onClose]);
  const panelRef = useModalFocus<HTMLElement>(true, requestClose);

  return (
    <aside className="drawer-backdrop" role="presentation">
      <section
        aria-labelledby="kb-form-title"
        aria-modal="true"
        className="drawer-panel kb-form-drawer"
        ref={panelRef}
        role="dialog"
        tabIndex={-1}
      >
        <header>
          <div>
            <h2 id="kb-form-title">{form.id ? '编辑知识库' : '新建知识库'}</h2>
            <p className="muted-text">保存后，分类、可见性和标签将立即更新。</p>
          </div>
          <IconButton disabled={busy} label="关闭" onClick={requestClose}>
            <X aria-hidden="true" />
          </IconButton>
        </header>

        <form className="drawer-form" onSubmit={onSubmit}>
          <div className="form-grid drawer-form-grid">
            <label>
              名称
              <input
                data-autofocus
                value={form.name}
                onChange={(event) => onChange({ ...form, name: event.target.value })}
                required
              />
            </label>
            <label>
              分类
              <select
                value={form.categoryId}
                onChange={(event) => onChange({ ...form, categoryId: event.target.value })}
              >
                <option value="">未分类</option>
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>{category.label}</option>
                ))}
              </select>
            </label>
            <label>
              可见性
              <select
                value={form.visibility}
                onChange={(event) => onChange({ ...form, visibility: event.target.value as 'private' | 'public' })}
              >
                <option value="private">私有</option>
                <option value="public">公开</option>
              </select>
            </label>
            <label>
              标签
              <select
                value={form.tagIds[0] ?? ''}
                onChange={(event) => onChange({ ...form, tagIds: event.target.value ? [event.target.value] : [] })}
              >
                <option value="">不设置标签</option>
                {tags.map((tag) => <option key={tag.id} value={tag.id}>{tag.name}</option>)}
              </select>
            </label>
            <label className="form-field-wide">
              描述
              <textarea
                value={form.description}
                onChange={(event) => onChange({ ...form, description: event.target.value })}
                rows={4}
              />
            </label>
          </div>

          {error && <p className="drawer-error-text" role="alert">{error}</p>}

          <div className="form-actions drawer-form-actions">
            <button className="secondary-button" type="button" onClick={requestClose} disabled={busy}>取消</button>
            <button type="submit" disabled={busy}>{busy ? '保存中...' : '保存'}</button>
          </div>
        </form>
      </section>
    </aside>
  );
}

type KnowledgeBaseRecycleBinDrawerProps = {
  busy: boolean;
  error: string;
  items: RecycleBinItem[];
  loading: boolean;
  workingId: string | null;
  onClose: () => void;
  onDeletePermanently: (item: RecycleBinItem) => void;
  onEmpty: () => void;
  onRefresh: () => void;
  onRestore: (item: RecycleBinItem) => void;
  onRestoreAll: () => void;
};

export function KnowledgeBaseRecycleBinDrawer({
  busy,
  error,
  items,
  loading,
  workingId,
  onClose,
  onDeletePermanently,
  onEmpty,
  onRefresh,
  onRestore,
  onRestoreAll,
}: KnowledgeBaseRecycleBinDrawerProps) {
  const mutationBusy = busy || Boolean(workingId);
  const requestClose = useCallback(() => {
    if (!mutationBusy) {
      onClose();
    }
  }, [mutationBusy, onClose]);
  const panelRef = useModalFocus<HTMLElement>(true, requestClose);

  return (
    <aside className="drawer-backdrop" role="presentation">
      <section
        aria-labelledby="kb-recycle-title"
        aria-modal="true"
        className="drawer-panel"
        ref={panelRef}
        role="dialog"
        tabIndex={-1}
      >
        <header>
          <div>
            <h2 id="kb-recycle-title">知识库回收站</h2>
            <p className="muted-text">展示当前用户已删除的知识库，可恢复后继续管理文档和会话。</p>
          </div>
          <IconButton label="关闭" onClick={requestClose} disabled={mutationBusy}><X aria-hidden="true" /></IconButton>
        </header>

        <div className="drawer-actions">
          <button className="secondary-button" type="button" onClick={onRefresh} disabled={loading || mutationBusy}>刷新</button>
          <button className="secondary-button" type="button" onClick={onRestoreAll} disabled={mutationBusy || items.length === 0}>恢复全部</button>
          <button className="danger-button" type="button" onClick={onEmpty} disabled={mutationBusy || items.length === 0}>清空回收站</button>
        </div>

        <div className="recycle-list">
          {loading ? (
            <LoadingSkeleton rows={4} columns={1} compact announce />
          ) : error ? (
            <div className="empty-state" role="alert">
              <p>{error}</p>
              <button className="secondary-button" type="button" onClick={onRefresh}>
                重试加载
              </button>
            </div>
          ) : items.length === 0 ? (
            <div className="empty-state">知识库回收站为空。</div>
          ) : items.map((item) => (
            <article className="recycle-item" key={item.id}>
              <div>
                <strong>{item.name}</strong>
                <span>删除时间 {formatDateTime(item.deletedAt)}</span>
              </div>
              <div className="table-actions">
                <button className="secondary-button" type="button" onClick={() => onRestore(item)} disabled={mutationBusy}>
                  {workingId === item.id ? '恢复中...' : '恢复'}
                </button>
                <button className="danger-button" type="button" onClick={() => onDeletePermanently(item)} disabled={mutationBusy}>永久删除</button>
              </div>
            </article>
          ))}
        </div>
      </section>
    </aside>
  );
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}
