import { useEffect, useRef, useState, type FormEvent } from 'react';
import { updateKnowledgeBase } from '../../api/resources';
import { useToast } from '../../components/feedback/ToastProvider';
import { Button } from '../../components/ui/Button';
import type { KnowledgeBase } from '../../types/api';
import { hasCapability } from '../../utils/access';
import { getErrorMessage } from '../../utils/errors';

export function DocumentVersionPolicyForm({ knowledgeBase, onUpdated }: { knowledgeBase: KnowledgeBase; onUpdated: (value: KnowledgeBase) => void }) {
  const stored = knowledgeBase.documentVersionPolicy ?? 'all';
  const [value, setValue] = useState(stored);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const active = useRef(true); const savingRef = useRef(false);
  const toast = useToast();
  const editable = hasCapability(knowledgeBase, 'kb.write');
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => { setValue(stored); setError(''); }, [stored]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!editable || savingRef.current || value === stored) return;
    savingRef.current = true; setSaving(true); setError('');
    try {
      const next = await updateKnowledgeBase(knowledgeBase.id, { name: knowledgeBase.name, description: knowledgeBase.description, categoryId: knowledgeBase.categoryId ?? null, visibility: knowledgeBase.visibility, documentVersionPolicy: value });
      if (!active.current) return;
      onUpdated(next); toast.success('文档版本检索范围已保存');
    } catch (caught) { if (active.current) setError(getErrorMessage(caught, '版本检索范围保存失败')); }
    finally { savingRef.current = false; if (active.current) setSaving(false); }
  }
  return <section className="ui-panel" aria-label="文档版本检索">
    <div className="ui-panel__head"><h2>文档版本检索</h2></div>
    <form className="ui-panel__body kb-config-form" onSubmit={(event) => void submit(event)}>
      <label>参与新问答的版本<select className="ui-select" aria-label="参与新问答的版本" value={value} disabled={!editable || saving} onChange={(event) => setValue(event.target.value as typeof value)}><option value="all">全部版本</option><option value="current">当前有效版本</option></select></label>
      <p className="ui-muted">当前有效版本使用替换链中最新已完成入库的内容。新版处理完成前、首次处理失败或取消时，继续使用旧版；重新处理期间保留已发布内容。</p>
      <p className="ui-muted">适用于本库参与的单库、多库和自动检索。历史文档、版本对比及旧回答引用继续保留；“保留两份”产生的独立文档均可检索。</p>
      {error && <p role="alert" className="ui-inline-error">{error}</p>}
      {editable ? <div className="kb-config-form__actions"><Button variant="secondary" disabled={saving || stored === value} onClick={() => { setValue(stored); setError(''); }}>重置</Button><Button type="submit" disabled={stored === value} loading={saving} loadingLabel="保存中">保存版本范围</Button></div> : <p className="ui-field__hint">当前设置为只读，需要管理员成员或所有者权限才能调整。</p>}
    </form>
  </section>;
}
