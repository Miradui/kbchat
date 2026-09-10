import { useEffect, useRef, useState } from 'react';

import { saveEvaluationCase } from '../../api/evaluations';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { useUnsavedChangesWarning } from '../../components/feedback/useUnsavedChangesWarning';
import { Button } from '../../components/ui/Button';
import { Dialog } from '../../components/ui/Dialog';
import { Checkbox, Field } from '../../components/ui/Field';
import type { EvaluationCase, EvaluationCaseInput } from '../../types/evaluation';
import { getErrorMessage } from '../../utils/errors';

export function EvaluationCaseDialog({ knowledgeBaseId, initial, onClose, onSaved }: {
  knowledgeBaseId: string;
  initial?: Partial<EvaluationCase>;
  onClose: () => void;
  onSaved: (item: EvaluationCase) => void;
}) {
  const [question, setQuestion] = useState(initial?.question || '');
  const [expected, setExpected] = useState(initial?.expectedAnswer || '');
  const [keywords, setKeywords] = useState(initial?.requiredKeywords?.join('\n') || '');
  const [citation, setCitation] = useState(initial?.requireCitation ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [discard, setDiscard] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const dirty = question !== (initial?.question || '') || expected !== (initial?.expectedAnswer || '') || keywords !== (initial?.requiredKeywords?.join('\n') || '') || citation !== (initial?.requireCitation ?? true);
  useUnsavedChangesWarning(dirty);
  function close() { if (!pending.current) { if (dirty) setDiscard(true); else onClose(); } }
  async function submit() {
    if (pending.current || !question.trim()) return;
    const input: EvaluationCaseInput = { question: question.trim(), expectedAnswer: expected.trim(), requiredKeywords: keywords.split('\n').map((word) => word.trim()).filter(Boolean), requireCitation: citation };
    if (input.requiredKeywords.length > 20 || input.requiredKeywords.some((word) => [...word].length > 100)) { setError('最多 20 个关键词，每个不超过 100 字。'); return; }
    pending.current = true; setBusy(true); setError('');
    try {
      const item = await saveEvaluationCase(knowledgeBaseId, input, initial?.id);
      if (mounted.current) { onSaved(item); onClose(); }
    } catch (error) { if (mounted.current) setError(getErrorMessage(error, '测试问题保存失败')); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  }
  return <>
    <Dialog open className="evaluation-case-dialog" title={initial?.id ? '编辑测试问题' : '保存测试问题'} description="使用可以独立理解的问题；参考答案供人工核对，关键词和引用要求用于自动检查。" onClose={close}>
      <form className="ui-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <Field label="测试问题"><textarea aria-label="测试问题" className="ui-input" required disabled={busy} rows={3} maxLength={4000} value={question} onChange={(event) => setQuestion(event.target.value)} /></Field>
        <Field label="参考答案（可选）"><textarea aria-label="参考答案" className="ui-input" disabled={busy} rows={3} maxLength={8000} value={expected} onChange={(event) => setExpected(event.target.value)} /></Field>
        <Field label="必须包含的关键词（可选）" hint="每行一个，最多 20 个。不区分大小写，按字面文本匹配。">
          <textarea aria-label="必须包含的关键词" className="ui-input" disabled={busy} rows={3} value={keywords} onChange={(event) => setKeywords(event.target.value)} />
        </Field>
        <label className="evaluation-checkbox"><Checkbox checked={citation} disabled={busy} onChange={(event) => setCitation(event.target.checked)} />回答必须包含引用</label>
        {error && <p className="ui-inline-error" role="alert">{error}</p>}
        <div className="ui-dialog__actions"><Button disabled={busy} variant="secondary" onClick={close}>取消</Button><Button disabled={!question.trim()} loading={busy} type="submit" variant="primary">保存测试问题</Button></div>
      </form>
    </Dialog>
    {discard && <ConfirmDialog title="放弃测试问题修改？" description="未保存的问题和评测规则将丢失。" confirmLabel="放弃修改" onCancel={() => setDiscard(false)} onConfirm={onClose} />}
  </>;
}
