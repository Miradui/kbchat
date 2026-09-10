import { useState } from 'react';

import { Button } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';
import { Checkbox, Field, Select } from '../../components/ui/Field';
import type { KnowledgeBaseBatchTagMode, KnowledgeBaseTag } from '../../types/api';
import type { CategoryOption } from './categoryTreeUtils';

export type KnowledgeBaseBatchChange =
  | { kind: 'move'; categoryId: string | null }
  | { kind: 'tags'; tagIds: string[]; mode: KnowledgeBaseBatchTagMode };

type Props = {
  kind: 'move' | 'tags';
  count: number;
  busy: boolean;
  error: string;
  categories: CategoryOption[];
  tags: KnowledgeBaseTag[];
  optionsLoading: boolean;
  optionsError: string;
  onRetryOptions: () => void;
  onClose: () => void;
  onSubmit: (change: KnowledgeBaseBatchChange) => void;
};

export function KnowledgeBaseBatchDialog({ kind, count, busy, error, categories, tags, optionsLoading, optionsError, onRetryOptions, onClose, onSubmit }: Props) {
  const [categoryId, setCategoryId] = useState('');
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [mode, setMode] = useState<KnowledgeBaseBatchTagMode>('add');
  const ready = !optionsLoading && !optionsError && (kind === 'move' ? Boolean(categoryId) : tagIds.length > 0);
  const close = () => { if (!busy) onClose(); };

  return (
    <Dialog open title={kind === 'move' ? '批量移动到分类' : '批量管理标签'} description={`此操作仅应用于已选择的 ${count} 个知识库。`} onClose={close}>
      <form className="ui-dialog__form" onSubmit={(event) => {
        event.preventDefault();
        if (busy || !ready) return;
        onSubmit(kind === 'move'
          ? { kind, categoryId: categoryId === '__none__' ? null : categoryId }
          : { kind, tagIds, mode });
      }}>
        {optionsLoading && <p className="ui-muted" role="status">正在加载选项…</p>}
        {optionsError && <div role="alert"><p className="ui-field__error">{optionsError}</p><Button onClick={onRetryOptions} variant="secondary">重新加载</Button></div>}
        {kind === 'move' ? (
          <Field htmlFor="kb-batch-category" label="目标分类" hint="选择“未分类”会将知识库移出当前分类。">
            <Select id="kb-batch-category" data-autofocus disabled={busy || optionsLoading || Boolean(optionsError)} value={categoryId} onChange={(event) => setCategoryId(event.target.value)}>
              <option value="" disabled>请选择目标分类</option>
              <option value="__none__">未分类</option>
              {categories.map(category => <option key={category.id} value={category.id}>{category.label}</option>)}
            </Select>
          </Field>
        ) : (
          <>
            <Field htmlFor="kb-batch-tag-mode" label="操作方式" hint={mode === 'replace' ? '替换后仅保留所选标签，原有其他标签会被移除。' : mode === 'remove' ? '仅移除下面勾选的标签，其他标签保留。' : '在现有标签上添加，已存在的标签不会重复。'}>
              <Select data-autofocus id="kb-batch-tag-mode" disabled={busy} value={mode} onChange={(event) => setMode(event.target.value as KnowledgeBaseBatchTagMode)}>
                <option value="add">添加标签</option><option value="remove">移除标签</option><option value="replace">替换全部标签</option>
              </Select>
            </Field>
            <fieldset className="kb-form__tags" disabled={busy || optionsLoading || Boolean(optionsError)}>
              <legend className="ui-field__label">选择标签（可多选）</legend>
              <div className="kb-form__tag-options">
                {tags.map(tag => <label className="kb-form__tag-option" key={tag.id}>
                  <Checkbox checked={tagIds.includes(tag.id)} onChange={() => setTagIds(current => current.includes(tag.id) ? current.filter(id => id !== tag.id) : [...current, tag.id])} />
                  {tag.name}
                </label>)}
              </div>
              {!optionsLoading && !optionsError && tags.length === 0 && <p className="ui-muted">还没有标签，请先到“标签”页面创建。</p>}
            </fieldset>
          </>
        )}
        {error && <p className="ui-field__error" role="alert">{error}</p>}
        <div className="ui-dialog__actions">
          <Button variant="secondary" disabled={busy} onClick={close}>取消</Button>
          <Button type="submit" loading={busy} disabled={!ready} loadingLabel="保存中…">{kind === 'move' ? '确认移动' : '应用标签'}</Button>
        </div>
      </form>
    </Dialog>
  );
}
