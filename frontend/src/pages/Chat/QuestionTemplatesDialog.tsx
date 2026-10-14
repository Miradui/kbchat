import { Search } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { deleteQuestionTemplate, listQuestionTemplates, saveQuestionTemplate } from '../../api/resources';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { useUnsavedChangesWarning } from '../../components/feedback/useUnsavedChangesWarning';
import { Button } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';
import { Field, Input, SearchInput } from '../../components/ui/Field';
import type { QuestionTemplate } from '../../types/api';
import { getErrorMessage } from '../../utils/errors';
import { PERSONAL_PAGE_SIZE, usePersonalList } from './usePersonalList';
import { fillQuestionTemplate, questionTemplateVariables } from './questionTemplates';

export function QuestionTemplatesDialog({ draft, onInsert, onClose }: { draft: string; onInsert: (text: string) => void; onClose: () => void }) {
  const [mode, setMode] = useState<'list' | 'edit' | 'fill'>('list');
  const [query, setQuery] = useState(''); const [page, setPage] = useState(1); const [composing, setComposing] = useState(false);
  const list = usePersonalList(listQuestionTemplates, query, page, mode === 'list' && !composing);
  const [selected, setSelected] = useState<QuestionTemplate | null>(null);
  const [title, setTitle] = useState(''); const [body, setBody] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [discard, setDiscard] = useState(false); const [deleting, setDeleting] = useState<QuestionTemplate | null>(null);
  const pending = useRef(false); const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const dirty = mode === 'edit' && (title !== (selected?.title ?? '') || body !== (selected?.body ?? ''));
  useUnsavedChangesWarning(dirty);
  const parsed = questionTemplateVariables(body);
  const filled = selected ? fillQuestionTemplate(selected.body, values) : '';
  const validValues = selected?.variables.every((name) => Boolean(values[name]?.trim()) && Array.from(values[name]).length <= 1000) ?? false;
  function back() { if (pending.current) return; if (dirty) setDiscard(true); else if (mode === 'list') onClose(); else { setMode('list'); setError(''); } }
  function edit(item: QuestionTemplate | null) { setSelected(item); setTitle(item?.title ?? ''); setBody(item?.body ?? draft); setError(''); setMode('edit'); }
  async function save() {
    if (pending.current || !title.trim() || !body.trim() || parsed === null) return;
    pending.current = true; setBusy(true); setError('');
    try {
      await saveQuestionTemplate(selected?.id ?? null, { title: title.trim(), body: body.trim() });
      if (mounted.current) { setMode('list'); list.refresh(); }
    } catch (caught) { if (mounted.current) setError(getErrorMessage(caught, '模板未保存，请重试。')); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  }
  async function remove() {
    if (!deleting || pending.current) return;
    pending.current = true; setBusy(true); setError('');
    try { await deleteQuestionTemplate(deleting.id); if (mounted.current) { setDeleting(null); if (list.items.length === 1 && page > 1) setPage(page - 1); list.refresh(); } }
    catch (caught) { if (mounted.current) setError(getErrorMessage(caught, '删除失败，请重试。')); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  }
  return <>
    <Dialog open title={mode === 'edit' ? (selected ? '编辑提问模板' : '新建提问模板') : mode === 'fill' ? '填写模板变量' : '提问模板'} description="保存常用提问，填好变量后插入草稿。模板仅自己可见。" className="chat-search-dialog" onClose={back}>
      {mode === 'list' && <>
        <div className="chat-search-dialog__actions"><SearchInput icon={<Search aria-hidden="true" />} aria-label="搜索提问模板" value={query} maxLength={200} onChange={(event) => { setQuery(event.target.value); setPage(1); }} onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)} />
          <Button onClick={() => edit(null)}>新建模板</Button></div>
        <div className="chat-search-dialog__results" aria-busy={list.loading}>
          <p role="status">{list.loading ? '正在加载模板…' : `共 ${list.total} 个模板`}</p>
          {list.error && <p role="alert">{list.error}<Button variant="link" onClick={list.refresh}>重试</Button></p>}
          {!list.loading && !list.error && !list.items.length && <p>暂无模板，可以将常用问题保存下来。</p>}
          {list.items.map((item) => <article className="chat-bookmark" key={item.id}>
            <strong>{item.title}</strong><p className="chat-template__body">{item.body}</p>
            <div className="chat-search-dialog__actions"><Button variant="secondary" onClick={() => { setSelected(item); setValues({}); setMode('fill'); setError(''); }}>使用模板</Button>
              <Button variant="ghost" onClick={() => edit(item)}>编辑</Button><Button variant="ghost" onClick={() => { setError(''); setDeleting(item); }}>删除</Button></div>
          </article>)}
        </div>
        <div className="chat-search-dialog__actions"><div className="chat-search-dialog__pages"><Button variant="ghost" disabled={list.loading || page <= 1} onClick={() => setPage(page - 1)}>上一页</Button>
          <span>{page} / {Math.max(page, Math.ceil(list.total / PERSONAL_PAGE_SIZE))}</span><Button variant="ghost" disabled={list.loading || page * PERSONAL_PAGE_SIZE >= list.total} onClick={() => setPage(page + 1)}>下一页</Button></div><Button variant="secondary" onClick={onClose}>关闭模板</Button></div>
      </>}
      {mode === 'edit' && <form className="ui-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <Field label="模板标题"><Input aria-label="模板标题" value={title} disabled={busy} maxLength={100} onChange={(event) => setTitle(event.target.value)} /></Field>
        <Field label="模板正文" hint="示例：请归纳 {{产品}} 的使用限制。最多 12000 字、20 个不同变量。">
          <textarea className="ui-input" aria-label="模板正文" rows={8} maxLength={12000} disabled={busy} value={body} onChange={(event) => setBody(event.target.value)} />
        </Field>
        {parsed === null ? <p role="alert">变量请写作 {'{{变量名}}'}，名称限中英文、数字、下划线或连字符，最多 40 字。</p> : <p>变量：{parsed.join('、') || '无'}</p>}
        {error && <p role="alert" className="ui-inline-error">{error}</p>}
        <div className="ui-dialog__actions"><Button variant="secondary" disabled={busy} onClick={back}>返回模板列表</Button><Button type="submit" loading={busy} disabled={!title.trim() || !body.trim() || parsed === null}>保存模板</Button></div>
      </form>}
      {mode === 'fill' && selected && <form className="ui-form" onSubmit={(event) => { event.preventDefault(); if (validValues && filled.trim() && Array.from(filled).length <= 12000) { onInsert(filled); onClose(); } }}>
        <strong>{selected.title}</strong>
        <div className="chat-template__variables">{selected.variables.map((name) => <Field key={name} label={name}><Input aria-label={name} maxLength={1000} value={values[name] ?? ''} onChange={(event) => setValues((current) => ({ ...current, [name]: event.target.value }))} /></Field>)}</div>
        <Field label="插入预览"><pre className="chat-template__preview">{filled}</pre></Field>
        <p className="ui-muted">{draft ? '将追加到现有草稿后面，保留已输入内容。' : '插入后可继续编辑，点击发送才会提问。'}</p>
        {Array.from(filled).length > 12000 && <p role="alert">填入后的问题超过 12000 字，请缩短变量内容。</p>}
        <div className="ui-dialog__actions"><Button variant="secondary" onClick={back}>返回模板列表</Button><Button type="submit" disabled={!validValues || !filled.trim() || Array.from(filled).length > 12000}>插入草稿</Button></div>
      </form>}
    </Dialog>
    {discard && <ConfirmDialog title="放弃模板修改？" description="未保存的模板修改将丢失，当前聊天草稿会保留。" confirmLabel="放弃修改" onCancel={() => setDiscard(false)} onConfirm={() => { setDiscard(false); setMode('list'); setError(''); }} />}
    {deleting && <ConfirmDialog title="删除提问模板？" description={`删除「${deleting.title}」后无法恢复。`} confirmLabel="删除" busy={busy} error={error} onCancel={() => { if (!pending.current) { setDeleting(null); setError(''); } }} onConfirm={remove} />}
  </>;
}
