import { useCallback, useState, type FormEvent } from 'react';
import { X } from 'lucide-react';

import { Button } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';
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

type KnowledgeBaseFormOverlayProps = {
  busy: boolean;
  categories: { id: string; label: string }[];
  error: string;
  form: KnowledgeBaseFormState;
  tags: KnowledgeBaseTag[];
  onChange: (form: KnowledgeBaseFormState) => void;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
};

export function KnowledgeBaseFormOverlay({
  busy,
  categories,
  error,
  form,
  tags,
  onChange,
  onClose,
  onSubmit,
}: KnowledgeBaseFormOverlayProps) {
  const requestClose = useCallback(() => {
    if (!busy) {
      onClose();
    }
  }, [busy, onClose]);
  const panelRef = useModalFocus<HTMLElement>(Boolean(form.id), requestClose);
  const fields = (
    <KnowledgeBaseFormFields
      busy={busy}
      categories={categories}
      error={error}
      form={form}
      tags={tags}
      onChange={onChange}
      onClose={requestClose}
      onSubmit={onSubmit}
    />
  );

  if (!form.id) {
    return (
      <Dialog
        open
        title="新建知识库"
        description="仅名称必填，创建后可直接导入文档。"
        onClose={requestClose}
      >
        {fields}
      </Dialog>
    );
  }

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
            <h2 id="kb-form-title">编辑知识库</h2>
            <p className="muted-text">更新基础信息、分类、标签和访问权限。</p>
          </div>
          <IconButton disabled={busy} label="关闭" onClick={requestClose}>
            <X aria-hidden="true" />
          </IconButton>
        </header>

        {fields}
      </section>
    </aside>
  );
}

function KnowledgeBaseFormFields({
  busy,
  categories,
  error,
  form,
  tags,
  onChange,
  onClose,
  onSubmit,
}: KnowledgeBaseFormOverlayProps) {
  const editing = Boolean(form.id);
  const [advancedOpen, setAdvancedOpen] = useState(editing);

  function toggleTag(tagId: string) {
    const tagIds = form.tagIds.includes(tagId)
      ? form.tagIds.filter((id) => id !== tagId)
      : [...form.tagIds, tagId];
    onChange({ ...form, tagIds });
  }

  return (
    <form className={editing ? 'kb-form drawer-form' : 'kb-form kb-form-dialog'} onSubmit={onSubmit}>
      <div className="kb-form-fields">
        <label>
          名称
          <input
            data-autofocus
            disabled={busy}
            value={form.name}
            onChange={(event) => onChange({ ...form, name: event.target.value })}
            required
          />
        </label>
        <label>
          描述
          <textarea
            disabled={busy}
            value={form.description}
            onChange={(event) => onChange({ ...form, description: event.target.value })}
            rows={3}
          />
        </label>

        <details
          className="kb-form-advanced"
          open={advancedOpen}
          onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
        >
          <summary>更多设置</summary>
          <div className="kb-form-advanced-fields">
            <label>
              分类
              <select
                disabled={busy}
                value={form.categoryId}
                onChange={(event) => onChange({ ...form, categoryId: event.target.value })}
              >
                <option value="">未分类</option>
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>{category.label}</option>
                ))}
              </select>
            </label>

            <fieldset className="kb-tag-fieldset">
              <legend>标签</legend>
              {tags.length === 0 ? (
                <p className="muted-text">暂无可用标签</p>
              ) : (
                <div className="kb-tag-options">
                  {tags.map((tag) => (
                    <label className="kb-tag-option" key={tag.id}>
                      <input
                        checked={form.tagIds.includes(tag.id)}
                        disabled={busy}
                        type="checkbox"
                        onChange={() => toggleTag(tag.id)}
                      />
                      <span>{tag.name}</span>
                    </label>
                  ))}
                </div>
              )}
            </fieldset>

            <label>
              访问权限
              <select
                disabled={busy}
                value={form.visibility}
                onChange={(event) => onChange({ ...form, visibility: event.target.value as 'private' | 'public' })}
              >
                <option value="private">私有</option>
                <option value="public">公开</option>
              </select>
            </label>
          </div>
        </details>
      </div>

      {error && <p className={editing ? 'drawer-error-text' : 'ui-dialog__error'} role="alert">{error}</p>}

      <div className={editing ? 'form-actions drawer-form-actions' : 'ui-dialog__actions'}>
        <Button variant="secondary" disabled={busy} onClick={onClose}>取消</Button>
        <Button loading={busy} loadingLabel="保存中" type="submit">
          {editing ? '保存修改' : '创建并导入文档'}
        </Button>
      </div>
    </form>
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
